import { createServer } from 'node:http';

const MAX_BODY_BYTES = 64 * 1024;
const statuses = new Set([
  'created', 'queued', 'collecting', 'processing',
  'completed', 'partial', 'failed', 'cancelled',
]);
const resultStatuses = new Set(['completed', 'partial']);
const domainErrors = {
  idempotency_conflict: [409, 'Ключ уже использован с другими параметрами', null],
  invalid_state_transition: [409, 'Недопустимый переход состояния задания', null],
  unknown_operation: [422, 'Неизвестная операция', 'operation'],
  invalid_tool_request: [422, 'Некорректные параметры задания', null],
  collection_not_allowed: [403, 'Сбор из источника запрещён', 'sourceIds'],
  unsupported_source: [422, 'Тип источника не поддерживается', 'sourceIds'],
  private_source_not_allowed: [422, 'Закрытые источники запрещены', 'sourceIds'],
};

class ApiError extends Error {
  constructor(status, code, message, field = null) {
    super(message);
    Object.assign(this, { status, code, field });
  }
}

function invalid(field, message) {
  return new ApiError(422, 'validation_error', message, field);
}

export function tokenAuthenticator(tokens) {
  const editors = new Map(Object.entries(tokens));
  if (!editors.size || [...editors].some(([token, editor]) =>
    !token || typeof editor !== 'string' || !editor.trim())) {
    throw new TypeError('Configure at least one token and editor ID');
  }
  return (token) => editors.get(token) ?? null;
}

function authenticateEditor(request, authenticate) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
  return match ? authenticate(match[1]) : null;
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function validateCreation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('body', 'Ожидается JSON-объект');
  }
  const fields = ['from', 'to', 'sourceIds'];
  for (const field of Object.keys(body)) {
    if (!fields.includes(field)) throw invalid(field, 'Неизвестное поле запроса');
  }
  if (!isDate(body.from)) throw invalid('from', 'Ожидается существующая дата YYYY-MM-DD');
  if (!isDate(body.to) || body.to < body.from) {
    throw invalid('to', 'Дата должна существовать и быть не раньше from');
  }
  if (!Array.isArray(body.sourceIds) || body.sourceIds.length < 1 || body.sourceIds.length > 20
    || body.sourceIds.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(body.sourceIds).size !== body.sourceIds.length) {
    throw invalid('sourceIds', 'Нужны от 1 до 20 различных непустых идентификаторов источников');
  }
  return body;
}

async function readBody(request) {
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    throw new ApiError(413, 'payload_too_large', 'Тело запроса превышает 64 КиБ');
  }
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAbort);
    };
    const onData = (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        cleanup();
        request.resume();
        reject(new ApiError(413, 'payload_too_large', 'Тело запроса превышает 64 КиБ'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = () => {
      cleanup();
      reject(new ApiError(400, 'invalid_json', 'Не удалось прочитать тело запроса'));
    };
    const onAbort = onError;
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAbort);
  });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new ApiError(415, 'unsupported_media_type', 'Ожидается Content-Type application/json');
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Синтаксически некорректный JSON');
  }
}

function jobView(job) {
  if (typeof job?.id !== 'string' || !statuses.has(job.status)) {
    throw new Error('Store returned an invalid job');
  }
  return {
    id: job.id,
    status: job.status,
    failureCode: job.result?.code ?? null,
    resultUrl: resultStatuses.has(job.status)
      ? `/jobs/${encodeURIComponent(job.id)}/results` : null,
    failures: job.result?.sourceFailures ?? [],
  };
}

function send(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  response.end(data);
}

/**
 * Store methods may be synchronous or asynchronous.
 * The store owns atomic creation, idempotency and queueing.
 */
export function createApiServer({ store, authenticate, allowedSourceIds, onError = console.error }) {
  if (typeof store?.createJob !== 'function' || typeof store?.getJob !== 'function'
    || typeof authenticate !== 'function' || !allowedSourceIds) {
    throw new TypeError('Expected store, authenticate and allowedSourceIds');
  }
  const allowed = new Set(allowedSourceIds);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const jobRoute = /^\/jobs\/([^/]+)(\/results)?$/.exec(path);
      const isCreation = path === '/jobs';
      if (!isCreation && !jobRoute) {
        throw new ApiError(404, 'unknown_operation', 'Операция не найдена');
      }
      const method = isCreation ? 'POST' : 'GET';
      if (request.method !== method) {
        response.setHeader('allow', method);
        throw new ApiError(405, 'unknown_operation', 'Метод не поддерживается');
      }
      const editorId = await authenticateEditor(request, authenticate);
      if (typeof editorId !== 'string' || !editorId.trim()) {
        response.setHeader('www-authenticate', 'Bearer');
        throw new ApiError(401, 'authentication_required', 'Требуется токен редактора');
      }
      if (isCreation) {
        const idempotencyKey = request.headers['idempotency-key'];
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()
          || idempotencyKey.length > 128) {
          throw invalid('Idempotency-Key', 'Нужен ключ длиной от 1 до 128 символов');
        }
        const { from, to, sourceIds } = validateCreation(await readBody(request));
        if (sourceIds.some((id) => !allowed.has(id))) {
          throw new ApiError(403, 'collection_not_allowed', 'Сбор из источника запрещён', 'sourceIds');
        }
        const outcome = await store.createJob({ editorId, idempotencyKey, from, to, sourceIds });
        if (typeof outcome?.created !== 'boolean') throw new Error('Invalid creation outcome');
        send(response, outcome.created ? 202 : 200, jobView(outcome.job));
        return;
      }
      let jobId;
      try {
        jobId = decodeURIComponent(jobRoute[1]);
      } catch {
        throw new ApiError(404, 'job_not_found', 'Задание не найдено');
      }
      const job = await store.getJob({ editorId, jobId });
      if (!job) throw new ApiError(404, 'job_not_found', 'Задание не найдено');
      if (!jobRoute[2]) {
        send(response, 200, jobView(job));
        return;
      }
      if (!resultStatuses.has(job.status)) {
        throw new ApiError(409, 'job_results_unavailable', 'Результат задания пока недоступен');
      }
      if (!Array.isArray(job.result?.items) || !Array.isArray(job.result?.sourceFailures)) {
        throw new Error('Store returned an invalid result');
      }
      send(response, 200, { items: job.result.items, failures: job.result.sourceFailures });
    } catch (error) {
      let failure = error;
      if (!(failure instanceof ApiError)) {
        const known = domainErrors[error?.code];
        if (known) {
          const [status, message, field] = known;
          // Only documented field names may cross the HTTP boundary.
          const safeField = ['from', 'to', 'sourceIds', 'pageSize', 'operation', 'cursor']
            .includes(error.field) ? error.field : field;
          failure = new ApiError(status, error.code, message, safeField);
        } else {
          try { onError(error); } catch { /* Logging must not prevent an HTTP response. */ }
          failure = new ApiError(500, 'internal_error', 'Внутренняя ошибка сервиса');
        }
      }
      if (!request.complete) request.resume();
      send(response, failure.status, {
        code: failure.code, message: failure.message, field: failure.field,
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
