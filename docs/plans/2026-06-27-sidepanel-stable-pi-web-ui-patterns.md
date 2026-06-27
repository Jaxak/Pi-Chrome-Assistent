# Стабилизация Sidepanel по паттернам pi-web-ui Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Вернуть стабильную работу сессий и чата в sidepanel, заимствовав у `@kkkiio/pi-web-ui` паттерны reconnect + authoritative snapshot, и добавить отображение и смену модели/заполненности контекста.

**Architecture:** Broker внутри Pi-сессии остаётся source of truth для targets и chat routing. Chrome background становится стабильным владельцем browser-side state: держит live `BrokerClient` для chat/subscription, использует one-shot `listTargets` только как fallback refresh, а sidepanel является тонким клиентом с reconnect и snapshot-on-connect. Target Pi-сессия публикует session runtime state — модель, thinking/context usage — через broker к browser clients.

**Tech Stack:** TypeScript, Chrome MV3 side panel, Pi Extension API, Node `ws`, Vitest, Vite build pipeline.

---

## Контекст и выводы из `@kkkiio/pi-web-ui`

`pi-web-ui` стабилен благодаря четырём паттернам:

1. **Server lifecycle follows Pi session lifecycle.** HTTP + WS server стартует на `session_start` и закрывается на `session_shutdown`.
2. **Browser is a thin reconnecting client.** Фронтенд переподключается к `/ws` после `onclose` с задержкой около `1200ms`.
3. **Authoritative snapshot on connect.** Каждый новый WS client сразу получает полный `mirror_sync` из текущего `ExtensionContext`.
4. **Commands execute through the live context.** Browser command `prompt` вызывает `pi.sendUserMessage(...)` через актуальный `latestCtx`, а не через восстановленные UI-флаги.

Для Chrome Assistent эти паттерны адаптируются так:

- `BackgroundAssistantStateServer` — authoritative browser-side snapshot server.
- `BrokerClient` — live channel к broker для chat/subscription.
- `listTargets` — только fallback refresh, не замена live channel.
- `sidepanel.ts` — reconnecting thin client к background port.
- Target Pi-сессия — authoritative source для model/context state выбранной сессии.

---

## Предварительная очистка перед исполнением

В рабочем дереве уже есть незакоммиченные изменения, включая два диагностических failing-теста, добавленных во время расследования:

- `src/chrome/backgroundStateServer.test.ts` — тест, показывающий, что при `listTargets` сейчас не создаётся live `BrokerClient` для chat.
- `src/chrome/sidepanelNavigation.test.ts` — тест, показывающий, что sidepanel не reconnect-ится после `port.onDisconnect`.

Перед исполнением плана нужно решить: оставить эти тесты как RED-шаги или переписать их в рамках Task 1/2. Не начинать production code edits, пока RED-тесты явно не зафиксированы.

---

### Task 1: Восстановить live BrokerClient при наличии one-shot refresh

**TDD scenario:** Modifying tested code — use existing failing regression test, then implement minimal fix.

**Files:**
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/backgroundStateServer.ts`
- Related: `src/chrome/background.ts`

**Step 1: Зафиксировать RED-тест**

Тест должен проверять сценарий:

```ts
it("keeps a live broker client for chat when one-shot session refresh is configured", async () => {
  const { server, brokerClients } = createServer({
    listTargets: async () => ({ ok: true, targets: [createTarget({ targetId: "target-1" })] }),
  });
  const port = new FakePort();

  await server.start();
  server.connectPort(port);
  await flushAsyncWork();
  brokerClients[0]?.emitConnectionState({ online: true, statusText: "Pi подключён" });
  port.emitMessage({ type: "assistant.selectTarget", targetId: "target-1" });

  port.emitMessage({ type: "assistant.sendChatMessage", message: "привет" });

  expect(brokerClients).toHaveLength(1);
  expect(brokerClients[0]?.connect).toHaveBeenCalledTimes(1);
  expect(brokerClients[0]?.setSelectedTargetId).toHaveBeenCalledWith("target-1");
  expect(brokerClients[0]?.sendChatMessage).toHaveBeenCalledWith("привет");
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run src/chrome/backgroundStateServer.test.ts -t "keeps a live broker" --reporter verbose
```

Expected: FAIL because `brokerClients` is empty or `sendChatMessage` is not called.

**Step 3: Minimal implementation**

In `BackgroundAssistantStateServer.applyBrowserToken()` remove the architectural branch that disables live broker when `listTargetsCommand` exists.

Desired behavior:

- if token exists, always call `connectBrokerClient(nextToken)`;
- if `listTargetsCommand` exists and sidepanel port is open, additionally run `refreshSessionsViaListTargets()`;
- one-shot refresh must not close or replace the live `BrokerClient`;
- `refreshSessionsViaBrokerClient()` remains only fallback for environments without `listTargetsCommand`.

Pseudo-shape:

```ts
if (nextToken !== undefined) {
  this.connectBrokerClient(nextToken);
}

this.broadcastSnapshot();

if (nextToken !== undefined && this.listTargetsCommand && this.ports.size > 0) {
  this.refreshSessionsViaListTargets();
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/chrome/backgroundStateServer.test.ts -t "keeps a live broker" --reporter verbose
```

Expected: PASS.

---

### Task 2: Sidepanel reconnect к background port по паттерну pi-web-ui

**TDD scenario:** Modifying tested code — write/keep failing reconnect test first.

**Files:**
- Modify: `src/chrome/sidepanelNavigation.test.ts`
- Modify: `src/chrome/sidepanel.ts`

**Step 1: RED-тест**

Проверить, что после `port.onDisconnect` sidepanel:

1. временно показывает состояние переподключения/недоступности;
2. вызывает `chrome.runtime.connect` повторно;
3. принимает новый `assistant.snapshot`;
4. заменяет unavailable UI нормальным списком сессий.

Test outline:

```ts
it("reconnects the assistant port after background disconnect instead of staying unavailable", async () => {
  vi.useFakeTimers();
  loadSidePanelHtml();
  const runtime = mockChromeRuntime();
  await importInitializedSidePanel();

  runtime.ports[0]?.emit({ type: "assistant.snapshot", state: createReadySnapshot() });
  runtime.ports[0]?.disconnect();

  await vi.advanceTimersByTimeAsync(250);
  runtime.ports[1]?.emit({
    type: "assistant.snapshot",
    state: createReadySnapshot({ targets: [createTarget({ alias: "Alpha restored" })] }),
  });

  expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
  expect(document.querySelector("#target-container")?.textContent).toContain("Alpha restored");
});
```

**Step 2: Verify RED**

```bash
npx vitest run src/chrome/sidepanelNavigation.test.ts -t "reconnects the assistant" --reporter verbose
```

Expected: FAIL because current sidepanel stays unavailable.

**Step 3: Implementation**

Implement in `sidepanel.ts`:

- `connectAssistantPort(elements)` becomes idempotent;
- keep `reconnectTimer` and `reconnectAttempt` module state;
- on disconnect:
  - ignore stale port disconnects;
  - set `assistantPort = undefined`;
  - render temporary Russian status: `Переподключаем боковую панель…`;
  - schedule reconnect with bounded short backoff: `[250, 1000, 2000]`, then stay at `2000`;
- on first successful snapshot after reconnect:
  - clear timer/attempt;
  - render authoritative snapshot.

Do not clear durable UI state before reconnect unless no snapshot arrives. This follows `pi-web-ui`: client reconnects, server sends snapshot.

**Step 4: Verify GREEN**

```bash
npx vitest run src/chrome/sidepanelNavigation.test.ts -t "reconnects the assistant" --reporter verbose
```

Expected: PASS.

---

### Task 3: Authoritative snapshot policy и stale targets

**TDD scenario:** Modifying tested code — existing tests plus focused regression tests.

**Files:**
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/assistantState.ts`
- Modify: `src/chrome/sidepanel.ts`

**Step 1: Add/verify tests**

Scenarios:

1. When broker goes offline after targets existed, `targets` remain and `connection.targetsStale === true`.
2. When broker reports online before targets, `targetsStale` remains true until `client.targets` or successful one-shot result arrives.
3. When successful targets arrive, `targetsStale === false` and selected target is preserved if still present.
4. When target disappears from fresh targets, selected target clears.

**Step 2: Run expected failing tests**

```bash
npx vitest run src/chrome/backgroundStateServer.test.ts -t "targets stale|sessions refresh|preserves selected" --reporter verbose
```

Expected: current failures identify exact regressions.

**Step 3: Implementation**

Rules:

- `targets_updated` is the only event allowed to replace `targets`.
- `connection_updated` must never clear `targets`.
- Offline/connecting state sets `targetsStale` to `state.targets.length > 0`.
- Successful `applyTargets` sets `targetsStale: false` and `targetsRefreshPending: false`.
- `isChatSendDisabled` remains strict for live chat, but UI must distinguish stale list from chat availability.

**Step 4: Verify**

```bash
npx vitest run src/chrome/backgroundStateServer.test.ts
```

Expected: PASS.

---

### Task 4: Chat readiness and selected target resubscription

**TDD scenario:** Modifying tested code.

**Files:**
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/brokerClient.test.ts`
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/brokerClient.ts`
- Modify: `src/chrome/assistantState.ts`

**Step 1: Tests**

Add/verify:

1. `BrokerClient.connect()` subscribes to existing `selectedTargetId` after socket open/targets response.
2. `BackgroundAssistantStateServer.selectTarget()` calls `brokerClient.setSelectedTargetId()` every time selected target changes.
3. After reconnect, selected target is re-subscribed.
4. `client.chatAccepted` should not be required for UI to append user message, but if broker returns `client.error`, UI receives error and busy clears.

**Step 2: Run RED**

```bash
npx vitest run src/chrome/brokerClient.test.ts src/chrome/backgroundStateServer.test.ts -t "selected target|sendChatMessage|subscribe"
```

**Step 3: Implementation**

- In `BrokerClient.handleEnvelope("client.targets")`, after `reportState(true, ...)` and `onTargets`, ensure current `selectedTargetId` is subscribed if socket is open.
- In `BrokerClient.connect()`, retain desired `selectedTargetId`; reset only `subscribedTargetId`.
- Do not conflate `listTargets` success with chat readiness. Chat readiness comes from live broker connection state.

**Step 4: Verify**

```bash
npx vitest run src/chrome/brokerClient.test.ts src/chrome/backgroundStateServer.test.ts
```

Expected: PASS.

---

### Task 5: Header avatar uses extension icon

**TDD scenario:** Trivial UI change — use judgment, verify DOM/build.

**Files:**
- Modify: `src/chrome/sidepanel.html`
- Modify: `src/chrome/sidepanel.css`
- Verify existing: `src/chrome/icon.svg`

**Step 1: HTML change**

Replace:

```html
<div class="avatar" aria-hidden="true">π</div>
```

With:

```html
<img class="avatar avatar--icon" src="./icon.svg" alt="" aria-hidden="true" />
```

Alternative if circular background is desired:

```html
<div class="avatar" aria-hidden="true">
  <img class="avatar__icon" src="./icon.svg" alt="" />
</div>
```

Recommended: wrapper variant if current CSS relies on circular avatar sizing.

**Step 2: CSS change**

Add:

```css
.avatar__icon {
  width: 20px;
  height: 20px;
  display: block;
}
```

If direct `<img>` variant is used, ensure `object-fit: contain` and remove text-specific `font-weight`.

**Step 3: Verify**

```bash
npm run build
```

Expected: icon copied to `dist/chrome/icon.svg`, sidepanel references it correctly.

---

### Task 6: Protocol for target runtime state: model + context usage

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/shared/protocol.test.ts`
- Modify: `docs/architecture/protocol.md`

**Step 1: Add protocol types and tests**

Add message types:

```ts
"client.getTargetRuntimeState",
"client.setTargetModel",
"target.runtimeState",
"target.getRuntimeState",
"target.setModel",
```

Add types:

```ts
export type TargetRuntimeState = {
  targetId: string;
  model?: {
    provider?: string;
    id?: string;
    label?: string;
  };
  contextUsage?: {
    tokens?: number;
    maxTokens?: number;
    percentage?: number;
  };
  thinkingLevel?: string;
  isIdle?: boolean;
  updatedAt: number;
};

export type BrowserClientSetTargetModelPayload = {
  token: string;
  targetId: string;
  provider: string;
  modelId: string;
};
```

Validation tests should reject missing `token`, `targetId`, `provider`, `modelId`.

**Step 2: Run RED**

```bash
npx vitest run src/shared/protocol.test.ts -t "runtime state|set target model"
```

Expected: FAIL until types/validators are added.

**Step 3: Implementation**

Implement validators analogously to `validateSendChatMessagePayload`.

**Step 4: Verify**

```bash
npx vitest run src/shared/protocol.test.ts
```

Expected: PASS.

---

### Task 7: Pi target publishes runtime state and handles model switching

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/pi/targetClient.ts`
- Modify: `src/pi/targetClient.test.ts`
- Modify: `src/pi/browserConnectExtension.ts`
- Modify: `src/pi/browserConnectExtension.test.ts`

**Step 1: Tests for target runtime state**

Add tests that simulate ExtensionContext-like values:

- `ctx.model` maps to `TargetRuntimeState.model`;
- `ctx.getContextUsage()` maps to context usage;
- `ctx.isIdle()` maps to `isIdle`;
- target emits `target.runtimeState` after registration and on relevant Pi events.

**Step 2: Tests for model switching**

Target receives `target.setModel` and calls:

```ts
const models = await ctx.modelRegistry.getAvailable();
const model = models.find((m) => m.provider === provider && m.id === modelId);
await pi.setModel(model);
```

Return success/error to broker.

**Step 3: Run RED**

```bash
npx vitest run src/pi/targetClient.test.ts src/pi/browserConnectExtension.test.ts -t "runtime state|set model"
```

**Step 4: Implementation**

In `browserConnectExtension.ts`, when connecting target:

- pass runtime state builder into `connectTargetToBroker`;
- subscribe to Pi events that can change UI state:
  - `model_select`;
  - `turn_start`;
  - `turn_end`;
  - `message_end`;
  - `session_start`.

Use the `pi-web-ui` pattern: keep latest `ExtensionContext` and build state from it when needed.

**Step 5: Verify**

```bash
npx vitest run src/pi/targetClient.test.ts src/pi/browserConnectExtension.test.ts
```

Expected: PASS.

---

### Task 8: Broker routes runtime state and model commands

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/pi/broker.ts`
- Modify: `src/pi/broker.test.ts`

**Step 1: Tests**

Add tests:

1. Browser sends `client.getTargetRuntimeState` → broker forwards `target.getRuntimeState` to selected target → browser receives `target.runtimeState` or `client.runtimeState` depending final naming.
2. Target emits `target.runtimeState` unsolicited → broker broadcasts it only to browser sockets subscribed to that `targetId`.
3. Browser sends `client.setTargetModel` → broker forwards `target.setModel`; target response returns to requesting browser.
4. Unauthorized browser token is rejected.

**Step 2: Run RED**

```bash
npx vitest run src/pi/broker.test.ts -t "runtime state|set model"
```

**Step 3: Implementation**

Follow existing chat routing structure:

- `browserSubscriptionsByTargetId` already exists — reuse it for runtime state broadcast.
- For request/response commands, reuse pending request map pattern from selection delivery or create separate minimal pending map.
- Keep no durable model state in broker; broker only routes and maybe caches last runtime state per target for fast browser snapshot.

Recommended: cache latest `TargetRuntimeState` in `RegisteredTarget` so `listTargets`/snapshot can include current model/context quickly later if needed.

**Step 4: Verify**

```bash
npx vitest run src/pi/broker.test.ts
```

Expected: PASS.

---

### Task 9: Chrome BrokerClient consumes runtime state and exposes model commands

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/chrome/brokerClient.ts`
- Modify: `src/chrome/brokerClient.test.ts`
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/assistantState.ts`
- Modify: `src/chrome/assistantState.test.ts`

**Step 1: State shape**

Extend `BackgroundAssistantState`:

```ts
runtime: {
  selectedTargetRuntime?: TargetRuntimeState;
  availableModels?: Array<{ provider?: string; id: string; label?: string }>;
  modelMutationPending: boolean;
  modelError?: string;
};
```

If available models cannot be fetched from current Pi API through target cheaply, defer full searchable picker and implement switching among returned available models in Task 10.

**Step 2: Tests**

- `client.runtimeState` updates background snapshot.
- Selecting target requests runtime state.
- `assistant.model.set` command calls `BrokerClient.setTargetModel(...)`.
- Model mutation pending clears on success/error.

**Step 3: Run RED**

```bash
npx vitest run src/chrome/brokerClient.test.ts src/chrome/backgroundStateServer.test.ts src/chrome/assistantState.test.ts -t "runtime state|model"
```

**Step 4: Implementation**

Add to `BrokerClientOptions`:

```ts
onRuntimeState?: (state: TargetRuntimeState) => void;
onModelCommandResult?: (...) => void;
```

Add methods:

```ts
requestTargetRuntimeState(targetId?: string): boolean;
setTargetModel(input: { targetId?: string; provider: string; modelId: string }): boolean;
```

Call `requestTargetRuntimeState` after subscribe/select and after reconnect.

**Step 5: Verify**

```bash
npx vitest run src/chrome/brokerClient.test.ts src/chrome/backgroundStateServer.test.ts src/chrome/assistantState.test.ts
```

Expected: PASS.

---

### Task 10: UI for context usage and model switching under composer

**TDD scenario:** New feature — full TDD cycle with jsdom tests.

**Files:**
- Modify: `src/chrome/sidepanel.html`
- Modify: `src/chrome/sidepanel.css`
- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/sidepanelNavigation.test.ts`

**Step 1: HTML**

Under `<textarea id="chat-input" ...>` add a compact status row:

```html
<div class="composer-runtime" aria-live="polite">
  <button id="model-button" class="composer-runtime__model" type="button">Модель: неизвестно</button>
  <span id="context-usage" class="composer-runtime__context">Контекст: —</span>
</div>
<div id="model-menu" class="model-menu" hidden></div>
```

All text must be Russian.

**Step 2: Tests**

- Snapshot with model/context renders: `Модель: provider/model`, `Контекст: 42%`.
- Clicking model button opens model list.
- Selecting model posts `{ type: "assistant.model.set", provider, modelId }`.
- During mutation button is disabled and displays `Меняем модель…`.
- Error displays Russian message.

**Step 3: Run RED**

```bash
npx vitest run src/chrome/sidepanelNavigation.test.ts -t "model|context"
```

**Step 4: Implementation**

In `sidepanel.ts`:

- add element refs: `modelButton`, `modelMenu`, `contextUsage`;
- render context as:
  - `Контекст: 12 340 / 200 000 токенов · 6%` if max known;
  - `Контекст: ~12 340 токенов` if max unknown;
  - `Контекст: —` if unavailable;
- render model as:
  - `Модель: Claude Sonnet` or `Модель: provider/modelId`;
  - `Модель: недоступна` if no selected target/runtime;
- model menu lists available models if target provides them;
- selection posts command to background.

**Step 5: Verify**

```bash
npx vitest run src/chrome/sidepanelNavigation.test.ts
```

Expected: PASS.

---

### Task 11: Documentation update

**TDD scenario:** Trivial documentation change.

**Files:**
- Modify: `docs/architecture/broker.md`
- Modify: `docs/architecture/protocol.md`
- Modify: `docs/architecture/chrome-extension.md`
- Modify: `docs/operations/troubleshooting.md`

**Steps:**

Document:

- live `BrokerClient` vs one-shot session refresh;
- sidepanel reconnect behavior;
- stale target policy;
- runtime state protocol;
- model switching limitations;
- context usage display source.

All user-facing documentation must be Russian.

---

### Task 12: Full verification and build

**TDD scenario:** Verification before completion.

**Files:**
- Generated/updated: `dist/chrome/*`

**Step 1: Run focused tests**

```bash
npx vitest run \
  src/shared/protocol.test.ts \
  src/pi/broker.test.ts \
  src/pi/targetClient.test.ts \
  src/pi/browserConnectExtension.test.ts \
  src/chrome/brokerClient.test.ts \
  src/chrome/backgroundStateServer.test.ts \
  src/chrome/assistantState.test.ts \
  src/chrome/sidepanelNavigation.test.ts
```

Expected: PASS.

**Step 2: Run full checks**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all PASS, build updates `dist/chrome`.

**Step 3: Manual smoke test**

1. Start Pi.
2. Run `/chrome-assistent-auth` if needed.
3. Run `/chrome-assistent-connect`.
4. Open extension sidepanel.
5. Verify icon in header.
6. Verify session appears.
7. Send chat message.
8. Kill/restart Pi owner session and confirm stale list + refresh/reconnect behavior.
9. Verify context usage/model display.
10. Change model from sidepanel and verify Pi session model changes.

**Step 4: GitNexus requirement before commit**

Run:

```bash
npx gitnexus analyze
```

Then, if MCP GitNexus tools are available, run detect changes / impact verification according to `AGENTS.md`. If MCP is unavailable, record that in final notes.

---

## Risk notes

- Model switching depends on Pi Extension API availability: `ctx.modelRegistry.getAvailable()` and `pi.setModel(...)`. If runtime types differ, adapt to actual API after reading SDK typings/tests.
- Context max token count may be unavailable. UI must gracefully show approximate current tokens.
- Broker protocol changes must stay backward-compatible enough that old target/browser clients fail safely with `client.error`, not crash.
- Do not implement model switching as Chrome-only state; the selected model must change in the target Pi session.

## Recommended implementation order

1. Stabilize existing chat/session lifecycle first: Tasks 1–4.
2. Apply header icon: Task 5.
3. Add runtime state/model protocol: Tasks 6–9.
4. Add UI: Task 10.
5. Docs and verification: Tasks 11–12.
