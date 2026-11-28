# Интерфейс хранилища Job для HTTP API

Ветка SQLite — `feature/5-sqlite-job-store`. HTTP-обработчики получают объект
хранилища как зависимость. Методы возвращают значения синхронно. В тестах
можно передать объект с теми же методами.

```js
store.createJob({ editorId, idempotencyKey, from, to, sourceIds })
// → { created: boolean, job: { id, status, result } }

store.getJob({ editorId, jobId })
// → { id, status, result } | null
```

- `editorId` — идентификатор, полученный после проверки токена. HTTP-слой
  проверяет заголовок, даты `YYYY-MM-DD`, порядок дат и список источников.
- `created: true` — новый Job сохранён в состоянии `queued`, HTTP 202.
  `created: false` — за последние 24 часа был такой же запрос, HTTP 200
  с текущим состоянием того же Job. Порядок `sourceIds` и полей тела
  значения не имеет. Ключи изолированы по редактору.
- Другие параметры с тем же действующим ключом вызывают ошибку с
  `error.code === 'idempotency_conflict'`, HTTP 409.
- `getJob` возвращает `null` для отсутствующего или чужого Job, HTTP 404.
  `result` до завершения равен `null`. Сохранённый результат использует
  формат ядра `{ items, sourceFailures, code? }`.
- Для `GET /jobs/{jobId}/results` HTTP-слой использует тот же `getJob`.
  Для `completed` и `partial` отдаёт `items` и `failures` из
  `sourceFailures`. Для других состояний возвращает
  `409 job_results_unavailable`.
- Непредвиденные ошибки хранилища преобразуются HTTP-слоем в общий ответ
  500. Детали SQLite остаются в журнале сервера.

Запись Job в очередь выполняется при создании. HTTP-обработчик не
запускает Dispatcher самостоятельно.

## Подключение SQLite

Точка входа для HTTP-сервера — `src/job-store-runtime.mjs`. Экспорт
`createStore({ databasePath })` применяет миграции, восстанавливает
прерванные Job и запускает одного фонового обработчика очереди.
`await store.close()` останавливает обработчик после текущего Job и закрывает
соединение. Источники для прототипа читаются из локальных снимков.

Для общего запуска задайте `JOB_STORE_MODULE=./src/job-store-runtime.mjs` и
`JOB_SOURCES_FILE` с путём к JSON-файлу снимков. `ALLOWED_SOURCE_IDS`
должен содержать идентификаторы из этого файла. Пример файла:

```json
[
  {
    "id": "website",
    "type": "website",
    "url": "https://example.com/",
    "entries": [
      {
        "canonicalUrl": "https://example.com/collection",
        "publishedAt": "2026-11-28T21:00:00Z",
        "attributes": { "brand": "Brand" }
      }
    ]
  }
]
```

Для `telegram` элементы `entries` содержат `messageId`, `date`,
`publicUrl` и `attributes`. Для тестов список источников можно передать
в `createStore` напрямую. Даты запроса охватывают полные календарные дни в
UTC. HTTP-слой отвечает за проверку токенов и доступность источников.
