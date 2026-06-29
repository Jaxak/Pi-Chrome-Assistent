# Chrome-расширение

## Архитектура

```
┌─────────────────────────────────────────────────┐
│  Chrome Extension (MV3)                         │
│                                                 │
│  ┌──────────┐  ┌────────────┐  ┌────────────┐  │
│  │ Sidepanel│  │ Background │  │  Content   │  │
│  │  (UI)    │◄─┤  Service   ├─►│  Script    │  │
│  │          │  │  Worker    │  │ (DOM Pick) │  │
│  └──────────┘  └─────┬──────┘  └────────────┘  │
│                       │                         │
└───────────────────────┼─────────────────────────┘
                        │ WebSocket (localhost)
                        ▼
              ┌──────────────────┐
              │ Pi Session Server│
              │ (Pi extension)   │
              └──────────────────┘
```

## Компоненты

### Sidepanel (`sidepanel.ts`, `sidepanel.html`, `sidepanel.css`)

Боковая панель с чатом. Получает state от Background через Chrome ports.

**Основные модули:**
- `sidepanelState.ts` — reducer для chat state (messages, agentBusy, busyLabel)
- `sidepanelRender.ts` — рендер DOM-элементов (сообщения, индикатор)
- `assistantState.ts` — глобальный state (connection, chat, runtime, diagnostics)
- `markdown.ts` — рендер markdown в HTML

### Background Service Worker (`background.ts`)

Точка входа расширения. Управляет:
- WebSocket-подключением к Pi через `BackgroundAssistantStateServer`
- Content script injection для DOM Picker
- Context menus
- Port-коммуникацией с Sidepanel

**Ключевые модули:**
- `backgroundStateServer.ts` — state server: держит WebSocket, раздаёт snapshots
- `sessionClient.ts` — WebSocket-клиент к Pi session server (reconnect, heartbeat)

### Content Script (`contentScript.ts`)

Внедряется в активную вкладку по запросу. Отвечает за:
- DOM Picker (`domPicker.ts`) — интерактивный выбор элемента
- Selection Overlay (`selectionOverlay.ts`) — UI оверлей с кнопками
- Crosshair Highlighter (`crosshairHighlighter.ts`) — подсветка при наведении
- Toast-уведомления (`toast.ts`)

## Поток данных

### Чат
```
User input → Background (sendChatMessage) → WebSocket → Pi SDK
Pi SDK events → WebSocket → Background (reduceAssistantState) → Port → Sidepanel
```

### DOM Picker
```
User click → Background → Content Script injection → DOM Picker UI
User selects → Overlay confirm → Background (sendSelection) → WebSocket → Pi
```

## State Management

State обновляется через **event-driven reducer** (`reduceAssistantState`):

- `session_snapshot` — полная замена (только при connect)
- `session.event` — инкрементальные обновления от Pi SDK events
- `connection_updated` — статус WebSocket-соединения
- `chat_event` — UI-события (errors)

Индикатор работы агента управляется событиями:
- `turn_start` → "Агент думает…"
- `tool_execution_start` → "Выполняет: {toolName}…"
- `message_start(assistant)` → "Пишет ответ…"
- `turn_end` → скрыть
