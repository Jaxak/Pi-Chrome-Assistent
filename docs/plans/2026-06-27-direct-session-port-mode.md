# Direct Session Port Mode Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Радикально заменить broker/listTargets/multi-session архитектуру на стабильное direct-подключение Chrome sidepanel к одному серверу конкретной Pi-сессии по указанному порту.

**Architecture:** Каждая Pi-сессия поднимает собственный WebSocket state server внутри процесса Pi, как в `@kkkiio/pi-web-ui`: server живёт вместе с Pi-сессией, browser client переподключается к одному URL и получает authoritative snapshot on connect. Первая сессия пытается стартовать на `127.0.0.1:31415`; если порт занят, Pi-сессия пробует следующий порт. Chrome extension больше не ищет список сессий автоматически: пользователь вводит порт в блоке «Сессия» и нажимает «Подключить».

**Tech Stack:** TypeScript, Chrome MV3 side panel/background, Pi Extension API, Node `ws`, Vitest/jsdom, Vite build.

---

## Исполнительная модель

Пользовательское требование по процессу:

- код пишут субагенты на модели `kontur/preview-code-pro`;
- основной агент не пишет production code напрямую;
- основной агент делает review после каждой задачи/батча;
- изменения выполняются без обратной совместимости;
- подход максимально радикальный и чистый.

Практическое правило для исполнения:

1. Перед каждой задачей основной агент запускает implementation subagent:

```ts
subagent({
  agent: "kontur.kontur-preview-code-pro",
  model: "kontur/preview-code-pro",
  context: "fresh",
  task: "Implement Task N from docs/plans/2026-06-27-direct-session-port-mode.md with TDD."
})
```

2. После результата основной агент запускает review subagent на той же модели или выполняет review сам с обязательным чеклистом:
   - удалены ли ненужные переменные;
   - не осталось ли старых `target`, `targets`, `selectedTargetId`, `listTargets`, `broker`, `subscribeTarget` в Chrome direct path;
   - не добавлена ли совместимость со старым протоколом;
   - тесты действительно соответствуют новой архитектуре.
3. Основной агент принимает/дорабатывает только после review.
4. Перед изменением символов соблюдать GitNexus requirement из `AGENTS.md`: выполнить `npx gitnexus impact --repo Pi-Chrome-Assistent --direction upstream <symbol>` или зафиксировать, почему символ удаляется целиком.

---

## Ключевые архитектурные решения

### Что удаляем полностью

Удалить как продуктовую функциональность и как тестовое ожидание:

- автоматический поиск сессий;
- список targets;
- выбранный target/session id;
- broker как общий реестр целей;
- target registration protocol;
- stale targets;
- browser subscriptions by target id;
- one-shot `listTargets` refresh;
- fallback between `BrokerClient` and `listTargets`;
- multi-session routing;
- auth flow, если он существует только для broker browser-token trust. В direct local mode не сохранять старую auth-архитектуру ради совместимости.

### Что оставляем или переносим

Оставить пользовательские возможности, но перепривязать к одному direct session connection:

- chat send/stream;
- DOM picker/send selection;
- model/context display;
- model switching;
- diagnostics;
- sidepanel reconnect;
- authoritative snapshot-on-connect;
- Russian UI.

### Новый поток

```text
Pi session
  /chrome-assistent-connect
    -> start DirectSessionServer on 127.0.0.1:31415 or next free port
    -> keep latest ExtensionContext
    -> send snapshot on each Chrome WS connect

Chrome sidepanel
  user enters port, clicks Подключить
    -> background stores port
    -> background opens ws://127.0.0.1:<port>
    -> server sends session.snapshot
    -> background maps it to BackgroundAssistantState
    -> sidepanel renders it
```

### Портовая политика

- Default port: `31415`.
- Pi direct server tries `31415`, then `31416`, `31417`, ... until success.
- Upper bound for automatic probing: configurable constant, e.g. `DIRECT_SESSION_PORT_SCAN_LIMIT = 100`.
- Pi status must show exact port:

```text
/chrome-assistent-connect: <label> · подключено · 127.0.0.1:31415
```

- Chrome sidepanel default input value: saved port from storage, otherwise `31415`.
- Clicking **«Подключить»** reconnects background to `ws://127.0.0.1:<port>` and stores the port.

---

## New direct protocol

Create a new direct protocol or replace `src/shared/protocol.ts` radically. Do not keep old message types unless still used by direct connection.

Recommended minimal message types:

```ts
export const DIRECT_SESSION_MESSAGE_TYPES = [
  "session.snapshot",
  "session.chat.send",
  "session.selection.send",
  "session.model.set",
  "session.command.result",
  "session.error",
] as const;
```

Payloads:

```ts
export type DirectSessionSnapshot = {
  session: {
    cwd: string;
    gitBranch?: string;
    pid: number;
    sessionName?: string;
    alias?: string;
    connectedAt: number;
  };
  chat: {
    events?: ChatEvent[];
    agentBusy: boolean;
    busyLabel: string;
  };
  runtime: {
    model?: TargetModelSummary;
    availableModels: TargetModelSummary[];
    contextUsage?: TargetContextUsage;
    isIdle: boolean;
    updatedAt: number;
  };
};

export type DirectSendChatPayload = { message: string };
export type DirectSendSelectionPayload = { selection: SelectionPayload };
export type DirectSetModelPayload = { provider: string; modelId: string };
export type DirectCommandResult = { ok: boolean; error?: string };
```

Notes:

- Direct server sends `session.snapshot` immediately after WS open.
- Chat deltas can be represented either as incremental `session.snapshot` updates or a separate event type. Prefer snapshots first for stability.
- If incremental chat events remain, they must be scoped to the single connected session, not target ids.

---

## Phase 0: Рабочее дерево и безопасность

### Task 0.1: Зафиксировать исходное состояние перед радикальной очисткой

**TDD scenario:** No code change.

**Files:** none.

**Steps:**

1. Run:

```bash
git status --short
git branch --show-current
npm test -- --reporter verbose
npm run typecheck
npm run build
```

2. Save output in implementation notes.
3. If current dirty diff from previous sidepanel/chat implementation should not be preserved, create a safety patch before cleanup:

```bash
git diff > /tmp/pi-chrome-assistent-before-direct-session.patch
```

4. Do not commit unless user explicitly asks. The next tasks intentionally delete large parts.

---

## Phase 1: Remove unnecessary functionality and tests first

Goal: reduce the codebase to a failing but clean shape where old multi-session concepts are gone. This phase is intentionally destructive.

### Task 1: Delete broker registry and multi-target protocol tests

**TDD scenario:** Deletion/cleanup — remove obsolete tests first, then remove code.

**Files:**
- Delete or radically rewrite: `src/pi/broker.test.ts`
- Delete or radically rewrite: `src/pi/targetClient.test.ts`
- Modify: `src/shared/protocol.test.ts`
- Modify: `src/shared/protocol.ts`

**Step 1: Remove obsolete test suites**

Delete test cases that assert any of the following:

- `BrowserConnectBrokerState`;
- `target.register` / `target.registered`;
- `target.heartbeat`;
- stale target cleanup;
- `client.listTargets`;
- `client.subscribeTarget` / `client.unsubscribeTarget`;
- `client.sendChatMessage` routed by `targetId`;
- `target.deliverChatMessage`;
- `target.chatEvent` routed to subscribers;
- `client.setTargetModel` routed by `targetId`.

**Step 2: Replace protocol tests with direct protocol tests**

New tests in `src/shared/protocol.test.ts` must assert only direct message types and validators:

```ts
it("accepts direct session message types", () => {
  expect(isProtocolEnvelope({ version: 1, type: "session.snapshot" })).toBe(true);
  expect(isProtocolEnvelope({ version: 1, type: "session.chat.send" })).toBe(true);
  expect(isProtocolEnvelope({ version: 1, type: "session.selection.send" })).toBe(true);
  expect(isProtocolEnvelope({ version: 1, type: "session.model.set" })).toBe(true);
  expect(isProtocolEnvelope({ version: 1, type: "session.command.result" })).toBe(true);
  expect(isProtocolEnvelope({ version: 1, type: "session.error" })).toBe(true);
});
```

**Step 3: Run tests to verify old imports fail**

```bash
npx vitest run src/shared/protocol.test.ts src/pi/broker.test.ts src/pi/targetClient.test.ts --reporter verbose
```

Expected: fail because old code still exports old protocol symbols or deleted tests are not aligned.

**Step 4: Radically simplify `src/shared/protocol.ts`**

Keep generic helpers if useful:

- `createRequestId`
- `isProtocolEnvelope`
- `parseProtocolEnvelope`
- `validateSelectionPayload`
- `validateChatEvent`

Remove old payloads and message types:

- `BrowserClientHelloPayload`
- `BrowserClientSendSelectionPayload`
- `BrowserClientSubscribeTargetPayload`
- `BrowserClientSendChatMessagePayload`
- `BrowserClientSetTargetModelPayload`
- `TargetDeliverChatMessagePayload`
- `TargetMetadata` if it only represents broker targets
- `PROTOCOL_MESSAGE_TYPES` entries for `client.*` and `target.*` broker routing.

Add direct payloads listed in **New direct protocol**.

**Step 5: Delete obsolete implementation files if no longer referenced**

Preferred radical cleanup:

```bash
git rm src/pi/broker.ts src/pi/targetClient.ts
```

If helper functions from `targetClient.ts` are still useful (`buildTargetMetadata`, chat/selection formatting), move them to new direct modules instead of keeping `targetClient.ts` with misleading name.

**Step 6: Verify no old protocol strings remain**

Run:

```bash
rg "client\.listTargets|target\.register|subscribeTarget|selectedTargetId|targetsStale|BrowserConnectBrokerState|connectTargetToBroker|TargetMetadata" src
```

Expected after this task: either no matches, or matches only in migration notes/docs to be removed in later doc task. No production direct path may contain them.

---

### Task 2: Remove Chrome multi-session state and tests

**TDD scenario:** Deletion/cleanup — remove obsolete tests first, then simplify state.

**Files:**
- Modify: `src/chrome/assistantState.ts`
- Modify: `src/chrome/assistantState.test.ts`
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify/Delete: `src/chrome/backgroundStateServer.test.ts`
- Delete or rewrite: `src/chrome/brokerClient.ts`
- Delete or rewrite: `src/chrome/brokerClient.test.ts`

**Step 1: Remove obsolete state expectations**

Delete tests that mention:

- `targets` array;
- `selectedTargetId`;
- `targetsStale`;
- `targetsRefreshPending`;
- `listTargets`;
- selecting a target;
- preserving selected target;
- resubscribing selected target;
- target disappearing.

**Step 2: Introduce new state shape tests**

`BackgroundAssistantState` should become single-session:

```ts
export type BackgroundAssistantState = {
  epoch: number;
  connection: {
    online: boolean;
    connecting: boolean;
    configuredPort: number;
    lastError?: string;
  };
  session?: {
    cwd: string;
    gitBranch?: string;
    pid: number;
    sessionName?: string;
    alias?: string;
    connectedAt: number;
  };
  chat: { ... };
  runtime: { ... };
  diagnostics: DiagnosticEntry[];
};
```

Tests:

```ts
it("creates initial direct session state", () => {
  const state = createInitialAssistantState();
  expect(state.connection).toMatchObject({ online: false, connecting: false, configuredPort: 31415 });
  expect(state.session).toBeUndefined();
});

it("applies direct session snapshot", () => {
  const state = reduceAssistantState(createInitialAssistantState(), {
    kind: "session_snapshot",
    snapshot: createDirectSnapshot(),
  });
  expect(state.connection.online).toBe(true);
  expect(state.session?.cwd).toBe("/repo");
});
```

**Step 3: Simplify `assistantState.ts`**

Remove:

- `formatAssistantStatus` branches about target count;
- `selectAvailableTarget`;
- `isChatSendDisabled` checks for selected target;
- target availability logic.

New `isChatSendDisabled`:

```ts
return (
  draftText.trim().length === 0 ||
  state.chat.sending ||
  state.chat.agentBusy ||
  state.connection.connecting ||
  !state.connection.online
);
```

**Step 4: Replace `BrokerClient` with direct session client skeleton**

Delete `src/chrome/brokerClient.ts` and create `src/chrome/sessionClient.ts`.

Minimal API:

```ts
export type SessionClientOptions = {
  port: number;
  webSocketFactory?: (url: string) => BrowserSocket;
  onSnapshot(snapshot: DirectSessionSnapshot): void;
  onConnectionState(state: { online: boolean; connecting: boolean; statusText?: string }): void;
};

export class SessionClient {
  connect(): void;
  reconnectToPort(port: number): void;
  sendChatMessage(message: string): boolean;
  sendSelection(selection: SelectionPayload): boolean;
  setModel(input: { provider: string; modelId: string }): boolean;
  close(): void;
}
```

**Step 5: Tests for `SessionClient`**

Create `src/chrome/sessionClient.test.ts`:

- connects to `ws://127.0.0.1:31415`;
- reports connecting then online after `session.snapshot`;
- sends `session.chat.send` without `targetId`;
- sends `session.model.set` without `targetId`;
- reconnects with backoff after close;
- `reconnectToPort(31416)` closes old socket and opens new URL.

**Step 6: Verify cleanup**

Run:

```bash
rg "targets|selectedTargetId|listTargets|BrokerClient|brokerClient|targetId|subscribeTarget|targetsStale|targetsRefreshPending" src/chrome
```

Expected: no production matches except `targetId` inside shared legacy tests should be gone too. If `targetId` remains for DOM picker naming, rename it to `session` concepts.

---

### Task 3: Remove sidepanel session list UI and tests

**TDD scenario:** Deletion/cleanup — remove obsolete UI tests, then simplify UI.

**Files:**
- Modify: `src/chrome/sidepanel.html`
- Modify: `src/chrome/sidepanel.css`
- Modify: `src/chrome/sidepanel.ts`
- Modify/Delete: `src/chrome/sidepanelNavigation.test.ts`
- Modify/Delete: `src/chrome/sidepanelAuthLifecycle.test.ts`
- Modify: `src/chrome/sidepanelRender.ts` only if obsolete session rendering helpers exist.

**Step 1: Remove obsolete UI tests**

Delete tests that assert:

- rendering target buttons;
- selecting target;
- stale target guidance;
- sessions refresh button;
- selected target preserved after reconnect;
- no targets guidance;
- broker unavailable guidance tied to targets.

**Step 2: Replace with direct port UI tests**

New tests in `sidepanelNavigation.test.ts`:

```ts
it("renders port input with default 31415", async () => {
  loadSidePanelHtml();
  mockChromeRuntime();
  await importInitializedSidePanel();
  expect(document.querySelector<HTMLInputElement>("#session-port-input")?.value).toBe("31415");
});

it("posts connect command with entered port", async () => {
  const runtime = mockChromeRuntime();
  await importInitializedSidePanel();
  const input = document.querySelector<HTMLInputElement>("#session-port-input")!;
  input.value = "31416";
  document.querySelector<HTMLButtonElement>("#connect-session-button")!.click();
  expect(runtime.port.postMessage).toHaveBeenCalledWith({ type: "assistant.session.connect", port: 31416 });
});
```

**Step 3: Simplify `sidepanel.html` session card**

Replace target list with port controls:

```html
<section class="ant-card session-card" aria-labelledby="session-heading">
  <div class="ant-card-body">
    <label class="field-label" id="session-heading" for="session-port-input">Сессия Pi</label>
    <div class="session-port-row">
      <input id="session-port-input" class="ant-input session-port-input" inputmode="numeric" pattern="[0-9]*" value="31415" />
      <button id="connect-session-button" class="button-secondary" type="button">Подключить</button>
    </div>
    <p id="session-connection-status" class="panel__hint">Введите порт Pi-сессии и нажмите «Подключить».</p>
  </div>
</section>
```

Remove:

- `#refresh-sessions-button`;
- `#session-stale-guidance`;
- `#target-container`;
- listbox role.

**Step 4: Simplify `sidepanel.ts`**

Remove variables:

- `currentTargets`;
- `currentSelectedTargetId`;
- `localSelectionChanged`;
- `sessionsRefreshPending`;
- `targetListUpdateMode`;
- `lastRenderedConnectionKey`;
- `lastRenderedTargetIds`;
- `forceNextSnapshotTargetRender`.

Remove functions:

- `findTargetById`;
- `renderTargetPlaceholder`;
- `formatTargetPrimaryLabel`;
- `formatTargetSecondaryLabel`;
- `updateTargetOptionLabels`;
- `createTargetOption`;
- `renderTargetList`;
- `renderSessionGuidance`;
- `requestSessionsRefresh`;
- `getConnectionDisplayKey`;
- `renderTargetsFromSnapshot`;
- `renderTargetSelectionOnly`.

Add functions:

```ts
function renderSessionConnection(elements: SidePanelElements, state: BackgroundAssistantState): void;
function getPortInputValue(elements: SidePanelElements): number | undefined;
function updateDirectSendButtons(elements: SidePanelElements): void;
```

**Step 5: Fix avatar CSS**

Requirement from user: remove green circle behind extension icon.

HTML should be direct image or wrapper with no background:

```html
<img class="avatar" src="./icon.svg" alt="" aria-hidden="true" />
```

CSS:

```css
.avatar {
  display: block;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  object-fit: contain;
  background: transparent;
  border-radius: 0;
}
```

Remove `.avatar__icon` if no longer needed.

**Step 6: Verify no old session-list variables remain**

```bash
rg "currentTargets|currentSelectedTargetId|targetListUpdateMode|targetsStale|refresh-sessions|target-container|target-option|selectedTarget" src/chrome/sidepanel.* src/chrome/*.test.ts
```

Expected: no matches.

---

## Phase 2: Implement direct Pi session server

### Task 4: Add direct session server inside Pi

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/pi/sessionServer.ts`
- Create: `src/pi/sessionServer.test.ts`
- Modify: `src/pi/browserConnectExtension.ts`
- Modify: `src/pi/browserConnectExtension.test.ts`

**Step 1: Write failing server tests**

`src/pi/sessionServer.test.ts`:

1. starts on requested port;
2. sends `session.snapshot` immediately after browser connects;
3. handles `session.chat.send` by calling injected `sendUserMessage`;
4. handles `session.selection.send` by calling injected selection handler;
5. handles `session.model.set` by calling injected model handler;
6. broadcasts fresh snapshot after runtime changes;
7. closes cleanly.

Example:

```ts
it("sends authoritative snapshot on websocket connect", async () => {
  const server = await startDirectSessionServer({
    host: "127.0.0.1",
    port: 0,
    buildSnapshot: () => createSnapshot({ cwd: "/repo" }),
    onChatMessage: vi.fn(),
    onSelection: vi.fn(),
    onSetModel: vi.fn(),
    logger: createMemoryLogger(),
  });

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await waitForOpen(socket);
  await expect(waitForProtocolMessage(socket, "session.snapshot")).resolves.toMatchObject({
    type: "session.snapshot",
    payload: expect.objectContaining({ session: expect.objectContaining({ cwd: "/repo" }) }),
  });

  await closeSocket(socket);
  await server.close();
});
```

**Step 2: Run RED**

```bash
npx vitest run src/pi/sessionServer.test.ts --reporter verbose
```

Expected: fail because file/API does not exist.

**Step 3: Implement `startDirectSessionServer`**

API:

```ts
export type DirectSessionServer = {
  port: number;
  broadcastSnapshot(): void;
  close(): Promise<void>;
};

export async function startDirectSessionServer(options: {
  host: string;
  port: number;
  buildSnapshot(): DirectSessionSnapshot;
  onChatMessage(message: string): Promise<DirectCommandResult> | DirectCommandResult;
  onSelection(selection: SelectionPayload): Promise<DirectCommandResult> | DirectCommandResult;
  onSetModel(input: { provider: string; modelId: string }): Promise<DirectCommandResult> | DirectCommandResult;
  logger: BrowserConnectLogger;
}): Promise<DirectSessionServer>;
```

Implementation rules:

- no target registry;
- no browser token;
- no subscriptions;
- no list targets;
- keep only connected browser sockets set;
- `broadcastSnapshot()` sends full `session.snapshot` to all open sockets;
- malformed command returns `session.error` or `session.command.result` with `ok:false`.

**Step 4: GREEN**

```bash
npx vitest run src/pi/sessionServer.test.ts --reporter verbose
```

Expected: PASS.

---

### Task 5: Start direct server on first available port from 31415

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/pi/sessionServer.ts`
- Modify: `src/pi/sessionServer.test.ts`
- Modify: `src/pi/browserConnectExtension.ts`
- Modify: `src/pi/browserConnectExtension.test.ts`

**Step 1: Add port allocation tests**

Test helper:

```ts
it("uses 31415 for the first session and next free port when occupied", async () => {
  const first = await startDirectSessionServerOnAvailablePort({ preferredPort: 31415, ...options });
  const second = await startDirectSessionServerOnAvailablePort({ preferredPort: 31415, ...options });
  expect(first.port).toBe(31415);
  expect(second.port).toBe(31416);
  await second.close();
  await first.close();
});
```

**Step 2: Implement allocator**

```ts
export const DEFAULT_DIRECT_SESSION_PORT = 31415;
export const DIRECT_SESSION_PORT_SCAN_LIMIT = 100;

export async function startDirectSessionServerOnAvailablePort(options): Promise<DirectSessionServer> {
  for (let offset = 0; offset < DIRECT_SESSION_PORT_SCAN_LIMIT; offset += 1) {
    const port = options.preferredPort + offset;
    try { return await startDirectSessionServer({ ...options, port }); }
    catch (error) { if (!isAddressInUseError(error)) throw error; }
  }
  throw new Error("Не удалось найти свободный порт для Chrome Assistent");
}
```

**Step 3: Integrate `/chrome-assistent-connect`**

In `browserConnectExtension.ts`:

- remove shared token read/create;
- remove broker owner variables;
- remove target connection variables;
- keep one `activeSessionServer`;
- on command, close previous server for this Pi session before starting new one;
- build snapshot from latest `ctx`;
- set status with actual port.

**Step 4: Events broadcast snapshots**

On Pi events:

- `model_select`;
- `turn_end`;
- `session_compact`;
- `message_start/update/end` if chat state changes.

Call:

```ts
activeSessionServer?.broadcastSnapshot();
```

**Step 5: Verify no broker owner remnants**

```bash
rg "ownedBroker|sharedToken|targetToken|trustedBrowser|connectTargetToBroker|startBrokerServer|broker.token" src/pi
```

Expected: no production matches. Tests/docs may be cleaned in documentation task.

---

## Phase 3: Implement Chrome direct connection by port

### Task 6: Add Chrome `SessionClient`

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/chrome/sessionClient.ts`
- Create: `src/chrome/sessionClient.test.ts`
- Delete: `src/chrome/brokerClient.ts`
- Delete: `src/chrome/brokerClient.test.ts`

**Step 1: RED tests**

Required tests:

```ts
it("connects to configured direct session port", () => {
  const socket = new FakeWebSocket();
  const client = new SessionClient({ port: 31415, webSocketFactory: (url) => { expect(url).toBe("ws://127.0.0.1:31415"); return socket; }, ... });
  client.connect();
});

it("reports online after session snapshot", async () => { ... });
it("sends chat without target id", async () => { ... });
it("sends model set without target id", async () => { ... });
it("reconnects to a new port", async () => { ... });
```

**Step 2: Implement minimal client**

- URL: `ws://127.0.0.1:${port}`;
- on open: wait for snapshot, but report connecting immediately;
- on `session.snapshot`: call `onSnapshot`, report online;
- on close/error: report offline and schedule reconnect to same port;
- `reconnectToPort(port)` closes current socket and opens new port;
- commands send direct messages.

**Step 3: Verify no old client remains**

```bash
rg "BrokerClient|client\.hello|client\.listTargets|targetId" src/chrome/sessionClient.ts src/chrome/*.test.ts
```

Expected: no matches in direct session client tests.

---

### Task 7: Rewrite background state server for direct port mode

**TDD scenario:** Modifying tested code — delete obsolete tests first, add direct tests.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/background.ts`
- Modify storage helpers only if browser token storage is removed.

**Step 1: New tests**

`backgroundStateServer.test.ts` should cover:

1. startup loads saved port or defaults to `31415`;
2. `assistant.session.connect` with valid port stores it and reconnects SessionClient;
3. invalid port creates Russian error diagnostic/snapshot;
4. `session.snapshot` updates state;
5. `assistant.sendChatMessage` calls `sessionClient.sendChatMessage`;
6. `assistant.model.set` calls `sessionClient.setModel`;
7. `assistant.startDomPicker` sends selection through direct client, not target id.

Example:

```ts
it("connects to user supplied port and stores it", async () => {
  const { server, sessionClients, storage } = createServer();
  const port = new FakePort();
  await server.start();
  server.connectPort(port);

  port.emitMessage({ type: "assistant.session.connect", port: 31416 });

  expect(sessionClients.at(-1)?.options.port).toBe(31416);
  await expect(storage.get<number>("sessionPort")).resolves.toBe(31416);
});
```

**Step 2: Simplify background server**

Remove:

- token helpers;
- auth mutations;
- selected target persistence;
- `listTargetsCommand`;
- `startDomPicker` requiring target id;
- broker generation tied to BrokerClient.

Add:

- `SESSION_PORT_STORAGE_KEY = "sessionPort"`;
- `DEFAULT_DIRECT_SESSION_PORT = 31415` import;
- `SessionClient` factory;
- `connectSessionClient(port)`;
- `handleSessionConnect(port)`.

**Step 3: Update `background.ts` legacy message handlers**

Radical no-backcompat option:

- remove legacy `listTargets`, `getBrowserAuthState`, `regenerateBrowserToken`, `clearBrowserToken` runtime message handlers if only used by old popup/auth;
- keep DOM picker content-script messages only if content script still uses them.

**Step 4: Verify cleanup**

```bash
rg "browserToken|auth\.refresh|regenerateToken|clearToken|selectedTargetId|listTargets|BrokerClient|TargetMetadata" src/chrome/background*.ts src/chrome/*.test.ts
```

Expected: no production matches unless explicitly justified for DOM picker internals.

---

### Task 8: Rewrite sidepanel around port input

**TDD scenario:** New UI behavior — full TDD cycle.

**Files:**
- Modify: `src/chrome/sidepanel.html`
- Modify: `src/chrome/sidepanel.css`
- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/sidepanelNavigation.test.ts`
- Modify: `src/chrome/sidepanelAuthLifecycle.test.ts` or delete if auth screen removed.

**Step 1: HTML/CSS**

Use the markup from Task 3.

Remove auth drawer if browser token auth is removed:

- remove `#panel-auth`;
- remove `#tab-auth`;
- remove header auth menu item;
- remove token buttons/output.

If auth screen remains for another reason, justify in review. Default radical plan: remove it.

**Step 2: TS logic**

Element refs:

```ts
sessionPortInput: HTMLInputElement | null;
connectSessionButton: HTMLButtonElement | null;
sessionConnectionStatus: HTMLElement | null;
```

On snapshot:

- fill input from `state.connection.configuredPort` unless user is editing;
- status text:
  - online: `Подключено к 127.0.0.1:<port>`;
  - connecting: `Подключаемся к 127.0.0.1:<port>…`;
  - offline/error: `Нет подключения к 127.0.0.1:<port>` or `state.connection.lastError`.

On button click:

```ts
postAssistantCommand({ type: "assistant.session.connect", port });
```

Invalid port UI:

- port must be integer `1..65535`;
- error text Russian: `Введите порт от 1 до 65535.`;
- do not send command.

**Step 3: Reconnect port behavior**

Keep sidepanel runtime port reconnect to background. This is separate from WS session reconnect.

On background port disconnect:

- preserve visible session info;
- set diagnostics/status to `Переподключаем боковую панель…`;
- disable command buttons until background snapshot returns.

**Step 4: Verify no target UI remnants**

```bash
rg "target-container|target-option|refresh-sessions|Сессии Pi|Выберите цель|цель Pi|selectedTarget|targets" src/chrome/sidepanel.* src/chrome/*.test.ts
```

Expected: no matches.

---

## Phase 4: Direct DOM picker and chat/model commands

### Task 9: Rewire DOM picker to direct session

**TDD scenario:** Modifying tested code.

**Files:**
- Modify: `src/chrome/background.ts`
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify tests touching DOM picker.

**Current old behavior to remove:** DOM picker sends selection to selected `targetId` via broker.

**New behavior:** DOM picker sends selection to currently connected direct session via `SessionClient.sendSelection(selection)`.

Tests:

```ts
it("sends DOM picker selection to direct session client", async () => {
  const sessionClient = fakeSessionClient();
  const { server } = createServer({ sessionClientFactory: () => sessionClient });
  await server.start();
  server.applySessionSnapshot(createSnapshot());
  await server.handlePickerSelection(selection);
  expect(sessionClient.sendSelection).toHaveBeenCalledWith(selection);
});
```

Rules:

- If no direct session online, show `Pi-сессия не подключена.`;
- No target id anywhere.

---

### Task 10: Direct chat/model runtime polish

**TDD scenario:** Modifying tested code.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/sidepanel.ts`
- Modify relevant tests.

Tests:

1. chat disabled when direct session offline;
2. chat enabled when online snapshot present;
3. sending chat posts `session.chat.send` through `SessionClient`;
4. model menu disabled while offline;
5. model selection posts `session.model.set` through `SessionClient`;
6. context/model render from `DirectSessionSnapshot.runtime`.

Remove any old checks for selected target.

---

## Phase 5: Documentation and final cleanup

### Task 11: Rewrite docs for direct session mode

**TDD scenario:** Documentation change.

**Files:**
- Rewrite: `docs/architecture/broker.md` or replace with `docs/architecture/direct-session-server.md`
- Rewrite: `docs/architecture/protocol.md`
- Rewrite: `docs/architecture/chrome-extension.md`
- Rewrite: `docs/architecture/pi-extension.md`
- Rewrite: `docs/operations/setup.md`
- Rewrite: `docs/operations/troubleshooting.md`
- Possibly delete docs that are solely broker-token/auth-target oriented.

Docs must explain in Russian:

- no multi-session list;
- first port is `31415`;
- additional sessions use next available port;
- user copies/enters port manually;
- sidepanel reconnects to background and SessionClient reconnects to the configured Pi port;
- how to switch sessions: change port and click **«Подключить»**;
- no automatic discovery.

### Task 12: Final dead-code sweep

**TDD scenario:** Cleanup verification.

Run these searches and remove every unjustified match:

```bash
rg "broker|Broker|targetId|targets|selectedTarget|listTargets|subscribeTarget|unsubscribeTarget|browserToken|trustedBrowser|target\.register|client\.hello|client\.listTargets" src docs
rg "auth\.refresh|regenerateToken|clearToken|Авторизация браузера|browser-token|trusted-browsers" src docs
rg "currentTargets|targetListUpdateMode|sessionStaleGuidance|refreshSessions" src
```

Expected:

- `broker` may remain only in historical plan files or removed docs; production code should not use broker.
- `targetId` should not exist in direct session production code.
- browser token/auth UI should be gone unless a new direct auth design is explicitly introduced.

If a variable remains, rename it to direct terminology:

- `target` → `session`;
- `selectedTarget` → not needed;
- `BrokerClient` → `SessionClient`;
- `BackgroundStateServerBrokerClient` → `BackgroundStateServerSessionClient`.

### Task 13: Full verification

Run:

```bash
npm test -- --reporter verbose
npm run typecheck
npm run build
npx gitnexus detect-changes --repo Pi-Chrome-Assistent
```

Also run targeted suites:

```bash
npx vitest run \
  src/shared/protocol.test.ts \
  src/pi/sessionServer.test.ts \
  src/pi/browserConnectExtension.test.ts \
  src/chrome/sessionClient.test.ts \
  src/chrome/backgroundStateServer.test.ts \
  src/chrome/assistantState.test.ts \
  src/chrome/sidepanelNavigation.test.ts \
  src/chrome/sidepanelAuthLifecycle.test.ts \
  --reporter verbose
```

Manual smoke:

1. Start first Pi session and run `/chrome-assistent-connect`.
2. Verify status shows `127.0.0.1:31415`.
3. Open sidepanel; default port is `31415`.
4. Click **«Подключить»**.
5. Verify no session list and no flicker.
6. Send chat.
7. Verify model/context display.
8. Change model.
9. Start second Pi session and run `/chrome-assistent-connect`; verify it uses `31416`.
10. Change sidepanel port to `31416`, click **«Подключить»**, verify it switches sessions.
11. Kill the Pi session for current port; verify sidepanel shows disconnected/reconnecting without session-list flicker.

---

## Review checklist for main agent after every subagent task

The main agent must reject a task if any of these are true:

- New code preserves old multi-session behavior.
- New code adds compatibility adapters for broker/listTargets.
- Variables named `target(s)` remain in direct Chrome flow.
- Session selection still depends on discovered list instead of port input.
- UI still has refresh sessions button or target listbox.
- Tests still assert old target selection/stale target behavior.
- `BrokerClient` remains in Chrome production code.
- Pi still starts shared broker/target registration instead of direct session server.
- Any user-facing string is not Russian.
- `npm run typecheck` fails.

---

## Expected result

After implementation, the app should behave like a direct session UI:

```text
Pi session on port 31415  <---->  Chrome sidepanel configured to 31415
```

No automatic session discovery. No flickering session list. No stale targets. Session switching is explicit and manual by port.
