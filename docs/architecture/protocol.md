# Протокол обмена

## Версия и транспорт

Chrome Assistent использует JSON-сообщения поверх WebSocket.

- **transport:** `ws://127.0.0.1:17345`
- **protocol version:** `1`

Каждое сообщение передаётся в формате envelope:

```json
{
  "version": 1,
  "type": "client.listTargets",
  "requestId": "optional-string",
  "payload": {}
}
```

## Поддерживаемые типы сообщений

В `src/shared/protocol.ts` зарегистрированы такие типы:

| Тип | Направление | Назначение |
|---|---|---|
| `client.hello` | browser → broker | Аутентифицировать браузерный socket по browser token |
| `client.listTargets` | browser → broker | Получить список активных Pi-целей |
| `client.sendSelection` | browser → broker | Отправить выделение в выбранную цель |
| `client.subscribeTarget` | browser → broker | Подписаться на chat-события выбранной Pi-цели |
| `client.unsubscribeTarget` | browser → broker | Отписаться от chat-событий выбранной Pi-цели |
| `client.sendChatMessage` | browser → broker | Отправить текстовое сообщение чата в выбранную Pi-цель |
| `client.targets` | broker → browser | Вернуть список целей |
| `client.sendResult` | broker → browser | Вернуть результат доставки |
| `client.chatAccepted` | broker → browser | Подтвердить приём chat-сообщения broker |
| `client.chatEvent` | broker → browser | Передать chat-событие подписанному браузеру |
| `client.error` | broker → browser | Вернуть структурированную ошибку |
| `target.register` | Pi → broker | Зарегистрировать Pi-сессию как цель |
| `target.registered` | broker → Pi | Подтвердить регистрацию |
| `target.heartbeat` | Pi → broker | Обновить liveness цели |
| `target.unregister` | Pi → broker | Явно снять цель с регистрации |
| `target.deliverSelection` | broker → Pi | Передать браузерное выделение конкретной цели |
| `target.sendSelectionResult` | Pi → broker | Вернуть итог обработки доставки |
| `target.deliverChatMessage` | broker → Pi | Передать текстовое chat-сообщение конкретной Pi-цели |
| `target.chatEvent` | Pi → broker | Передать событие жизненного цикла ответа ассистента |

## Handshake браузерного клиента

### Получение списка целей

Корректная последовательность:

1. Открыть WebSocket.
2. Отправить `client.hello` с payload:

```json
{
  "token": "<browserToken>"
}
```

3. Дождаться отсутствия ошибки аутентификации.
4. Отправить `client.listTargets`.
5. Получить `client.targets` с массивом `targets`.

Если browser token неизвестен Pi, broker возвращает `client.error` с ошибкой авторизации.

### Отправка выделения

Background тоже начинает с `client.hello`, а затем отправляет `client.sendSelection` с payload вида:

```json
{
  "token": "<browserToken>",
  "targetId": "<uuid>",
  "selection": {
    "url": "https://example.com",
    "title": "Page title",
    "selectedText": "...",
    "selectedHtml": "<div>...</div>",
    "selector": "main article pre:nth-of-type(1)",
    "comment": "необязательный комментарий",
    "capturedAt": 1710000000000
  }
}
```

Ответ приходит в `client.sendResult`:

```json
{
  "ok": true
}
```

или

```json
{
  "ok": false,
  "error": "Target is not available"
}
```

### Подписка на чат и отправка сообщения

Side panel использует долгоживущее WebSocket-соединение. После `client.hello` браузер подписывается на выбранную цель:

```json
{
  "token": "<browserToken>",
  "targetId": "<uuid>"
}
```

Payload используется в `client.subscribeTarget` и `client.unsubscribeTarget`. Для отправки текста side panel вызывает `client.sendChatMessage`:

```json
{
  "token": "<browserToken>",
  "targetId": "<uuid>",
  "message": "Привет, ответь одним предложением"
}
```

Broker подтверждает приём через `client.chatAccepted`, доставляет Pi-цели `target.deliverChatMessage`, а затем пересылает подписанным браузерам `client.chatEvent`. В первой версии side panel отображает только plain text и не показывает tool calls/tool results.

Chat event payload имеет один из видов:

```json
{ "kind": "user_message", "text": "...", "timestamp": 1710000000000 }
{ "kind": "agent_busy", "busy": true, "label": "Агент работает в фоне…", "timestamp": 1710000000000 }
{ "kind": "assistant_message_start", "messageId": "msg-1", "timestamp": 1710000000000 }
{ "kind": "assistant_text_delta", "messageId": "msg-1", "delta": "...", "timestamp": 1710000000000 }
{ "kind": "assistant_message_end", "messageId": "msg-1", "timestamp": 1710000000000 }
{ "kind": "error", "message": "...", "timestamp": 1710000000000 }
```

## Handshake Pi-цели

Pi-сессия работает как `target` и должна:

1. Открыть WebSocket.
2. Отправить `target.register`:

```json
{
  "token": "<targetToken>",
  "target": {
    "targetId": "<uuid>",
    "cwd": "/path/to/project",
    "pid": 12345,
    "connectedAt": 1710000000000,
    "lastSeenAt": 1710000000000
  }
}
```

3. Дождаться `target.registered` с тем же `requestId`.
4. Каждые `5_000 ms` отправлять `target.heartbeat`.
5. При получении `target.deliverSelection` обработать payload и ответить `target.sendSelectionResult`.
6. При получении `target.deliverChatMessage` отправить текст в Pi и публиковать события ответа через `target.chatEvent`.
7. По штатному завершению отправить `target.unregister`.

## Ответственность клиентов

### Браузер

Браузерный клиент обязан:

- знать корректный browser token;
- отправлять `client.hello` перед `client.listTargets`;
- передавать валидный `targetId` при отправке;
- подписываться только на выбранную Pi-цель;
- показывать индикатор **«Агент работает в фоне…»** сразу после отправки chat-сообщения и скрывать его после `assistant_message_end`, `agent_busy(false)` или `error`;
- обрабатывать `client.error` и таймауты.

### Pi-цель

Pi-цель обязана:

- зарегистрироваться с валидным target token;
- поддерживать heartbeat;
- возвращать `target.sendSelectionResult` на каждый `target.deliverSelection`.

## Валидация chat payload

`client.subscribeTarget` и `client.unsubscribeTarget` требуют непустые строковые `token` и `targetId`.

`client.sendChatMessage` требует непустые строковые `token`, `targetId` и `message`. Сообщение из одних пробелов отклоняется.

`client.chatEvent` и `target.chatEvent` требуют конечный числовой `timestamp` и известный `kind`. Для событий ассистента обязательны `messageId`, для `assistant_text_delta` — строковый `delta`, для `error` — непустой текст ошибки.

## Валидация payload выделения

Поле `selection` считается валидным, только если:

- `url` — непустая строка;
- `title` — строка;
- `selectedText` — строка;
- `selectedHtml` — строка;
- `selector` — строка или отсутствует;
- `comment` — строка или отсутствует;
- `capturedAt` — конечное число;
- хотя бы одно из `selectedText` или `selectedHtml` непустое.

## Наблюдаемые особенности

- `requestId` используется для сопоставления ответов и pending deliveries.
- Browser token участвует и в `client.hello`, и в payload `client.sendSelection`.
- Target token используется только для Pi-регистрации и не предназначен для браузера.
- Если цель не отвечает в течение `30_000 ms`, результатом будет `Delivery timed out`.

## Связанные документы

- [Broker](./broker.md)
- [Pi-расширение](./pi-extension.md)
- [Chrome-расширение](./chrome-extension.md)
