# Direct Session Heartbeat Stability Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Устранить idle-обрывы direct WebSocket-подключения Chrome sidepanel к Pi-сессии, сохранив стабильный long-lived канал по образцу `pi-web-ui`, и одновременно отполировать UI блока подключения по порту.

**Architecture:** Опираемся на паттерн `@kkkiio/pi-web-ui`: server живёт внутри Pi-процесса, на connect сразу отдаёт authoritative snapshot, держит heartbeat на стороне WebSocket server и удаляет stale clients. На стороне Chrome сохраняем persistent direct client, делаем бесконечный reconnect с bounded delay и восстановление по сохранённому порту после рестарта MV3 background. Не используем connect-on-send как основной механизм, потому что это ломает streaming/response lifecycle при обрыве во время ответа модели.

**Tech Stack:** TypeScript, Chrome MV3 background/sidepanel/content script, Node `ws`, Vitest, Vite build, Pi Extension API.

---

## Reference implementation to mirror

Перед началом реализации исполнитель обязан перечитать и использовать как reference:

- ` /tmp/tmp.96hXOcOPq1/package/extensions/mirror-server.ts`
  - `wss.on("connection", ...)`
  - `ws.on("pong", ...)`
  - `heartbeatTimer = setInterval(..., 20000)`
  - initial state + full snapshot on connect
- `docs/plans/2026-06-27-direct-session-port-mode.md`
- текущие direct-модули проекта:
  - `src/pi/sessionServer.ts`
  - `src/pi/browserConnectExtension.ts`
  - `src/chrome/sessionClient.ts`
  - `src/chrome/backgroundStateServer.ts`
  - `src/chrome/sidepanel.ts`
  - `src/chrome/sidepanel.css`
  - `src/chrome/sidepanelNavigation.test.ts`
  - `src/chrome/sidepanelAuthLifecycle.test.ts`

Ключевой вывод из `pi-web-ui`:

1. Не lazy-connect per action.
2. Есть long-lived WS.
3. Есть server-side heartbeat каждые 20s.
4. На reconnect клиент получает полный snapshot.
5. Сервер чистит stale sockets сам.

---

## Design decisions for this fix

### Что НЕ делаем

- не переключаемся на "подключаться только по кнопке Отправить" как основной режим;
- не завязываем восстановление только на ручной reconnect;
- не возвращаем broker/listTargets/auth;
- не делаем workaround уровня "просто скрыть ошибку".

### Что делаем

- добавляем heartbeat в direct `sessionServer`;
- делаем reconnect в `SessionClient` бесконечным, а не только 3 попытки;
- сохраняем snapshot-on-connect как authoritative recovery mechanism;
- при клике на `Отправить` разрешаем форсировать reconnect только как fallback UX, но не как основную transport-стратегию;
- улучшаем session status UI:
  - `session-port-input` высота `32px`;
  - статусное сообщение цветное и с emoji:
    - warning: жёлтый, например `⚠️`;
    - success: зелёный, например `✅`;
    - error: красный, например `❌`.

---

## Phase 1: Reproduce and lock the bugs with tests

### Task 1: Add failing tests for idle stability and reconnect policy

**TDD scenario:** Modifying tested code — run existing tests first, then add focused failing tests.

**Files:**
- Modify: `src/pi/sessionServer.test.ts`
- Modify: `src/chrome/sessionClient.test.ts`
- Modify: `src/chrome/backgroundStateServer.test.ts`

**Step 1: Run baseline tests**

Run:
```bash
npx vitest run src/pi/sessionServer.test.ts src/chrome/sessionClient.test.ts src/chrome/backgroundStateServer.test.ts --reporter verbose
```

Expected: PASS on current branch before new tests are added.

**Step 2: Add failing heartbeat server tests**

In `src/pi/sessionServer.test.ts` add tests for:

1. server sends/preserves heartbeat cycle for open clients;
2. server removes dead client that does not respond to ping;
3. heartbeat timer is cleared on `close()`.

Test shape:
```ts
it("keeps live websocket clients through heartbeat", async () => {
  // start server with short heartbeat interval for test
  // connect ws client
  // wait > 1 heartbeat interval
  // assert socket still open
});
```

```ts
it("terminates stale websocket clients that miss heartbeat", async () => {
  // use controllable/fake ws client or node ws with pong disabled if feasible
  // assert server closes/removes stale connection
});
```

**Step 3: Add failing reconnect policy tests**

In `src/chrome/sessionClient.test.ts` add tests for:

1. reconnect does not stop after 3 attempts;
2. after repeated close events client keeps scheduling retries with last bounded delay;
3. after reconnect and snapshot, retry counter resets.

Concrete test direction:
```ts
it("keeps reconnecting after many consecutive close events", () => {
  // Fake timers
  // repeatedly close sockets
  // advance timers beyond 3 attempts
  // expect more than 3 connection attempts total
});
```

**Step 4: Add failing background restore tests**

In `src/chrome/backgroundStateServer.test.ts` add/keep focused tests for:

1. saved port reconnects automatically after first sidepanel port attaches;
2. if `SessionClient` later disconnects, state remains recoverable and reconnect loop continues;
3. service-worker-style re-instantiation with stored `sessionPort` recreates live direct client.

**Step 5: Verify RED**

Run:
```bash
npx vitest run src/pi/sessionServer.test.ts src/chrome/sessionClient.test.ts src/chrome/backgroundStateServer.test.ts --reporter verbose
```

Expected: FAIL specifically on newly added heartbeat/reconnect assertions.

**Step 6: Commit test-only state**

```bash
git add src/pi/sessionServer.test.ts src/chrome/sessionClient.test.ts src/chrome/backgroundStateServer.test.ts
git commit -m "test: capture direct session stability regressions"
```

---

## Phase 2: Implement pi-web-ui-style heartbeat on the Pi session server

### Task 2: Add server-side heartbeat to `sessionServer`

**TDD scenario:** New transport behavior — implement minimal code to satisfy new failing tests.

**Files:**
- Modify: `src/pi/sessionServer.ts`
- Test: `src/pi/sessionServer.test.ts`

**Step 1: Add heartbeat configuration constants**

Add to `src/pi/sessionServer.ts`:
```ts
export const DIRECT_SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
```

Optional test hook:
```ts
heartbeatIntervalMs?: number;
```
inside server start options.

**Step 2: Track per-client liveness**

Add internal type similar to `pi-web-ui`:
```ts
type AliveWebSocket = WebSocket & { isAlive?: boolean };
```

On `connection`:
```ts
const aliveWs = ws as AliveWebSocket;
aliveWs.isAlive = true;
ws.on("pong", () => {
  aliveWs.isAlive = true;
});
```

**Step 3: Add heartbeat interval**

Mirror `pi-web-ui` logic:
```ts
const heartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const aliveClient = client as AliveWebSocket;
    if (!aliveClient.isAlive) {
      client.terminate();
      continue;
    }
    aliveClient.isAlive = false;
    client.ping();
  }
}, heartbeatIntervalMs);
```

**Step 4: Clear heartbeat on server close**

`close()` must clear the interval before/while closing sockets.

**Step 5: Keep snapshot-on-connect unchanged**

Do not replace current snapshot-on-connect behavior.

**Step 6: Verify GREEN**

Run:
```bash
npx vitest run src/pi/sessionServer.test.ts --reporter verbose
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/pi/sessionServer.ts src/pi/sessionServer.test.ts
git commit -m "fix: add direct session websocket heartbeat"
```

---

## Phase 3: Make browser reconnect effectively permanent

### Task 3: Replace finite reconnect attempts with stable bounded retry loop

**TDD scenario:** Modifying tested code — existing direct client tests plus new reconnect tests.

**Files:**
- Modify: `src/chrome/sessionClient.ts`
- Test: `src/chrome/sessionClient.test.ts`

**Problem today:**
`DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1000]` and reconnect stops once the array is exhausted.

**Step 1: Keep RED test active**

Run only reconnect tests:
```bash
npx vitest run src/chrome/sessionClient.test.ts --reporter verbose
```

Expected: reconnect persistence test fails before implementation.

**Step 2: Change reconnect scheduling policy**

Instead of:
```ts
const delay = this.reconnectDelaysMs[this.reconnectAttempt];
if (delay === undefined) return;
```

Use bounded infinite retry:
```ts
const delay = this.reconnectDelaysMs[
  Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)
];
this.reconnectAttempt += 1;
```

So after the initial ramp-up it keeps retrying forever at the last delay.

**Step 3: Preserve reset on successful open/snapshot**

Keep retry counter reset on open/success path.

**Step 4: Verify GREEN**

Run:
```bash
npx vitest run src/chrome/sessionClient.test.ts --reporter verbose
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/sessionClient.ts src/chrome/sessionClient.test.ts
git commit -m "fix: keep direct session client reconnecting indefinitely"
```

---

## Phase 4: Restore live direct connection automatically after MV3 background restart

### Task 4: Ensure saved port restore creates a live `SessionClient`

**TDD scenario:** Modifying tested code — existing tests already cover this partially; keep dedicated restore tests.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts`
- Test: `src/chrome/backgroundStateServer.test.ts`

**Step 1: Run restore tests**

```bash
npx vitest run src/chrome/backgroundStateServer.test.ts --reporter verbose
```

Expected: PASS only after implementation.

**Step 2: Ensure `tryRestoreSavedPort()` calls live connect path**

Correct behavior:
- validate saved port;
- if no client exists, call `handleSessionConnect(savedPort)`;
- do not merely copy `configuredPort` into state.

**Step 3: Avoid duplicate reconnect loops**

Guard against duplicate client creation:
```ts
if (this.sessionClient === undefined) {
  this.handleSessionConnect(savedPort);
}
```

**Step 4: Verify GREEN**

```bash
npx vitest run src/chrome/backgroundStateServer.test.ts --reporter verbose
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/backgroundStateServer.ts src/chrome/backgroundStateServer.test.ts
git commit -m "fix: restore saved direct session connection after background restart"
```

---

## Phase 5: Improve sidepanel UX for connection status

### Task 5: Make session status visibly semantic and align input height

**TDD scenario:** Modifying tested UI — update tests first if current assertions are too weak.

**Files:**
- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/sidepanel.css`
- Modify: `src/chrome/sidepanelNavigation.test.ts`
- Modify: `src/chrome/sidepanelAuthLifecycle.test.ts`
- Modify: `src/chrome/sidepanel.html` only if extra wrapper/class needed

**Step 1: Add failing UI tests**

Add tests for:

1. `#session-port-input` has same visual height as connect button (`32px` via class/style contract);
2. warning state renders yellow message with emoji for default/help state;
3. success state renders green message with emoji when online;
4. error state renders red message with emoji when `lastError` exists.

Suggested text expectations:
- warning/default:
  - `⚠️ Введите порт Pi-сессии и нажмите «Подключить».`
- success:
  - `✅ Подключено к 127.0.0.1:<port>`
- error:
  - `❌ <текст ошибки>`

**Step 2: Add semantic status rendering in `sidepanel.ts`**

Refactor `renderSessionConnection()` so it computes both:
- `statusText`
- `statusTone: "warning" | "success" | "error" | "info"`

Use exact rules:

```ts
if (state.connection.connecting) {
  // optionally info or warning; choose one and keep tests aligned
}
else if (state.connection.online) {
  success
}
else if (state.connection.lastError) {
  error
}
else {
  warning
}
```

**Step 3: Apply visual class names**

For example:
```ts
elements.sessionConnectionStatus.dataset.tone = statusTone;
```

CSS contract:
```css
.session-port-input {
  height: 32px;
}

#connect-session-button {
  height: 32px;
}

.panel__hint[data-tone="warning"] { color: #d4a106; }
.panel__hint[data-tone="success"] { color: #389e0d; }
.panel__hint[data-tone="error"] { color: #cf1322; }
```

Do not hardcode green circle/background hacks; only message tone.

**Step 4: Verify GREEN**

```bash
npx vitest run src/chrome/sidepanelNavigation.test.ts src/chrome/sidepanelAuthLifecycle.test.ts --reporter verbose
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/sidepanel.ts src/chrome/sidepanel.css src/chrome/sidepanelNavigation.test.ts src/chrome/sidepanelAuthLifecycle.test.ts src/chrome/sidepanel.html
git commit -m "fix: add semantic direct session status ui"
```

---

## Phase 6: Optional send-button reconnect assist (secondary, not primary)

### Task 6: Add soft reconnect trigger on send only as fallback UX

**TDD scenario:** Modifying behavior with existing tests.

**Files:**
- Modify: `src/chrome/sidepanel.ts`
- Modify: `src/chrome/backgroundStateServer.ts`
- Modify: relevant tests only if needed

**Important:** This task is optional and secondary.

**Behavior:**
- if user clicks `Отправить` while offline but `configuredPort` exists,
  - trigger `assistant.session.connect` first,
  - show reconnecting state,
  - do **not** pretend message was sent yet.

No automatic queueing in this task unless a dedicated test is added. YAGNI.

**Why optional:** if heartbeat + infinite reconnect works well, this fallback may be unnecessary.

---

## Phase 7: Final verification

### Task 7: Full direct-mode verification

**TDD scenario:** Verification only.

**Files:** none or docs if outcomes need updating.

**Step 1: Run focused direct suites**

```bash
npx vitest run \
  src/pi/sessionServer.test.ts \
  src/pi/browserConnectExtension.test.ts \
  src/chrome/sessionClient.test.ts \
  src/chrome/backgroundStateServer.test.ts \
  src/chrome/background.test.ts \
  src/chrome/contentScript.test.ts \
  src/chrome/contentScriptMessages.test.ts \
  src/chrome/sidepanelNavigation.test.ts \
  src/chrome/sidepanelAuthLifecycle.test.ts \
  src/shared/protocol.test.ts \
  --reporter verbose
```

**Step 2: Run full project checks**

```bash
npm test -- --reporter verbose
npm run typecheck
npm run build
```

Expected: all PASS.

**Step 3: Run cleanup scan**

```bash
rg "browserToken|BROWSER_TOKEN_STORAGE_KEY|selectedTargetId|listTargets|BrokerClient|brokerClient|TargetMetadata|targetsStale|targetsRefreshPending|subscribeTarget|client\.hello|client\.targets|target\.register|connectTargetToBroker|startBrokerServer|chrome-assistent-auth|DEFAULT_BROKER" src || true
```

Expected: no production matches.

**Step 4: Run GitNexus detect-changes**

```bash
npx gitnexus detect-changes --repo Pi-Chrome-Assistent
```

If risk is HIGH/CRITICAL, include explicit note in handoff/PR that this is expected because transport architecture was intentionally replaced.

**Step 5: Commit final verification-safe state**

```bash
git add -A
git commit -m "fix: stabilize direct session connection lifecycle"
```

---

## Expected outcome

После выполнения плана система должна вести себя так:

1. Пользователь подключается к порту один раз.
2. При бездействии 20+ секунд direct WS не отваливается из-за idle timeout.
3. Если background service worker Chrome рестартует, direct connection автоматически восстанавливается по сохранённому `sessionPort`.
4. Если соединение всё же оборвалось, `SessionClient` продолжает retry бесконечно.
5. После reconnect sidepanel получает полный свежий snapshot.
6. Статус подключения в UI визуально понятен:
   - `⚠️` warning,
   - `✅` success,
   - `❌` error,
   - input `session-port-input` высотой `32px`, как кнопка `Подключить`.

---

## Notes for implementer

- Отдельная ошибка runtime вида:
  ```text
  Cannot find module ... @earendil-works/pi-ai/dist/providers/openai-completions.js
  ```
  не решается heartbeat-логикой. Это отдельная проблема установленного Pi/`pi-ai` package/provider registry и должна диагностироваться отдельно от транспортной стабильности.
- При реализации heartbeat не ломать существующий direct protocol payload layout.
- Не добавлять broker compatibility adapters.
- Предпочитать минимальные transport-level изменения над крупным UI refactor.
