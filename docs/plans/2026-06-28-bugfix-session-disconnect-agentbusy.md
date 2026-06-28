# План исправления: отключение сессии и agentBusy (v2)

**Дата:** 2026-06-28  
**Ветка:** `feat/sidepanel-chat`  
**Приоритет:** HIGH

---

## Проблемы

### Баг A: Сессия отключается через ~20 секунд

**Симптом:** После ответа Pi сессия отключается через ~20 секунд.

**Корневая причина:** Heartbeat в `sessionServer.ts` с интервалом 20 сек. Если Chrome service worker suspended — не отвечает на ping → сервер делает terminate.

**Решение:** Убрать heartbeat полностью. Для локального сервера с 1-2 клиентами он избыточен.

### Баг B: "Агент работает в фоне" не исчезает

**Симптом:** После завершения ответа Pi индикатор `agentBusy` остаётся видимым.

**Корневая причина:** Race condition — snapshot после turn_end перезаписывает `agentBusy`.

**Решение:** Убрать `broadcastSnapshot()` из обработчика `turn_end` (уже сделано).

---

## План исправления

### Задача 1: Убрать heartbeat из sessionServer.ts

**Файл:** `src/pi/sessionServer.ts`

**Что убрать:**
1. Константу `DIRECT_SESSION_HEARTBEAT_INTERVAL_MS`
2. Переменную `heartbeatTimer`
3. Тип `AliveWebSocket` и поле `isAlive`
4. Логику ping/pong в обработчике `connection`
5. `setInterval` для heartbeat
6. `clearInterval` в `closeServer`
7. Параметр `heartbeatIntervalMs` из опций

**Что оставить:**
- WebSocket сервер работает как раньше
- Соединение живёт пока одна из сторон явно не закроет

### Задача 2: Убрать keepalive из Chrome расширения

**Файлы:**
- `src/chrome/keepalive.ts` — удалить файл
- `src/chrome/manifest.json` — убрать `"alarms"` из permissions
- `src/chrome/background.ts` — убрать импорт и вызов `initKeepaliveListener()`
- `src/chrome/backgroundStateServer.ts` — убрать импорт и вызовы `startKeepalive()`/`stopKeepalive()`
- `src/chrome/background.test.ts` — убрать mock для keepalive и chrome.alarms
- `src/chrome/backgroundStateServer.test.ts` — убрать mock для keepalive

### Задача 3: Обновить тесты sessionServer

**Файл:** `src/pi/sessionServer.test.ts`

Убрать тесты связанные с heartbeat (если есть).

---

## Порядок выполнения

| # | Задача | Оценка |
|---|--------|--------|
| 1 | Убрать heartbeat из sessionServer.ts | 15 мин |
| 2 | Убрать keepalive из Chrome расширения | 10 мин |
| 3 | Обновить/убрать тесты | 10 мин |

---

## Критерии приёмки

- [ ] Сессия остаётся активной неограниченно долго
- [ ] Нет фоновых процессов в расширении (нет alarms)
- [ ] "Агент работает в фоне" исчезает после завершения ответа
- [ ] Все тесты проходят
- [ ] TypeScript компилируется без ошибок

---

## Итоговые изменения (после выполнения)

**Убрано:**
- Heartbeat логика на сервере
- chrome.alarms keepalive в расширении
- ~100 строк кода

**Результат:**
- Простая архитектура
- Нет фоновой активности
- WebSocket живёт пока нужен
