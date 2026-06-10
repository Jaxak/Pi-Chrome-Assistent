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
| `client.targets` | broker → browser | Вернуть список целей |
| `client.sendResult` | broker → browser | Вернуть результат доставки |
| `client.error` | broker → browser | Вернуть структурированную ошибку |
| `target.register` | Pi → broker | Зарегистрировать Pi-сессию как цель |
| `target.registered` | broker → Pi | Подтвердить регистрацию |
| `target.heartbeat` | Pi → broker | Обновить liveness цели |
| `target.unregister` | Pi → broker | Явно снять цель с регистрации |
| `target.deliverSelection` | broker → Pi | Передать браузерное выделение конкретной цели |
| `target.sendSelectionResult` | Pi → broker | Вернуть итог обработки доставки |

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
6. По штатному завершению отправить `target.unregister`.

## Ответственность клиентов

### Браузер

Браузерный клиент обязан:

- знать корректный browser token;
- отправлять `client.hello` перед `client.listTargets`;
- передавать валидный `targetId` при отправке;
- обрабатывать `client.error` и таймауты.

### Pi-цель

Pi-цель обязана:

- зарегистрироваться с валидным target token;
- поддерживать heartbeat;
- возвращать `target.sendSelectionResult` на каждый `target.deliverSelection`.

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
