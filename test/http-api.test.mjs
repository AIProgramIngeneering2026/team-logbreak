import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { createApiServer, tokenAuthenticator } from '../src/http-api.mjs';
import { CollectionJob } from '../src/job.mjs';
import { Dispatcher } from '../src/dispatcher.mjs';
import { Registry } from '../src/registry.mjs';
import { telegramChannelTool } from '../src/telegram-tool.mjs';
import { startServer } from '../src/server.mjs';

const contract = parse(readFileSync(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema(contract, 'openapi');
const validators = new Map();
const body = { from: '2026-11-01', to: '2026-11-30', sourceIds: ['telegram'] };

// A test double for the agreed store interface. SQLite and concurrency are tested by its owner.
function memoryStore() {
  const jobs = new Map();
  const keys = new Map();
  return {
    jobs,
    createCalls: 0,
    createJob(input) {
      this.createCalls++;
      const { editorId, idempotencyKey, from, to, sourceIds } = input;
      const key = JSON.stringify([editorId, idempotencyKey]);
      const fingerprint = JSON.stringify([from, to, [...sourceIds].sort()]);
      const previous = keys.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw Object.assign(new Error('Private storage information'), { code: 'idempotency_conflict' });
        }
        return { created: false, job: structuredClone(jobs.get(previous.id).job) };
      }
      const job = { id: `job-${jobs.size + 1}`, status: 'queued', result: null };
      jobs.set(job.id, { editorId, job });
      keys.set(key, { fingerprint, id: job.id });
      return { created: true, job: structuredClone(job) };
    },
    getJob({ editorId, jobId }) {
      const row = jobs.get(jobId);
      return row?.editorId === editorId ? structuredClone(row.job) : null;
    },
  };
}

function assertContract(path, method, status, value) {
  const key = `${path} ${method} ${status}`;
  if (!validators.has(key)) {
    const response = contract.paths[path][method].responses[status];
    assert.ok(response, `Undocumented response ${key}`);
    const resolved = response.$ref
      ? response.$ref.slice(2).split('/').reduce((part, segment) => part[segment], contract)
      : response;
    validators.set(key, ajv.compile({
      ...resolved.content['application/json'].schema,
      components: contract.components,
    }));
  }
  const validate = validators.get(key);
  assert.ok(validate(value), JSON.stringify(validate.errors));
}

async function setup(t, store = memoryStore(), options = {}) {
  const errors = [];
  const server = createApiServer({
    store,
    authenticate: tokenAuthenticator({ 'token-a': 'editor-a', 'token-b': 'editor-b' }),
    allowedSourceIds: ['telegram', 'website'],
    onError: (error) => errors.push(error),
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function call(path, {
    method = 'GET', token = 'token-a', key = 'key-1', value, raw, headers = {},
  } = {}) {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        ...(method === 'POST' && { 'idempotency-key': key, 'content-type': 'application/json' }),
        ...headers,
      },
      body: raw ?? (value === undefined ? undefined : JSON.stringify(value)),
    });
    const result = await response.json();
    assert.match(response.headers.get('content-type'), /^application\/json/);
    return { status: response.status, value: result };
  }
  return { store, errors, url, call };
}

function assertError(response, status, code, field = null) {
  assert.equal(response.status, status);
  assert.equal(response.value.code, code);
  assert.equal(response.value.field, field);
  assert.equal(typeof response.value.message, 'string');
  assertContract('/jobs', 'post', status, response.value);
  assert.deepEqual(Object.keys(response.value).sort(), ['code', 'field', 'message']);
}

test('HTTP: создать Job, выполнить настоящее ядро, получить статус и результат по OpenAPI', async (t) => {
  const { call, store } = await setup(t);
  const created = await call('/jobs', { method: 'POST', value: body });
  assert.equal(created.status, 202);
  assert.equal(created.value.status, 'queued');
  assertContract('/jobs', 'post', 202, created.value);
  const { id } = created.value;
  const source = { id: 'telegram', type: 'telegram', url: 'https://t.me/example', allowed: true, enabled: true };
  const dispatcher = new Dispatcher(new Registry([telegramChannelTool(() => [{
    messageId: '1', date: '2026-11-20T12:00:00Z', publicUrl: 'https://t.me/example/1',
    attributes: { brand: 'Line', price: 1000 },
  }])]), { findSource: () => source });
  // Simulate the runner owned by the storage/execution PR, outside the HTTP handler.
  const job = new CollectionJob(id);
  job.enqueue();
  await dispatcher.run(job, {
    sourceIds: body.sourceIds,
    from: body.from + 'T00:00:00Z',
    to: body.to + 'T23:59:59.999Z',
  });
  store.jobs.get(id).job = job.snapshot();
  const status = await call(`/jobs/${id}`);
  assert.equal(status.value.status, 'completed');
  assertContract('/jobs/{jobId}', 'get', status.status, status.value);
  const result = await call(status.value.resultUrl);
  assert.equal(result.status, 200);
  assert.equal(result.value.items[0].brand, 'Line');
  assert.deepEqual(result.value.failures, []);
  assertContract('/jobs/{jobId}/results', 'get', result.status, result.value);
});

test('HTTP: повтор ключа и семантически того же тела возвращает прежний Job', async (t) => {
  const { call, store } = await setup(t);
  const original = { ...body, sourceIds: ['telegram', 'website'] };
  const first = await call('/jobs', { method: 'POST', value: original });
  const second = await call('/jobs', {
    method: 'POST', value: { sourceIds: ['website', 'telegram'], to: body.to, from: body.from },
  });
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.deepEqual(second.value, first.value);
  assert.equal(store.jobs.size, 1);
  assertContract('/jobs', 'post', 200, second.value);
});

test('HTTP: тот же ключ с другим телом даёт 409', async (t) => {
  const { call, store } = await setup(t);
  await call('/jobs', { method: 'POST', value: body });
  assertError(await call('/jobs', {
    method: 'POST', value: { ...body, to: '2026-11-29' },
  }), 409, 'idempotency_conflict');
  assert.equal(store.jobs.size, 1);
});

test('HTTP: ключи двух редакторов изолированы, чужой и неизвестный Job дают одинаковый 404', async (t) => {
  const { call, store } = await setup(t);
  const first = await call('/jobs', { method: 'POST', value: body });
  const foreign = await call(`/jobs/${first.value.id}`, { token: 'token-b' });
  const missing = await call('/jobs/missing', { token: 'token-b' });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign, missing);
  assertContract('/jobs/{jobId}', 'get', 404, foreign.value);
  const result = await call(`/jobs/${first.value.id}/results`, { token: 'token-b' });
  assert.deepEqual(result, missing);
  const second = await call('/jobs', { method: 'POST', token: 'token-b', value: body });
  assert.equal(second.status, 202);
  assert.notEqual(second.value.id, first.value.id);
  assert.equal(store.jobs.size, 2);
});

test('HTTP: результат queued Job недоступен, partial возвращает failures', async (t) => {
  const { call, store } = await setup(t);
  const created = await call('/jobs', { method: 'POST', value: body });
  const path = `/jobs/${created.value.id}/results`;
  const unavailable = await call(path);
  assertError(unavailable, 409, 'job_results_unavailable');
  const row = store.jobs.get(created.value.id);
  row.job.status = 'partial';
  row.job.result = { items: [], sourceFailures: [{ sourceId: 'website', code: 'source_timeout' }] };
  const result = await call(path);
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { items: [], failures: row.job.result.sourceFailures });
  assertContract('/jobs/{jobId}/results', 'get', 200, result.value);
});

test('HTTP: неизвестный токен и отсутствие авторизации дают 401 до обращения к store', async (t) => {
  const { call, store } = await setup(t);
  for (const token of [null, 'unknown-token']) {
    assertError(await call('/jobs', { method: 'POST', token, value: body }),
      401, 'authentication_required');
  }
  assert.equal(store.createCalls, 0);
});

test('HTTP: проверка дат, списка источников, лишних полей и ключа', async (t) => {
  const { call, store } = await setup(t);
  const cases = [
    [null, 'body'], [[], 'body'], [{}, 'from'],
    [{ ...body, from: '2026-02-30' }, 'from'],
    [{ ...body, from: '2026-1-01' }, 'from'],
    [{ ...body, to: '2026-10-01' }, 'to'],
    [{ ...body, sourceIds: [] }, 'sourceIds'],
    [{ ...body, sourceIds: ['telegram', 'telegram'] }, 'sourceIds'],
    [{ ...body, sourceIds: [''] }, 'sourceIds'],
    [{ ...body, sourceIds: Array.from({ length: 21 }, (_, i) => `s-${i}`) }, 'sourceIds'],
    [{ ...body, status: 'completed' }, 'status'],
  ];
  for (const [value, field] of cases) {
    assertError(await call('/jobs', { method: 'POST', value }), 422, 'validation_error', field);
  }
  assertError(await call('/jobs', { method: 'POST', value: body, key: '' }),
    422, 'validation_error', 'Idempotency-Key');
  assertError(await call('/jobs', { method: 'POST', value: body, key: 'x'.repeat(129) }),
    422, 'validation_error', 'Idempotency-Key');
  assert.equal(store.createCalls, 0);
});

test('HTTP: запрещённый источник не создаёт Job', async (t) => {
  const { call, store } = await setup(t);
  assertError(await call('/jobs', { method: 'POST', value: { ...body, sourceIds: ['private'] } }),
    403, 'collection_not_allowed', 'sourceIds');
  assert.equal(store.jobs.size, 0);
});

test('HTTP: JSON, тип содержимого и лимит тела имеют единый формат ошибок', async (t) => {
  const { call, store } = await setup(t);
  assertError(await call('/jobs', { method: 'POST', raw: '{' }), 400, 'invalid_json');
  assertError(await call('/jobs', {
    method: 'POST', value: body, headers: { 'content-type': 'text/plain' },
  }), 415, 'unsupported_media_type');
  assertError(await call('/jobs', { method: 'POST', raw: ' '.repeat(65537) }),
    413, 'payload_too_large');
  assert.equal(store.createCalls, 0);
});

test('HTTP: потоковое тело без Content-Length ограничено 64 КиБ', async (t) => {
  const { url, store } = await setup(t);
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(url + '/jobs', {
      method: 'POST',
      headers: { authorization: 'Bearer token-a', 'idempotency-key': 'stream',
        'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, (result) => {
      const chunks = [];
      result.on('data', (chunk) => chunks.push(chunk));
      result.on('end', () => resolve({
        status: result.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()),
      }));
    });
    request.on('error', reject);
    request.write(' '.repeat(32768));
    request.end(' '.repeat(32769));
  });
  assertError(response, 413, 'payload_too_large');
  assert.equal(store.createCalls, 0);
});

test('HTTP: неизвестный путь и неверный метод дают JSON 404 и 405', async (t) => {
  const { call } = await setup(t);
  const missing = await call('/not-an-operation');
  assert.equal(missing.status, 404);
  assert.equal(missing.value.code, 'unknown_operation');
  const wrongMethod = await call('/jobs');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.value.code, 'unknown_operation');
  assertContract('/jobs', 'post', 405, wrongMethod.value);
});

test('HTTP: ошибки ядра получают безопасные коды, статусы и поля', async (t) => {
  const store = memoryStore();
  const { call } = await setup(t, store);
  for (const [code, status, field] of [
    ['invalid_state_transition', 409, null],
    ['unknown_operation', 422, 'operation'],
    ['invalid_tool_request', 422, 'from'],
  ]) {
    store.createJob = () => { throw Object.assign(new Error('/private/query.sql'), { code, field }); };
    const result = await call('/jobs', { method: 'POST', value: body });
    assertError(result, status, code, field);
    assert.ok(!JSON.stringify(result).includes('query.sql'));
  }
});

test('HTTP: неизвестная ошибка SQLite не раскрывает SQL, путь и трассу', async (t) => {
  const secret = new Error('SQLITE_ERROR SELECT token FROM secrets /private/database.sqlite');
  const store = memoryStore();
  store.createJob = async () => { throw secret; };
  const { call, errors } = await setup(t, store);
  const result = await call('/jobs', { method: 'POST', value: body });
  assertError(result, 500, 'internal_error');
  assert.deepEqual(errors, [secret]);
  assert.doesNotMatch(JSON.stringify(result.value), /SQLITE|SELECT|private|stack/);
});

test('OpenAPI: схема создания принимает обычный запрос и отклоняет лишний статус и невозможную дату', () => {
  const requestSchema = contract.paths['/jobs'].post.requestBody.content['application/json'].schema;
  const validate = ajv.compile(requestSchema);
  assert.ok(validate(body), JSON.stringify(validate.errors));
  assert.equal(validate({ ...body, status: 'completed' }), false);
  assert.equal(validate({ ...body, from: '2026-02-30' }), false);
});

test('HTTP: повторяющийся Idempotency-Key отклоняется до создания Job', async (t) => {
  const { url, store } = await setup(t);
  for (const keys of [['same', 'same'], ['first', 'second']]) {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(url + '/jobs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token-a',
          'content-type': 'application/json',
          'idempotency-key': keys,
        },
      }, (result) => {
        const chunks = [];
        result.on('data', (chunk) => chunks.push(chunk));
        result.on('error', reject);
        result.on('end', () => resolve({
          status: result.statusCode,
          value: JSON.parse(Buffer.concat(chunks).toString()),
        }));
      });
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
    assertError(response, 422, 'validation_error', 'Idempotency-Key');
  }
  assert.equal(store.createCalls, 0);
  assert.equal(store.jobs.size, 0);
});

test('Ошибка запуска на занятом порту закрывает store до возврата ошибки', async (t) => {
  const { url } = await setup(t);
  const store = memoryStore();
  let closes = 0;
  let closed = false;
  store.close = async () => {
    closes++;
    await new Promise((resolve) => setImmediate(resolve));
    closed = true;
  };
  await assert.rejects(startServer({
    store, tokens: { 'test-token': 'editor-a' }, allowedSourceIds: ['telegram'],
    port: Number(new URL(url).port),
  }), { code: 'EADDRINUSE' });
  assert.equal(closes, 1);
  assert.equal(closed, true);
});

test('Ошибка конфигурации HTTP также закрывает уже созданный store', async () => {
  const store = memoryStore();
  let closes = 0;
  store.close = async () => { closes++; };
  await assert.rejects(startServer({
    store, tokens: {}, allowedSourceIds: ['telegram'], port: 0,
  }), TypeError);
  assert.equal(closes, 1);
});

test('Запуск HTTP с готовым store и конфигурацией редакторов', async (t) => {
  const server = await startServer({
    store: memoryStore(), tokens: { 'local-test-token': 'editor-a' },
    allowedSourceIds: ['telegram'], port: 0,
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/jobs`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-test-token', 'idempotency-key': 'startup',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'queued');
});
