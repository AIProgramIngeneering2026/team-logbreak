# Контракт Tool

## Назначение

`Tool` — единая граница между Dispatcher и конкретным источником данных. Dispatcher не знает протокол источника, формат его ответа, правила пагинации и повторов. Конкретный Tool не меняет состояние `CollectionJob` и не записывает `FashionItem` в хранилище: он только проверяет свой вход и возвращает нормализованные сырые публикации либо типизированный отказ.

## Интерфейс

Псевдокод ниже задаёт обязательный контракт реализаций независимо от языка:

```text
interface Tool {
  sourceType: "telegram" | "website"

  collect(request: CollectRequest, context: ToolContext)
    -> CollectPage | ToolError
}

CollectRequest {
  source: {
    id: string,
    type: "telegram" | "website",
    url: absolute URI
  },
  from: date-time,
  to: date-time,
  cursor: string | null,
  pageSize: integer 1..500
}

ToolContext {
  deadline: date-time,
  cancellationToken: CancellationToken,
  requestId: string
}

CollectPage {
  records: RawPublication[0..500],
  nextCursor: string | null,
  observedAt: date-time
}

RawPublication {
  externalId: string,
  publishedAt: date-time,
  originalUrl: absolute URI,
  text: string | null,
  attributes: object
}

ToolError {
  code: ToolErrorCode,
  retryable: boolean,
  retryAfterSeconds: integer | null,
  safeMessage: string
}
```

`ToolErrorCode` принимает одно из значений:

| Код | Когда возвращается | Повтор |
|---|---|---|
| `invalid_tool_request` | Тип источника не совпадает с Tool, период неверен, курсор повреждён или `pageSize` вне диапазона | нет |
| `collection_not_allowed` | Источник закрыл доступ или его правила запрещают автоматический сбор | нет |
| `source_timeout` | Источник не ответил до `deadline` | да, если deadline Job ещё не истёк |
| `source_rate_limited` | Источник вернул ограничение частоты | да, с учётом `retryAfterSeconds` |
| `invalid_source_response` | Ответ нельзя безопасно разобрать или обязательное поле исчезло | нет |
| `source_unavailable` | Временная сетевая ошибка или ответ 5xx | да |
| `cancelled` | Dispatcher отменил контекст | нет |

Технические исключения, тело ответа источника, токены и stack trace не пересекают границу Tool. Неожиданное исключение преобразуется в `source_unavailable`, журналируется с `requestId`, а пользователю возвращается только безопасный код из `SourceFailure`.

## Кто проверяет параметры

- HTTP API проверяет синтаксис, авторизацию, существование разрешённых `sourceIds`, размер тела, период и число источников до создания Job.
- Dispatcher формирует `CollectRequest`, задаёт общий deadline, отмену и ограничивает число повторов.
- Непосредственно перед первым вызовом Tool Dispatcher повторно читает состояние источника. Если источник удалён, отключён или больше не разрешён, сетевой вызов не выполняется, а источник завершается с `collection_not_allowed`.
- Каждый Tool повторно проверяет инварианты собственного входа и соответствие типа источника. Это защищает границу при вызове не через HTTP API.
- Tool проверяет структуру внешнего ответа. Нормализатор после Tool проверяет доменные поля Fashion Item и выполняет дедупликацию.

Dispatcher делает не более трёх попыток на страницу. Для `source_rate_limited` он ждёт `retryAfterSeconds`, но не дольше оставшегося deadline; для остальных повторяемых ошибок использует ограниченную экспоненциальную задержку. Исчерпание попыток превращается в `SourceFailure` с тем же безопасным кодом. Успех хотя бы одного источника приводит к `partial`, отказ всех источников — к `failed`.

Курсор непрозрачен для Dispatcher и действителен только для того же источника, периода и размера страницы. Tool обязан читать данные в стабильном окне `from..to`, сортировать их по `(publishedAt, externalId)` и не возвращать более 500 записей за вызов. Dispatcher запоминает курсоры в рамках одного запуска: повтор уже использованного курсора или непустой `nextCursor` без продвижения страницы считается `invalid_source_response`, поэтому ошибочный Tool не может зациклить Job. Повторы записей между страницами допустимы из-за изменений источника и удаляются нормализатором по `(source.id, externalId)`; отсутствие `externalId` считается `invalid_source_response`.

После сигнала отмены Tool прекращает новые сетевые запросы и возвращает `cancelled`. Dispatcher игнорирует запоздавший результат; Tool не публикует данные самостоятельно.

## TelegramChannelTool

**Получает:** `CollectRequest` для разрешённого публичного Telegram-канала и контекст выполнения.

**Возвращает:** страницу публичных сообщений; `externalId` — стабильный идентификатор сообщения, `originalUrl` — публичная ссылка, `text` и доступные атрибуты вложения передаются без скачивания закрытого содержимого.

**Отказывает:** `collection_not_allowed` для закрытого или ставшего недоступным канала; `source_rate_limited` при ограничении Telegram; `source_timeout`, `source_unavailable` и `invalid_source_response` по общей таблице.

**Скрывает:** протокол Telegram, его схему ответа, служебные токены, пагинацию и преобразование сообщения в `RawPublication`.

## WebsiteTool

**Получает:** `CollectRequest` для разрешённого сайта бренда и контекст выполнения.

**Возвращает:** страницу открытых карточек и новостей; `externalId` берётся из стабильного ID страницы либо из канонического URL, `originalUrl` указывает на исходную страницу.

**Отказывает:** `collection_not_allowed`, если правила доступа или `robots.txt` запрещают сбор; `invalid_source_response`, если разметка изменилась и обязательные поля нельзя извлечь безопасно; остальные отказы — по общей таблице.

**Скрывает:** HTTP-клиент, правила конкретного сайта, селекторы, лимиты частоты, пагинацию и преобразование страницы в `RawPublication`.

