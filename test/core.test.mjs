import assert from 'node:assert/strict';
import test from 'node:test';
import { CollectionJob, recoverInterruptedJobs } from '../src/job.mjs';
import { Registry } from '../src/registry.mjs';
import { Dispatcher } from '../src/dispatcher.mjs';
import { telegramChannelTool } from '../src/telegram-tool.mjs';
import { websiteTool } from '../src/website-tool.mjs';
import { toolError } from '../src/tool.mjs';

const from = '2026-11-01T00:00:00Z';
const to = '2026-11-30T23:59:59Z';
const publishedAt = '2026-11-20T12:00:00Z';
const telegram = { id: 'telegram', type: 'telegram', url: 'https://t.me/example', enabled: true, allowed: true };
const website = { id: 'website', type: 'website', url: 'https://example.org', enabled: true, allowed: true };
const page = { records: [], nextCursor: null, observedAt: publishedAt };
const request = { sourceIds: ['telegram'], from, to };
const transitionError = { code: 'invalid_state_transition' };

function setup(tools, sources = [telegram, website]) {
  const registry = new Registry(tools);
  const dispatcher = new Dispatcher(registry, {
    findSource: (id) => sources.find((source) => source.id === id),
    onUnexpectedError() {},
  });
  const job = new CollectionJob('job-1');
  assert.equal(job.status, 'created');
  job.enqueue();
  return { registry, dispatcher, job };
}

test('оба Tool выполняют обычный путь Job и сохраняют происхождение карточек', async () => {
  const msg = { messageId: '1', date: publishedAt, publicUrl: 'https://t.me/example/1', attributes: { brand: '  Line  ' } };
  const { dispatcher, job } = setup([
    telegramChannelTool(() => [msg, msg, { ...msg, messageId: '2' }]),
    websiteTool(() => [{ canonicalUrl: 'https://example.org/item', publishedAt, attributes: { brand: 'Studio', price: 1_500 } }]),
  ]);
  await dispatcher.run(job, { ...request, sourceIds: ['telegram', 'website'], pageSize: 1 });
  assert.equal(job.status, 'completed');
  const { items, sourceFailures } = job.result;
  assert.deepEqual(sourceFailures, []);
  assert.deepEqual(items.map(({ brand }) => brand), ['Line', 'Line', 'Studio']);
  assert.deepEqual(items[2].originUrls, ['https://example.org/item']);
});

test('З1 — повторный Dispatcher не запускает второй Tool у того же Job', async () => {
  let calls = 0;
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const { dispatcher, job } = setup([{ sourceType: 'telegram', collect() {
    calls++;
    started.resolve();
    return pending.promise;
  } }]);
  const running = dispatcher.run(job, request);
  await started.promise;
  await assert.rejects(dispatcher.run(job, request), transitionError);
  assert.equal(calls, 1);
  pending.resolve(page);
  await running;
  assert.equal(job.status, 'completed');
});

test('З2 — восстановление завершает прерванные задания в обоих рабочих состояниях', () => {
  const collecting = new CollectionJob('collecting');
  const processing = new CollectionJob('processing');
  const queued = new CollectionJob('queued');
  for (const job of [collecting, processing, queued]) job.enqueue();
  collecting.start();
  processing.start();
  processing.process();
  const completed = new CollectionJob('completed');
  completed.enqueue();
  completed.start();
  completed.process();
  completed.finish({ items: [], sourceFailures: [] });
  const restored = [collecting, processing, queued, completed]
    .map((job) => CollectionJob.restore(JSON.parse(JSON.stringify(job.snapshot()))));
  recoverInterruptedJobs(restored);
  for (const job of restored.slice(0, 2)) {
    assert.equal(job.status, 'failed');
    assert.equal(job.result.code, 'job_interrupted');
  }
  assert.equal(restored[2].status, 'queued');
  assert.equal(restored[3].status, 'completed');
});

test('З3 — отмена во время Tool блокирует запоздалый результат и следующий Tool', async () => {
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  let calls = 0;
  const { dispatcher, job } = setup([
    { sourceType: 'telegram', collect() {
      started.resolve();
      return pending.promise;
    } },
    { sourceType: 'website', collect() { calls++; return page; } },
  ]);
  const running = dispatcher.run(job, { ...request, sourceIds: ['telegram', 'website'] });
  await started.promise;
  job.cancel();
  await running;
  pending.resolve(page);
  assert.throws(() => job.finish({ items: [] }), transitionError);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.result, null);
  assert.equal(calls, 0);
});

test('З4 — после ошибки Job не публикует успешный результат', () => {
  const { job } = setup([]);
  job.start();
  job.fail({ code: 'source_unavailable' });
  assert.throws(() => job.finish({ items: [] }), transitionError);
  assert.equal(job.status, 'failed');
  assert.equal(job.result.code, 'source_unavailable');
});

test('З5 — нельзя завершить Job без сбора и обработки', () => {
  const { job } = setup([]);
  assert.throws(() => job.finish({ items: [] }), transitionError);
  assert.throws(() => job.process(), transitionError);
  assert.equal(job.status, 'queued');
  assert.equal(job.result, null);
});

test('З6 — завершённый Job не запускается повторно', async () => {
  let calls = 0;
  const { dispatcher, job } = setup([{ sourceType: 'telegram', collect() { calls++; return page; } }]);
  await dispatcher.run(job, request);
  await assert.rejects(dispatcher.run(job, request), transitionError);
  assert.equal(job.status, 'completed');
  assert.equal(calls, 1);
});

test('неизвестная операция возвращает явную ошибку Registry и переводит Job в failed', async () => {
  const { registry, dispatcher, job } = setup([]);
  assert.throws(() => registry.get('telegram'), { code: 'unknown_operation' });
  await dispatcher.run(job, request);
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.result.sourceFailures, [
    { sourceId: 'telegram', code: 'unknown_operation', field: 'source.type' },
  ]);
});

test('каждый Tool проверяет параметры и возвращает имя поля', async () => {
  for (const [makeTool, source] of [[telegramChannelTool, telegram], [websiteTool, website]]) {
    const { dispatcher, job } = setup([makeTool(() => assert.fail('Источник не должен читаться'))]);
    await dispatcher.run(job, { ...request, sourceIds: [source.id], pageSize: 501 });
    assert.equal(job.status, 'failed');
    assert.deepEqual(job.result.sourceFailures, [
      { sourceId: source.id, code: 'invalid_tool_request', field: 'pageSize' },
    ]);
  }
});

test('падение Tool ограничено тремя попытками и приводит к failed с безопасным кодом', async () => {
  let calls = 0;
  const { dispatcher, job } = setup([{ sourceType: 'telegram', collect() {
    calls++;
    throw new Error('internal detail');
  } }]);
  await dispatcher.run(job, request);
  assert.equal(job.status, 'failed');
  assert.equal(calls, 3);
  assert.deepEqual(job.result.sourceFailures, [{ sourceId: 'telegram', code: 'source_unavailable' }]);
});

test('Dispatcher принимает новый Tool через Registry, частичный успех сохраняет отказ', async () => {
  const custom = { ...website, type: 'new-adapter' };
  const { dispatcher, job } = setup([
    { sourceType: 'new-adapter', collect: () => page },
    { sourceType: 'telegram', collect: () => toolError('collection_not_allowed') },
  ], [telegram, custom]);
  await dispatcher.run(job, { ...request, sourceIds: ['telegram', 'website'] });
  assert.equal(job.status, 'partial');
  assert.deepEqual(job.result.sourceFailures, [{ sourceId: 'telegram', code: 'collection_not_allowed' }]);
});

test('снятие разрешения блокирует вызов Tool', async () => {
  const { dispatcher, job } = setup([
    { sourceType: 'telegram', collect: () => assert.fail('Источник заблокирован') },
  ], [{ ...telegram, allowed: false }]);
  await dispatcher.run(job, request);
  assert.equal(job.status, 'failed');
  assert.equal(job.result.sourceFailures[0].code, 'collection_not_allowed');
});

test('общий deadline завершает зависший Tool и запрещает запуск следующего', async () => {
  let calls = 0;
  const { dispatcher, job } = setup([
    { sourceType: 'telegram', collect: () => new Promise(() => {}) },
    { sourceType: 'website', collect() { calls++; return page; } },
  ]);
  await dispatcher.run(job, { ...request, sourceIds: ['telegram', 'website'], timeoutMs: 20 });
  assert.equal(job.status, 'failed');
  assert.equal(calls, 0);
  assert.deepEqual(job.result.sourceFailures.map(({ code }) => code), ['source_timeout', 'source_timeout']);
});

test('повтор курсора завершает источник ошибкой', async () => {
  const record = { externalId: 'x', publishedAt, originalUrl: telegram.url, text: null, attributes: {} };
  const { dispatcher, job } = setup([
    { sourceType: 'telegram', collect: () => ({ ...page, records: [record], nextCursor: 'same' }) },
  ]);
  await dispatcher.run(job, request);
  assert.equal(job.status, 'failed');
  assert.equal(job.result.sourceFailures[0].code, 'invalid_source_response');
});
