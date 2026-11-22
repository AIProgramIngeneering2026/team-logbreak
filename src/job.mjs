const transitions = new Map([
  ['created', ['queued']],
  ['queued', ['collecting', 'cancelled']],
  ['collecting', ['processing', 'failed', 'cancelled']],
  ['processing', ['completed', 'partial', 'failed', 'cancelled']],
]);

const terminalStates = new Set(['completed', 'partial', 'failed', 'cancelled']);

export class CollectionJob {
  #status = 'created';
  #result = null;
  #controller = new AbortController();

  constructor(id) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new TypeError('Job id must be a non-empty string');
    }
    Object.defineProperty(this, 'id', { value: id, enumerable: true });
  }

  static restore({ id, status, result }) {
    if (!transitions.has(status) && !terminalStates.has(status)) {
      throw new TypeError('Unknown Job status in snapshot');
    }
    const job = new CollectionJob(id);
    job.#status = status;
    job.#result = structuredClone(result);
    if (status === 'cancelled' || status === 'failed') job.#controller.abort();
    return job;
  }

  get status() { return this.#status; }
  get result() { return structuredClone(this.#result); }
  get signal() { return this.#controller.signal; }

  snapshot() { return { id: this.id, status: this.#status, result: this.result }; }

  enqueue() { this.#transition('queued'); }
  start() { this.#transition('collecting'); }
  process() { this.#transition('processing'); }

  finish(result) {
    this.#transition(result?.sourceFailures?.length ? 'partial' : 'completed', result);
  }

  fail(result) {
    this.#transition('failed', result);
    this.#controller.abort();
  }

  cancel() {
    this.#transition('cancelled');
    this.#controller.abort();
  }

  #transition(next, result = null) {
    if (!transitions.get(this.#status)?.includes(next)) {
      throw Object.assign(new Error(`Invalid Job transition: ${this.#status} → ${next}`), {
        code: 'invalid_state_transition',
        from: this.#status,
        to: next,
      });
    }
    // Commit the state and its result synchronously before any observer can cancel.
    this.#result = structuredClone(result);
    this.#status = next;
  }
}

export function recoverInterruptedJobs(jobs) {
  for (const job of jobs) {
    if (job.status === 'collecting' || job.status === 'processing') {
      job.fail({ code: 'job_interrupted', items: [], sourceFailures: [] });
    }
  }
}
