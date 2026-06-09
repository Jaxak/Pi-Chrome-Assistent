# Browser Connect MVP Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Build an MVP Chrome extension and Pi extension that sends a user-selected DOM fragment from Chrome into a selected already-running Pi TUI terminal via `/browser-connect [alias]`.

**Architecture:** Implement a TypeScript workspace with shared protocol/domain code, a project-local Pi extension that registers `/browser-connect [alias]` and manages a localhost WebSocket broker, and a Manifest V3 Chrome extension with popup target selection plus content-script DOM picker. Browser only receives delivery success/error in MVP; Pi answers are read in the terminal.

**Tech Stack:** TypeScript, npm scripts, Vitest, Chrome Manifest V3 APIs, DOM content scripts, Node.js `http` + `ws`, Pi extension API (`registerCommand`, `sendUserMessage`, session lifecycle events).

---

## Important Context and References

Read before implementing:

- Design: `docs/plans/2026-06-08-browser-connect-mvp-design.md`
- Chrome MV3 reference in project: `CHROME_EXTENSIONS.md`
- Pi extension docs: `/home/simonov_mn/.local/share/fnm/node-versions/v24.12.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi examples: `/home/simonov_mn/.local/share/fnm/node-versions/v24.12.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/send-user-message.ts`
- Pi extension examples index from docs if needed: `/home/simonov_mn/.local/share/fnm/node-versions/v24.12.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/`

Implementation constraints:

- Broker binds only to `127.0.0.1`.
- Browser must not wait for Pi answer in MVP.
- Browser must show delivery success/error toast.
- Errors must be logged on browser side and Pi/broker side.
- Payload content must be truncated before sending to Pi.
- Do not log full selected text/HTML by default.
- Prefer small, testable modules over logic embedded directly in popup/content scripts.

---

## Planned File Layout

Create this layout:

```text
package.json
tsconfig.json
vitest.config.ts
src/
  shared/
    constants.ts
    protocol.ts
    protocol.test.ts
    truncation.ts
    truncation.test.ts
    formatSelectionMessage.ts
    formatSelectionMessage.test.ts
  pi/
    browserConnectExtension.ts
    broker.ts
    broker.test.ts
    targetClient.ts
    targetClient.test.ts
    logging.ts
  chrome/
    manifest.json
    popup.html
    popup.css
    popup.ts
    popup.test.ts
    background.ts
    contentScript.ts
    domPicker.ts
    domPicker.test.ts
    selectionOverlay.ts
    toast.ts
    diagnostics.ts
    diagnostics.test.ts
.pi/
  extensions/
    browser-connect/
      index.ts
README.md
```

Notes:

- `src/pi/browserConnectExtension.ts` contains the real Pi extension implementation.
- `.pi/extensions/browser-connect/index.ts` is a tiny project-local wrapper that imports/exports the extension during development.
- If direct TypeScript path imports from `.pi/extensions/...` are awkward at runtime, the wrapper may duplicate a minimal import using relative paths or instruct users to run built output. Keep the wrapper as thin as possible.
- Chrome build output can be `dist/chrome/`, but source files live in `src/chrome/`.

---

## Task 1: Initialize TypeScript/Vitest project skeleton

**TDD scenario:** Trivial setup — use judgment, verify scripts run.

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/shared/constants.ts`
- Modify: `.gitignore`
- Modify: `README.md`

**Step 1: Create `package.json`**

Use this package baseline:

```json
{
  "name": "pi-chrome-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "npm run build:chrome",
    "build:chrome": "node scripts/build-chrome.mjs"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "latest",
    "typebox": "latest",
    "ws": "latest"
  },
  "devDependencies": {
    "@types/chrome": "latest",
    "@types/node": "latest",
    "@types/ws": "latest",
    "typescript": "latest",
    "vite": "latest",
    "vitest": "latest"
  }
}
```

If package versions resolve poorly, pin current installable versions after `npm install`.

**Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["node", "chrome", "vitest/globals"],
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@pi/*": ["src/pi/*"],
      "@chrome/*": ["src/chrome/*"]
    }
  },
  "include": ["src", ".pi/extensions", "vitest.config.ts", "scripts"]
}
```

**Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

**Step 4: Create `src/shared/constants.ts`**

```ts
export const PROTOCOL_VERSION = 1;
export const DEFAULT_BROKER_HOST = "127.0.0.1";
export const DEFAULT_BROKER_PORT = 17345;
export const MAX_SELECTED_TEXT_BYTES = 50 * 1024;
export const MAX_SELECTED_HTML_BYTES = 100 * 1024;
export const TARGET_HEARTBEAT_INTERVAL_MS = 5_000;
export const TARGET_STALE_AFTER_MS = 15_000;
export const DIAGNOSTIC_LOG_LIMIT = 50;
```

**Step 5: Update `.gitignore`**

Ensure these entries exist:

```gitignore
node_modules/
dist/
coverage/
.pi/browser-connect.log
*.tsbuildinfo
```

Do not ignore `.pi/extensions/` because the project-local Pi extension wrapper is source.

**Step 6: Update `README.md` with dev commands**

Add minimal development section:

```md
## Development

```bash
npm install
npm test
npm run typecheck
npm run build:chrome
```

The unpacked Chrome extension build will be emitted to `dist/chrome`.
```

**Step 7: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and dependencies install successfully.

**Step 8: Verify setup**

Run:

```bash
npm test
npm run typecheck
```

Expected:

- tests: pass with no tests or empty suite behavior handled by Vitest;
- typecheck: pass.

If Vitest fails because no tests exist, add a minimal `src/shared/constants.test.ts` that asserts `PROTOCOL_VERSION === 1`.

**Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/shared/constants.ts .gitignore README.md
git commit -m "chore: initialize TypeScript project"
```

---

## Task 2: Implement shared protocol validation

**TDD scenario:** New feature — full TDD cycle.

**Files:**

- Create: `src/shared/protocol.ts`
- Create: `src/shared/protocol.test.ts`

**Step 1: Write failing tests**

Create `src/shared/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createRequestId,
  isProtocolEnvelope,
  parseProtocolEnvelope,
  validateSelectionPayload,
  type SelectionPayload,
} from "./protocol";

const validSelection: SelectionPayload = {
  url: "https://example.com/page",
  title: "Example",
  selectedText: "hello",
  selectedHtml: "<p>hello</p>",
  selector: "p",
  comment: "explain",
  capturedAt: 1710000000000,
};

describe("protocol envelope", () => {
  it("accepts a valid protocol envelope", () => {
    expect(
      isProtocolEnvelope({ version: 1, type: "client.listTargets", requestId: "abc" }),
    ).toBe(true);
  });

  it("rejects envelopes with wrong version", () => {
    expect(isProtocolEnvelope({ version: 2, type: "client.listTargets" })).toBe(false);
  });

  it("parses valid JSON into an envelope", () => {
    expect(parseProtocolEnvelope(JSON.stringify({ version: 1, type: "client.hello" }))).toEqual({
      version: 1,
      type: "client.hello",
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseProtocolEnvelope("not json")).toBeNull();
  });

  it("creates unique request ids", () => {
    expect(createRequestId()).not.toEqual(createRequestId());
  });
});

describe("selection payload validation", () => {
  it("accepts a valid payload", () => {
    expect(validateSelectionPayload(validSelection).ok).toBe(true);
  });

  it("rejects missing URL", () => {
    const result = validateSelectionPayload({ ...validSelection, url: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects payload without text and html", () => {
    const result = validateSelectionPayload({ ...validSelection, selectedText: "", selectedHtml: "" });
    expect(result.ok).toBe(false);
  });
});
```

**Step 2: Run tests and verify failure**

```bash
npm test -- src/shared/protocol.test.ts
```

Expected: FAIL because `protocol.ts` does not exist.

**Step 3: Implement `src/shared/protocol.ts`**

Define:

- `ProtocolEnvelope`
- `SelectionPayload`
- `TargetMetadata`
- `DeliveryResult`
- message type string constants or union types
- `createRequestId()`
- `isProtocolEnvelope(value)`
- `parseProtocolEnvelope(raw)`
- `validateSelectionPayload(value)` returning `{ ok: true } | { ok: false; error: string }`

Minimal implementation shape:

```ts
import { PROTOCOL_VERSION } from "./constants";

export type ProtocolEnvelope<TPayload = unknown> = {
  version: typeof PROTOCOL_VERSION;
  type: string;
  requestId?: string;
  payload?: TPayload;
};

export type SelectionPayload = {
  url: string;
  title: string;
  selectedText: string;
  selectedHtml: string;
  selector?: string;
  comment?: string;
  capturedAt: number;
};

export type TargetMetadata = {
  targetId: string;
  alias?: string;
  cwd: string;
  gitBranch?: string;
  pid: number;
  sessionName?: string;
  connectedAt: number;
  lastSeenAt: number;
};

export type DeliveryResult = {
  ok: boolean;
  error?: string;
};

export function createRequestId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProtocolEnvelope>;
  return candidate.version === PROTOCOL_VERSION && typeof candidate.type === "string";
}

export function parseProtocolEnvelope(raw: string): ProtocolEnvelope | null {
  try {
    const parsed = JSON.parse(raw);
    return isProtocolEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function validateSelectionPayload(value: unknown): { ok: true } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "Payload must be an object" };
  const payload = value as Partial<SelectionPayload>;
  if (!payload.url) return { ok: false, error: "Missing url" };
  if (!payload.capturedAt || typeof payload.capturedAt !== "number") return { ok: false, error: "Missing capturedAt" };
  if (!payload.selectedText && !payload.selectedHtml) {
    return { ok: false, error: "Selection must include text or html" };
  }
  return { ok: true };
}
```

If `crypto.randomUUID` is not available in test environment, import `randomUUID` from `node:crypto` and use that.

**Step 4: Run tests**

```bash
npm test -- src/shared/protocol.test.ts
npm run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/shared/protocol.ts src/shared/protocol.test.ts
git commit -m "feat: add browser connect protocol types"
```

---

## Task 3: Implement payload truncation and Pi message formatting

**TDD scenario:** New feature — full TDD cycle.

**Files:**

- Create: `src/shared/truncation.ts`
- Create: `src/shared/truncation.test.ts`
- Create: `src/shared/formatSelectionMessage.ts`
- Create: `src/shared/formatSelectionMessage.test.ts`

**Step 1: Write failing truncation tests**

Create `src/shared/truncation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { truncateUtf8 } from "./truncation";

describe("truncateUtf8", () => {
  it("keeps short strings unchanged", () => {
    expect(truncateUtf8("hello", 100)).toEqual({ value: "hello", truncated: false, originalBytes: 5 });
  });

  it("truncates long strings and marks them", () => {
    const result = truncateUtf8("abcdef", 3);
    expect(result.truncated).toBe(true);
    expect(result.value).toContain("[truncated]");
  });

  it("does not split unicode into invalid replacement characters", () => {
    const result = truncateUtf8("😀😀😀", 5);
    expect(result.value).not.toContain("�");
  });
});
```

**Step 2: Write failing formatter tests**

Create `src/shared/formatSelectionMessage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatSelectionMessage } from "./formatSelectionMessage";
import type { SelectionPayload } from "./protocol";

const payload: SelectionPayload = {
  url: "https://example.com",
  title: "Example",
  selectedText: "const x = 1;",
  selectedHtml: "<pre>const x = 1;</pre>",
  selector: "pre",
  comment: "Explain this",
  capturedAt: 1710000000000,
};

describe("formatSelectionMessage", () => {
  it("includes source, comment, text and html", () => {
    const message = formatSelectionMessage(payload);
    expect(message).toContain("Пользователь отправил фрагмент страницы из браузера");
    expect(message).toContain("https://example.com");
    expect(message).toContain("Explain this");
    expect(message).toContain("```text");
    expect(message).toContain("```html");
  });

  it("handles missing comment", () => {
    const message = formatSelectionMessage({ ...payload, comment: "" });
    expect(message).toContain("Комментарий пользователя:");
    expect(message).toContain("не указан");
  });
});
```

**Step 3: Run tests and verify failure**

```bash
npm test -- src/shared/truncation.test.ts src/shared/formatSelectionMessage.test.ts
```

Expected: FAIL because modules do not exist.

**Step 4: Implement truncation**

`src/shared/truncation.ts` should export:

```ts
export type TruncateResult = {
  value: string;
  truncated: boolean;
  originalBytes: number;
};

export function truncateUtf8(input: string, maxBytes: number): TruncateResult {
  const originalBytes = Buffer.byteLength(input, "utf8");
  if (originalBytes <= maxBytes) return { value: input, truncated: false, originalBytes };

  let output = "";
  let bytes = 0;
  for (const char of input) {
    const nextBytes = Buffer.byteLength(char, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    output += char;
    bytes += nextBytes;
  }

  return {
    value: `${output}\n\n[truncated: original ${originalBytes} bytes, limit ${maxBytes} bytes]`,
    truncated: true,
    originalBytes,
  };
}
```

**Step 5: Implement formatter**

`src/shared/formatSelectionMessage.ts` should:

- accept `SelectionPayload`;
- call `truncateUtf8` for text/html using constants;
- include source URL/title/selector;
- include comment or `не указан`;
- include text and html fenced blocks;
- avoid crashing on empty values.

**Step 6: Run tests**

```bash
npm test -- src/shared/truncation.test.ts src/shared/formatSelectionMessage.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/shared/truncation.ts src/shared/truncation.test.ts src/shared/formatSelectionMessage.ts src/shared/formatSelectionMessage.test.ts
git commit -m "feat: format browser selections for pi"
```

---

## Task 4: Implement broker core with target registration and delivery

**TDD scenario:** New feature — full TDD cycle.

**Files:**

- Create: `src/pi/broker.ts`
- Create: `src/pi/broker.test.ts`
- Create: `src/pi/logging.ts`

**Step 1: Write failing broker tests**

Create `src/pi/broker.test.ts` with a lightweight in-memory test if possible. Avoid full real socket tests initially.

Test a pure `BrowserConnectBrokerState` class or equivalent exported from `broker.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { BrowserConnectBrokerState } from "./broker";
import type { TargetMetadata } from "../shared/protocol";

const target: TargetMetadata = {
  targetId: "target-1",
  alias: "frontend",
  cwd: "/repo",
  gitBranch: "main",
  pid: 123,
  connectedAt: 1000,
  lastSeenAt: 1000,
};

describe("BrowserConnectBrokerState", () => {
  it("registers and lists targets", () => {
    const state = new BrowserConnectBrokerState();
    state.registerTarget(target, vi.fn());
    expect(state.listTargets()).toEqual([target]);
  });

  it("updates heartbeat timestamp", () => {
    const state = new BrowserConnectBrokerState();
    state.registerTarget(target, vi.fn());
    state.heartbeat("target-1", 2000);
    expect(state.listTargets()[0].lastSeenAt).toBe(2000);
  });

  it("removes stale targets", () => {
    const state = new BrowserConnectBrokerState();
    state.registerTarget(target, vi.fn());
    state.removeStaleTargets(20_000, 5_000);
    expect(state.listTargets()).toEqual([]);
  });

  it("returns error when delivering to missing target", async () => {
    const state = new BrowserConnectBrokerState();
    await expect(state.deliverSelection("missing", {} as never)).resolves.toEqual({
      ok: false,
      error: "Target is not available",
    });
  });
});
```

**Step 2: Run tests and verify failure**

```bash
npm test -- src/pi/broker.test.ts
```

Expected: FAIL.

**Step 3: Implement pure broker state**

`src/pi/broker.ts` should export:

- `BrowserConnectBrokerState`
- `TargetConnection` callback type
- later-friendly `startBrokerServer(...)` stub or real function

State responsibilities:

- register target metadata + delivery callback;
- list active targets;
- update heartbeat;
- unregister target;
- remove stale targets;
- deliver selection to target callback;
- return `{ ok: false, error }` for missing targets or callback errors.

**Step 4: Implement logging helper**

`src/pi/logging.ts`:

```ts
export type BrowserConnectLogger = {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
};

export function createMemoryLogger(): BrowserConnectLogger { ... }
export function createFileLogger(path: string): BrowserConnectLogger { ... }
```

For MVP, synchronous append or queued async append is acceptable. Ensure logging failures do not crash the extension.

**Step 5: Run tests**

```bash
npm test -- src/pi/broker.test.ts
npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/pi/broker.ts src/pi/broker.test.ts src/pi/logging.ts
git commit -m "feat: add browser connect broker state"
```

---

## Task 5: Implement WebSocket broker server protocol

**TDD scenario:** New feature — full TDD cycle where practical; integration test with real localhost WebSocket.

**Files:**

- Modify: `src/pi/broker.ts`
- Modify: `src/pi/broker.test.ts`

**Step 1: Add integration test for target registration and client listing**

Extend `src/pi/broker.test.ts` with a real `WebSocketServer` test using dynamic port `0` if supported by implementation.

Behavior to test:

1. Start broker on `127.0.0.1` port `0`.
2. Open target WebSocket and send `target.register` with valid token.
3. Open client WebSocket and send `client.listTargets`.
4. Assert `client.targets` contains registered target.
5. Close server.

Use helper functions to wait for specific protocol messages.

**Step 2: Add integration test for sendSelection delivery**

Behavior:

1. Register target.
2. Client sends `client.sendSelection` with targetId and selection payload.
3. Target receives `target.deliverSelection`.
4. Target responds with `target.sendSelectionResult` `{ ok: true }`.
5. Client receives `client.sendResult` `{ ok: true }`.

**Step 3: Add invalid token test**

Behavior:

- client or target with wrong token receives `client.error` / connection closed;
- no target is registered.

**Step 4: Run tests and verify failure**

```bash
npm test -- src/pi/broker.test.ts
```

Expected: FAIL until WebSocket server is implemented.

**Step 5: Implement `startBrokerServer`**

`src/pi/broker.ts` should export:

```ts
export type StartBrokerServerOptions = {
  host: string;
  port: number;
  token: string;
  logger: BrowserConnectLogger;
  staleAfterMs?: number;
};

export type BrowserConnectBrokerServer = {
  port: number;
  close(): Promise<void>;
};

export async function startBrokerServer(options: StartBrokerServerOptions): Promise<BrowserConnectBrokerServer>;
```

Implementation details:

- Use Node `http.createServer()` + `new WebSocketServer({ server })` from `ws`.
- Bind to `options.host` only.
- Parse messages using `parseProtocolEnvelope`.
- Token can be in payload for MVP:
  - `client.hello` payload `{ token }`
  - `target.register` payload `{ token, target }`
  - `client.sendSelection` payload `{ token, targetId, selection }`
- Maintain request correlation with `requestId`.
- Validate selection payload before forwarding.
- Keep pending delivery map keyed by delivery request id.
- Return `client.sendResult` to requesting client.
- Cleanup target on socket close.
- Run stale cleanup interval and clear it on `close()`.

**Step 6: Run tests**

```bash
npm test -- src/pi/broker.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/pi/broker.ts src/pi/broker.test.ts
git commit -m "feat: add websocket broker protocol"
```

---

## Task 6: Implement Pi target client and `/browser-connect` extension

**TDD scenario:** New feature — unit test target client behavior and extension helpers; manual Pi test later.

**Files:**

- Create: `src/pi/targetClient.ts`
- Create: `src/pi/targetClient.test.ts`
- Create: `src/pi/browserConnectExtension.ts`
- Create: `.pi/extensions/browser-connect/index.ts`

**Step 1: Write target client tests**

Create `src/pi/targetClient.test.ts` to verify:

- metadata label generation uses alias when present;
- `buildTargetMetadata` includes cwd, pid, alias, branch if git branch helper returns it;
- delivery handler formats selection and calls injected `sendUserMessage` with immediate mode when idle;
- delivery handler uses `{ deliverAs: "followUp" }` when not idle.

Example test shape:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleDeliveredSelection } from "./targetClient";

it("sends selection immediately when Pi is idle", async () => {
  const sendUserMessage = vi.fn();
  await handleDeliveredSelection({
    selection: {
      url: "https://example.com",
      title: "Example",
      selectedText: "hello",
      selectedHtml: "<p>hello</p>",
      capturedAt: Date.now(),
    },
    isIdle: () => true,
    sendUserMessage,
  });
  expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("hello"), undefined);
});

it("queues as followUp when Pi is busy", async () => {
  const sendUserMessage = vi.fn();
  await handleDeliveredSelection({
    selection: {
      url: "https://example.com",
      title: "Example",
      selectedText: "hello",
      selectedHtml: "<p>hello</p>",
      capturedAt: Date.now(),
    },
    isIdle: () => false,
    sendUserMessage,
  });
  expect(sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "followUp" });
});
```

**Step 2: Run tests and verify failure**

```bash
npm test -- src/pi/targetClient.test.ts
```

Expected: FAIL.

**Step 3: Implement target client helpers**

`src/pi/targetClient.ts` should include:

- `buildTargetMetadata(options)`;
- `getGitBranch(cwd)` using `git rev-parse --abbrev-ref HEAD`, safe fallback;
- `handleDeliveredSelection(...)`;
- `connectTargetToBroker(...)` that opens WebSocket, registers target, heartbeats, receives `target.deliverSelection`, sends `target.sendSelectionResult`.

Use injected logger. Do not make tests depend on real Pi context.

**Step 4: Implement Pi extension**

`src/pi/browserConnectExtension.ts`:

- default export function `(pi: ExtensionAPI) => void`;
- register command `browser-connect`;
- handler parses optional alias from args;
- generate or reuse token;
- try connecting to broker;
- if connect fails, start broker with `startBrokerServer(...)`, then connect target;
- store cleanup callbacks;
- on `session_shutdown`, unregister/close target connection and close owned broker if this instance owns it;
- show `ctx.ui.notify(...)` status to user;
- set status line `browser-connect` with alias/connected indicator.

Use Pi APIs from docs:

- `pi.registerCommand("browser-connect", { description, handler })`
- `pi.sendUserMessage(...)` from extension closure or equivalent injection inside target callback
- `ctx.isIdle()` to choose delivery mode
- `pi.on("session_shutdown", ...)` for cleanup

**Step 5: Create project-local extension wrapper**

`.pi/extensions/browser-connect/index.ts`:

```ts
export { default } from "../../../src/pi/browserConnectExtension";
```

If runtime module resolution fails in manual testing, replace with a tiny wrapper that imports via relative `.ts` path supported by Pi/jiti. Keep this file committed.

**Step 6: Run tests/typecheck**

```bash
npm test -- src/pi/targetClient.test.ts src/shared/formatSelectionMessage.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Manual Pi smoke test**

Run:

```bash
pi
```

Inside Pi:

```text
/reload
/browser-connect test
```

Expected:

- no extension load error;
- notification says browser connect is active;
- status line or notification includes alias `test` and port.

If full Pi manual test is not possible in automation, document exact manual result in final implementation notes.

**Implementation note (manual smoke verification recorded):**

- `pi --version` passed (`0.78.1`).
- Normal `pi -p "/browser-connect test"` was blocked by an unrelated global stale ctx error in another extension.
- Isolated smoke succeeded with a temporary HOME:
  ```bash
  tmp_home=$(mktemp -d) && HOME="$tmp_home" pi -p "/browser-connect test"; status=$?; rm -rf "$tmp_home"; exit $status
  ```
- `.pi/browser-connect.log` showed the broker started on `127.0.0.1:17345`, the target connected with alias `test`, then unregistered/closed during shutdown.

**Step 8: Commit**

```bash
git add src/pi/targetClient.ts src/pi/targetClient.test.ts src/pi/browserConnectExtension.ts .pi/extensions/browser-connect/index.ts
git commit -m "feat: add pi browser connect extension"
```

---

## Task 7: Implement Chrome build pipeline and manifest

**TDD scenario:** Trivial setup with build verification.

**Files:**

- Create: `scripts/build-chrome.mjs`
- Create: `src/chrome/manifest.json`
- Create: `src/chrome/popup.html`
- Create: `src/chrome/popup.css`
- Create: `src/chrome/background.ts`
- Create: `src/chrome/popup.ts`
- Create: `src/chrome/contentScript.ts`

**Step 1: Create build script**

`scripts/build-chrome.mjs` should use Vite programmatic build or simple `vite build` calls to emit:

```text
dist/chrome/manifest.json
dist/chrome/popup.html
dist/chrome/popup.css
dist/chrome/popup.js
dist/chrome/background.js
dist/chrome/contentScript.js
```

For MVP, simple approach is acceptable:

- copy static files from `src/chrome`;
- run Vite builds for each TS entry with `format: "iife"` or Chrome-compatible ES module output;
- ensure `manifest.json` points to emitted JS names.

**Step 2: Create Manifest V3**

`src/chrome/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Pi Browser Connect",
  "version": "0.1.0",
  "description": "Send selected browser content to a running Pi terminal.",
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": ["http://127.0.0.1/*", "ws://127.0.0.1/*"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_title": "Send to Pi",
    "default_popup": "popup.html"
  },
  "content_scripts": []
}
```

Note: MV3 host permissions may need URL patterns adjusted because WebSocket permission behavior varies. If `ws://` pattern is rejected, use `http://127.0.0.1/*` and document the exact Chrome behavior.

**Step 3: Create minimal popup**

`popup.html` should load `popup.css` and `popup.js`, include:

- status row;
- target select/list container;
- send button;
- diagnostics button/area.

No inline scripts due to MV3 CSP.

**Step 4: Create minimal TS entry files**

- `background.ts`: message router placeholder.
- `popup.ts`: initializes UI placeholder.
- `contentScript.ts`: listens for `startDomPicker` message placeholder.

**Step 5: Build**

```bash
npm run build:chrome
```

Expected: `dist/chrome` exists and includes manifest + JS files.

**Step 6: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add scripts/build-chrome.mjs src/chrome/manifest.json src/chrome/popup.html src/chrome/popup.css src/chrome/background.ts src/chrome/popup.ts src/chrome/contentScript.ts
git commit -m "feat: add chrome extension shell"
```

---

## Task 8: Implement browser diagnostics and broker client utilities

**TDD scenario:** New feature — full TDD cycle.

**Files:**

- Create: `src/chrome/diagnostics.ts`
- Create: `src/chrome/diagnostics.test.ts`
- Modify: `src/chrome/background.ts`
- Modify: `src/chrome/popup.ts`

**Step 1: Write diagnostics tests**

`src/chrome/diagnostics.test.ts`:

- use a fake storage adapter, not real `chrome.storage`;
- verify logs are capped at `DIAGNOSTIC_LOG_LIMIT`;
- verify entries include timestamp, phase, message;
- verify clear removes logs.

**Step 2: Implement diagnostics module**

`diagnostics.ts` should export:

- `DiagnosticEntry` type;
- `StorageAdapter` interface;
- `appendDiagnostic(storage, entry)`;
- `listDiagnostics(storage)`;
- `clearDiagnostics(storage)`;
- `chromeStorageAdapter()` for runtime.

Do not make test import global Chrome APIs.

**Step 3: Implement broker client in background**

In `background.ts`, add functions/messages for popup/content script:

- `listTargets` → connects to broker, sends `client.listTargets`, returns targets;
- `sendSelection` → connects/sends `client.sendSelection`, returns delivery result;
- `getDiagnostics`;
- `clearDiagnostics`.

Store token and selected target in `chrome.storage.local`. For MVP token can be user-provided later if not discoverable; if design requires auto-token, implement a simple default dev token only if Pi extension matches. Prefer explicit token in storage and UI if needed.

**Step 4: Update popup to display diagnostics errors**

Popup should show:

- connection status;
- last error summary;
- diagnostics section with recent errors.

**Step 5: Run tests/build**

```bash
npm test -- src/chrome/diagnostics.test.ts
npm run typecheck
npm run build:chrome
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/chrome/diagnostics.ts src/chrome/diagnostics.test.ts src/chrome/background.ts src/chrome/popup.ts
git commit -m "feat: add chrome diagnostics and broker client"
```

---

## Task 9: Implement popup target selection UX

**TDD scenario:** Modifying tested code — add tests for pure rendering helpers if popup DOM logic is non-trivial.

**Files:**

- Modify: `src/chrome/popup.ts`
- Create or modify: `src/chrome/popup.test.ts`
- Modify: `src/chrome/popup.css`

**Step 1: Extract pure target label helper and test it**

Create `src/chrome/popup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatTargetPrimaryLabel, formatTargetSecondaryLabel } from "./popup";

it("uses alias as primary label", () => {
  expect(formatTargetPrimaryLabel({ alias: "frontend", cwd: "/repo", pid: 1, connectedAt: 1, lastSeenAt: 1, targetId: "t" })).toBe("frontend");
});

it("falls back to cwd basename and branch", () => {
  expect(formatTargetPrimaryLabel({ cwd: "/work/repo", gitBranch: "main", pid: 1, connectedAt: 1, lastSeenAt: 1, targetId: "t" })).toContain("repo");
});
```

**Step 2: Run tests and verify failure**

```bash
npm test -- src/chrome/popup.test.ts
```

Expected: FAIL until helpers exist/exported.

**Step 3: Implement popup UI behavior**

`popup.ts` should:

- load targets from background on startup;
- load selected target from storage;
- render target list/select;
- preserve selected target if still active;
- disable send button if no target;
- on send click, store selected target and ask background to inject/start content script picker in active tab;
- display broker unavailable guidance: `Pi не подключён. Выполните /browser-connect в терминале.`

**Step 4: Add styling**

`popup.css`:

- compact 320–380px width;
- clear target item labels;
- disabled send state;
- diagnostics styling.

**Step 5: Run tests/build**

```bash
npm test -- src/chrome/popup.test.ts
npm run typecheck
npm run build:chrome
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/chrome/popup.ts src/chrome/popup.test.ts src/chrome/popup.css
git commit -m "feat: add pi target selection popup"
```

---

## Task 10: Implement DOM picker heuristic and overlay UI

**TDD scenario:** New feature — full TDD cycle for pure DOM heuristic using jsdom if needed.

**Files:**

- Create: `src/chrome/domPicker.ts`
- Create: `src/chrome/domPicker.test.ts`
- Create: `src/chrome/selectionOverlay.ts`
- Create: `src/chrome/toast.ts`
- Modify: `src/chrome/contentScript.ts`
- Modify: `package.json` dev deps if jsdom is needed
- Modify: `vitest.config.ts` if jsdom tests are needed

**Step 1: Add jsdom test support if needed**

If DOM tests need jsdom, install:

```bash
npm install -D jsdom
```

Configure test environment per file with:

```ts
// @vitest-environment jsdom
```

**Step 2: Write DOM picker tests**

`src/chrome/domPicker.test.ts` should verify:

- `pre`/`code` blocks are preferred;
- semantic `article` selected over tiny child span;
- `body` is avoided when a reasonable container exists;
- generated selector is stable enough for simple DOM.

**Step 3: Run tests and verify failure**

```bash
npm test -- src/chrome/domPicker.test.ts
```

Expected: FAIL.

**Step 4: Implement `domPicker.ts`**

Export pure helpers:

- `findLogicalSelectionElement(start: Element): Element`
- `createCssSelector(element: Element): string`
- `buildSelectionPayload(element: Element, comment: string): SelectionPayload`

Heuristic:

- semantic tags score high;
- `pre`, `code`, `table`, `blockquote` score high;
- penalize `html`, `body`;
- require meaningful `innerText`/`textContent` length;
- prefer element with reasonable bounding rect if running in real browser.

**Step 5: Implement visual overlay and comment modal**

`selectionOverlay.ts`:

- creates fixed-position highlight box;
- updates on hover;
- creates comment modal;
- cleanup function removes all injected nodes/listeners.

`toast.ts`:

- `showToast(message, kind)`;
- success/error styling via injected shadow/root or unique class names.

**Step 6: Wire content script**

`contentScript.ts`:

- listen for `startDomPicker` from background;
- start picker mode;
- on click, open comment modal;
- on send, call `chrome.runtime.sendMessage({ type: "sendSelection", targetId, selection })`;
- show success/error toast based on result;
- handle Escape cancellation;
- log failures through diagnostics message.

**Step 7: Run tests/build**

```bash
npm test -- src/chrome/domPicker.test.ts
npm run typecheck
npm run build:chrome
```

Expected: PASS.

**Step 8: Commit**

```bash
git add src/chrome/domPicker.ts src/chrome/domPicker.test.ts src/chrome/selectionOverlay.ts src/chrome/toast.ts src/chrome/contentScript.ts package.json package-lock.json vitest.config.ts
git commit -m "feat: add browser DOM picker"
```

---

## Task 11: End-to-end manual integration and hardening

**TDD scenario:** Manual E2E + regression tests for fixes discovered.

**Files:**

- Modify: `README.md`
- Modify: `docs/plans/2026-06-08-browser-connect-mvp-implementation-plan.md` only if implementation notes are needed
- Modify code files only for fixes discovered during E2E

**Step 1: Full automated verification**

Run:

```bash
npm test
npm run typecheck
npm run build:chrome
```

Expected: PASS.

**Step 2: Load unpacked extension**

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click **Load unpacked**.
4. Select `dist/chrome`.

Expected: Extension loads without manifest errors.

**Step 3: Start Pi and connect**

Run in terminal:

```bash
pi
```

Inside Pi:

```text
/reload
/browser-connect frontend
```

Expected:

- Pi shows browser-connect active notification/status;
- no extension errors in terminal;
- broker log file exists or is ready.

**Step 4: Verify popup target list**

Open extension popup.

Expected:

- `frontend` appears;
- secondary text includes cwd/branch/pid;
- target can be selected;
- send button enabled.

**Step 5: Send simple DOM fragment**

Open a normal web page with a visible paragraph or code block.

1. Click extension.
2. Select target.
3. Click **Send to Pi**.
4. Hover elements and confirm green highlight appears.
5. Click a block.
6. Enter comment: `Кратко объясни этот фрагмент`.
7. Click **Send**.

Expected:

- browser shows `Отправлено в Pi` toast;
- Pi terminal receives formatted user message;
- Pi starts processing it.

**Step 6: Verify error states**

Test at least:

- stop Pi/broker, then try sending: browser says `/browser-connect` is needed;
- select target, close that Pi, wait heartbeat timeout, try sending: browser asks to choose another target;
- attempt huge selection if practical: payload is truncated and Pi still receives bounded content.

**Step 7: Add regression tests for discovered bugs**

For each bug found:

1. Add a failing unit/integration test.
2. Run the focused test and verify failure.
3. Fix implementation.
4. Run focused test and full verification.

**Step 8: Update README usage docs**

Add:

```md
## Usage MVP

1. Install dependencies and build Chrome extension:
   ```bash
   npm install
   npm run build:chrome
   ```
2. Load `dist/chrome` as unpacked extension.
3. Start `pi` in a project.
4. Run `/reload` if the project-local extension was added after Pi startup.
5. Run `/browser-connect [alias]`.
6. Open the browser extension, select the Pi target, and click **Send to Pi**.
```

Also document:

- broker port;
- broker lifecycle MVP limitation;
- logs location;
- no browser-side Pi answer streaming in MVP.

**Step 9: Final verification**

Run:

```bash
npm test
npm run typecheck
npm run build:chrome
git status --short
```

Expected:

- tests pass;
- typecheck passes;
- build passes;
- only intended files changed.

**Step 10: Commit**

```bash
git add README.md docs/plans/2026-06-08-browser-connect-mvp-implementation-plan.md src package.json package-lock.json tsconfig.json vitest.config.ts scripts .pi/extensions .gitignore
git commit -m "docs: document browser connect MVP usage"
```

**Implementation note (Task 11 verification record):**

- Automated verification passed:
  - `npm test`
  - `npm run typecheck`
  - `npm run build:chrome`
- Browser/manual GUI verification was **not possible in this environment** because no local Chrome/Chromium/Edge executable was available and there is no GUI session to open `chrome://extensions`, load `dist/chrome`, or exercise the popup/content-script DOM picker interactively.
- Practical CLI substitute evidence collected instead:
  - `dist/chrome/manifest.json` was generated by `npm run build:chrome` and parsed successfully as Manifest V3 with the expected popup and background worker entries.
  - `pi --version` returned `0.78.1`.
  - Isolated Pi smoke test succeeded with a temporary `HOME` to avoid unrelated global extension interference:
    ```bash
    tmp_home=$(mktemp -d)
    HOME="$tmp_home" pi -p "/browser-connect frontend"
    rm -rf "$tmp_home"
    ```
  - Project-local `.pi/browser-connect.log` recorded the expected broker lifecycle for alias `frontend`: failed initial connect, broker start on `127.0.0.1:17345`, target registration, then clean unregister/close on process shutdown.
- No new E2E-discovered code defects were observable in the available environment, so no regression tests or implementation changes beyond documentation were added in Task 11.

---

## Optional Follow-up Tasks After MVP

Do not implement these until MVP works end-to-end:

1. Stream Pi answer back to browser via `message_update`.
2. Add Native Messaging host for production-grade transport.
3. Add richer target identity with terminal title / tty / tmux pane when available.
4. Add send history.
5. Add explicit token pairing UI instead of development token/storage assumptions.
6. Package Pi extension and Chrome extension for distribution.

---

## Completion Criteria

MVP is complete when:

- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build:chrome` passes.
- Unpacked Chrome extension loads successfully.
- `/browser-connect [alias]` works in an already open Pi TUI session.
- Popup lists active Pi targets and allows choosing a concrete console instance.
- DOM picker highlights logical blocks and sends selected content plus optional comment.
- Browser shows success toast when Pi accepts the payload.
- Browser shows useful error toast when broker/target is unavailable.
- Browser diagnostics contain recent send/connect errors.
- Pi/broker log contains operational errors without full sensitive payload content.
- README explains setup, usage, logs, and MVP limitations.
