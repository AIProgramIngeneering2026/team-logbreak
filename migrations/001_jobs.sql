CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  editor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT
) STRICT;

CREATE INDEX jobs_status ON jobs(status);

CREATE TABLE job_idempotency_keys (
  editor_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (editor_id, key)
) STRICT;

CREATE INDEX job_idempotency_expiry ON job_idempotency_keys(expires_at);
