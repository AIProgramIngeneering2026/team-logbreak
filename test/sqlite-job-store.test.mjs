import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { Dispatcher } from '../src/dispatcher.mjs';
import { JobPersistenceError } from '../src/job.mjs';
import { createStore } from '../src/job-store-runtime.mjs';
import { SqliteJobStore } from '../src/sqlite-job-store.mjs';

const request = {
  editorId: 'editor-a',
  idempotencyKey: 'collect',
  from: '2026-11-28',
  to: '2026-11-28',
  sourceIds: ['website'],
};

function databasePath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'logbreak-db-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'jobs.sqlite');
}

function withDb(filename, inspect) {
  const db = new DatabaseSync(filename);
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

function dispatcher(onCollect = () => {}) {
  const publishedAt = '2026-11-28T21:00:00.000Z';
  const tool = {
    collect({ from, to }) {
      onCollect();
      assert.equal(from, '2026-11-28T00:00:00.000Z');
      assert.equal(to, '2026-11-28T23:59:59.999Z');
      return {
        records: [{
          externalId: 'publication',
          publishedAt,
          originalUrl: 'https://example.com/publication',
          text: null,
          attributes: { brand: 'Brand' },
        }],
        observedAt: publishedAt,
        nextCursor: null,
      };
    },
  };
  return new Dispatcher({ get: () => tool }, {
    findSource: (id) => ({ id, type: 'website', enabled: true, allowed: true }),
  });
}

test('migrates an empty database and preserves the result and key after reopening', async (t) => {
  const filename = databasePath(t);
  let store = new SqliteJobStore(filename);
  let completed;
  try {
    const { created, job } = store.createJob(request);
    assert.equal(created, true);
    assert.equal(job.status, 'queued');
    assert.equal(job.result, null);
    assert.equal(store.getJob({ editorId: 'another-editor', jobId: job.id }), null);

    completed = await store.runNext(dispatcher());
    assert.equal(completed.id, job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result.items[0].brand, 'Brand');
    assert.equal(await store.runNext(dispatcher()), null);
  } finally {
    store.close();
  }

  store = new SqliteJobStore(filename);
  try {
    assert.deepEqual(store.createJob(request), { created: false, job: completed });
    assert.deepEqual(store.getJob({ editorId: request.editorId, jobId: completed.id }), completed);
    assert.equal(await store.runNext(dispatcher()), null);
  } finally {
    store.close();
  }
  withDb(filename, (db) => {
    assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM jobs').get().count, 1);
  });
});

test('scopes the key by editor, compares canonical parameters and permits reuse after 24 hours', () => {
  let now = 0;
  const store = new SqliteJobStore(':memory:', { now: () => now });
  try {
    const initial = { ...request, sourceIds: ['website', 'telegram'] };
    const { job } = store.createJob(initial);
    assert.deepEqual(store.createJob({ ...initial, sourceIds: ['telegram', 'website'] }), {
      created: false, job,
    });
    assert.throws(() => store.createJob(request), { code: 'idempotency_conflict' });
    assert.equal(store.createJob({ ...request, editorId: 'another-editor' }).created, true);
    now = 24 * 60 * 60 * 1_000;
    assert.equal(store.createJob(request).created, true);
    assert.deepEqual(store.getJob({ editorId: request.editorId, jobId: job.id }), job);
  } finally {
    store.close();
  }
});

test('rolls back Job creation when saving its key fails', (t) => {
  const filename = databasePath(t);
  const store = new SqliteJobStore(filename);
  try {
    withDb(filename, (db) => db.exec(`
      CREATE TRIGGER reject_key BEFORE INSERT ON job_idempotency_keys
      BEGIN SELECT RAISE(ABORT, 'cannot save key'); END
    `));
    assert.throws(() => store.createJob(request), /cannot save key/);
    withDb(filename, (db) => {
      assert.equal(db.prepare('SELECT count(*) AS count FROM jobs').get().count, 0);
      db.exec('DROP TRIGGER reject_key');
    });
    assert.equal(store.createJob(request).created, true);
  } finally {
    store.close();
  }
});

test('rolls back a failed result write and recovers interrupted work on restart', async (t) => {
  const filename = databasePath(t);
  let store = new SqliteJobStore(filename);
  let jobId;
  try {
    jobId = store.createJob(request).job.id;
    withDb(filename, (db) => db.exec(`
      CREATE TRIGGER reject_completion BEFORE UPDATE ON jobs WHEN NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'cannot save result'); END
    `));
    await assert.rejects(store.runNext(dispatcher()), JobPersistenceError);
    assert.deepEqual(store.getJob({ editorId: request.editorId, jobId }), {
      id: jobId, status: 'processing', result: null,
    });
  } finally {
    store.close();
  }

  store = new SqliteJobStore(filename);
  try {
    store.recoverInterrupted();
    assert.deepEqual(store.getJob({ editorId: request.editorId, jobId }), {
      id: jobId, status: 'failed', result: { code: 'job_interrupted', items: [], sourceFailures: [] },
    });
    assert.equal(await store.runNext(dispatcher()), null);
  } finally {
    store.close();
  }
});


test('concurrent connections create one Job and the worker dispatches it once', async (t) => {
  const filename = databasePath(t);
  const store = new SqliteJobStore(filename);
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const storeUrl = new URL('../src/sqlite-job-store.mjs', import.meta.url).href;
  const program = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { SqliteJobStore } = await import(workerData.storeUrl);
      const db = new SqliteJobStore(workerData.filename);
      try {
        const gate = new Int32Array(workerData.gate);
        if (Atomics.add(gate, 0, 1) === 0) {
          if (Atomics.wait(gate, 0, 1, 5000) === 'timed-out') throw new Error('Connection barrier timed out');
        } else {
          Atomics.notify(gate, 0);
        }
        parentPort.postMessage(db.createJob(workerData.request));
      } finally {
        db.close();
      }
    })().catch((error) => { throw error; });
  `;
  const workers = [];
  try {
    const create = () => new Promise((resolve, reject) => {
      const worker = new Worker(program, {
        eval: true, workerData: { gate, filename, storeUrl, request },
      });
      workers.push(worker);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`SQLite test worker exited with code ${code}`));
      });
    });
    const results = await Promise.all([create(), create()]);
    assert.deepEqual(results.map(({ created }) => created).sort(), [false, true]);
    assert.equal(results[0].job.id, results[1].job.id);

    let calls = 0;
    const worker = dispatcher(() => calls++);
    assert.equal((await store.runNext(worker)).status, 'completed');
    assert.equal(await store.runNext(worker), null);
    assert.equal(calls, 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    store.close();
  }
});

test('runtime factory processes a queue persisted by an earlier process', async (t) => {
  const filename = databasePath(t);
  const initialStore = new SqliteJobStore(filename);
  const queued = initialStore.createJob(request).job;
  initialStore.close();
  const store = createStore({
    databasePath: filename,
    sources: [{
      id: 'website',
      type: 'website',
      url: 'https://example.com/',
      entries: [{
        publishedAt: '2026-11-28T21:00:00Z',
        canonicalUrl: 'https://example.com/publication',
        attributes: { brand: 'Brand' },
      }],
    }],
  });
  try {
    const lookup = { editorId: request.editorId, jobId: queued.id };
    const deadline = Date.now() + 5_000;
    while (store.getJob(lookup).status !== 'completed' && Date.now() < deadline) {
      await delay(10);
    }
    assert.equal(store.getJob(lookup).result?.items[0]?.brand, 'Brand');
  } finally {
    await store.close();
  }
});
