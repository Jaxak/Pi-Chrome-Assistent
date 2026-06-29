# План: Динамический working-индикатор по событиям Pi SDK

**Дата:** 2026-06-29  
**Ветка:** `feat/sidepanel-chat`  
**Статус:** В работе

---

## Принципы

1. **Текущий код индикатора — legacy-мусор.** `sending`, `activeToolsCount`, hardcoded `busyLabel` — всё удалить.
2. **Данные берутся ТОЛЬКО из events.** Никаких подсчётов, никаких heuristics.
3. **Воспроизводим поведение TUI:** turn_start → spinner, tool_execution_start → название инструмента, message_start(assistant) → "Пишет ответ…", turn_end → скрыть.
4. **Без обратной совместимости.** Ломаем всё что мешает.

---

## Текущее состояние (мусор, подлежит удалению)

| Поле | Статус | Проблема |
|------|--------|----------|
| `sending: boolean` | МЁРТВОЕ | Всегда `false` после рефакторинга. Не несёт информации. |
| `activeToolsCount: number` | КОСТЫЛЬ | Ручной подсчёт start/end. Дублирует информацию из events. |
| `busyLabel: string` | HARDCODED | Всегда "Агент работает в фоне…". Не отражает реальную активность. |
| `agentBusy: boolean` | ИСПОЛЬЗУЕТСЯ | Оставить, но управлять ТОЛЬКО через events. |
| chat_event `agent_busy` | КОСТЫЛЬ | Используется в sendChatMessage для fake busy state до event. Заменить. |
| chat_event `sending_started` | УДАЛЕНО | Уже убрано в Этапе 1. |

---

## Целевое поведение (как TUI)

```
turn_start          → показать: "Агент думает…"
tool_execution_start → обновить: "Выполняет: {toolName}…"
tool_execution_end   → вернуть: "Агент думает…" (или следующий tool)
message_start(asst)  → обновить: "Пишет ответ…"
message_end(asst)    → (скрыть если нет следующего tool)
turn_end            → скрыть индикатор
```

---

## Задачи

### 1. Удалить `sending` из всего кодовой базы

**Файлы:** `sidepanelState.ts`, `assistantState.ts`, `backgroundStateServer.ts`, все тесты

- Удалить `sending: boolean` из `SidePanelState`
- Удалить `sending: boolean` из `BackgroundAssistantState.chat`
- Удалить все `sending: false` / `sending: true` присваивания
- В `isChatSendDisabled`: убрать `state.chat.sending ||` — `agentBusy` достаточен
- Обновить все тесты: убрать проверки и установки `sending`

### 2. Удалить `activeToolsCount`

**Файлы:** `assistantState.ts`, `sidepanel.ts`, `sidepanelRender.ts`

- Удалить `activeToolsCount: number` из `BackgroundAssistantState.chat`
- Удалить case `tool_execution_start/end` подсчёт в `reduceAssistantState`
- Удалить аргумент `activeToolsCount` из `updateAgentWorkingElement`
- Удалить конкатенацию ` · Вызов инструментов (N)` из render

### 3. Заменить `busyLabel` на event-driven `workingLabel`

**Файлы:** `sidepanelState.ts`, `assistantState.ts`

Логика в обработчике `session.event` (в `reduceAssistantState`):

```
turn_start          → agentBusy=true,  busyLabel="Агент думает…"
tool_execution_start → busyLabel="Выполняет: {toolName}…"
tool_execution_end   → busyLabel="Агент думает…"
message_start(asst)  → busyLabel="Пишет ответ…"
turn_end            → agentBusy=false, busyLabel=DEFAULT
```

Удалить `agent_busy` chat_event kind — больше не нужен. `sendChatMessage` не должен устанавливать fake busy state. Вместо этого: отправить сообщение → Pi SDK эмитнет `turn_start` → индикатор покажется.

### 4. Обновить `sendChatMessage` и `sendSelection`

**Файл:** `backgroundStateServer.ts`

- `sendChatMessage`: убрать `applyState({ kind: "chat_event", event: { kind: "agent_busy", ... } })`. Просто отправить через sessionClient. Индикатор появится когда придёт `turn_start` event от Pi SDK.
- `sendSelection`: аналогично — просто отправить.
- Убрать `agent_busy` из `SidePanelChatEvent` type union.

### 5. Обновить `sidepanelRender.ts`

**Файл:** `sidepanelRender.ts`

`updateAgentWorkingElement(element, label, visible)` — упростить:
- Убрать аргумент `activeToolsCount`
- Просто показать/скрыть + установить label

### 6. Вычистить тесты

- Удалить тесты для `sending`, `activeToolsCount`, `agent_busy` event
- Добавить тесты:
  - turn_start → agentBusy=true, busyLabel="Агент думает…"
  - tool_execution_start → busyLabel="Выполняет: {toolName}…"
  - message_start(assistant) → busyLabel="Пишет ответ…"
  - turn_end → agentBusy=false

---

## Порядок выполнения

```
[ ] 1. Удалить sending
[ ] 2. Удалить activeToolsCount
[ ] 3. busyLabel по events + удалить agent_busy event kind
[ ] 4. Обновить sendChatMessage/sendSelection
[ ] 5. Обновить sidepanelRender
[ ] 6. Тесты
[ ] Финал: npm test + tsc --noEmit
```

---

## Критерии завершения

- `npm test` — все тесты проходят
- `npx tsc --noEmit` — 0 ошибок
- В коде НЕТ: `sending`, `activeToolsCount`, chat_event `agent_busy`
- Индикатор отражает реальную активность Pi через события
- `isChatSendDisabled` использует только `agentBusy` (не `sending`)
