import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApiServer, tokenAuthenticator } from './http-api.mjs';

/**
 * The storage entry point exports createStore({ databasePath }).
 * It applies migrations before returning a ready store.
 */
export async function startServer({
  store,
  tokens,
  allowedSourceIds,
  port = 3000,
  host = '127.0.0.1',
  onError = console.error,
}) {
  try {
    const server = createApiServer({
      store, authenticate: tokenAuthenticator(tokens), allowedSourceIds, onError,
    });
    await new Promise((ready, reject) => {
      server.once('error', reject);
      server.listen(port, host, ready);
    });
    return server;
  } catch (error) {
    try {
      await store.close?.();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Server startup and store cleanup failed');
    }
    throw error;
  }
}

async function main() {
  const { JOB_STORE_MODULE, DATABASE_PATH, EDITOR_TOKENS, ALLOWED_SOURCE_IDS } = process.env;
  if (!JOB_STORE_MODULE || !DATABASE_PATH || !EDITOR_TOKENS || !ALLOWED_SOURCE_IDS) {
    throw new Error('Configure JOB_STORE_MODULE, DATABASE_PATH, EDITOR_TOKENS, ALLOWED_SOURCE_IDS');
  }
  const tokens = JSON.parse(EDITOR_TOKENS);
  const allowedSourceIds = JSON.parse(ALLOWED_SOURCE_IDS);
  if (!Array.isArray(allowedSourceIds) || !allowedSourceIds.length
    || allowedSourceIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('ALLOWED_SOURCE_IDS must contain source IDs');
  }
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const { createStore } = await import(pathToFileURL(resolve(JOB_STORE_MODULE)));
  const store = await createStore({ databasePath: DATABASE_PATH });
  const server = await startServer({
    store, tokens, allowedSourceIds, port, host: process.env.HOST ?? '127.0.0.1',
  });
  console.log(`HTTP API listening on ${JSON.stringify(server.address())}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      try { await store.close?.(); } catch (error) { console.error(error); process.exitCode = 1; }
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
