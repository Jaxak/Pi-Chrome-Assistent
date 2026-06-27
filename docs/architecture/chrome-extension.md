# Chrome-расширение

## Общая структура

Браузерная часть собрана как Chrome Manifest V3 extension и включает три основных слоя:

1. **side panel** — UI-клиент: чат, выбор Pi-сессии, авторизация и Dev-журнал без собственного интеграционного состояния.
2. **background service worker** — единственный владелец browser token, постоянного WebSocket к broker, выбранной цели, chat-доставки, diagnostics и connection status.
3. **content script** — интерактивный DOM picker на странице.

Сборка кладёт артефакты в `dist/chrome`.

## Разрешения и точки входа

`src/chrome/manifest.json` задаёт:

- `permissions`: `activeTab`, `scripting`, `storage`, `sidePanel`;
- `host_permissions`: `http://127.0.0.1/*`, `ws://127.0.0.1/*`;
- `background.service_worker`: `background.js`;
- `side_panel.default_path`: `sidepanel.html`.

`background.ts` настраивает открытие боковой панели по клику на иконку расширения через Chrome Side Panel API. Popup больше не используется как точка входа.

## Владение состоянием и поток данных

В браузере есть один авторитетный владелец интеграционного состояния — background service worker. Он создаёт и поддерживает broker WebSocket через `BrokerClient`, хранит текущий browser token, список Pi-целей, выбранную цель, состояние чата, диагностику и итоговый статус подключения.

Side panel не открывает broker WebSocket и не вычисляет connection status самостоятельно. Она подключается к background через долгоживущий `chrome.runtime.Port` с именем `sidepanel`, получает immutable state snapshots и отправляет только команды пользователя.

Потоки данных:

- **background → sidepanel:** snapshots состояния `assistant.snapshot` с `BackgroundAssistantState`;
- **sidepanel → background:** команды `assistant.selectTarget`, `assistant.sendChatMessage`, `assistant.model.set`, `assistant.startDomPicker`, `assistant.auth.*`, `assistant.diagnostics.refresh`;
- **background → broker:** постоянный WebSocket для списка целей, подписки на выбранную цель, chat-доставки, runtime state и смены модели;
- **background → content script:** запуск DOM picker и пересылка выделения в выбранную Pi-цель.

## Ответственность side panel

Файлы:

- `src/chrome/sidepanel.html`
- `src/chrome/sidepanel.css`
- `src/chrome/sidepanel.ts`
- `src/chrome/sidepanelRender.ts`
- `src/chrome/sidepanelState.ts`

Боковая панель визуально следует Ant Compact с оливковой primary-палитрой, но реализована вручную без React и без зависимости от Ant Design.

Основные элементы:

- header **«Ассистент»** со статусом подключения и badge **«готов»**;
- header kebab-меню:
  - **«Настройки»** — disabled;
  - **«Авторизация»**;
  - **«Dev-журнал»**;
- блок выбора **«Сессия»**;
- основной plain text чат;
- composer с textarea **«Сообщение ассистенту»**, кнопкой **«Отправить»** и kebab-меню **«DOM picker»**.

### Чат

Side panel отображает чат из snapshots background и отправляет пользовательские действия командами в background:

1. при открытии создаёт `chrome.runtime.connect({ name: "sidepanel" })`;
2. получает `assistant.snapshot` с текущими целями, выбранной целью, сообщениями, busy/sending/error и auth-статусом;
3. при выборе цели отправляет `assistant.selectTarget`;
4. при отправке текста отправляет `assistant.sendChatMessage`;
5. при смене модели отправляет `assistant.model.set`;
6. при запуске DOM picker отправляет `assistant.startDomPicker`.

Под полем ввода side panel показывает текущую модель выбранной Pi-сессии и заполненность контекстного окна. Список моделей приходит из target Pi-сессии через broker, поэтому смена модели применяется именно в выбранной Pi-сессии, а не только в UI.

Сообщения рендерятся только через `textContent`, без `innerHTML`. Markdown, tool calls и tool results в первой версии не отображаются.

После отправки сообщения background добавляет пользовательское сообщение в состояние и показывает индикатор **«Агент работает в фоне…»**. Индикатор скрывается после `assistant_message_end`, `agent_busy(false)`, ошибки или разрыва подключения; side panel только отражает очередной snapshot.

### DOM picker

Сценарий DOM picker сохранён в composer kebab-меню `⋯` пунктом **«DOM picker»**. При выборе пункта side panel отправляет в background команду `assistant.startDomPicker`. Background использует выбранную цель из собственного состояния. Боковая панель остаётся открытой, пока пользователь выбирает элемент на странице.

### Авторизация и Dev-журнал

Экран **«Авторизация»** показывает browser token из snapshot, умеет копировать, перевыпускать и удалять token через команды `assistant.auth.refresh`, `assistant.auth.regenerateToken` и `assistant.auth.clearToken`.

Экран **«Dev-журнал»** показывает диагностические записи из background и позволяет обновить их командой `assistant.diagnostics.refresh`.

## Ответственность background

Файлы:

- `src/chrome/background.ts`
- `src/chrome/backgroundStateServer.ts`
- `src/chrome/brokerClient.ts`

Background service worker владеет browser-side state server и постоянным WebSocket к `ws://127.0.0.1:17345`. Он:

- загружает browser token и выбранную цель из `chrome.storage.local`;
- открывает broker WebSocket, отправляет `client.hello`, получает список целей и подписывается на выбранную цель;
- использует one-shot `listTargets` только как refresh/fallback и не заменяет им live `BrokerClient`;
- принимает chat/runtime/model-события broker и сводит их в `BackgroundAssistantState`;
- рассылает snapshots всем подключённым sidepanel ports;
- применяет команды side panel и сохраняет выбранную цель;
- пишет diagnostics в `chrome.storage.local` и показывает их в snapshots;
- перезапускает broker client при смене token и игнорирует поздние события старого поколения.

Side panel переживает разрыв `chrome.runtime.Port`: показывает статус **«Переподключаем боковую панель…»**, сохраняет последний snapshot и переподключается к background с коротким backoff. После reconnect background снова отправляет полный authoritative snapshot.

Background также обрабатывает legacy/служебные сообщения:

- `ping`
- `listTargets`
- `startDomPicker`
- `sendSelection`
- `pickerDiagnostic`
- `getDiagnostics`
- `clearDiagnostics`
- `getBrowserAuthState`
- `regenerateBrowserToken`
- `clearBrowserToken`

Для legacy/служебных запросов `listTargets` и `sendSelection` background может открыть короткоживущее WebSocket-соединение к broker, выполнить `client.hello`, отправить запрос, дождаться ответа и закрыть socket. Основной chat-канал при этом остаётся background-owned.

### Что хранится в `chrome.storage.local`

- `browserToken` — token текущей установки браузера;
- `selectedTargetId` — последняя выбранная цель;
- `diagnostics` — кольцевой буфер диагностических записей.

## Ответственность content script

Файл: `src/chrome/contentScript.ts`

Content script:

- внедряется по запросу background в активную вкладку;
- запускает DOM picker для выбранной Pi-цели;
- строит упорядоченную цепочку кандидатов вокруг элемента под курсором;
- показывает overlay с действиями **«Отправить» / «Отмена»** и комментарий перед отправкой;
- собирает выделение и комментарий;
- отправляет результат в background как `sendSelection`;
- показывает toast об успехе или ошибке.

## Визуальная тема расширения

UI расширения использует оливковую тему:

- side panel следует Ant Compact tokens: плотные отступы, карточки, select-like target list, textarea, primary button, badge;
- overlay DOM picker и toast используют согласованный визуальный стиль.

## Ограничения текущего UI

- Первая версия side panel chat показывает только plain text.
- Tool calls и tool results не отображаются.
- История чата не восстанавливается после закрытия боковой панели или перезапуска браузера.
- Browser authorization и публикация Pi-сессии остаются двумя отдельными шагами.

## Связанные документы

- [Обзор архитектуры](./overview.md)
- [Протокол](./protocol.md)
- [Установка и запуск](../operations/setup.md)
- [Тестирование](../operations/testing.md)
