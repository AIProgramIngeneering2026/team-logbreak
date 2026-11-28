import { JobPersistenceError } from './job.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { isDateTime, isPublication, toolError } from './tool.mjs';
import { normalizePublications } from './normalize.mjs';

const toolErrorCodes = new Set([
  'invalid_tool_request', 'collection_not_allowed', 'source_timeout', 'source_rate_limited',
  'invalid_source_response', 'source_unavailable', 'cancelled',
]);
const retryableCodes = new Set(['source_timeout', 'source_rate_limited', 'source_unavailable']);

export class Dispatcher {
  constructor(registry, { findSource, onUnexpectedError = console.error }) {
    this.registry = registry;
    this.findSource = findSource;
    this.onUnexpectedError = onUnexpectedError;
  }

  async run(job, { sourceIds, from, to, pageSize = 100, timeoutMs = 30_000 }) {
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 20
      || sourceIds.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(sourceIds).size !== sourceIds.length) {
      throw Object.assign(new TypeError('Expected 1–20 distinct source IDs'), {
        code: 'invalid_tool_request', field: 'sourceIds',
      });
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw Object.assign(new TypeError('Invalid job timeout'), {
        code: 'invalid_tool_request', field: 'timeoutMs',
      });
    }

    // start() claims the job before the first await.
    job.start();
    const deadline = Date.now() + timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = AbortSignal.any([job.signal, timeout.signal]);
    const context = {
      cancellationToken: signal,
      deadline: new Date(deadline).toISOString(),
      requestId: job.id,
    };
    const publications = [];
    const sourceFailures = [];
    try {
      for (const sourceId of sourceIds) {
        const outcome = await this.#collectSource(sourceId, { from, to, pageSize }, context);
        if (job.signal.aborted) return;
        if (outcome.error) {
          const { code, field } = outcome.error;
          sourceFailures.push({ sourceId, code, ...(field && { field }) });
        } else {
          for (const record of outcome.records) publications.push({ source: outcome.source, record });
        }
      }
      if (sourceFailures.length === sourceIds.length) {
        job.fail({ items: [], sourceFailures });
        return;
      }
      job.process();
      let items;
      try {
        items = normalizePublications(publications);
      } catch (error) {
        job.fail({ code: 'invalid_source_response', items: [], sourceFailures });
        this.onUnexpectedError('Сбой нормализации публикаций', context.requestId, error);
        return;
      }
      job.finish({ items, sourceFailures });
    } catch (error) {
      if (error instanceof JobPersistenceError) throw error;
      if (job.signal.aborted) return;
      job.fail({ code: 'source_unavailable', items: [], sourceFailures });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #collectSource(sourceId, params, context) {
    const signal = context.cancellationToken;
    const expired = () => signal.aborted || Date.now() >= Date.parse(context.deadline);
    if (expired()) return { error: toolError('source_timeout') };

    let source;
    try {
      source = await untilAborted(() => this.findSource(sourceId), signal);
    } catch {
      if (expired()) return { error: toolError('source_timeout') };
      this.onUnexpectedError('Сбой чтения источника', context.requestId);
      return { error: toolError('source_unavailable') };
    }
    if (expired()) return { error: toolError('source_timeout') };
    if (!source?.enabled || !source.allowed || source.id !== sourceId) {
      return { error: toolError('collection_not_allowed') };
    }

    let tool;
    try {
      tool = this.registry.get(source.type);
    } catch (error) {
      if (error.code !== 'unknown_operation') throw error;
      return { error: toolError(error.code, { field: error.field }) };
    }

    const records = [];
    const cursors = new Set();
    let cursor = null;
    do {
      const page = await this.#collectPage(tool, { ...params, source, cursor }, context);
      if (page.code) return { error: page };
      if (page.nextCursor !== null && (cursors.has(page.nextCursor) || !page.records.length)) {
        return { error: toolError('invalid_source_response') };
      }
      for (const record of page.records) records.push(record);
      cursor = page.nextCursor;
      cursors.add(cursor);
    } while (cursor !== null);

    return { source, records };
  }

  async #collectPage(tool, request, context) {
    const signal = context.cancellationToken;
    const deadline = Date.parse(context.deadline);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal.aborted || Date.now() >= deadline) return toolError('source_timeout');

      let page;
      try {
        page = await untilAborted(() => tool.collect(request, context), signal);
      } catch {
        if (signal.aborted) return toolError('source_timeout');
        this.onUnexpectedError('Сбой выполнения Tool', context.requestId);
        page = toolError('source_unavailable');
      }
      if (signal.aborted || Date.now() >= deadline) return toolError('source_timeout');
      if (page?.code) {
        if (!toolErrorCodes.has(page.code)) return toolError('invalid_source_response');
        if (!page.retryable || !retryableCodes.has(page.code) || attempt === 3) return page;
        const retryAfter = page.retryAfterSeconds;
        const wait = page.code === 'source_rate_limited' && Number.isInteger(retryAfter) && retryAfter >= 0
          ? retryAfter * 1_000 : 25 * 2 ** (attempt - 1);
        if (wait >= deadline - Date.now()) return page;
        try {
          await delay(wait, undefined, { signal });
        } catch {
          return toolError('source_timeout');
        }
      } else {
        if (!Array.isArray(page?.records) || page.records.length > Math.min(request.pageSize, 500)
          || !page.records.every(isPublication) || !isDateTime(page.observedAt)
          || page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) {
          return toolError('invalid_source_response');
        }
        return page;
      }
    }
  }
}

async function untilAborted(start, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return start();
    });
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
