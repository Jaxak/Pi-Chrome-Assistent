# Production Sidepanel State Server Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Убрать гонки состояния в боковой панели, сделав background service worker единственным владельцем состояния интеграции Chrome ⇄ Pi, а sidepanel — только UI-клиентом состояния и команд.

**Architecture:** Вводим единый browser-side state server в `background.ts`/новом модуле `backgroundStateServer.ts`. Только он владеет browser token, broker WebSocket, списком Pi targets, выбранной target-сессией, chat delivery, diagnostics и connection status. Sidepanel подключается к нему через `chrome.runtime.connect` Port, получает immutable snapshots/events и отправляет команды (`selectTarget`, `sendChatMessage`, `startDomPicker`, `auth.*`, `diagnostics.refresh`), но больше не открывает broker WebSocket и не вычисляет connection state самостоятельно.

**Tech Stack:** Chrome Extension Manifest V3 service worker, TypeScript, WebSocket protocol `ws://127.0.0.1:17345`, Chrome runtime Port messaging, `chrome.storage.local`, Vitest/jsdom, existing Pi broker protocol.

---

## Design Decision

### Единственный владелец состояния

Authoritative owner: **background state server**.

Sidepanel больше не должна иметь такие mutable globals как источник правды:

- `currentTargets`
- `currentSelectedTargetId`
- `currentTokenConfigured`
- `currentConnectionStatus`
- `currentBrokerClient`
- `currentBrokerClientToken`

В sidepanel допустимо только локальное UI-состояние: открытая вкладка UI, значение textarea, открыто/закрыто меню. Всё интеграционное состояние приходит snapshot-ом из background.

### State server contract

Новый state server хранит модель:

```ts
export type BackgroundAssistantState = {
  epoch: number;
  connection: {
    brokerOnline: boolean;
    bridgeOnline: boolean;
    connecting: boolean;
    tokenConfigured: boolean;
    browserAuthorized: boolean | undefined;
    lastError?: string;
  };
  targets: TargetMetadata[];
  selectedTargetId?: string;
  chat: {
    messages: SidepanelChatMessage[];
    agentBusy: boolean;
    busyLabel: string;
    sending: boolean;
    error?: string;
  };
  auth: {
    browserToken?: string;
    tokenConfigured: boolean;
    mutationPending: boolean;
    error?: string;
  };
  diagnostics: DiagnosticEntry[];
};
```

Любая асинхронная операция получает `epoch`/generation. Если token изменился, WebSocket пересоздан или state server перезапущен, поздние события старого поколения игнорируются.

### Runtime Port protocol

Sidepanel открывает долгоживущий порт:

```ts
const port = chrome.runtime.connect({ name: "sidepanel" });
```

Background сразу отправляет:

```ts
{ type: "assistant.snapshot", state }
```

Далее background рассылает всем подключённым sidepanel ports:

```ts
{ type: "assistant.snapshot", state }
```

или, если потребуется оптимизация позже:

```ts
{ type: "assistant.patch", patch, epoch }
```

В первой production-версии используем full snapshot: проще тестировать, меньше риск рассинхронизации.

Команды sidepanel → background:

```ts
type SidepanelCommand =
  | { type: "assistant.selectTarget"; targetId?: string }
  | { type: "assistant.sendChatMessage"; message: string }
  | { type: "assistant.startDomPicker"; tabId?: number }
  | { type: "assistant.auth.refresh" }
  | { type: "assistant.auth.regenerateToken" }
  | { type: "assistant.auth.clearToken" }
  | { type: "assistant.diagnostics.refresh" };
```

---

## Task 1: Зафиксировать целевой контракт state server

**TDD scenario:** New feature — full TDD cycle for pure types/helpers.

**Files:**
- Create: `src/chrome/assistantState.ts`
- Create: `src/chrome/assistantState.test.ts`
- Read: `src/chrome/sidepanelState.ts`
- Read: `src/chrome/diagnostics.ts`

**Step 1: Write failing tests**

Add tests for:

1. initial state has `connecting: true`, no token, no targets, disabled chat;
2. formatting status from state returns stable Russian strings;
3. selecting a disappeared target clears `selectedTargetId` and disables sending;
4. chat error clears `agentBusy` and `sending`.

Run:

```bash
npm test -- --run src/chrome/assistantState.test.ts
```

Expected: FAIL because file does not exist.

**Step 2: Implement pure state model**

Create exported types and pure reducer helpers:

```ts
export function createInitialAssistantState(): BackgroundAssistantState
export function reduceAssistantState(state: BackgroundAssistantState, event: AssistantStateEvent): BackgroundAssistantState
export function formatAssistantStatus(state: BackgroundAssistantState): string
export function isChatSendDisabled(state: BackgroundAssistantState, draftText: string): boolean
export function selectAvailableTarget(state: BackgroundAssistantState, targetId?: string): BackgroundAssistantState
```

All user-visible strings must be Russian.

**Step 3: Verify**

```bash
npm test -- --run src/chrome/assistantState.test.ts src/chrome/sidepanelState.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/chrome/assistantState.ts src/chrome/assistantState.test.ts
git commit -m "feat: add assistant state model"
```

---

## Task 2: Extract broker WebSocket client into background-safe client

**TDD scenario:** Modifying tested code — run existing tests first, then add generation tests.

**Files:**
- Modify: `src/chrome/sidepanelBrokerClient.ts`
- Rename or create: `src/chrome/brokerClient.ts`
- Modify: `src/chrome/sidepanelBrokerClient.test.ts` or create `src/chrome/brokerClient.test.ts`

**Step 1: Run current tests**

```bash
npm test -- --run src/chrome/sidepanelBrokerClient.test.ts
```

Expected: current baseline PASS before refactor.

**Step 2: Rename conceptually**

Move/rename `SidePanelBrokerClient` to a UI-agnostic `BrokerClient`:

```ts
export class BrokerClient
```

It must not import sidepanel modules and must expose callbacks only:

```ts
onConnectionState
onTargets
onChatEvent
```

**Step 3: Add tests for late events**

Test that after `close()`:

- late `open` does not send `client.hello`;
- late `client.targets` does not call `onTargets`;
- late `client.chatEvent` does not call `onChatEvent`;
- reconnect timer is cancelled.

**Step 4: Verify**

```bash
npm test -- --run src/chrome/brokerClient.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/brokerClient.ts src/chrome/brokerClient.test.ts src/chrome/sidepanelBrokerClient.ts src/chrome/sidepanelBrokerClient.test.ts
git commit -m "refactor: make broker client background owned"
```

---

## Task 3: Implement background state server skeleton

**TDD scenario:** New feature — full TDD cycle with mocked Chrome APIs and fake broker client.

**Files:**
- Create: `src/chrome/backgroundStateServer.ts`
- Create: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/background.ts`

**Step 1: Write failing tests**

Test server behavior without real WebSocket:

1. `connectPort(port)` immediately posts `assistant.snapshot`;
2. multiple ports receive same snapshot after state change;
3. disconnected ports are removed;
4. `assistant.selectTarget` updates state and persists `selectedTargetId`;
5. storage failure records diagnostic but does not roll back in-memory selection.

Run:

```bash
npm test -- --run src/chrome/backgroundStateServer.test.ts
```

Expected: FAIL.

**Step 2: Implement server class**

Create:

```ts
export class BackgroundAssistantStateServer {
  connectPort(port: ChromeRuntimePortLike): void;
  start(): Promise<void>;
  stop(): void;
  getSnapshot(): BackgroundAssistantState;
}
```

Constructor dependencies must be injectable for tests:

```ts
storage
runtimeClock
brokerClientFactory
recordDiagnostic
```

**Step 3: Integrate into background**

In `background.ts`, instantiate one module-level server and handle:

```ts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") stateServer.connectPort(port);
});
```

Keep existing `sendMessage` handlers temporarily for compatibility.

**Step 4: Verify**

```bash
npm test -- --run src/chrome/backgroundStateServer.test.ts src/chrome/background.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/backgroundStateServer.ts src/chrome/backgroundStateServer.test.ts src/chrome/background.ts
git commit -m "feat: add background assistant state server"
```

---

## Task 4: Move auth lifecycle ownership to background state server

**TDD scenario:** Modifying tested code — add state-server auth tests before implementation.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Read: `src/chrome/browserToken.ts`
- Modify if needed: `src/chrome/background.ts`

**Step 1: Add failing tests**

Cover:

1. server startup loads/creates browser token through existing token helpers;
2. no token configured closes broker client and broadcasts token guidance;
3. regenerate token increments epoch exactly once and recreates broker client exactly once;
4. clear token closes broker client, clears targets and selected target, disables chat;
5. repeated auth refresh with same token does not reconnect broker client.

**Step 2: Implement auth commands**

Handle commands:

```ts
assistant.auth.refresh
assistant.auth.regenerateToken
assistant.auth.clearToken
```

All token changes must go through one method:

```ts
private applyBrowserToken(nextToken: string | undefined): void
```

This method is the only place allowed to create/close broker client.

**Step 3: Verify**

```bash
npm test -- --run src/chrome/backgroundStateServer.test.ts src/chrome/browserToken.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/chrome/backgroundStateServer.ts src/chrome/backgroundStateServer.test.ts
git commit -m "feat: centralize sidepanel auth state in background"
```

---

## Task 5: Move targets, selection and subscription ownership to background

**TDD scenario:** New behavior tests in state server and broker client.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/brokerClient.ts`
- Modify: `src/chrome/brokerClient.test.ts`

**Step 1: Add failing tests**

Cover:

1. broker `onTargets` updates state and broadcasts snapshot;
2. selected target remains if it is still present;
3. selected target is cleared if it disappears;
4. selection command calls `brokerClient.setSelectedTargetId` only after state accepts target;
5. selection is persisted to storage after in-memory state update;
6. late `onTargets` from stale broker generation is ignored.

**Step 2: Implement generation guard**

Every broker client callback captures `brokerEpoch`:

```ts
const epoch = this.state.epoch;
const client = new BrokerClient({
  onTargets: (targets) => {
    if (this.state.epoch !== epoch) return;
    this.applyTargets(targets);
  },
});
```

**Step 3: Verify**

```bash
npm test -- --run src/chrome/backgroundStateServer.test.ts src/chrome/brokerClient.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/chrome/backgroundStateServer.ts src/chrome/backgroundStateServer.test.ts src/chrome/brokerClient.ts src/chrome/brokerClient.test.ts
git commit -m "feat: centralize target selection in background"
```

---

## Task 6: Move chat send and chat event reduction to background

**TDD scenario:** Modifying tested code — add state-server chat tests first.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/assistantState.ts`
- Modify: `src/chrome/assistantState.test.ts`

**Step 1: Add failing tests**

Cover:

1. `assistant.sendChatMessage` with no selected target returns/broadcasts Russian error and does not call broker;
2. valid send appends user message immediately and sets busy;
3. broker `sendChatMessage` false produces `Pi недоступен` chat error and clears busy;
4. `client.chatEvent` reduces chat state in background and broadcasts snapshot;
5. stale broker chat events are ignored by epoch.

**Step 2: Implement command**

State server handles:

```ts
assistant.sendChatMessage
```

Sidepanel must no longer call broker directly.

**Step 3: Verify**

```bash
npm test -- --run src/chrome/backgroundStateServer.test.ts src/chrome/assistantState.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/chrome/backgroundStateServer.ts src/chrome/backgroundStateServer.test.ts src/chrome/assistantState.ts src/chrome/assistantState.test.ts
git commit -m "feat: route sidepanel chat through background state server"
```

---

## Task 7: Convert sidepanel to a pure UI client

**TDD scenario:** Modifying tested code — update sidepanel jsdom tests before implementation.

**Files:**
- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/sidepanelAuthLifecycle.test.ts`
- Modify: `src/chrome/sidepanelNavigation.test.ts`
- Modify or remove: `src/chrome/sidepanelBrokerClient.test.ts` imports if obsolete
- Modify: `src/chrome/sidepanelState.ts` if only UI helpers remain

**Step 1: Add failing sidepanel tests**

Mock `chrome.runtime.connect` and assert:

1. sidepanel opens exactly one Port named `sidepanel`;
2. receiving `assistant.snapshot` renders status and targets;
3. clicking target posts `{ type: "assistant.selectTarget", targetId }` and does not mutate integration state locally;
4. sending chat posts `{ type: "assistant.sendChatMessage", message }`;
5. auth buttons post auth commands;
6. sidepanel never constructs `BrokerClient` / `SidePanelBrokerClient`.

**Step 2: Implement pure UI adapter**

Remove from `sidepanel.ts`:

- broker client construction;
- direct `chrome.runtime.sendMessage({ type: "listTargets" })` state refresh as source of truth;
- local `currentConnectionStatus` as authoritative integration status.

Keep local UI-only state:

```ts
let currentSnapshot: BackgroundAssistantState | undefined;
let currentActiveTab: SidePanelTab = "assistant";
```

Render from snapshot only.

**Step 3: Verify**

```bash
npm test -- --run src/chrome/sidepanelAuthLifecycle.test.ts src/chrome/sidepanelNavigation.test.ts src/chrome/sidepanelRender.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/chrome/sidepanel.ts src/chrome/sidepanel*.test.ts src/chrome/sidepanelState.ts
git commit -m "refactor: make sidepanel a background state client"
```

---

## Task 8: Route DOM picker through the same state server command path

**TDD scenario:** Existing regression tests + new command test.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/background.ts`
- Modify: `src/chrome/background.test.ts`
- Modify: `src/chrome/sidepanel.ts`

**Step 1: Add failing tests**

Cover:

1. sidepanel DOM picker menu posts `assistant.startDomPicker` with explicit active tab id when available;
2. background state server rejects missing selected target with Russian error;
3. background uses existing `startDomPicker` implementation path with explicit `tabId`;
4. restricted URLs produce Russian error and diagnostic.

**Step 2: Implement command bridge**

State server command handler validates selected target and delegates to existing background helper for DOM picker. Do not duplicate injection logic.

**Step 3: Verify**

```bash
npm test -- --run src/chrome/backgroundStateServer.test.ts src/chrome/background.test.ts src/chrome/contentScript.test.ts src/chrome/contentScriptMessages.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/chrome/backgroundStateServer.ts src/chrome/backgroundStateServer.test.ts src/chrome/background.ts src/chrome/background.test.ts src/chrome/sidepanel.ts
git commit -m "feat: route dom picker through assistant state server"
```

---

## Task 9: Retire legacy sidepanel request/response paths

**TDD scenario:** Cleanup with regression tests.

**Files:**
- Modify: `src/chrome/background.ts`
- Modify: `src/chrome/background.test.ts`
- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/sidepanelBrokerClient.ts` or delete if replaced by `brokerClient.ts`
- Modify: `scripts/build-chrome.mjs` if entry list changes
- Modify: `src/scripts/build-chrome.test.ts`

**Step 1: Search exact legacy paths**

```bash
rg -n "listTargets|getDiagnostics|getBrowserAuthState|SidePanelBrokerClient|refreshSidePanelState" src/chrome
```

**Step 2: Remove sidepanel usage**

Sidepanel must not call these as state source:

```ts
chrome.runtime.sendMessage({ type: "listTargets" })
chrome.runtime.sendMessage({ type: "getBrowserAuthState" })
```

They may remain in background only if needed for backward-compatible tests/tools, but sidepanel must use Port.

**Step 3: Verify build entries**

If `sidepanelBrokerClient.ts` is no longer directly used by sidepanel, either keep it renamed as `brokerClient.ts` or remove obsolete bundle entry.

**Step 4: Verify**

```bash
npm test -- --run src/chrome/background.test.ts src/scripts/build-chrome.test.ts
npm run build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome scripts src/scripts
git commit -m "chore: remove legacy sidepanel state paths"
```

---

## Task 10: Update architecture documentation

**TDD scenario:** Documentation update after behavior is implemented.

**Files:**
- Modify: `docs/architecture/chrome-extension.md`
- Modify: `docs/architecture/protocol.md` if runtime Port protocol is documented there or add subsection
- Modify: `docs/operations/troubleshooting.md`

**Step 1: Document new ownership**

Update Chrome extension architecture:

- background owns broker WebSocket;
- sidepanel is UI-only;
- state snapshots flow background → sidepanel;
- commands flow sidepanel → background.

**Step 2: Document troubleshooting**

Add section:

- stable status expected;
- how to inspect background service worker logs;
- what diagnostics mean for token/auth/broker/target errors.

**Step 3: Verify docs references**

```bash
rg -n "Side panel держит постоянное WebSocket|Постоянное chat-подключение живёт в side panel|SidePanelBrokerClient" docs src
```

Expected: no stale docs claiming sidepanel owns persistent broker connection.

**Step 4: Commit**

```bash
git add docs/architecture/chrome-extension.md docs/architecture/protocol.md docs/operations/troubleshooting.md
git commit -m "docs: document background-owned sidepanel state"
```

---

## Task 11: Full verification and regression checklist

**TDD scenario:** Verification before completion.

**Files:**
- No source modifications unless verification finds defects.

**Step 1: Run automated checks**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all PASS.

**Step 2: Manual production scenario**

1. Build extension.
2. Reload extension in Chrome.
3. Open sidepanel without Pi broker.
4. Verify stable status: `Pi не подключён...`, no flicker.
5. Generate/copy browser token if needed.
6. Run `/chrome-assistent-auth` in Pi.
7. Run `/chrome-assistent-connect` in one Pi session.
8. Verify target appears without closing sidepanel.
9. Select target.
10. Verify status stays stable, no blinking.
11. Send chat message.
12. Verify busy indicator appears and clears after response/error.
13. Open second Pi session and run `/chrome-assistent-connect`.
14. Verify second target appears dynamically.
15. Close selected Pi session.
16. Verify selected target clears once and buttons disable; no broker offline flicker.
17. Start DOM picker on normal `https://` page.
18. Verify selection reaches selected Pi session.
19. Try DOM picker on `chrome://` or new tab.
20. Verify Russian error and diagnostic entry.
21. Open Dev-журнал → Назад.
22. Verify navigation remains correct.

**Step 3: Project-required impact/change detection**

GitNexus MCP is not available in the current tool list. Before final commit/merge, run available CLI/index checks if configured:

```bash
npx gitnexus analyze
```

Then run GitNexus change detection if the MCP/CLI is available in the environment, per `AGENTS.md`.

**Step 4: Final commit or PR**

Only after all checks pass.

---

## Risk Controls

### Race prevention

- Only background state server mutates integration state.
- Sidepanel cannot open broker WebSocket.
- Every broker client generation has an epoch guard.
- Token changes go through one `applyBrowserToken` method.
- Full snapshots avoid UI patch ordering bugs.

### MV3 service worker lifecycle

- On service worker wake, state server reconstructs state from `chrome.storage.local` and reconnects broker if token exists.
- Sidepanel reconnects Port if disconnected and waits for a fresh snapshot.
- No state correctness depends on sidepanel lifetime.

### Error isolation

- Broker offline, browser auth error, target unavailable and DOM picker errors are separate state fields/diagnostics.
- Target-level error must not set broker offline unless WebSocket is actually offline.

---

## Acceptance Criteria

Implementation is complete only when:

- sidepanel has no direct broker WebSocket ownership;
- background is the single owner of token, broker connection, targets, selected target, chat state and diagnostics;
- sidepanel renders only background snapshots for integration state;
- selecting a session cannot start competing refresh/reconnect loops;
- status does not flicker during target selection, target updates or reconnect;
- dynamic target register/unregister works without reopening sidepanel;
- closed selected session clears selection without marking broker offline;
- chat send/receive works through background-owned broker client;
- DOM picker works through background command path or returns clear Russian errors;
- all UI/user docs strings remain Russian;
- `npm test`, `npm run typecheck`, `npm run build` pass.
