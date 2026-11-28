import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CollectionJob, recoverInterruptedJobs } from './job.mjs';

const migrationsDir = new URL('../migrations/', import.meta.url);
const keyLifetimeMs = 24 * 60 * 60 * 1_000;

function transaction(db, execute) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = execute();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate(db) {
  transaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY NOT NULL) STRICT');
    const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
    const record = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
    const migrations = readdirSync(migrationsDir).filter((name) => /^\d+.+\.sql$/.test(name)).sort();
    for (const name of migrations) {
      const version = name.split('_', 1)[0];
      if (applied.get(version)) continue;
      db.exec(readFileSync(new URL(name, migrationsDir), 'utf8'));
      record.run(version);
    }
  });
}

function snapshot(row) {
  return { id: row.id, status: row.status, result: JSON.parse(row.result_json) };
}

export class SqliteJobStore {
  #db;
  #now;
  #queries;

  constructor(filename, { now = Date.now } = {}) {
    this.#db = new DatabaseSync(filename);
    this.#now = now;
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
      migrate(this.#db);
      const prepare = (sql) => this.#db.prepare(sql);
      this.#queries = {
        getJob: prepare('SELECT id, status, result_json FROM jobs WHERE editor_id = ? AND id = ?'),
        getKey: prepare('SELECT request_hash, job_id FROM job_idempotency_keys WHERE editor_id = ? AND key = ?'),
        expireKeys: prepare('DELETE FROM job_idempotency_keys WHERE expires_at <= ?'),
        insertJob: prepare('INSERT INTO jobs (id, editor_id, status, request_json) VALUES (?, ?, ?, ?)'),
        insertKey: prepare(`INSERT INTO job_idempotency_keys
          (editor_id, key, request_hash, job_id, expires_at) VALUES (?, ?, ?, ?, ?)`),
        nextJob: prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1"),
        interruptedJobs: prepare("SELECT * FROM jobs WHERE status IN ('collecting', 'processing')"),
        saveTransition: prepare('UPDATE jobs SET status = ?, result_json = ? WHERE id = ? AND status = ?'),
      };
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close() {
    this.#db.close();
  }

  createJob({ editorId, idempotencyKey, from, to, sourceIds }) {
    const request = JSON.stringify({ from, to, sourceIds });
    const canonicalRequest = JSON.stringify({ from, to, sourceIds: [...sourceIds].sort() });
    const requestHash = createHash('sha256').update(canonicalRequest).digest('hex');
    return transaction(this.#db, () => {
      const now = this.#now();
      this.#queries.expireKeys.run(now);
      const key = this.#queries.getKey.get(editorId, idempotencyKey);
      if (key) {
        if (key.request_hash !== requestHash) {
          throw Object.assign(new Error('Idempotency key already used with different parameters'), {
            code: 'idempotency_conflict',
          });
        }
        return { created: false, job: this.getJob({ editorId, jobId: key.job_id }) };
      }

      const job = new CollectionJob(randomUUID());
      job.enqueue();
      this.#queries.insertJob.run(job.id, editorId, job.status, request);
      this.#queries.insertKey.run(editorId, idempotencyKey, requestHash, job.id, now + keyLifetimeMs);
      return { created: true, job: job.snapshot() };
    });
  }

  getJob({ editorId, jobId }) {
    const row = this.#queries.getJob.get(editorId, jobId);
    return row ? snapshot(row) : null;
  }

  recoverInterrupted() {
    recoverInterruptedJobs(this.#queries.interruptedJobs.all().map((row) => this.#restore(row)));
  }

  async runNext(dispatcher) {
    const row = this.#queries.nextJob.get();
    if (!row) return null;

    const job = this.#restore(row);
    const { from, to, sourceIds } = JSON.parse(row.request_json);
    await dispatcher.run(job, {
      from: `${from}T00:00:00.000Z`,
      to: `${to}T23:59:59.999Z`,
      sourceIds,
    });
    return job.snapshot();
  }

  #restore(row) {
    return CollectionJob.restore(snapshot(row), {
      saveTransition: ({ id, status, result }, previousStatus) => {
        // A single SQLite statement commits the status and result together.
        const saved = this.#queries.saveTransition.run(status, JSON.stringify(result), id, previousStatus);
        if (saved.changes !== 1) throw new Error('Stored Job status changed before transition');
      },
    });
  }
}
