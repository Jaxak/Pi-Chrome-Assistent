# Direct Chat Mirror Rearchitecture Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Полностью заменить текущую нестабильную direct-chat реализацию на mirror-механику по образцу `pi-web-ui`, чтобы история сессии и live-ответы приходили в sidepanel одним и тем же согласованным способом.

**Architecture:** Источником истины для чата становится не синтетический `chat.events`, а authoritative snapshot из `ctx.sessionManager.getBranch()` плюс поток сырых Pi events (`message_start`, `message_update`, `message_end`, `turn_*`, `tool_execution_*`, `model_select`). Chrome sidepanel должен стать mirror-клиентом: на connect получает полную историю entries, а затем обновляет UI по live events. Любой старый промежуточный слой, который пытается отдельно «собирать чат», удаляется без обратной совместимости.

**Tech Stack:** TypeScript, Chrome MV3 background/sidepanel/content script, Pi Extension API, Node `ws`, Vitest, Vite build.

---

## Reference implementation to mirror

Перед началом реализации исполнитель обязан перечитать и использовать как эталон:

- `/tmp/tmp.96hXOcOPq1/package/extensions/mirror-server.ts`
  - `buildStateSnapshot(ctx)`
  - `ctx.sessionManager.getBranch()`
  - event forwarding через `broadcast({ type: "event", event: ... })`
  - heartbeat (`ping`/`pong`/`terminate`)
- `docs/plans/2026-06-27-direct-session-heartbeat-stability.md`
- `docs/plans/2026-06-28-direct-chat-mirror-rearchitecture.md` (этот план)
- текущие direct-модули проекта:
  - `src/pi/browserConnectExtension.ts`
  - `src/pi/sessionServer.ts`
  - `src/chrome/sessionClient.ts`
  - `src/chrome/backgroundStateServer.ts`
  - `src/chrome/assistantState.ts`
  - `src/chrome/sidepanelState.ts`
  - `src/chrome/sidepanel.ts`
  - `src/shared/protocol.ts`

Ключевой вывод из `pi-web-ui`:

1. snapshot содержит **entries branch**, а не самодельную реконструкцию чата;
2. live updates приходят отдельными raw events;
3. reconnect и initial load используют один и тот же источник истины;
4. UI не «угадывает» историю, а зеркалит session state;
5. stale sockets чистятся heartbeat-сервером.

---

## Non-goals / what must be deleted

### Что удалить до новой реализации

Удалить как продуктовую архитектуру, тестовые ожидания и мёртвый код:

- текущий synthetic chat pipeline на основе `snapshot.chat.events` как **основного** источника истории;
- любые попытки отдельно «материализовать чат» из промежуточного transient-only слоя, если они не опираются на authoritative session entries;
- устаревшие тесты, которые закрепляют неверное поведение:
  - чат живёт только в `chat.events`;
  - reconnect можно чинить merge-логикой вместо полного snapshot+event mirror;
  - sidepanel history должна сохраняться за счёт локального state fallback, а не за счёт snapshot;
- любой dead code, оставшийся после удаления broker/direct transitional paths;
- любой код, который делает вид, что чат работает без обработки raw `message_update` от Pi.

### Что НЕ делаем

- не сохраняем обратную совместимость со старым chat-only protocol;
- не поддерживаем одновременно две архитектуры (old direct-chat + new mirror-chat);
- не оставляем feature flags для старого пути;
- не делаем workaround вида «подгружать историю только на reconnect кнопкой».

---

## New target protocol

Новый direct protocol для UI должен быть ближе к `pi-web-ui`:

### Snapshot envelope

`session.snapshot` payload должен включать:

```ts
session: {
  cwd: string;
  gitBranch?: string;
  pid: number;
  sessionName?: string;
  alias?: string;
  connectedAt: number;
};
chat: {
  entries: SessionEntryLike[];
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
```

`SessionEntryLike` — минимальный сериализуемый shape, достаточный для sidepanel mirror UI:

```ts
{
  type: "message";
  id: string;
  timestamp: string;
  message: {
    role: "user" | "assistant" | "toolResult" | "custom" | "branchSummary" | "compactionSummary";
    content: unknown;
    stopReason?: string;
    errorMessage?: string;
  };
}
```

### Live event envelope

Добавить отдельный тип, например:

```ts
{ type: "session.event", payload: PiMirrorEvent }
```

Где `PiMirrorEvent` по смыслу повторяет forwarded events из `pi-web-ui`, минимум:

- `message_start`
- `message_update`
- `message_end`
- `turn_start`
- `turn_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `model_select`

### Commands remain direct

Сохранить direct command types:

- `session.chat.send`
- `session.selection.send`
- `session.model.set`
- `session.command.result`
- `session.error`

Но chat rendering в UI больше не должен зависеть от custom `ChatEvent` как primary data model.

---

## Phase 1: Delete wrong architecture and lock failures

### Task 1: Remove/replace wrong chat-state tests first

**TDD scenario:** Deletion/cleanup — remove obsolete tests first, then pin correct failing behavior.

**Files:**
- Modify: `src/chrome/assistantState.test.ts`
- Modify: `src/chrome/sidepanelState.test.ts`
- Modify: `src/pi/browserConnectExtension.test.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`
- Modify: `src/chrome/sidepanelNavigation.test.ts` only if chat assertions depend on old shape

**Step 1: Delete obsolete assertions**

Delete tests that encode any of these wrong assumptions:

- chat history is reconstructed only from `snapshot.chat.events`;
- local Chrome state may preserve old messages when snapshot is empty;
- duplicate-avoidance merge on synthetic chat events is the desired persistence model;
- a reconnect may be considered successful without loading authoritative entries history;
- sidepanel chat correctness is proven without raw `message_update` handling.

**Step 2: Add new failing tests for mirror behavior**

Add tests that describe the correct architecture:

1. `session.snapshot` with `chat.entries` renders full persisted history;
2. subsequent `session.event` with `message_update` appends live assistant delta to the currently streaming message;
3. reconnect with the same snapshot reproduces the same visible chat without relying on previous local state;
4. opening/closing sidepanel does not require `/reload` or `/chrome-assistent-connect` to see new assistant messages.

**Step 3: Verify RED**

Run:
```bash
npx vitest run \
  src/chrome/assistantState.test.ts \
  src/chrome/sidepanelState.test.ts \
  src/chrome/backgroundStateServer.test.ts \
  src/pi/browserConnectExtension.test.ts \
  --reporter verbose
```

Expected: FAIL on new mirror-behavior tests.

---

### Task 2: Delete old synthetic chat data model from protocol/tests

**TDD scenario:** Cleanup before implementation.

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/shared/protocol.test.ts`

**Step 1: Remove obsolete primary chat types**

Remove `ChatEvent` as the primary snapshot history model.

If some event union is still useful for live forwarding, rename it to mirror-specific semantics instead of pretending it is authoritative history.

**Step 2: Replace protocol tests**

Protocol tests must now assert:

- `session.snapshot` accepts `chat.entries`
- `session.event` accepts forwarded event payloads
- direct command envelopes still validate

**Step 3: Verify no old `chat.events`-as-history assumptions remain**

Run:
```bash
rg "chat\.events|assistant_text_delta|assistant_message_start|assistant_message_end" src/shared src/chrome src/pi
```

Expected after cleanup:
- matches remain only where they are part of **live event forwarding**, not the primary chat snapshot history model.

---

## Phase 2: Rebuild Pi server to mirror `pi-web-ui`

### Task 3: Make `browserConnectExtension` produce authoritative entries snapshot

**TDD scenario:** Modifying tested code — existing tests plus new snapshot tests.

**Files:**
- Modify: `src/pi/browserConnectExtension.ts`
- Modify: `src/pi/browserConnectExtension.test.ts`

**Step 1: Add failing tests**

Tests must prove:

1. `buildSnapshot()` includes `ctx.sessionManager.getBranch()` entries as-is (or a minimal faithful serialization);
2. snapshot includes persisted user + assistant history after reconnect;
3. snapshot does not depend on old transient merge tricks for already persisted messages.

**Step 2: Delete wrong merge helpers**

Delete helpers that try to merge synthetic chat history to simulate persistence.

Examples likely to delete or radically simplify:
- `mergeChatEvents(...)`
- `buildChatEventsFromSessionBranch(...)`
- any `extractTextContent(...)` path used only to reconstruct chat from entries when the entries themselves can be sent.

**Step 3: Implement authoritative snapshot**

Mirror `pi-web-ui` approach:

```ts
const entries = ctx.sessionManager.getBranch();
return {
  session: ...,
  chat: {
    entries,
    agentBusy: !ctx.isIdle(),
    busyLabel: "Агент работает в фоне…",
  },
  runtime: ...,
};
```

If a minimal serializable projection is needed, keep it faithful to original session messages.

**Step 4: Verify GREEN**

Run:
```bash
npx vitest run src/pi/browserConnectExtension.test.ts --reporter verbose
```

Expected: PASS.

---

### Task 4: Forward raw Pi events over direct session WebSocket

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/pi/sessionServer.ts`
- Modify: `src/pi/sessionServer.test.ts`
- Modify: `src/pi/browserConnectExtension.ts`
- Modify: `src/pi/browserConnectExtension.test.ts`
- Modify: `src/shared/protocol.ts`
- Modify: `src/shared/protocol.test.ts`

**Step 1: Add failing tests**

Need tests for:

1. server can send `session.event` envelopes to connected clients;
2. browserConnectExtension forwards `message_start/update/end` into `session.event`;
3. `assistantMessageEvent.type === "text_delta"` survives into client payload.

**Step 2: Add protocol support**

Add `session.event` to allowed protocol message types.

**Step 3: Implement server broadcast helper**

In `sessionServer.ts` add something like:

```ts
broadcastEvent(event: PiMirrorEvent): void;
```

**Step 4: Hook browserConnectExtension Pi events**

On:
- `message_start`
- `message_update`
- `message_end`
- optionally `turn_start`, `turn_end`, `tool_execution_*`, `model_select`

call:
```ts
activeSessionServer?.broadcastEvent({ type: "message_update", ...eventPayload });
```

**Step 5: Keep heartbeat unchanged**

Do not regress heartbeat.

**Step 6: Verify GREEN**

Run:
```bash
npx vitest run \
  src/pi/sessionServer.test.ts \
  src/pi/browserConnectExtension.test.ts \
  src/shared/protocol.test.ts \
  --reporter verbose
```

Expected: PASS.

---

## Phase 3: Rebuild Chrome client as a mirror client

### Task 5: Teach `SessionClient` to receive `session.event`

**TDD scenario:** Modifying tested code.

**Files:**
- Modify: `src/chrome/sessionClient.ts`
- Modify: `src/chrome/sessionClient.test.ts`

**Step 1: Add failing tests**

Tests must assert:

1. `session.snapshot` still updates connection state;
2. `session.event` is delivered to a new callback, e.g. `onSessionEvent(...)`;
3. reconnect still works with the new event type.

**Step 2: Extend client API**

Add option:

```ts
onSessionEvent?(event: PiMirrorEvent): void;
```

**Step 3: Implement envelope handling**

In `handleEnvelope(raw)` add:

```ts
case "session.event":
  this.onSessionEvent?.(envelope.payload as PiMirrorEvent);
  return;
```

**Step 4: Verify GREEN**

Run:
```bash
npx vitest run src/chrome/sessionClient.test.ts --reporter verbose
```

Expected: PASS.

---

### Task 6: Replace `assistantState` chat model with entries + live event reducer

**TDD scenario:** High risk (`reduceAssistantState` is CRITICAL) — write tests first and keep blast radius minimal.

**Files:**
- Modify: `src/chrome/assistantState.ts`
- Modify: `src/chrome/assistantState.test.ts`
- Modify: `src/chrome/sidepanelState.ts`
- Modify: `src/chrome/sidepanelState.test.ts`

**Step 1: Add failing reducer tests**

Need tests for:

1. snapshot with entries renders all persisted user/assistant messages;
2. live `message_update` with `text_delta` appends to the current streaming assistant message;
3. `message_end` finalizes the streaming message;
4. reconnect with same entries reproduces the same visible chat;
5. empty snapshot clears visible chat.

**Step 2: Delete dead reducer paths**

Delete code that only exists for the old synthetic event-history path.

Examples likely to remove or radically rewrite:
- old `materializeChatMessages(events)`
- any reducer branch that treats synthetic `ChatEvent[]` as authoritative persisted history
- tests that validate custom merge heuristics instead of real mirror behavior

**Step 3: Introduce mirror-state helpers**

Implement two separate concepts:

1. **Snapshot hydration from entries**
   - parse `entries`
   - build visible `SidepanelChatMessage[]`
2. **Live event application**
   - apply raw forwarded Pi events to already-hydrated messages

**Step 4: Update types**

`SidepanelChatMessage` can stay close to current UI shape, but the reducer input must become session-entry-aware.

**Step 5: Verify GREEN**

Run:
```bash
npx vitest run \
  src/chrome/assistantState.test.ts \
  src/chrome/sidepanelState.test.ts \
  --reporter verbose
```

Expected: PASS.

---

### Task 7: Rewire `BackgroundAssistantStateServer` to apply snapshot + live events

**TDD scenario:** Modifying tested code.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`

**Step 1: Add failing tests**

Need tests for:

1. `onSnapshot` hydrates full history from `entries`;
2. `onSessionEvent(message_update)` updates currently visible assistant response;
3. reconnect does not require `/reload` to see new live messages;
4. opening a new sidepanel port receives already-current mirrored state.

**Step 2: Extend session client factory wiring**

Pass both callbacks:

```ts
onSnapshot(snapshot) { ... }
onSessionEvent(event) { ... }
```

**Step 3: Add state transitions**

Background server should:
- store the current mirror state;
- update it on snapshot;
- mutate it incrementally on live forwarded events;
- broadcast refreshed `assistant.snapshot` to sidepanel ports.

**Step 4: Verify GREEN**

Run:
```bash
npx vitest run src/chrome/backgroundStateServer.test.ts --reporter verbose
```

Expected: PASS.

---

## Phase 4: Rebuild sidepanel rendering around mirror state

### Task 8: Update sidepanel rendering/tests for mirror-driven chat

**TDD scenario:** Modifying tested UI.

**Files:**
- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/sidepanelNavigation.test.ts`
- Modify: `src/chrome/sidepanelAuthLifecycle.test.ts`
- Modify: `src/chrome/sidepanelRender.ts` only if needed
- Modify: `src/chrome/sidepanelRender.test.ts` only if needed

**Step 1: Add failing UI tests**

Need tests for:

1. persisted history from snapshot entries is visible immediately after connect;
2. live assistant delta appears without reconnect;
3. close/open sidepanel still shows latest chat from background state;
4. reconnect status UI still works.

**Step 2: Delete obsolete rendering assumptions**

Delete tests or code that assume chat only changes when a brand-new snapshot with synthetic chat messages arrives.

**Step 3: Keep Russian UX**

Do not regress existing Russian strings, emoji status tone, or DOM picker UI.

**Step 4: Verify GREEN**

Run:
```bash
npx vitest run \
  src/chrome/sidepanelNavigation.test.ts \
  src/chrome/sidepanelAuthLifecycle.test.ts \
  src/chrome/sidepanelRender.test.ts \
  --reporter verbose
```

Expected: PASS.

---

## Phase 5: DOM picker and dead-code cleanup

### Task 9: Keep DOM picker on the new architecture and remove dead fallback code

**TDD scenario:** Modifying tested code.

**Files:**
- Modify: `src/chrome/background.ts`
- Modify: `src/chrome/background.test.ts`
- Modify: `src/chrome/contentScript.ts` only if needed
- Modify: `src/chrome/contentScript.test.ts` only if needed

**Step 1: Verify sendSelection still goes through direct command path**

DOM picker remains command-based (`session.selection.send`), not mirror-based. The new mirror architecture must not regress this.

**Step 2: Delete dead code**

Delete any picker-specific compatibility code that only exists because the old chat architecture was broken.

**Step 3: Verify GREEN**

Run:
```bash
npx vitest run \
  src/chrome/background.test.ts \
  src/chrome/contentScript.test.ts \
  --reporter verbose
```

Expected: PASS.

---

### Task 10: Dead-code sweep

**TDD scenario:** Cleanup verification.

**Files:** production code + tests + docs if needed.

Run these searches and remove every unjustified match:

```bash
rg "chat\.events|materializeChatMessages|mergeChatEvents|buildChatEventsFromSessionBranch|assistant_text_delta|assistant_message_start|assistant_message_end" src
rg "reconstruct|hydrate.*events|synthetic chat|transient chat" src docs
```

Expected after cleanup:
- live forwarded event handling may still mention raw Pi event names;
- no production code should treat the old synthetic event list as the primary persisted chat history model;
- no dead helpers should remain.

---

## Phase 6: Final verification

### Task 11: Full mirror-chat verification

**TDD scenario:** Verification only.

**Files:** none.

**Step 1: Focused test suites**

Run:
```bash
npx vitest run \
  src/shared/protocol.test.ts \
  src/pi/sessionServer.test.ts \
  src/pi/browserConnectExtension.test.ts \
  src/chrome/sessionClient.test.ts \
  src/chrome/backgroundStateServer.test.ts \
  src/chrome/background.test.ts \
  src/chrome/contentScript.test.ts \
  src/chrome/assistantState.test.ts \
  src/chrome/sidepanelState.test.ts \
  src/chrome/sidepanelNavigation.test.ts \
  src/chrome/sidepanelAuthLifecycle.test.ts \
  src/chrome/sidepanelRender.test.ts \
  --reporter verbose
```

**Step 2: Full project verification**

```bash
npm test -- --reporter verbose
npm run typecheck
npm run build
```

**Step 3: GitNexus detect-changes**

```bash
npx gitnexus detect-changes --repo Pi-Chrome-Assistent
```

If risk stays HIGH/CRITICAL, mention explicitly in handoff that this is expected because chat architecture was intentionally replaced.

**Step 4: Manual smoke checklist**

1. Start Pi session and run `/chrome-assistent-connect`.
2. Open sidepanel, connect by port.
3. Verify full prior chat history appears immediately.
4. Send a user message.
5. Verify live assistant response appears token-by-token or incrementally during the same turn.
6. Close and reopen sidepanel.
7. Verify current chat state remains visible.
8. Trigger background restart / extension reload.
9. Verify reconnect restores full history without requiring `/reload` or rerunning `/chrome-assistent-connect`.
10. Run DOM picker on a normal `https://` page and verify selection arrives in chat.

---

## Review checklist for main agent after every implementation task

The main agent must reject a task if any of these are true:

- old synthetic chat architecture remains primary;
- reconnect correctness still depends on transient merge heuristics instead of authoritative snapshot + live event stream;
- sidepanel still cannot receive live assistant text without reconnect;
- full chat history still requires `/reload` or rerunning `/chrome-assistent-connect`;
- DOM picker still posts messages into a dead path;
- dead helper functions remain after migration;
- tests still assert the wrong architecture;
- user-facing strings are not Russian;
- `npm run typecheck` fails.

---

## Expected result

После выполнения плана direct-chat должен работать по mirror-модели `pi-web-ui`:

```text
Pi session entries snapshot + raw live events  <---->  Chrome sidepanel mirror client
```

То есть:

1. На connect sidepanel получает полную историю текущей Pi session.
2. Во время live ответа новые assistant deltas появляются без reconnect.
3. Close/open panel не ломает чат.
4. Background restart/reconnect не требует `/reload` или нового `/chrome-assistent-connect` для актуального чата.
5. DOM picker работает через direct command path.
6. Мёртвый и неверный transitional chat code удалён.
