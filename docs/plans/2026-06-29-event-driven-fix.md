# План: Чистая event-driven архитектура по эталону pi-web-ui

**Дата:** 2026-06-29  
**Ветка:** `feat/sidepanel-chat`  
**Статус:** В работе

---

## Принципы

1. **Текущий код — мусор.** Не опираться на существующие merge-функции, heuristics, workaround'ы. Удалять без сожалений.
2. **Без обратной совместимости.** Ломаем всё что мешает чистой архитектуре.
3. **Без костылей.** Никаких "временных" решений, special cases, edge case handling.
4. **Без дублей.** Переиспользовать, следовать паттернам.
5. **Эталон — pi-web-ui.** Snapshot при connect, events для всего остального.

---

## Архитектура (как в pi-web-ui)

```
CONNECT:
  Server → Client: snapshot (entries из sessionManager.getBranch())
  Client: messages = hydrateFromEntries(entries)  ← полная замена

RUNTIME:
  Pi SDK → Server → Client: events (message_start, message_update, message_end, turn_start, turn_end, tool_execution_*)
  Client: обрабатывает events инкрементально

SYNC POINT (turn_end):
  Server → Client: snapshot (entries актуальны, стриминг завершён)
  Client: messages = hydrateFromEntries(entries)  ← полная замена
```

**Нет merge. Нет дедупликации. Нет heuristics.**

---

## Задачи

### 1. Сервер: убрать лишние broadcastSnapshot()

**Файл:** `src/pi/browserConnectExtension.ts`

Убрать `broadcastSnapshot()` из:
- `model_select` handler
- `turn_start` handler
- `session_compact` handler
- `tool_execution_start` handler
- `tool_execution_update` handler
- `tool_execution_end` handler
- `onChatMessage` callback (оба вызова — до и после sendUserMessage)
- `onSelection` callback (оба вызова)

Оставить `broadcastSnapshot()` ТОЛЬКО в:
- `turn_end` handler (sync point — entries содержат все завершённые messages)
- При connect нового WebSocket клиента (sessionServer делает автоматически)
- `onSetModel` — модель изменилась, нужно обновить runtime в UI

**Почему:** pi-web-ui не шлёт snapshot повторно. Events достаточно для real-time UI. turn_end — безопасный sync point где entries = полная правда.

### 2. Клиент: обработать user message через event

**Файл:** `src/chrome/sidepanelState.ts`

В `applyMirrorEventToChatState`, case `message_start`:
- Убрать фильтр `if (event.message.role !== "assistant" && event.message.role !== "") return state`
- Обработать `role === "user"`: добавить user message в чат (text из event или пустой, заполнится из snapshot при turn_end)

Pi SDK эмитит `message_start` с role="user" когда получает user message. Это тот же механизм что использует pi-web-ui.

Для user message в `message_start`: нужно извлечь текст. Pi SDK передаёт content в event. Проверить формат и извлечь.

### 3. Клиент: snapshot = полная замена messages

**Файл:** `src/chrome/assistantState.ts`

- Удалить `mergeWithStreamingAssistant` целиком
- В `applySessionSnapshot`: `messages = hydrateMessagesFromEntries(entries)` — одна строка, без условий, без merge

**Почему:** snapshot приходит ТОЛЬКО в safe points (connect, turn_end). В этих точках entries = полная правда. Streaming messages не существуют в этих точках.

### 4. Клиент: runtime обновления через events

**Файл:** `src/chrome/assistantState.ts`

Проверить что `session.event` с типом `model_select` обновляет runtime state. Если нет — добавить обработку. В pi-web-ui model_select event пробрасывается и фронт обновляет model info.

Для `tool_execution_start/end` — уже обрабатывается (activeToolsCount).
Для `turn_end` — уже обрабатывается (agentBusy=false).

### 5. Тесты: обновить под новую архитектуру

- Удалить тесты для `mergeWithStreamingAssistant` / merge-логики
- Добавить тесты:
  - snapshot = полная замена messages (нет merge)
  - user message появляется через message_start event с role=user
  - turn_end snapshot обновляет messages полностью
  - нет дублей при любой последовательности events + snapshots
- Обновить серверные тесты если broadcastSnapshot удалён из callbacks

### 6. Удалить мёртвый код

После реализации:
- Убедиться что нет unused functions/imports
- Убедиться что нет комментариев-костылей типа "NOTE: broadcastSnapshot() intentionally omitted"
- Удалить `trimMessages` из `assistantState.ts` если дублирует `sidepanelState.ts` (переиспользовать)

---

## Порядок выполнения

```
[ ] 1. Сервер: убрать лишние broadcastSnapshot()
[ ] 2. Клиент: message_start обрабатывает role=user
[ ] 3. Клиент: snapshot = полная замена (удалить merge)
[ ] 4. Клиент: runtime через events (проверить/добавить)
[ ] 5. Тесты
[ ] 6. Удалить мёртвый код
[ ] Финал: npm test + tsc --noEmit + ручное тестирование
```

---

## Критерии завершения

- `npm test` — все тесты проходят
- `npx tsc --noEmit` — 0 ошибок
- В коде НЕТ: merge функций, дедупликации, pending логики, heuristics
- User message появляется в чате через event от Pi SDK
- Assistant message стримится через events
- Snapshot при reconnect восстанавливает полную историю
- Нет дублей ни при каком сценарии
