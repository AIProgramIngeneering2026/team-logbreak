import { createHmac, randomBytes } from 'node:crypto';

const messages = {
  invalid_tool_request: 'Некорректные параметры сбора',
  collection_not_allowed: 'Сбор из источника запрещён',
  source_timeout: 'Истекло время сбора',
  source_rate_limited: 'Источник ограничил частоту запросов',
  invalid_source_response: 'Некорректный ответ источника',
  source_unavailable: 'Источник временно недоступен',
  cancelled: 'Сбор отменён',
  unknown_operation: 'Неизвестная операция',
};
const retryableCodes = new Set(['source_timeout', 'source_rate_limited', 'source_unavailable']);

export function toolError(code, { field, retryAfterSeconds = null, retryable = retryableCodes.has(code) } = {}) {
  return { code, retryable, retryAfterSeconds, safeMessage: messages[code], ...(field && { field }) };
}

export function isUri(value) {
  if (typeof value !== 'string' || value.trim() !== value) return false;
  return URL.canParse(value);
}

export function isDateTime(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    && Number.isFinite(Date.parse(value));
}

export function isPublication(record) {
  return typeof record?.externalId === 'string' && !!record.externalId.trim()
    && isDateTime(record.publishedAt) && isUri(record.originalUrl)
    && (record.text === null || typeof record.text === 'string')
    && record.attributes !== null && typeof record.attributes === 'object'
    && !Array.isArray(record.attributes);
}

function invalidField(request, sourceType) {
  if (!request || typeof request !== 'object') return 'request';
  const { source, from, to, pageSize, cursor } = request;
  if (source?.type !== sourceType) return 'source.type';
  if (typeof source.id !== 'string' || !source.id.trim()) return 'source.id';
  if (!isUri(source.url)) return 'source.url';
  if (!isDateTime(from)) return 'from';
  if (!isDateTime(to) || Date.parse(from) > Date.parse(to)) return 'to';
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) return 'pageSize';
  if (cursor !== null && typeof cursor !== 'string') return 'cursor';
  return null;
}

export function createSnapshotTool(sourceType, readSnapshot, toPublication, onUnexpectedError = console.error) {
  const secret = randomBytes(32);

  function cursorFor(request, offset) {
    const { source, from, to, pageSize } = request;
    const scope = JSON.stringify([source.id, source.url, from, to, pageSize, offset]);
    const signature = createHmac('sha256', secret).update(scope).digest('base64url');
    return `${offset}.${signature}`;
  }

  return Object.freeze({
    sourceType,
    async collect(request, context) {
      const field = invalidField(request, sourceType);
      if (field) return toolError('invalid_tool_request', { field });

      let offset = 0;
      if (request.cursor !== null) {
        offset = Number(request.cursor.split('.', 1)[0]);
        if (!Number.isSafeInteger(offset) || offset < 1 || cursorFor(request, offset) !== request.cursor) {
          return toolError('invalid_tool_request', { field: 'cursor' });
        }
      }

      if (context.cancellationToken.aborted) return toolError('cancelled');
      if (Date.now() >= Date.parse(context.deadline)) return toolError('source_timeout');
      let entries;
      try {
        entries = await readSnapshot(request.source, context);
      } catch {
        onUnexpectedError('Сбой чтения источника', context.requestId);
        return toolError('source_unavailable');
      }
      if (context.cancellationToken.aborted) return toolError('cancelled');
      if (Date.now() >= Date.parse(context.deadline)) return toolError('source_timeout');
      if (entries === null) return toolError('collection_not_allowed');
      if (!Array.isArray(entries)) return toolError('invalid_source_response');

      const records = entries.map(toPublication);
      if (!records.every(isPublication)) return toolError('invalid_source_response');

      const from = Date.parse(request.from);
      const to = Date.parse(request.to);
      const window = records.filter(({ publishedAt }) => {
        const instant = Date.parse(publishedAt);
        return instant >= from && instant <= to;
      }).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt)
        || Number(a.externalId > b.externalId) - Number(a.externalId < b.externalId));

      const next = offset + request.pageSize;
      return {
        records: window.slice(offset, next),
        nextCursor: next < window.length ? cursorFor(request, next) : null,
        observedAt: new Date().toISOString(),
      };
    },
  });
}
