# Исправление регрессий интеграции Chrome Side Panel Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** восстановить стабильную интеграцию Chrome расширения с Pi после перехода на side panel: стабильный статус подключения, динамический список Pi-сессий, рабочий DOM picker и корректная навигация Dev-журнала.

**Architecture:** проблема не должна исправляться точечными патчами в UI. Нужно разделить состояния broker/авторизации/targets/chat, добавить push-обновления списка targets из broker в browser clients, привести DOM picker к sidepanel-compatible flow с явной целевой вкладкой и покрыть сценарии регрессионными тестами.

**Tech Stack:** TypeScript, Chrome Extension Manifest V3, Chrome Side Panel API, WebSocket protocol между Chrome background/sidepanel и Pi broker, Vitest/jsdom, Pi extension API.

---

## Контекст расследования

Ветка: `feat/sidepanel-chat`.

Сравнение с `main` показало, что рабочий popup-flow был заменён на новую sidepanel-архитектуру:

- добавлены `src/chrome/sidepanel.*`;
- добавлен persistent WebSocket client `src/chrome/sidepanelBrokerClient.ts`;
- расширен broker/chat protocol в `src/pi/broker.ts`, `src/pi/targetClient.ts`, `src/shared/protocol.ts`;
- manifest переключён с `default_popup` на `side_panel.default_path`.

Проверка, выполненная во время расследования:

```bash
npm test -- --run src/chrome/sidepanelBrokerClient.test.ts src/chrome/sidepanelRender.test.ts src/chrome/background.test.ts src/pi/broker.test.ts
```

Результат: тесты проходят, но не покрывают пользовательские регрессии.

---

## Root Cause Summary

### 1. Статус «Pi недоступен» моргает

**Файлы:**

- `src/chrome/sidepanel.ts`
- `src/chrome/sidepanelBrokerClient.ts`

**Причина:** один DOM-статус `#status-text` обновляется из нескольких независимых потоков:

1. `refreshSidePanelState()` делает one-shot `listTargets` через background и пишет summary/guidance.
2. `SidePanelBrokerClient` пишет WebSocket lifecycle: `Подключаемся к Pi…`, `Pi подключён`, `Pi недоступен`.
3. Ошибки уровня выбранной target-сессии могут визуально выглядеть как недоступность всего Pi.

**Вывод:** нужен единый state reducer/status model, а не прямые записи в UI из разных callback-ов.

---

### 2. Список Pi-сессий не обновляется динамически

**Файлы:**

- `src/chrome/sidepanelBrokerClient.ts`
- `src/chrome/sidepanel.ts`
- `src/pi/broker.ts`

**Причина:** sidepanel живёт долго, но список targets остался request/response-моделью popup.

Сейчас:

- sidepanel запрашивает `client.listTargets` при открытии WebSocket;
- broker возвращает `client.targets` только как ответ на `client.listTargets`;
- при `target.register`, `target.unregister`, socket close и stale cleanup broker не рассылает обновлённый список browser clients.

В `main` popup переоткрывался и каждый раз получал новый snapshot. В sidepanel это стало регрессией.

---

### 3. DOM picker не работает из sidepanel

**Файлы:**

- `src/chrome/sidepanel.ts`
- `src/chrome/background.ts`
- `src/chrome/manifest.json`
- `src/chrome/contentScript.ts`

**Причина:** popup-flow полагался на `activeTab` grant после клика по extension action. Sidepanel flow запускает picker позже из постоянной панели.

Сейчас sidepanel отправляет только:

```ts
{ type: "startDomPicker", targetId }
```

А background сам выбирает вкладку через:

```ts
chrome.tabs.query({ active: true, currentWindow: true })
```

Это ненадёжно для sidepanel: активная вкладка могла измениться, окно могло измениться, а permission на injection может отсутствовать.

---

### 4. Кнопка «Назад» в Dev-журнале не работает

**Файлы:**

- `src/chrome/sidepanel.html`
- `src/chrome/sidepanel.ts`

**Причина:** кнопка «Назад» внутри Dev-журнала имеет `id="tab-sessions"`, а обработчик `#tab-sessions` активирует вкладку `sessions`, то есть сам Dev-журнал.

Нужно разделить id кнопки открытия панели и id кнопки возврата.

---

## Implementation Tasks

### Task 1: Зафиксировать регрессию Dev-журнала тестом

**TDD scenario:** New failing regression test.

**Files:**

- Modify: `src/chrome/sidepanelRender.test.ts` или создать отдельный `src/chrome/sidepanelNavigation.test.ts`
- Read: `src/chrome/sidepanel.html`
- Read: `src/chrome/sidepanel.ts`

**Step 1: Write failing test**

Проверить сценарий:

1. sidepanel стартует на assistant panel;
2. пользователь нажимает header menu → `Dev-журнал`;
3. видна panel sessions/devlog;
4. пользователь нажимает `Назад`;
5. снова видна assistant panel.

**Step 2: Run test to verify it fails**

```bash
npm test -- --run src/chrome/sidepanelNavigation.test.ts
```

Expected: FAIL, потому что back button остаётся на Dev-журнале.

**Step 3: Implement minimal fix**

- В `src/chrome/sidepanel.html` заменить id кнопки назад в Dev-журнале:

```html
<button id="devlog-back-button" class="button-secondary button-compact" type="button">Назад</button>
```

- В `src/chrome/sidepanel.ts` добавить элемент в `SidePanelElements` и обработчик:

```ts
devlogBackButton: HTMLButtonElement | null;
```

```ts
devlogBackButton: document.querySelector<HTMLButtonElement>("#devlog-back-button"),
```

```ts
elements.devlogBackButton?.addEventListener("click", () => {
  activateTab(elements, "assistant");
});
```

**Step 4: Verify**

```bash
npm test -- --run src/chrome/sidepanelNavigation.test.ts
```

Expected: PASS.

---

### Task 2: Ввести broker push-update для списка targets

**TDD scenario:** New broker protocol tests first.

**Files:**

- Modify: `src/pi/broker.ts`
- Modify: `src/pi/broker.test.ts`
- Possibly modify: `src/shared/protocol.ts`
- Possibly modify: `src/shared/protocol.test.ts`

**Step 1: Write failing tests in broker**

Добавить тесты:

1. authenticated browser socket получает `client.targets` после нового `target.register` без повторного `client.listTargets`;
2. authenticated browser socket получает `client.targets` после `target.unregister`;
3. authenticated browser socket получает `client.targets` после закрытия target socket;
4. unauthenticated browser socket не получает список targets.

**Step 2: Run test to verify failure**

```bash
npm test -- --run src/pi/broker.test.ts
```

Expected: FAIL, потому что broker сейчас не делает fan-out targets.

**Step 3: Implement broker fan-out**

В `startBrokerServer()` добавить helper:

```ts
const sendTargetsSnapshotToClient = (socket: WebSocket, requestId?: string) => {
  sendEnvelope(socket, {
    type: "client.targets",
    requestId,
    payload: { targets: state.listTargets() },
  });
};

const broadcastTargetsSnapshot = () => {
  for (const browserSocket of authenticatedClientSockets) {
    sendTargetsSnapshotToClient(browserSocket);
  }
};
```

Использовать:

- после успешного `target.register`;
- после `unregisterSocketTarget()` если target реально удалён;
- после stale cleanup;
- не рассылать unauthenticated sockets.

**Step 4: Keep listTargets compatible**

В обработчике `client.listTargets` заменить inline `sendEnvelope` на `sendTargetsSnapshotToClient(socket, envelope.requestId)`.

**Step 5: Verify**

```bash
npm test -- --run src/pi/broker.test.ts src/shared/protocol.test.ts
```

Expected: PASS.

---

### Task 3: Научить sidepanel client принимать динамические targets

**TDD scenario:** New SidePanelBrokerClient tests.

**Files:**

- Modify: `src/chrome/sidepanelBrokerClient.ts`
- Modify: `src/chrome/sidepanelBrokerClient.test.ts`

**Step 1: Write failing tests**

Добавить сценарии:

1. после initial `client.targets` приходит unsolicited `client.targets` с новой целью — `onTargets` вызывается повторно;
2. после disappearance выбранной цели `SidePanelBrokerClient` не переводит Pi в offline;
3. если selected target исчез, sidepanel получает пустой/обновлённый target list.

**Step 2: Run test to verify failure**

```bash
npm test -- --run src/chrome/sidepanelBrokerClient.test.ts
```

**Step 3: Implement**

`handleEnvelope()` уже принимает `client.targets`; убедиться, что:

- не требуется matching requestId;
- `reportState(true, "Pi подключён")` вызывается только после успешной auth/list snapshot;
- если selected target отсутствует в snapshot, не отправлять subscribe и не писать `Pi недоступен`.

**Step 4: Verify**

```bash
npm test -- --run src/chrome/sidepanelBrokerClient.test.ts
```

Expected: PASS.

---

### Task 4: Перестроить status model sidepanel

**TDD scenario:** Modifying tested code — write focused unit tests for pure helpers/reducer.

**Files:**

- Modify: `src/chrome/sidepanelState.ts`
- Modify: `src/chrome/sidepanelState.test.ts`
- Modify: `src/chrome/sidepanel.ts`

**Step 1: Add state fields**

Расширить state модель или добавить отдельную модель статуса:

```ts
type SidePanelConnectionStatus = {
  brokerOnline: boolean;
  bridgeOnline: boolean;
  tokenConfigured: boolean | undefined;
  browserAuthorized: boolean | undefined;
  targetsCount: number;
  selectedTargetId?: string;
  selectedTargetAvailable: boolean;
  lastError?: string;
  connecting: boolean;
};
```

**Step 2: Add status formatting tests**

Покрыть тексты:

- broker unavailable → `Pi не подключён. Выполните /chrome-assistent-connect в терминале.`
- token missing → `Для отправки настройте browserToken...`
- auth error → `Браузер не авторизован в Pi...`
- targets empty → `Pi подключён · нет активных целей`
- selected target gone → `Pi подключён · выбранная сессия закрыта`
- normal → `Pi подключён · целей: N`

**Step 3: Run tests to verify failure**

```bash
npm test -- --run src/chrome/sidepanelState.test.ts
```

**Step 4: Implement formatter/reducer**

Сделать одну функцию вычисления статуса, например:

```ts
export function formatSidePanelStatus(status: SidePanelConnectionStatus): string
```

В `sidepanel.ts` заменить прямые конкурирующие `setStatus()` из разных callback-ов на обновление state + один render status.

**Step 5: Verify no flicker regressions in tests**

```bash
npm test -- --run src/chrome/sidepanelState.test.ts src/chrome/sidepanelBrokerClient.test.ts
```

---

### Task 5: Укрепить WebSocket lifecycle и reconnect

**TDD scenario:** New tests around timeout/error/close.

**Files:**

- Modify: `src/chrome/sidepanelBrokerClient.ts`
- Modify: `src/chrome/sidepanelBrokerClient.test.ts`
- Modify if needed: `src/chrome/sidepanel.ts`

**Step 1: Add failing tests**

Покрыть:

1. socket `error` приводит к controlled close/reconnect, а не только к status update;
2. initial `client.hello`/`client.listTargets` timeout закрывает socket и планирует reconnect;
3. auth error не запускает бесконечное мигание, а сообщает состояние авторизации;
4. `close()` игнорирует late open/message/error.

**Step 2: Run failure**

```bash
npm test -- --run src/chrome/sidepanelBrokerClient.test.ts
```

**Step 3: Implement lifecycle state**

Добавить:

- initial handshake timeout;
- `closeCurrentSocketForReconnect(reason)`;
- дедупликацию одинаковых connection state events;
- отдельную обработку auth/token errors.

**Step 4: Verify**

```bash
npm test -- --run src/chrome/sidepanelBrokerClient.test.ts
```

---

### Task 6: Исправить DOM picker sidepanel-flow

**TDD scenario:** Regression tests in background + sidepanel.

**Files:**

- Modify: `src/chrome/background.ts`
- Modify: `src/chrome/background.test.ts`
- Modify: `src/chrome/sidepanel.ts`
- Modify or verify: `src/chrome/manifest.json`
- Read: `src/chrome/contentScript.ts`

**Step 1: Add background tests**

Покрыть:

1. `startDomPicker` принимает explicit `tabId` и использует его;
2. invalid/missing tabId возвращает русскую ошибку;
3. restricted URLs возвращают русскую ошибку до `executeScript`;
4. scripting permission error возвращается в response и пишется в diagnostics.

**Step 2: Run failure**

```bash
npm test -- --run src/chrome/background.test.ts
```

**Step 3: Pass target tab from sidepanel**

В sidepanel перед отправкой `startDomPicker` получить целевую вкладку явно.

Минимальный вариант:

```ts
const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
```

и отправить:

```ts
{
  type: "startDomPicker",
  targetId: selectedTargetId,
  tabId: activeTab.id,
}
```

Если `chrome.tabs` недоступен в sidepanel typing/test harness — запросить tab через background отдельным message или расширить существующий `startDomPicker` так, чтобы tab resolution был централизован, но явно проверялся и логировался.

**Step 4: Validate in background**

В `background.ts`:

- принять `tabId?: unknown`;
- если tabId передан, использовать его;
- получить tab через `chrome.tabs.get(tabId)`;
- проверить URL:

```ts
function canInjectIntoTabUrl(url: string | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}
```

Текст ошибки — на русском.

**Step 5: Decide permissions**

Если `activeTab` grant всё ещё ненадёжен из sidepanel, выбрать один путь:

- добавить optional host permissions и запрос permission по пользовательскому клику;
- или документированно показывать пользователю понятную ошибку, что нужно активировать страницу/дать доступ.

Без этого DOM picker будет оставаться flaky.

**Step 6: Verify**

```bash
npm test -- --run src/chrome/background.test.ts src/chrome/contentScript.test.ts src/chrome/contentScriptMessages.test.ts
```

---

### Task 7: Синхронизировать selected target при dynamic updates

**TDD scenario:** Sidepanel state tests.

**Files:**

- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/sidepanelState.ts`
- Modify: `src/chrome/sidepanelState.test.ts`

**Step 1: Add tests**

Покрыть:

1. если selected target остался в списке — сохраняем выбор;
2. если selected target исчез — сбрасываем выбор и отключаем send/chat;
3. если появляется только одна target-сессия — не выбирать её автоматически без явного правила, либо выбрать только если это сохранённый targetId;
4. storage failure не ломает in-memory state.

**Step 2: Implement state transitions**

В `onTargets` sidepanel:

```ts
const previousSelectedTargetId = currentSelectedTargetId;
currentTargets = targets;
currentSelectedTargetId = chooseSelectedTargetId(currentTargets, [previousSelectedTargetId]);
```

Если target исчез:

- вызвать `currentBrokerClient?.setSelectedTargetId(undefined)`;
- очистить chat selected target;
- показать guidance.

**Step 3: Verify**

```bash
npm test -- --run src/chrome/sidepanelState.test.ts src/chrome/sidepanelBrokerClient.test.ts
```

---

### Task 8: Убрать reconnect churn при auth/token изменениях

**TDD scenario:** Sidepanel auth lifecycle tests.

**Files:**

- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/sidepanelState.test.ts` or new sidepanel auth test

**Step 1: Add tests**

Покрыть:

1. repeated render of same browser token does not close/recreate broker client;
2. `clearBrowserToken` closes current broker client;
3. regenerate token reconnects exactly once;
4. token missing sets `currentTokenConfigured = false` and disables send/chat.

**Step 2: Implement**

Хранить current connected token:

```ts
let currentBrokerClientToken: string | undefined;
```

В `connectPersistentBrokerClient()`:

- если token не изменился и client уже есть — не переподключать;
- если token изменился — close old client и создать новый.

При token cleared:

- close client;
- reset bridge state;
- update buttons/status.

**Step 3: Verify**

```bash
npm test -- --run src/chrome/sidepanelState.test.ts src/chrome/sidepanelBrokerClient.test.ts
```

---

### Task 9: End-to-end verification checklist

**TDD scenario:** Manual verification after automated tests.

**Files:**

- No source modifications in this task unless verification finds a bug.

**Step 1: Run full automated checks**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all pass.

**Step 2: Manual Chrome verification**

1. Build extension.
2. Reload extension in Chrome.
3. Open sidepanel.
4. Without Pi connection: verify stable Russian guidance, no flicker loop.
5. Run `/chrome-assistent-connect` in Pi.
6. Verify session appears without closing sidepanel.
7. Start another Pi session and run `/chrome-assistent-connect`.
8. Verify second session appears dynamically.
9. Close one terminal/session.
10. Verify target disappears dynamically.
11. Select live session and send chat message.
12. Verify busy state clears after response/error.
13. Run DOM picker on normal `https://` page.
14. Verify selected DOM fragment reaches Pi.
15. Try DOM picker on restricted page (`chrome://`, new tab).
16. Verify clear Russian error and Dev-журнал entry.
17. Open header menu → Dev-журнал → Назад.
18. Verify return to assistant panel.

**Step 3: Inspect changed scope**

Project instructions require GitNexus before commit. If GitNexus tools are available in the execution environment, run the required change detection before committing:

```bash
npx gitnexus analyze
```

Then use the configured GitNexus change detection tool if available.

---

## Risk Notes

### High risk

- Broker target push updates touch protocol flow and authenticated browser sockets.
- DOM picker permissions may require manifest/permission UX decision.
- WebSocket lifecycle changes can affect chat streaming and selection delivery.

### Medium risk

- Status model refactor can change visible Russian UI strings.
- Token lifecycle changes can affect authorization onboarding.

### Low risk

- Dev-журнал back button id/handler split.

---

## Acceptance Criteria

Исправление считается готовым только если:

- список Pi-сессий обновляется без закрытия/открытия sidepanel;
- закрытая Pi-сессия исчезает из списка без ручного refresh;
- запуск новой Pi-сессии появляется в sidepanel автоматически;
- `Pi недоступен` не моргает при нормальном подключении и reconnect;
- target-level errors не отображаются как broker/Pi offline;
- DOM picker запускается на ожидаемой вкладке или показывает понятную русскую ошибку;
- Dev-журнал `Назад` возвращает в чат;
- все пользовательские строки в UI/ошибках остаются на русском;
- `npm test`, `npm run typecheck`, `npm run build` проходят.
