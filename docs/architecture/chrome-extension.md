# Chrome-расширение

## Общая структура

Браузерная часть собрана как Chrome Manifest V3 extension и включает три основных слоя:

1. **side panel** — основной UI: чат, выбор Pi-сессии, авторизация и Dev-журнал.
2. **background service worker** — служебные запросы к broker, хранение browser token, выбранной цели и диагностики.
3. **content script** — интерактивный DOM picker на странице.

Сборка кладёт артефакты в `dist/chrome`.

## Разрешения и точки входа

`src/chrome/manifest.json` задаёт:

- `permissions`: `activeTab`, `scripting`, `storage`, `sidePanel`;
- `host_permissions`: `http://127.0.0.1/*`, `ws://127.0.0.1/*`;
- `background.service_worker`: `background.js`;
- `side_panel.default_path`: `sidepanel.html`.

`background.ts` настраивает открытие боковой панели по клику на иконку расширения через Chrome Side Panel API. Popup больше не используется как точка входа.

## Ответственность side panel

Файлы:

- `src/chrome/sidepanel.html`
- `src/chrome/sidepanel.css`
- `src/chrome/sidepanel.ts`
- `src/chrome/sidepanelState.ts`
- `src/chrome/sidepanelBrokerClient.ts`

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

Side panel держит постоянное WebSocket-подключение к broker через `SidePanelBrokerClient`:

1. отправляет `client.hello` с browser token;
2. запрашивает `client.listTargets`;
3. подписывается на выбранную цель через `client.subscribeTarget`;
4. отправляет сообщения через `client.sendChatMessage`;
5. принимает `client.chatEvent` и обновляет `sidepanelState`.

Сообщения рендерятся только через `textContent`, без `innerHTML`. Markdown, tool calls и tool results в первой версии не отображаются.

После отправки сообщения side panel сразу добавляет пользовательское сообщение и показывает индикатор **«Агент работает в фоне…»**. Индикатор скрывается после `assistant_message_end`, `agent_busy(false)`, ошибки или разрыва подключения.

### DOM picker

Сценарий DOM picker сохранён и перенесён в composer kebab-меню `⋯` пунктом **«DOM picker»**. При выборе пункта side panel отправляет в background сообщение `startDomPicker` с текущим `targetId`. Боковая панель остаётся открытой, пока пользователь выбирает элемент на странице.

### Авторизация и Dev-журнал

Экран **«Авторизация»** показывает browser token, умеет копировать, перевыпускать и удалять token.

Экран **«Dev-журнал»** показывает диагностические записи из background и позволяет обновить их.

## Ответственность background

Файл: `src/chrome/background.ts`

Background обрабатывает сообщения:

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

Для legacy/служебных запросов `listTargets` и `sendSelection` background открывает короткоживущее WebSocket-соединение к `ws://127.0.0.1:17345`, выполняет `client.hello`, отправляет запрос, ждёт ответ и закрывает socket.

Постоянное chat-подключение живёт в side panel, а не в background.

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
