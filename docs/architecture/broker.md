# Локальный broker

## Назначение

Broker — это локальный WebSocket-сервер, через который браузерное расширение и Pi-сессии обмениваются служебными сообщениями Chrome Assistent.

Параметры по умолчанию:

- **host:** `127.0.0.1`
- **port:** `17345`
- **URL:** `ws://127.0.0.1:17345`

## Кто владеет broker

Broker не запускается отдельным системным демоном. Он поднимается одной из Pi-сессий после команды `/chrome-assistent-connect`.

Алгоритм текущей версии:

1. Pi-сессия сначала пытается подключиться к уже существующему broker.
2. Если подключения нет, она пытается поднять собственный broker server на фиксированном порту.
3. Если старт проиграл гонку за порт (`EADDRINUSE`), сессия повторно подключается к уже поднятому серверу.
4. После успешной регистрации эта Pi-сессия становится обычной целью, а при необходимости ещё и владельцем жизненного цикла broker.

## Аутентификация

### Внутренний target token

Для регистрации Pi-целей broker использует внутренний token Pi runtime. Он хранится в глобальном каталоге:

```text
~/.pi/chrome-assistent/broker.token
```

Этот token нужен только Pi-стороне и не предназначен для ручного копирования в браузер.

### Browser token

Браузер проходит отдельную авторизацию:

1. боковая панель создаёт или показывает browser token на экране **«Авторизация»**;
2. пользователь выполняет `/chrome-assistent-auth` в Pi;
3. Pi добавляет этот token в реестр доверенных браузеров:

```text
~/.pi/chrome-assistent/trusted-browsers.json
```

После этого browser token можно использовать для `client.hello`, `client.sendSelection`, `client.subscribeTarget` и `client.sendChatMessage`.

## Что broker хранит в памяти

Для каждой активной Pi-цели broker держит:

- `targetId`
- `alias`
- `cwd`
- `gitBranch`
- `pid`
- `sessionName`
- `connectedAt`
- `lastSeenAt`
- WebSocket-соединение цели

Для side panel chat broker также держит в памяти подписки browser sockets по `targetId`. Подписки очищаются при `client.unsubscribeTarget`, закрытии browser socket или завершении broker.

Список целей и подписок живёт только в памяти текущего broker process.

## Жизненный цикл цели

### Регистрация

После `target.register` broker:

- сохраняет метаданные цели;
- обновляет `lastSeenAt`;
- привязывает `targetId` к socket;
- подтверждает регистрацию сообщением `target.registered`.

Если тот же `targetId` регистрируется повторно, старое соединение вытесняется новым.

### Heartbeat и stale cleanup

Pi-цель отправляет heartbeat каждые `5_000 ms`.

Broker считает цель stale, если heartbeat не обновлялся `15_000 ms`, после чего:

- удаляет цель из списка;
- закрывает её socket;
- завершает pending deliveries ошибкой.

### Явное отключение

При `target.unregister` broker удаляет цель и закрывает socket.

## Доставка chat-сообщений

Background service worker держит постоянный browser WebSocket к broker. После `client.hello` background выбирает цель по команде side panel или сохранённому `selectedTargetId` и отправляет `client.subscribeTarget`, чтобы получать только события этой Pi-сессии.

Когда браузер вызывает `client.sendChatMessage`, broker:

1. проверяет, что browser socket уже аутентифицирован через `client.hello`;
2. сверяет token в payload с token текущего socket;
3. находит активный target socket по `targetId`;
4. подтверждает приём сообщением `client.chatAccepted`;
5. отправляет Pi-цели `target.deliverChatMessage`.

Когда Pi-цель отправляет `target.chatEvent`, broker пересылает его как `client.chatEvent` только browser sockets, подписанным на этот `targetId`.

Если цель недоступна, broker возвращает `client.error` и может отправить browser-стороне chat event вида `error`, чтобы UI мог снять индикатор фоновой работы.

## Доставка выделения

Когда браузер вызывает `client.sendSelection`, broker:

1. проверяет browser token и payload;
2. находит `targetId`;
3. создаёт внутренний `requestId`;
4. отправляет цели `target.deliverSelection`;
5. ждёт `target.sendSelectionResult`.

Таймаут доставки по умолчанию — `30_000 ms`.

Если цель:

- не найдена — браузер получает `Target is not available`;
- не ответила вовремя — браузер получает `Delivery timed out`;
- отключилась — pending delivery завершается ошибкой отключения.

## Логи и наблюдаемость

Pi-часть пишет события broker и target в:

```text
~/.pi/chrome-assistent/chrome-assistent.log
```

Логи помогают понять:

- кто поднял broker server;
- когда зарегистрировалась или отключилась цель;
- были ли ошибки сокета, таймауты или гонка старта.

## Известные ограничения

- Broker слушает только localhost и не поддерживает удалённые подключения.
- Нет отдельного фонового демона: broker живёт вместе с owning Pi-сессией.
- Нет очереди сообщений и повторной доставки после рестарта.
- Chat deltas не replay-ятся при переподключении side panel.
- Список целей раскрывает локальные метаданные доверенному браузеру.

## Связанные документы

- [Обзор архитектуры](./overview.md)
- [Pi-расширение](./pi-extension.md)
- [Протокол](./protocol.md)
- [Модель безопасности](../security/security-model.md)
