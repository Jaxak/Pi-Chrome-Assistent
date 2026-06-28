# Ревью ветки `feat/sidepanel-chat`

**Дата:** 2026-06-28  
**Ветка:** `feat/sidepanel-chat` (50 коммитов поверх `main`)  
**Масштаб изменений:** +17 833 / −9 022 строк, 67 файлов  
**Тесты:** 358 из 358 ✅ (26 файлов, 6.77с)  
**TODO/FIXME:** 0  

---

## 1. Что сделано хорошо 👍

### Архитектура

- **Чистое разделение на слои:** pure reducer (`assistantState.ts`) → state server (`backgroundStateServer.ts`) → Chrome listeners (`background.ts`) → UI (`sidepanel.ts`). Классическая однонаправленная архитектура состояния, хорошо подходящая для Chrome-расширения.
- **Dependency Injection** для всех Chrome API-зависимостей (`StartDomPickerDependencies`, `BackgroundMessageListenerDependencies`) — делает функции тестируемыми без реального Chrome.
- **Иммутабельный редюсер** — все обновления состояния через spread, массивы копируются. Нет мутаций.
- **Epoch-счётчик** для дешёвой детекции изменений на стороне UI — хорошее решение.
- **`structuredClone`** для изоляции снапшотов — предотвращает мутации внутреннего состояния через общие ссылки.
- **Mirror-архитектура** — переход от poll-based `chat.events` к event-driven `session.event` с hydration из entries — правильное архитектурное решение.

### Безопасность

- **Нет XSS-векторов:** весь пользовательский контент рендерится через `textContent`. Нигде нет `innerHTML`, `eval`, `document.write`. Есть тест, явно проверяющий это.
- **Санитизация ошибок:** внутренние детали (WebSocket URL, `chrome.storage.local`, `requestId`) вырезаются перед показом пользователю.
- **CSP:** `connect-src` ограничен `self` и `ws://127.0.0.1:*` — нет подключений к внешним хостам.
- **Сервер слушает только 127.0.0.1** — не доступен по сети.
- **`O_NOFOLLOW`** при записи логов + права `0o600`/`0o700` — защита от symlink-атак.
- **Лимиты размеров** (`MAX_SELECTED_TEXT_BYTES`, `MAX_SELECTED_HTML_BYTES`) — проверяются и на стороне Chrome, и на стороне сервера.

### Качество кода

- **Ноль TODO/FIXME** в продакшн-коде — весь tech debt был закрыт в рамках ветки.
- **Всего 3 `console.*`** в продакшн-коде — все уместные (ошибки DOM picker, предупреждения об ошибках инициализации).
- **Весь UI/UX на русском языке** — тексты в сайдпанели, тосты, сообщения об ошибках, статусы. Тесты явно проверяют русский текст.
- **Валидация протокола** — все входящие payload'ы проверяются перед использованием.
- **Stale socket guard** — `isCurrentActiveSocket()` closure предотвращает обработку событий от предыдущего сокета после реконнекта. Критически важный паттерн, реализован корректно.

### Тесты

- **358 тестов, 100% проходят** — отличное покрытие.
- **Соотношение тест/код ≈ 2.1:1** (7378 строк тестов / 3500 строк source) — значительная инвестиция в корректность.
- **Качественные assertion'ы** — каждый тест проверяет конкретное значение, переход состояния или side-effect. Нет филлеров "should exist".
- **Edge cases протестированы:** fallback-цепочки, non-injectable URL'ы, двойные fallback-ошибки, reconnect с backoff, out-of-order events, throwing ports.
- **Интеграционные тесты с реальными WebSocket'ами** — `sessionServer.test.ts` поднимает настоящие HTTP/WS серверы, тестируя полный roundtrip протокола.
- **jsdom-тесты UI** — `sidepanelNavigation.test.ts` загружает реальный HTML, импортирует реальный модуль, проверяет DOM-рендеринг и пользовательские взаимодействия.
- **Качественные моки** — purpose-built fakes (`FakePort`, `FakeWebSocket`, `FakeStorage`) с API для инспекции, без over-mocking'а.

### DevOps и документация

- **README полностью на русском** с чётким flow: установка → подключение → использование.
- **CHANGELOG** ведётся — изменения документированы.
- **Manifest V3** — актуальный стандарт.
- **`private: true`** — защита от случайного npm publish.

---

## 2. Замечания

### 🔴 HIGH — Необходимо исправить перед публикацией

| # | Файл | Проблема | Рекомендация |
|---|------|----------|--------------|
| H1 | `manifest.json` | **`<all_urls>` в host_permissions избыточен.** Расширение имеет `"host_permissions": ["http://127.0.0.1/*", "ws://127.0.0.1/*", "<all_urls>"]`. `<all_urls>` даёт расширению доступ к любому origin'у через background fetch/XHR. В сочетании с `content_scripts` на всех страницах — это потенциальный вектор эксфильтрации данных при компрометации расширения. Chrome Web Store может отклонить расширение с таким разрешением без обоснования. | Убрать `<all_urls>`. Для DOM picker'а достаточно `activeTab` + `scripting` (уже есть `activeTab`). Для localhost-подключений достаточно явных `127.0.0.1` host_permissions. |
| H2 | `sessionClient.ts` | **Бесконечный reconnect без cap'а.** Backoff достигает потолка в 1000ms и далее клиент переподключается каждую секунду навсегда. Если Pi-сессия не запущена, service worker будет создавать и разрушать WebSocket каждую секунду, пока Chrome не suspendирует его. | Увеличить потолок до 5–10 секунд после начального ramp'а, или добавить max attempts с переходом в состояние "manual reconnect". |

### 🟡 MEDIUM — Рекомендуется исправить (не блокер)

| # | Файл | Проблема | Рекомендация |
|---|------|----------|--------------|
| M1 | `browserConnectExtension.ts` | **`broadcastSnapshot()` вызывается на каждый Pi-event.** Каждый `text_delta` триггерит полную JSON-сериализацию всей истории сессии. При потоковом ответе с 500 дельтами и 50 entries в истории — это 500× JSON.stringify(fullSnapshot). | Добавить throttle/debounce (не чаще 1 раза в 100–200ms). `broadcastEvent()` уже отправляет дельты в реальном времени — snapshot не нужен на каждый event. |
| M2 | `sessionServer.ts` | **Нет `maxPayload` на WebSocket-сервере.** Библиотека `ws` по умолчанию принимает до 100 MB. Любой локальный процесс может отправить 100 MB сообщение, которое будет полностью буферизовано в Node.js. | Добавить `maxPayload: 1_048_576` (1 MB) при создании `WebSocketServer`. |
| M3 | `sessionServer.ts` | **Нет rate limiting'а входящих сообщений.** Вредоносный или багнутый клиент может флудить `session.chat.send`, каждый из которых триггерит `pi.sendUserMessage()`. | Добавить простой rate limiter — не более N сообщений за M секунд на клиента. |
| M4 | `sessionClient.ts` | **`session.event` payload не валидируется.** Payload кастуется напрямую к `PiMirrorEvent` без вызова `validatePiMirrorEvent()` (которая существует в `protocol.ts`). Malformed event пройдёт в редюсер без проверки. | Добавить `validatePiMirrorEvent(envelope.payload)` перед вызовом `onSessionEvent`. |
| M5 | `manifest.json` | **Content script инжектится на все страницы.** `"matches": ["https://*/*", "http://*/*"]` инжектирует content script на каждую страницу. Если он нужен только для DOM picker'а — лучше инжектировать по запросу через `chrome.scripting.executeScript`. | Перейти на on-demand injection. Это уменьшит attack surface и потребление ресурсов. |
| M6 | `backgroundStateServer.ts` | **`refreshDiagnostics()` и `recordDiagnostic()` обходят `applyState()`.** Все остальные мутации состояния идут через `applyState()`, но эти два метода напрямую модифицируют `this.state` и вызывают `broadcastSnapshot()` вручную. Если `applyState()` когда-либо получит дополнительные side-effect'ы — эти пути их пропустят. | Привести к единому паттерну через `applyState()`. |
| M7 | `scripts/build-chrome.mjs` | **Shell injection через `execSync`.** Пути интерполируются в shell-команду. Хотя сейчас пути берутся из `__dirname`, директория с `"` или `$()` в имени вызовет shell injection. | Заменить `execSync` на `execFileSync` с массивом аргументов. |
| M8 | `scripts/build-chrome.mjs` | **Зависимость от `rsvg-convert` не документирована.** Build упадёт с непонятной ошибкой на системах без `librsvg2-bin`. | Добавить в README раздел "Требования для сборки" или проверять наличие утилиты с понятным сообщением. |
| M9 | `sidepanel.ts` | **`JSON.stringify` diffing на каждом снапшоте.** `renderChat()` сериализует все сообщения через `JSON.stringify` для детекции изменений. При длинных разговорах (100+ сообщений с потоковыми дельтами) — это O(n) сериализация на каждом кадре. | Использовать `state.epoch` или count + hash последнего сообщения вместо полной сериализации. |
| M10 | `sidepanelState.ts` | **Неограниченный рост массива сообщений.** Сообщения накапливаются без cap'а. В долгих сессиях массив растёт бесконечно. | Добавить лимит (например, последние 500 сообщений) или виртуализированный рендеринг. |

### 🟢 LOW — Мелкие улучшения (можно отложить)

| # | Файл | Проблема |
|---|------|----------|
| L1 | `package.json` | `engines.node >= 24.0.0` агрессивен — 22 LTS был бы безопаснее для совместимости. |
| L2 | `package.json` | `typebox` в devDependencies не используется (`grep -rn "typebox" src/` — 0 результатов). |
| L3 | `package.json` | `jsdom ^29.1.1` использует caret, тогда как все остальные devDependencies зафиксированы точно. |
| L4 | `manifest.json` | Разрешение `tabs` может быть избыточным — если нужен только `tab.url` активной вкладки, достаточно `activeTab`. |
| L5 | `selectionOverlay.ts` | Нет focus trap в модальном окне комментария — Tab может перемещать фокус на элементы под оверлеем. Accessibility gap. |
| L6 | `selectionOverlay.ts` | Нет scroll lock при открытии модального окна — страница позади прокручивается. |
| L7 | `protocol.ts` | Legacy `ChatEvent` и `validateChatEvent` помечены как временные, но до сих пор импортируются. Tech debt для post-launch cleanup. |
| L8 | `assistantState.ts` | `busyLabel` использует `||` вместо `??` — пустая строка `""` фоллбэчится к предыдущему значению. Вероятно, намеренно, но стоит добавить комментарий. |
| L9 | `sidepanelRender.ts` | Нет рендеринга markdown/rich text — ассистентские сообщения с code blocks отображаются plain text. Безопасно, но UX деградирует для code-heavy разговоров. |
| L10 | `backgroundStateServer.ts` | `stopDomPicker()` напрямую вызывает Chrome API вместо DI — единственное место в классе с hard dependency. |

---

## 3. Замечания по тестам (не блокеры)

| # | Проблема | Приоритет |
|---|----------|-----------|
| T1 | `validateChatEvent` (65 строк, 6 event kinds) не имеет прямых unit-тестов в `protocol.test.ts` — покрыт только транзитивно. | Low |
| T2 | `startSendingUserMessage` с пустой/whitespace строкой не тестируется напрямую в `sidepanelState.test.ts`. | Very Low |
| T3 | `agent_busy` event kind в `reduceSidePanelChatEvent` не тестируется напрямую. | Low |
| T4 | `setModel` error paths (offline, пустой provider/modelId) не покрыты в `backgroundStateServer.test.ts`. | Low |
| T5 | Heartbeat stale-client тест зависит от `ws._autoPong` — недокументированное внутреннее свойство. | Low |
| T6 | Дублирование хелперов (`createDirectSnapshot`, `FakePort`) в нескольких тест-файлах — кандидат для test-utils модуля. | Low |

---

## 4. Безопасность — итоговая оценка

| Область | Статус | Комментарий |
|---------|--------|-------------|
| XSS | ✅ Безопасно | Только `textContent`, тесты подтверждают |
| Сетевой доступ | ✅ Безопасно | Только 127.0.0.1, CSP ограничивает connect-src |
| Файловый I/O | ✅ Безопасно | `O_NOFOLLOW`, права 0o600 |
| Валидация ввода | ✅ Хорошо | Порт, текст чата, selection payload — всё валидируется |
| Санитизация ошибок | ✅ Хорошо | Внутренние детали не попадают к пользователю |
| Permissions | ⚠️ H1 | `<all_urls>` избыточен |
| WebSocket auth | ⚠️ Info | Нет аутентификации на localhost WS — допустимо для dev-инструмента, стоит задокументировать |
| Content size | ✅ Хорошо | Лимиты на обеих сторонах |

---

## 5. План действий

### Перед публикацией (блокеры)

- [ ] **H1** — Убрать `<all_urls>` из `host_permissions` в `manifest.json`
- [ ] **H2** — Увеличить потолок reconnect delay до 5–10с в `sessionClient.ts`

### Рекомендовано (до или сразу после 1.0)

- [ ] **M1** — Throttle `broadcastSnapshot` в `browserConnectExtension.ts`
- [ ] **M2** — Установить `maxPayload: 1MB` на WebSocket-сервере
- [ ] **M4** — Валидировать `session.event` payload через `validatePiMirrorEvent`
- [ ] **M7** — Заменить `execSync` на `execFileSync` в build-скрипте
- [ ] **M8** — Документировать зависимость от `rsvg-convert`

### Можно отложить (post-launch)

- [ ] **M3** — Rate limiting входящих WS-сообщений
- [ ] **M5** — On-demand injection content script
- [ ] **M6** — Унифицировать `refreshDiagnostics`/`recordDiagnostic` через `applyState()`
- [ ] **M9** — Оптимизировать diffing сообщений в `renderChat()`
- [ ] **M10** — Лимит на количество сообщений в чате
- [ ] **L1–L10** — Мелкие улучшения по необходимости

---

## 6. Вердикт

### ✅ Код production-ready с двумя обязательными доработками (H1, H2)

Ветка `feat/sidepanel-chat` представляет собой **зрелую, хорошо спроектированную реализацию** sidepanel-чата для Chrome-расширения Pi. Архитектура чистая, тесты покрывают все критические пути, безопасность проработана на уровне выше среднего для Chrome-расширений.

**Критических багов не обнаружено.** Два HIGH-замечания (избыточные разрешения и бесконечный reconnect) — это не runtime-краши, а вопросы production hardening, которые решаются за 1–2 часа.

Всё остальное — MEDIUM и LOW улучшения, которые повысят надёжность и производительность, но не блокируют выпуск.
