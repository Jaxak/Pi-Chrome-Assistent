# Pi-расширение (серверная часть)

## Назначение

Pi-расширение (`src/pi/browserConnectExtension.ts`) — это extension для Pi Coding Agent, которое:
1. Запускает WebSocket-сервер на localhost
2. Транслирует события Pi SDK в браузер
3. Принимает сообщения и selections от браузера и передаёт в Pi

## Команда `/chrome-assistent-connect`

Запускает WebSocket-сервер и выводит порт подключения:
```
/chrome-assistent-connect
```

Сервер привязывается к `127.0.0.1` и сканирует порты начиная с 18920.

## WebSocket Session Server (`sessionServer.ts`)

**При подключении клиента:**
- Отправляет `session.snapshot` — полное состояние (messages, runtime info)

**При событиях Pi SDK:**
- Транслирует `session.event` — инкрементальные обновления

**Принимает от клиента:**
- `session.chat` — текстовое сообщение пользователя
- `session.selection` — DOM-фрагмент со страницы
- `session.setModel` — смена модели

## Транслируемые события

| Pi SDK event | Broadcast event | Назначение |
|---|---|---|
| `turn_start` | `{ type: "turn_start", turnId }` | Начало работы агента |
| `turn_end` | `{ type: "turn_end", turnId }` | Конец работы агента |
| `message_start` | `{ type: "message_start", message }` | Новое сообщение (user/assistant) |
| `message_update` | `{ type: "message_update", message }` | Стриминг текста |
| `message_end` | `{ type: "message_end", message }` | Сообщение завершено |
| `tool_execution_start` | `{ type: "tool_execution_start", toolName }` | Запуск инструмента |
| `tool_execution_end` | `{ type: "tool_execution_end", toolName }` | Завершение инструмента |
| `session_compact` | `{ type: "session_compact" }` | Компактификация истории |
| `model_select` | `{ type: "model_select", provider, modelId }` | Смена модели |

## Snapshot (полный state)

Отправляется только при:
- Подключении нового WebSocket-клиента
- Команде `session.setModel`

Содержит:
```typescript
{
  entries: SessionEntry[],       // история сообщений
  runtime: {
    model: { provider, id, label },
    availableModels: [...],
    contextUsage: { tokens, maxTokens, percent },
    isIdle: boolean
  }
}
```

## Обработка selections

При получении `session.selection` от браузера:
- Форматирует в текстовое сообщение (`formatSelectionMessage`)
- Вызывает `pi.sendUserMessage(formatted)` — Pi обрабатывает как обычный запрос

## Вспомогательные модули

- `chromeAssistentPaths.ts` — пути runtime (`~/.pi/chrome-assistent/`)
- `logging.ts` — файловый логгер с ротацией
- `secureFilesystem.ts` — безопасная работа с директориями (symlink protection)
