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

Создайте `new SqliteJobStore(filename)` из `src/sqlite-job-store.mjs`.
Конструктор применяет пронумерованные миграции. При запуске единственного
worker вызовите `store.recoverInterrupted()`, затем вызывайте
`await store.runNext(dispatcher)` для обработки очереди. Метод возвращает
снимок обработанного Job или `null`, если очередь пуста. Даты запроса
охватывают полные календарные дни в UTC. После остановки worker вызовите
`store.close()`.
