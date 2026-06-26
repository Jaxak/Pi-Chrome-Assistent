# Pi-расширение

## Команды

Pi-часть регистрирует две пользовательские команды:

```text
/chrome-assistent-auth
/chrome-assistent-connect [alias]
```

### `/chrome-assistent-auth`

Команда запрашивает browser token у пользователя и добавляет его в глобальный реестр доверенных браузеров.

### `/chrome-assistent-connect [alias]`

Команда публикует текущую Pi-сессию как цель для браузерного расширения. Необязательный `alias` попадает в метаданные цели и показывается на вкладке **«Сессии»**.

## Где Pi хранит служебные файлы

Все runtime-файлы живут в глобальном каталоге:

```text
~/.pi/chrome-assistent/
```

Ключевые файлы:

- `broker.token` — внутренний token для регистрации Pi-целей;
- `trusted-browsers.json` — список доверенных browser token;
- `chrome-assistent.log` — логи Pi/broker.

## Какие метаданные регистрируются

При подключении Pi строит `TargetMetadata`:

- `targetId`
- `alias`
- `cwd`
- `gitBranch`
- `pid`
- `sessionName`
- `connectedAt`
- `lastSeenAt`

Эти данные потом видны в боковой панели после аутентифицированного `client.listTargets`.

## Поток работы `/chrome-assistent-connect`

Текущий код делает следующее:

1. нормализует `alias`;
2. читает или создаёт внутренний target token;
3. закрывает предыдущую активную target-связь, если она была;
4. собирает свежие метаданные цели;
5. пытается зарегистрироваться в broker на `127.0.0.1:17345`;
6. если broker недоступен — пытается поднять его сама;
7. после успешной регистрации обновляет статус и уведомление в UI Pi.

## Что видит пользователь в Pi

После успешного подключения Pi показывает статус вида:

```text
/chrome-assistent-connect: <label> · подключено · 127.0.0.1:<port>
```

При ошибке команда сообщает:

```text
Не удалось выполнить /chrome-assistent-connect: <текст ошибки>
```

## Как Pi получает chat-сообщения из браузера

После доставки `target.deliverChatMessage` через broker Pi вызывает `handleDeliveredChatMessage(...)`, который:

1. сразу публикует chat event `agent_busy(true)` с текстом **«Агент работает в фоне…»**;
2. проверяет, простаивает ли сейчас Pi;
3. вызывает `pi.sendUserMessage(...)`:
   - сразу, если Pi idle;
   - с `deliverAs: "followUp"`, если Pi уже занят ответом;
4. при ошибке публикует chat event `error` и `agent_busy(false)`.

Pi-расширение подписано на lifecycle events Pi runtime:

- `message_start` → `assistant_message_start`;
- `message_update` с text delta → `assistant_text_delta`;
- `message_end` → `assistant_message_end` и `agent_busy(false)`.

Эти события уходят в broker как `target.chatEvent`, а затем в боковую панель как `client.chatEvent`.

## Как Pi получает выделение из браузера

После доставки через broker Pi вызывает `handleDeliveredSelection(...)`, который:

1. форматирует payload браузера в текстовое сообщение для Pi;
2. проверяет, простаивает ли сейчас Pi;
3. вызывает `pi.sendUserMessage(...)`:
   - сразу, если Pi idle;
   - с `deliverAs: "followUp"`, если Pi уже занят ответом.

Итог: DOM picker отправляет контекст в Pi как пользовательское сообщение. Ответ ассистента может отображаться в боковой панели чата через lifecycle events.

## Ограничения текущей версии

- Side panel chat отображает только plain text.
- Tool calls и tool results не передаются в UI первой версии.
- Chat deltas не replay-ятся после переподключения боковой панели.
- Browser authorization и подключение Pi-сессии остаются двумя отдельными шагами.
- Жизненный цикл broker server всё ещё связан с Pi-сессией, которая его подняла.

## Связанные документы

- [Обзор архитектуры](./overview.md)
- [Локальный broker](./broker.md)
- [Chrome-расширение](./chrome-extension.md)
- [Авторизация браузера](../operations/token-setup.md)
