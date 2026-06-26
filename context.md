# Code Context

## Files Retrieved
1. `src/chrome/sidepanel.ts` (lines 179-190, 692-713, 721-755, 908-910, 925-970) - sidepanel state refresh, persistent broker callbacks, DOM picker click path, Dev-журнал refresh.
2. `src/chrome/sidepanelBrokerClient.ts` (lines 126-130, 191-200, 211-233, 250-258, 318-329) - persistent websocket status/reconnect and one-shot target list subscription behavior.
3. `src/pi/broker.ts` (lines 453-469, 594-618, 756-822, 825-839, 906-915) - broker target register/unregister/list flows; no target-list broadcast to browser clients.
4. `src/chrome/sidepanel.html` (lines 78-105) - drawer/back button IDs for auth and Dev-журнал.
5. `src/chrome/background.ts` (lines 93-95, 517-558, 634-657) - active tab lookup and startDomPicker/listTargets runtime handlers.

## Key Code

### Сравнение с `main`
`git diff --name-status main...HEAD` показывает, что sidepanel в этой ветке новая: `src/chrome/sidepanel.{html,css,ts}`, `sidepanelBrokerClient.ts`, render/state tests добавлены; в `main` этих файлов нет. Жалобы относятся к новой реализации ветки `feat/sidepanel-chat`, а не к регрессии существующего main UI.

### Root causes

1. **Список Pi-сессий не обновляется динамически**
   - Sidepanel делает `refreshSidePanelState()` только при инициализации и по кнопке Dev-журнала `Обновить`: `src/chrome/sidepanel.ts` lines 704-713, 908-910.
   - Persistent client запрашивает `client.listTargets` только один раз при `open`: `src/chrome/sidepanelBrokerClient.ts` lines 191-200.
   - Broker отвечает на `client.listTargets` только текущим снимком: `src/pi/broker.ts` lines 594-618.
   - При `target.register`, `target.unregister`, socket close/stale cleanup нет рассылки `client.targets` всем browser clients: регистрация заканчивается `target.registered` и log, `src/pi/broker.ts` lines 756-822; unregister только удаляет из state/log, lines 453-469; close вызывает unregister, lines 906-915.
   - Риск фикса: потребуется протокольное решение (push target list на browser sockets или polling). Нужно аккуратно не сломать auth/token boundaries и тесты broker/background/sidepanel.

2. **DOM picker из sidepanel может запускаться не на странице пользователя**
   - Sidepanel отправляет только `{ type: "startDomPicker", targetId }` без tabId/windowId: `src/chrome/sidepanel.ts` lines 955-958.
   - Background выбирает `chrome.tabs.query({ active: true, currentWindow: true })`: `src/chrome/background.ts` lines 93-95, затем inject/sendMessage в этот tabId, lines 517-558.
   - Из side panel `currentWindow`/active tab может быть не ожидаемой вкладкой страницы (особенно после фокуса panel/window changes); нет передачи last active tab из sidepanel или tab capture при открытии sidepanel.
   - Риск фикса: Chrome sidePanel API/tab focus semantics; нужно проверить документацию Pi/Chrome и добавить тесты на явный tabId/ошибки restricted URLs.

3. **Кнопка “Назад” в Dev-журнале не возвращает в чат**
   - В `sidepanel.html` кнопка Dev-журнала “Назад” имеет `id="tab-sessions"`: `src/chrome/sidepanel.html` line 98.
   - `getSidePanelElements()` трактует `#tab-sessions` как `sessionsTabButton`; обработчик клика вызывает `activateTab(elements, "sessions")`, т.е. остается на Dev-журнале: `src/chrome/sidepanel.ts` lines 692-697 и обработчик sessions tab в initialize (около lines 837-839 по файлу).
   - Auth drawer работает иначе: “Назад” имеет `id="tab-assistant"`, line 80.
   - Риск фикса низкий: переименовать/подключить back button на assistant; добавить тест DOM/render на Dev-журнал back.

4. **Мигание статуса “Pi недоступен”**
   - Два независимых источника пишут в один `#status-text`:
     - `refreshSidePanelState()` ставит результат one-shot `listTargets`/guidance: `src/chrome/sidepanel.ts` lines 728-755.
     - `SidePanelBrokerClient` через `onConnectionState` немедленно пишет `Подключаемся к Pi…`, `Pi подключён`, `Pi недоступен`: `src/chrome/sidepanel.ts` lines 179-190; client connect/error/close/reconnect: `src/chrome/sidepanelBrokerClient.ts` lines 126-130, 211-233, 318-329.
   - При недоступном broker `error` и `close` оба репортят `Pi недоступен`, потом reconnect пишет `Подключаемся к Pi…`; параллельно refresh может писать `Pi не подключён...` или `Фоновый скрипт недоступен`.
   - Риск фикса: нужно развести connection state для chat bridge и summary/list status или debounce/state machine, иначе можно скрыть реальные auth/token ошибки.

## Architecture
- Sidepanel UI (`sidepanel.html` + `sidepanel.ts`) общается с background через `chrome.runtime.sendMessage` для `listTargets`, `getDiagnostics`, `startDomPicker`, browser token actions.
- Background (`background.ts`) для `listTargets` открывает краткоживущий authenticated websocket к local Pi broker и закрывает его; для `startDomPicker` inject-ит `contentScript.js` в active tab.
- Sidepanel chat additionally держит persistent websocket через `SidePanelBrokerClient`; он auth/listTargets/subscribeTarget и получает `client.chatEvent`.
- Broker (`src/pi/broker.ts`) хранит targets в памяти и маршрутизирует selection/chat, но сейчас не публикует изменения target registry браузерным клиентам.

## Start Here
Открыть `src/chrome/sidepanel.ts`: там сходятся все четыре пользовательские жалобы (target render/refresh, shared status, Dev-журнал navigation handlers, DOM picker command). Для динамического списка сразу смотреть вместе с `src/chrome/sidepanelBrokerClient.ts` и `src/pi/broker.ts`.

## Supervisor coordination
Не требовалось; блокеров нет. Изменения в код не вносились.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Scope limited to investigation; no source code edits, only context/progress artifacts written. Root causes include requested sidepanel session updates, DOM picker, Dev-журнал back button, and Pi unavailable status flicker with files/lines and risks."
    }
  ],
  "changedFiles": [
    "context.md",
    "progress.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git status --short && git branch --show-current && git rev-parse --abbrev-ref main",
      "result": "passed",
      "summary": "Confirmed branch feat/sidepanel-chat and pre-existing modified sidepanel files; main ref exists."
    },
    {
      "command": "git diff --stat main...HEAD && git diff --name-status main...HEAD",
      "result": "passed",
      "summary": "Compared branch with main; sidepanel files are new in this branch."
    },
    {
      "command": "grep/find/read targeted source inspection",
      "result": "passed",
      "summary": "Inspected sidepanel, broker client, broker, background, and sidepanel HTML relevant ranges."
    },
    {
      "command": "nl -ba ... | sed -n ...",
      "result": "passed",
      "summary": "Collected exact line numbers for cited root causes."
    }
  ],
  "validationOutput": [],
  "residualRisks": [
    "Repository had pre-existing unstaged source changes before investigation: src/chrome/sidepanelBrokerClient.ts and src/chrome/sidepanelBrokerClient.test.ts plus untracked docs/plans.",
    "No runtime/browser validation was performed; findings are static code analysis."
  ],
  "noStagedFiles": true,
  "notes": "No source files were edited."
}
```
