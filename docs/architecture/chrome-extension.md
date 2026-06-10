# Chrome-расширение

## Общая структура

Браузерная часть собрана как Chrome Manifest V3 extension и включает три основных слоя:

1. **popup** — вкладки `Асистент | Сессии | Авторизация`.
2. **background service worker** — обмен с broker, хранение состояния и диагностики.
3. **content script** — интерактивный DOM picker на странице.

Сборка кладёт артефакты в `dist/chrome`.

## Разрешения и точки входа

`src/chrome/manifest.json` задаёт:

- `permissions`: `activeTab`, `scripting`, `storage`;
- `host_permissions`: `http://127.0.0.1/*`, `ws://127.0.0.1/*`;
- `background.service_worker`: `background.js`;
- `action.default_popup`: `popup.html`.

## Ответственность popup

Файл: `src/chrome/popup.ts`

Popup разделён на три вкладки.

### Вкладка «Асистент»

- показывает основной статус подключения;
- содержит единственную primary-кнопку **«Отправить в Pi»**;
- не показывает техническую диагностику.

### Вкладка «Сессии»

- показывает список активных Pi-целей;
- сохраняет и восстанавливает `selectedTargetId`;
- показывает диагностику и позволяет обновить состояние.

### Вкладка «Авторизация»

- запрашивает `getBrowserAuthState` у background;
- показывает текущий browser token;
- умеет копировать token;
- умеет перевыпускать token;
- умеет удалять token.

## Ответственность background

Файл: `src/chrome/background.ts`

Background — единственная часть браузерного расширения, которая ходит к broker и пишет состояние в `chrome.storage.local`.

Он обрабатывает сообщения:

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

### Что хранится в `chrome.storage.local`

- `browserToken` — token текущей установки браузера;
- `selectedTargetId` — последняя выбранная цель;
- `diagnostics` — кольцевой буфер диагностических записей.

### Как background работает с broker

Для `listTargets` и `sendSelection` background:

1. открывает новый WebSocket к `ws://127.0.0.1:17345`;
2. ждёт открытия соединения;
3. отправляет `client.hello` с browser token;
4. отправляет основной запрос;
5. ждёт ответ по `requestId`;
6. закрывает socket.

Если token отсутствует, background завершает запрос раньше сети и возвращает понятную ошибку.

## Ответственность content script

Файл: `src/chrome/contentScript.ts`

Content script:

- внедряется по запросу background в активную вкладку;
- запускает DOM picker для выбранной Pi-цели;
- собирает выделение и комментарий;
- отправляет результат в background как `sendSelection`;
- показывает toast об успехе или ошибке.

## Практические ограничения текущего UI

- Popup не показывает поток ответа Pi.
- Авторизация браузера и публикация Pi-сессии — это два отдельных шага.
- Диагностика остаётся техническим экраном на вкладке **«Сессии»**, а не частью основного сценария **«Асистент»**.

## Связанные документы

- [Обзор архитектуры](./overview.md)
- [Протокол](./protocol.md)
- [Установка и запуск](../operations/setup.md)
- [Тестирование](../operations/testing.md)
