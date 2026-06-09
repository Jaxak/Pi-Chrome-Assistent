# Chrome-расширение

## Общая структура

Браузерная часть собрана как Chrome Manifest V3 extension и включает три основных слоя:

1. **popup** — UI выбора цели и запуска picker.
2. **background service worker** — обмен с broker, хранение настроек и диагностики.
3. **content script** — интерактивный DOM picker на странице.

Сборка кладёт артефакты в `dist/chrome`.

## Разрешения и точки входа

`src/chrome/manifest.json` задаёт:

- `permissions`: `activeTab`, `scripting`, `storage`;
- `host_permissions`: `http://127.0.0.1/*`, `ws://127.0.0.1/*`;
- `background.service_worker`: `background.js`;
- `action.default_popup`: `popup.html`.

Это означает, что расширение:

- может внедрять content script в активную вкладку;
- хранит локальное состояние в `chrome.storage.local`;
- общается только с локальным broker на loopback-интерфейсе.

## Ответственность popup

Файл: `src/chrome/popup.ts`

Popup отвечает за пользовательский сценарий перед запуском picker:

- запрашивает текущее состояние через `listTargets` и `getDiagnostics`;
- показывает список доступных Pi-целей;
- сохраняет и восстанавливает `selectedTargetId`;
- блокирует кнопку отправки, если:
  - нет выбранной цели;
  - `brokerToken` не настроен;
  - popup не смог получить состояние background/service worker;
- запускает DOM picker сообщением `startDomPicker`.

### Что popup хранит в памяти

- `currentTargets`
- `currentSelectedTargetId`
- `currentTokenConfigured`
- текст последней диагностической сводки

### Важные состояния UI

Popup использует несколько базовых подсказок:

- `Pi не подключён. Выполните /browser-connect в терминале.`
- `Нет активных целей. Выполните /browser-connect в нужной сессии Pi.`
- `Для отправки настройте brokerToken в chrome.storage.local.`
- `Выберите элемент на странице, чтобы отправить его в Pi.`

При старте picker popup закрывается через `window.close()`.

## Ответственность background

Файл: `src/chrome/background.ts`

Background — это единственная часть браузерного расширения, которая ходит к broker и пишет состояние в `chrome.storage.local`.

Он обрабатывает сообщения:

- `ping`
- `listTargets`
- `startDomPicker`
- `sendSelection`
- `pickerDiagnostic`
- `getDiagnostics`
- `clearDiagnostics`

### Что хранится в `chrome.storage.local`

- `brokerToken` — общий токен для broker;
- `selectedTargetId` — последняя выбранная цель;
- `diagnostics` — кольцевой буфер диагностических записей.

### Как background работает с broker

Для `listTargets` и `sendSelection` background:

1. открывает новый WebSocket к `ws://127.0.0.1:17345`;
2. ждёт открытия соединения;
3. при наличии токена отправляет `client.hello`;
4. отправляет основной запрос;
5. ждёт ответ по `requestId`;
6. закрывает socket.

Если `brokerToken` отсутствует, background падает **до сетевого запроса** с ошибкой:

```text
No broker token configured in chrome.storage.local
```

### Диагностика

При сбоях background добавляет записи с `phase` вроде:

- `listTargets`
- `sendSelection`
- `picker:startDomPicker`
- `picker:sendSelection`

Их потом показывает popup.

## Ответственность content script

Файл: `src/chrome/contentScript.ts`

Content script:

- внедряется по запросу background в активную вкладку;
- ставит guard, чтобы не регистрировать listener повторно;
- запускает DOM picker для выбранного `targetId`;
- собирает выделение и комментарий;
- отправляет результат в background как `sendSelection`;
- показывает toast об успехе или ошибке.

### Что делает DOM picker

- подсвечивает логический DOM-блок под курсором;
- на клик фиксирует выбранный элемент;
- открывает модальное окно комментария;
- по `Esc` полностью отменяет режим выбора.

### Сообщения пользователю

Успешная отправка показывает toast:

```text
Отправлено в Pi
```

Типовые ошибки приводятся к более понятным сообщениям, например:

- `Pi не подключён. Выполните /browser-connect в терминале.`
- `Выбранный терминал Pi недоступен. Выберите другой.`
- `Не удалось отправить в Pi: ...`

## Практические ограничения текущего UI

- В текущем коде часть popup-интерфейса и технических статусов всё ещё на английском.
- Browser token настраивается не через popup, а только вручную через `chrome.storage.local`.
- Popup показывает лишь статус доставки и диагностику, но не поток ответа Pi.

## Связанные документы

- [Обзор архитектуры](./overview.md)
- [Протокол](./protocol.md)
- [Установка и запуск](../operations/setup.md)
- [Тестирование](../operations/testing.md)
- [Устранение неполадок](../operations/troubleshooting.md)
