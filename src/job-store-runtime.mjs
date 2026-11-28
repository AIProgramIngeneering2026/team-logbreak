import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Dispatcher } from './dispatcher.mjs';
import { Registry } from './registry.mjs';
import { SqliteJobStore } from './sqlite-job-store.mjs';
import { telegramChannelTool } from './telegram-tool.mjs';
import { isUri } from './tool.mjs';
import { websiteTool } from './website-tool.mjs';

function loadSources() {
  const filename = process.env.JOB_SOURCES_FILE;
  if (!filename) throw new Error('Configure JOB_SOURCES_FILE');
  return JSON.parse(readFileSync(filename, 'utf8'));
}

export function createStore({ databasePath, sources = loadSources(), onError = console.error }) {
  if (!Array.isArray(sources) || !sources.length) throw new TypeError('Expected a list of Job sources');

  const catalog = new Map();
  for (const source of sources) {
    if (typeof source?.id !== 'string' || !source.id.trim() || catalog.has(source.id)
      || !['telegram', 'website'].includes(source.type) || !isUri(source.url)
      || !Array.isArray(source.entries)) {
      throw new TypeError('Invalid or duplicate Job source');
    }
    catalog.set(source.id, { ...source, enabled: true, allowed: true });
  }

  const readSnapshot = (source) => catalog.get(source.id).entries;
  const dispatcher = new Dispatcher(
    new Registry([telegramChannelTool(readSnapshot, onError), websiteTool(readSnapshot, onError)]),
    { findSource: (id) => catalog.get(id), onUnexpectedError: onError },
  );
  const store = new SqliteJobStore(databasePath);
  try {
    store.recoverInterrupted();
  } catch (error) {
    store.close();
    throw error;
  }

  const stopping = new AbortController();
  const work = runWorker(store, dispatcher, stopping.signal).catch((error) => {
    if (!(stopping.signal.aborted && error.name === 'AbortError')) onError(error);
  });
  let closing;
  return {
    createJob: (request) => store.createJob(request),
    getJob: (request) => store.getJob(request),
    close() {
      stopping.abort();
      closing ??= work.finally(() => store.close());
      return closing;
    },
  };
}

async function runWorker(store, dispatcher, signal) {
  while (!signal.aborted) {
    if (!await store.runNext(dispatcher) && !signal.aborted) {
      await delay(50, undefined, { signal, ref: false });
    }
  }
}
