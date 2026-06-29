# План рефакторинга: Event-driven синхронизация сообщений

**Дата:** 2026-06-29  
**Ветка:** `feat/sidepanel-chat`  
**Статус:** В работе

---

## Проблема

Текущая архитектура синхронизации сообщений использует heuristics (сравнение текстов, pending флаги, hasSimilarServerMessage) для merge локального и серверного состояния. Это приводит к:

- Race conditions между pending messages и snapshots
- Ненадёжной дедупликации (разные форматы текста client vs server)
- Сложному коду с множеством edge cases
- 8+ потенциальных мест для багов

## Решение

Перейти на **event-driven модель** (как pi-web-ui):

1. Клиент НЕ добавляет optimistic updates для user messages
2. Сервер отправляет события (message_start, user message через snapshot/события)
3. Клиент обновляет state на основе событий от сервера
4. Snapshot отправляется только при подключении

**Преимущества:**
- 2 точки отказа вместо 5
- 3 места для багов вместо 8+
- Латенси ~50ms (незаметна пользователю)
- Проверенная архитектура (pi-web-ui работает)

---

## Этап 1: Вычистка мёртвого кода

### Цель
Удалить всю нерабочую функциональность и подготовить кодовую базу к рефакторингу.

### Задачи

| # | Файл | Что удалить | Причина |
|---|------|-------------|---------|
| 1.1 | `assistantState.ts` | `hasSimilarServerMessage()` | Heuristic, будет не нужен |
| 1.2 | `assistantState.ts` | Логика pending user messages в `mergeWithPendingMessages()` | Заменится на event-driven |
| 1.3 | `assistantState.ts` | `hasPendingUserMessages()` с pending логикой | Упростится |
| 1.4 | `sidepanelState.ts` | `pending?: true` в SidepanelChatMessage | Не будет optimistic updates |
| 1.5 | `sidepanelState.ts` | `pending_user_message` event kind | Не нужен |
| 1.6 | `sidepanelState.ts` | `sending_started` event kind | Возможно не нужен |
| 1.7 | `backgroundStateServer.ts` | `formatSelectionForDisplay()` | Не будет pending |
| 1.8 | `backgroundStateServer.ts` | Optimistic update в `sendSelection()` | Удалить |
| 1.9 | `backgroundStateServer.ts` | Optimistic update в `sendChatMessage()` | Оставить только отправку |

### Критерий завершения
- Все тесты проходят
- Код компилируется
- Нет unused imports/functions (ESLint)

---

## Этап 2: Реализация Event-driven модели

### Цель
Сообщения появляются в UI только когда сервер подтвердит их получение.

### 2.1 Анализ текущего потока событий

```
Текущий поток (selection):
1. User clicks DOM picker → выбирает элемент
2. contentScript → background: sendSelection
3. background → Pi server (WebSocket): session.selection.send
4. Pi server → pi.sendUserMessage(formatted)
5. Pi SDK fires: message_start (user), message_end (user)
6. browserConnectExtension: broadcastSnapshot()
7. background receives snapshot → updates state → renders
```

**Вопрос:** Есть ли событие когда Pi принял user message?

### 2.2 Исследование событий Pi SDK

Нужно проверить:
- [ ] Какие события Pi SDK отправляет для user messages?
- [ ] Есть ли `turn_start` или аналог для user input?
- [ ] Достаточно ли snapshot после `pi.sendUserMessage()`?

### 2.3 Варианты реализации

**Вариант 2.3.A: Snapshot после отправки**
```
Client                              Server
   |-- send selection --------------->|
   |                                   |-- pi.sendUserMessage()
   |                                   |-- broadcastSnapshot() 
   |<-- snapshot with user message ---|
   |-- render message --------------->|
```

Плюсы: Просто, snapshot уже содержит сообщение
Минусы: Зависит от timing (может прийти до добавления в sessionManager)

**Вариант 2.3.B: Событие от Pi SDK**
```
Client                              Server
   |-- send selection --------------->|
   |                                   |-- pi.sendUserMessage()
   |                                   |<- Pi SDK: turn_start или message event
   |<-- event: user_message ---------|
   |-- render message --------------->|
```

Плюсы: Явное событие
Минусы: Нужно найти правильное событие

**Вариант 2.3.C: Response от команды**
```
Client                              Server
   |-- send selection --------------->|
   |                                   |-- pi.sendUserMessage()
   |<-- response: { ok, message } ----|
   |-- render message --------------->|
```

Плюсы: Синхронный ответ
Минусы: Нужно изменить протокол

### 2.4 Задачи реализации

| # | Задача | Файл | Описание |
|---|--------|------|----------|
| 2.4.1 | Исследовать события Pi SDK | `browserConnectExtension.ts` | Логировать все события, найти подходящее |
| 2.4.2 | Выбрать вариант реализации | — | На основе исследования |
| 2.4.3 | Изменить `sendSelection()` | `backgroundStateServer.ts` | Убрать optimistic, просто отправить |
| 2.4.4 | Изменить `sendChatMessage()` | `backgroundStateServer.ts` | Убрать optimistic, просто отправить |
| 2.4.5 | Обработать событие/snapshot | `assistantState.ts` | Добавить сообщение при получении от сервера |
| 2.4.6 | Показать индикатор "Отправка..." | `sidepanel.ts` | UI feedback без fake message |
| 2.4.7 | Обновить тесты | `*.test.ts` | Привести в соответствие с новой логикой |

### Критерий завершения
- Selection появляется в чате после подтверждения сервера
- Обычные сообщения появляются после подтверждения сервера
- Нет дублей
- Нет исчезающих сообщений
- Все тесты проходят

---

## Этап 3: Финальная чистка репозитория

### Цель
Убедиться что репозиторий чист, нет мусора, мёртвого кода, устаревшей документации.

### Задачи

| # | Категория | Действие |
|---|-----------|----------|
| 3.1 | Код | `grep -r "TODO\|FIXME\|HACK\|XXX"` — исправить или удалить |
| 3.2 | Код | ESLint no-unused-vars — удалить неиспользуемое |
| 3.3 | Код | Проверить все `console.log/warn/error` — оставить только нужные |
| 3.4 | Тесты | Удалить тесты для удалённой функциональности |
| 3.5 | Тесты | Проверить покрытие новой логики |
| 3.6 | Документация | Обновить README если нужно |
| 3.7 | Документация | Удалить устаревшие планы из `docs/plans/` |
| 3.8 | Файлы | `git clean -fdn` — проверить untracked файлы |
| 3.9 | Зависимости | Проверить неиспользуемые в package.json |

### Критерий завершения
- `npm run lint` — 0 ошибок
- `npm run typecheck` — 0 ошибок  
- `npm test` — все проходят
- Нет TODO/FIXME в production коде
- README актуален

---

## Порядок выполнения

```
[ ] Этап 1: Вычистка мёртвого кода
    [ ] 1.1 - 1.9: Удаление heuristics и pending логики
    [ ] Тесты проходят
    
[ ] Этап 2: Event-driven модель
    [ ] 2.4.1: Исследование событий Pi SDK
    [ ] 2.4.2: Выбор варианта
    [ ] 2.4.3 - 2.4.7: Реализация
    [ ] Тесты проходят
    [ ] Ручное тестирование
    
[ ] Этап 3: Финальная чистка
    [ ] 3.1 - 3.9: Все проверки
    [ ] Финальный коммит
```

---

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Pi SDK не отправляет нужные события | Средняя | Использовать snapshot после sendUserMessage |
| Snapshot приходит до обновления sessionManager | Высокая | Добавить небольшую задержку или retry |
| Сломаем существующую функциональность | Низкая | Поэтапный рефакторинг + тесты на каждом шаге |

---

## Заметки

- Перед каждым этапом — коммит текущего состояния
- После каждого этапа — ручное тестирование в браузере
- При обнаружении проблемы — сначала исследование, потом план, потом фикс
