# Medium Review Fixes Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Исправить 10 замечаний уровня MEDIUM из ревью `feat/sidepanel-chat`

**Architecture:** Каждое замечание изолировано — можно реализовывать в любом порядке. Все изменения покрываются юнит-тестами. Приоритет: M1, M2, M4, M7, M8 (рекомендованы до 1.0), затем остальные.

**Tech Stack:** TypeScript, Vitest, ws (WebSocket), Chrome Extensions API (Manifest V3)

---

## Phase 1: Приоритетные исправления (до 1.0)

### Task 1: M1 — Throttle `broadcastSnapshot` в `browserConnectExtension.ts`

**TDD scenario:** Modifying tested code — run existing tests first

**Проблема:** `broadcastSnapshot()` вызывается на каждый Pi-event. При потоковом ответе с 500 дельтами — это 500× JSON.stringify(fullSnapshot).

**Решение:** Добавить throttle (не чаще 1 раза в 100ms). События (`broadcastEvent`) уже отправляют дельты — snapshot нужен только периодически для синхронизации.

**Files:**
- Modify: `src/pi/browserConnectExtension.ts:97-120` (секция event handlers)
- Test: `src/pi/browserConnectExtension.test.ts`

**Step 1: Запустить существующие тесты**

Run: `npx vitest run src/pi/browserConnectExtension.test.ts`
Expected: All tests PASS

**Step 2: Написать failing test для throttle**

```typescript
// В секции Pi event handlers, после существующих тестов
describe("broadcastSnapshot throttling", () => {
  it("should throttle broadcastSnapshot calls to at most once per 100ms", async () => {
    vi.useFakeTimers();
    const { pi, ctx } = createFakePi();
    (await import("./browserConnectExtension")).default(pi);
    
    // Connect
    await pi.triggerCommand("chrome-assistent-connect", "", ctx);
    mockBroadcastSnapshot.mockClear();
    
    // Fire 10 message_update events rapidly
    for (let i = 0; i < 10; i++) {
      pi.emit("message_update", { message: { id: "m1", role: "assistant" } }, ctx);
    }
    
    // Should not have called broadcastSnapshot yet (events don't trigger snapshot)
    // But message_end does
    pi.emit("message_end", { message: { id: "m1", role: "assistant" } }, ctx);
    expect(mockBroadcastSnapshot).toHaveBeenCalledTimes(1);
    
    // Fire another message_end immediately
    pi.emit("message_end", { message: { id: "m2", role: "assistant" } }, ctx);
    // Should still be 1 due to throttle
    expect(mockBroadcastSnapshot).toHaveBeenCalledTimes(1);
    
    // Advance time past throttle window
    vi.advanceTimersByTime(150);
    
    // Now trigger another event
    pi.emit("model_select", {}, ctx);
    expect(mockBroadcastSnapshot).toHaveBeenCalledTimes(2);
    
    vi.useRealTimers();
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/pi/browserConnectExtension.test.ts -t "throttle"`
Expected: FAIL — текущая реализация вызывает snapshot на каждый event

**Step 4: Implement throttle helper**

```typescript
// После секции Constants, добавить helper:
const BROADCAST_SNAPSHOT_THROTTLE_MS = 100;

function createThrottledBroadcast(
  fn: () => void,
  delayMs: number,
): { call: () => void; flush: () => void } {
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const call = () => {
    if (pending) return;
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      fn();
    }, delayMs);
  };

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending) {
      pending = false;
      fn();
    }
  };

  return { call, flush };
}
```

**Step 5: Apply throttle to broadcastSnapshot**

```typescript
// Внутри browserConnectExtension, после создания logger:
const throttledBroadcast = createThrottledBroadcast(
  () => activeSessionServer?.broadcastSnapshot(),
  BROADCAST_SNAPSHOT_THROTTLE_MS,
);

const broadcastSnapshot = () => {
  throttledBroadcast.call();
};

// В session_shutdown handler добавить flush:
pi.on("session_shutdown", async (_event, ctx) => {
  throttledBroadcast.flush();
  if (activeSessionServer) {
    // ...existing code
  }
});
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run src/pi/browserConnectExtension.test.ts`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/pi/browserConnectExtension.ts src/pi/browserConnectExtension.test.ts
git commit -m "perf(M1): throttle broadcastSnapshot to max 1 per 100ms"
```

---

### Task 2: M2 — Установить `maxPayload: 1MB` на WebSocket-сервере

**TDD scenario:** New feature — full TDD cycle

**Проблема:** ws по умолчанию принимает до 100 MB. Любой локальный процесс может отправить огромное сообщение.

**Files:**
- Modify: `src/pi/sessionServer.ts:85-95` (WebSocketServer creation)
- Test: `src/pi/sessionServer.test.ts`

**Step 1: Запустить существующие тесты**

Run: `npx vitest run src/pi/sessionServer.test.ts`
Expected: All tests PASS

**Step 2: Написать failing test**

```typescript
describe("WebSocket maxPayload limit", () => {
  it("should close connection when message exceeds 1MB", async () => {
    const server = await startServer();
    const { socket, waitForClose } = await connectClient(server.port);
    
    // Send message larger than 1MB
    const largePayload = JSON.stringify({
      version: "1",
      type: "session.chat.send",
      payload: { message: "x".repeat(1_100_000) }, // ~1.1MB
    });
    
    socket.send(largePayload);
    
    // Connection should be closed by server
    const closeEvent = await waitForClose;
    expect(closeEvent.code).toBe(1009); // Message Too Big
    
    await server.close();
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/pi/sessionServer.test.ts -t "maxPayload"`
Expected: FAIL — сообщение принимается без ограничений

**Step 4: Add maxPayload constant and apply to WebSocketServer**

```typescript
// В секции Constants:
export const WEBSOCKET_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MB

// В startDirectSessionServer, при создании WebSocketServer:
const wss = new WebSocketServer({
  host: options.host,
  port: options.port,
  maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES,
});
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/pi/sessionServer.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/pi/sessionServer.ts src/pi/sessionServer.test.ts
git commit -m "security(M2): limit WebSocket maxPayload to 1MB"
```

---

### Task 3: M4 — Валидировать `session.event` payload через `validatePiMirrorEvent`

**TDD scenario:** Modifying tested code — run existing tests first

**Проблема:** В `sessionClient.ts` payload `session.event` кастуется к `PiMirrorEvent` без валидации.

**Files:**
- Modify: `src/chrome/sessionClient.ts:165-170` (handleEnvelope, case "session.event")
- Test: `src/chrome/sessionClient.test.ts`

**Step 1: Запустить существующие тесты**

Run: `npx vitest run src/chrome/sessionClient.test.ts`
Expected: All tests PASS

**Step 2: Написать failing test**

```typescript
describe("session.event validation", () => {
  it("should ignore malformed session.event payloads", async () => {
    const onSessionEvent = vi.fn();
    const { socket, client } = createClientWithSocket({ onSessionEvent });
    
    socket.simulateOpen();
    socket.simulateMessage(createSnapshotEnvelope());
    
    // Send malformed event (missing required fields)
    socket.simulateMessage(JSON.stringify({
      version: PROTOCOL_VERSION,
      type: "session.event",
      payload: { type: "message_start" }, // missing message.id and message.role
    }));
    
    await flush();
    
    expect(onSessionEvent).not.toHaveBeenCalled();
  });

  it("should accept valid session.event payloads", async () => {
    const onSessionEvent = vi.fn();
    const { socket, client } = createClientWithSocket({ onSessionEvent });
    
    socket.simulateOpen();
    socket.simulateMessage(createSnapshotEnvelope());
    
    // Send valid event
    socket.simulateMessage(JSON.stringify({
      version: PROTOCOL_VERSION,
      type: "session.event",
      payload: {
        type: "message_start",
        message: { id: "msg-1", role: "assistant" },
      },
    }));
    
    await flush();
    
    expect(onSessionEvent).toHaveBeenCalledWith({
      type: "message_start",
      message: { id: "msg-1", role: "assistant" },
    });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/chrome/sessionClient.test.ts -t "session.event validation"`
Expected: FAIL — malformed events проходят без валидации

**Step 4: Add validation to handleEnvelope**

```typescript
// В начале файла, добавить импорт:
import {
  // ...existing imports
  validatePiMirrorEvent,
} from "../shared/protocol";

// В handleEnvelope, case "session.event":
case "session.event": {
  this.resetIdleTimer();
  const validation = validatePiMirrorEvent(envelope.payload);
  if (!validation.ok) {
    // Ignore malformed events silently — they shouldn't crash the client
    return;
  }
  this.onSessionEvent?.(envelope.payload as PiMirrorEvent);
  return;
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/chrome/sessionClient.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/chrome/sessionClient.ts src/chrome/sessionClient.test.ts
git commit -m "security(M4): validate session.event payloads with validatePiMirrorEvent"
```

---

### Task 4: M7 — Заменить `execSync` на `execFileSync` в build-скрипте

**TDD scenario:** Modifying tested code — run existing tests first

**Проблема:** Shell injection через интерполяцию путей в `execSync`.

**Files:**
- Modify: `scripts/build-chrome.mjs:30-35` (icon generation loop)
- Test: `src/scripts/build-chrome.test.ts`

**Step 1: Запустить существующие тесты**

Run: `npx vitest run src/scripts/build-chrome.test.ts`
Expected: All tests PASS

**Step 2: Написать failing test для защиты от shell injection**

```typescript
describe("icon generation shell safety", () => {
  it("should use execFileSync instead of execSync for shell safety", async () => {
    // This test verifies the code uses execFileSync by checking
    // the build script source doesn't contain execSync with string interpolation
    const buildScript = await readFile("scripts/build-chrome.mjs", "utf-8");
    
    // Should not have execSync with template literals containing paths
    expect(buildScript).not.toMatch(/execSync\s*\(`[^`]*\$\{/);
    
    // Should use execFileSync
    expect(buildScript).toMatch(/execFileSync/);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/scripts/build-chrome.test.ts -t "shell safety"`
Expected: FAIL — текущий код использует execSync

**Step 4: Replace execSync with execFileSync**

```javascript
// В начале файла, изменить импорт:
import { execFileSync } from "node:child_process";

// В секции генерации иконок:
for (const size of iconSizes) {
  const pngName = `icon${size}.png`;
  const outputPath = path.join(chromeDistDir, pngName);
  execFileSync("rsvg-convert", [
    "-w", String(size),
    "-h", String(size),
    svgIcon,
    "-o", outputPath,
  ]);
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/scripts/build-chrome.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add scripts/build-chrome.mjs src/scripts/build-chrome.test.ts
git commit -m "security(M7): replace execSync with execFileSync to prevent shell injection"
```

---

### Task 5: M8 — Документировать зависимость от `rsvg-convert`

**TDD scenario:** Trivial change — documentation only

**Проблема:** Build упадёт с непонятной ошибкой на системах без `librsvg2-bin`.

**Files:**
- Modify: `README.md` (добавить раздел "Требования для сборки")
- Modify: `scripts/build-chrome.mjs` (добавить проверку с понятным сообщением)

**Step 1: Добавить проверку наличия rsvg-convert в build-скрипт**

```javascript
// После импортов, перед основным кодом:
import { execFileSync, spawnSync } from "node:child_process";

// Проверка наличия rsvg-convert
const rsvgCheck = spawnSync("which", ["rsvg-convert"], { stdio: "pipe" });
if (rsvgCheck.status !== 0) {
  console.error(`
❌ Не найдена утилита rsvg-convert.

Для сборки Chrome-расширения требуется librsvg2-bin:

  Ubuntu/Debian:  sudo apt install librsvg2-bin
  macOS:          brew install librsvg
  Fedora:         sudo dnf install librsvg2-tools

После установки повторите сборку.
`);
  process.exit(1);
}
```

**Step 2: Добавить раздел в README.md**

Добавить после секции "Установка" перед "Быстрый старт":

```markdown
## Требования для сборки

Для сборки Chrome-расширения из исходников требуется:

- **Node.js** ≥ 24.0.0
- **rsvg-convert** (для генерации PNG-иконок из SVG)

### Установка rsvg-convert

| ОС | Команда |
|----|---------|
| Ubuntu/Debian | `sudo apt install librsvg2-bin` |
| macOS | `brew install librsvg` |
| Fedora | `sudo dnf install librsvg2-tools` |

---
```

**Step 3: Verify the script runs correctly**

Run: `npm run build:chrome` (или соответствующая команда)
Expected: Build completes successfully

**Step 4: Commit**

```bash
git add README.md scripts/build-chrome.mjs
git commit -m "docs(M8): document rsvg-convert dependency and add runtime check"
```

---

## Phase 2: Дополнительные улучшения (post-launch)

### Task 6: M3 — Rate limiting входящих WS-сообщений

**TDD scenario:** New feature — full TDD cycle

**Проблема:** Клиент может флудить `session.chat.send`, каждый из которых триггерит `pi.sendUserMessage()`.

**Files:**
- Modify: `src/pi/sessionServer.ts`
- Test: `src/pi/sessionServer.test.ts`

**Step 1: Запустить существующие тесты**

Run: `npx vitest run src/pi/sessionServer.test.ts`
Expected: All tests PASS

**Step 2: Написать failing test**

```typescript
describe("rate limiting", () => {
  it("should reject messages when rate limit exceeded", async () => {
    const onChatMessage = vi.fn().mockResolvedValue({ ok: true });
    const server = await startServer({ onChatMessage });
    const { socket, waitForMessage } = await connectClient(server.port);
    
    // Consume initial snapshot
    await waitForMessage();
    
    // Send 10 messages rapidly (limit is 5 per second)
    for (let i = 0; i < 10; i++) {
      socket.send(JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "session.chat.send",
        requestId: `req-${i}`,
        payload: { message: `Message ${i}` },
      }));
    }
    
    // Wait for responses
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    // Should have processed only 5 messages
    expect(onChatMessage).toHaveBeenCalledTimes(5);
    
    await server.close();
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/pi/sessionServer.test.ts -t "rate limiting"`
Expected: FAIL — все сообщения обрабатываются

**Step 4: Implement rate limiter**

```typescript
// После секции Constants:
const RATE_LIMIT_MESSAGES_PER_SECOND = 5;
const RATE_LIMIT_WINDOW_MS = 1000;

class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxMessages: number;
  private readonly windowMs: number;

  constructor(maxMessages: number, windowMs: number) {
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
  }

  tryConsume(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    
    // Remove expired timestamps
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
    
    if (this.timestamps.length >= this.maxMessages) {
      return false;
    }
    
    this.timestamps.push(now);
    return true;
  }
}

// В handleConnection, создать rate limiter для соединения:
const rateLimiter = new RateLimiter(RATE_LIMIT_MESSAGES_PER_SECOND, RATE_LIMIT_WINDOW_MS);

// В обработчике message, перед switch:
if (!rateLimiter.tryConsume()) {
  sendError(ws, envelope.requestId, "Превышен лимит сообщений. Подождите.");
  return;
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/pi/sessionServer.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/pi/sessionServer.ts src/pi/sessionServer.test.ts
git commit -m "security(M3): add rate limiting for incoming WebSocket messages"
```

---

### Task 7: M5 — On-demand injection content script

**TDD scenario:** Modifying tested code — run existing tests first

**Проблема:** Content script инжектится на все страницы. Лучше инжектировать по запросу.

**Files:**
- Modify: `src/chrome/manifest.json` (удалить content_scripts)
- Modify: `src/chrome/background.ts` (добавить programmatic injection)
- Test: `src/chrome/background.test.ts`

**Step 1: Запустить существующие тесты**

Run: `npx vitest run src/chrome/background.test.ts`
Expected: All tests PASS

**Step 2: Написать failing test**

```typescript
describe("on-demand content script injection", () => {
  it("should inject content script when DOM picker is requested", async () => {
    const mockExecuteScript = vi.fn().mockResolvedValue([{}]);
    vi.stubGlobal("chrome", {
      ...chrome,
      scripting: { executeScript: mockExecuteScript },
    });
    
    await startDomPicker({ tabId: 123 });
    
    expect(mockExecuteScript).toHaveBeenCalledWith({
      target: { tabId: 123 },
      files: ["contentScript.js"],
    });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/chrome/background.test.ts -t "on-demand"`
Expected: FAIL — content script уже инжектирован статически

**Step 4: Remove static content_scripts from manifest**

```json
{
  // ...existing fields
  // УДАЛИТЬ секцию content_scripts полностью
}
```

**Step 5: Add programmatic injection in background.ts**

```typescript
// В startDomPicker функции, перед отправкой сообщения:
async function injectContentScriptIfNeeded(tabId: number): Promise<void> {
  try {
    // Check if already injected by sending a ping
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    // Not injected — inject now
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["contentScript.js"],
    });
  }
}

// Вызвать перед использованием:
await injectContentScriptIfNeeded(tabId);
```

**Step 6: Add "scripting" permission to manifest**

```json
{
  "permissions": ["activeTab", "storage", "sidePanel", "tabs", "scripting"],
  // ...
}
```

**Step 7: Run test to verify it passes**

Run: `npx vitest run src/chrome/background.test.ts`
Expected: All tests PASS

**Step 8: Commit**

```bash
git add src/chrome/manifest.json src/chrome/background.ts src/chrome/background.test.ts
git commit -m "perf(M5): switch to on-demand content script injection"
```

---

### Task 8: M6 — Унифицировать `refreshDiagnostics`/`recordDiagnostic` через `applyState()`

**TDD scenario:** Refactoring tested code — run existing tests first

**Проблема:** `refreshDiagnostics()` и `recordDiagnostic()` обходят `applyState()`.

**Files:**
- Modify: `src/chrome/backgroundStateServer.ts:280-320`
- Test: `src/chrome/backgroundStateServer.test.ts`

**Step 1: Запустить существующие тесты**

Run: `npx vitest run src/chrome/backgroundStateServer.test.ts`
Expected: All tests PASS

**Step 2: Refactor refreshDiagnostics to use applyState**

```typescript
private async refreshDiagnostics(): Promise<void> {
  try {
    const diagnostics = await listDiagnostics(this.storage);
    this.applyState({ kind: "diagnostics_updated", diagnostics });
  } catch (error) {
    await this.recordDiagnostic(
      "assistant.diagnostics.refresh",
      `Не удалось обновить диагностику: ${getErrorMessage(error)}`,
    );
  }
}
```

**Step 3: Refactor recordDiagnostic to use applyState**

```typescript
private async recordDiagnostic(phase: string, message: string): Promise<void> {
  const diagnostic: DiagnosticEntry = {
    timestamp: this.runtimeClock(),
    phase,
    message,
  };

  this.applyState({
    kind: "diagnostics_updated",
    diagnostics: [...this.state.diagnostics, diagnostic],
  });

  try {
    await this.recordDiagnosticEntry(diagnostic);
  } catch {
    // Diagnostic persistence is best-effort
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/chrome/backgroundStateServer.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/chrome/backgroundStateServer.ts
git commit -m "refactor(M6): unify diagnostics methods through applyState()"
```

---

### Task 9: M9 — Оптимизировать diffing сообщений в `renderChat()`

**TDD scenario:** Modifying tested code — run existing tests first

**Проблема:** `JSON.stringify` на всех сообщениях при каждом рендере — O(n) на кадр.

**Files:**
- Modify: `src/chrome/sidepanel.ts:180-210` (renderChat функция)
- Test: Визуальная проверка (unit-тесты для pure functions уже есть)

**Step 1: Implement epoch-based diffing**

```typescript
// Заменить текущий diffing:
let lastRenderedEpoch = -1;

function renderChat(elements: SidePanelElements): void {
  const chat = currentSnapshot?.chat;
  const epoch = currentSnapshot?.epoch ?? 0;
  
  // Skip render if epoch hasn't changed
  if (epoch === lastRenderedEpoch) {
    return;
  }
  lastRenderedEpoch = epoch;
  
  const allMessages = chat?.messages ?? [];
  // ...rest of existing render logic, but remove JSON.stringify comparison
  
  if (elements.messageList) {
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      fragment.append(createChatMessageElement(message));
    }
    elements.messageList.replaceChildren(fragment);

    if (elements.messagesScroll) {
      elements.messagesScroll.scrollTop = elements.messagesScroll.scrollHeight;
    }
  }
  
  // ...rest of function
}
```

**Step 2: Remove unused variables**

```typescript
// Удалить:
// let lastRenderedMessageCount = 0;
// let lastRenderedMessageSignatures: string[] = [];
```

**Step 3: Manual test**

1. Открыть sidepanel
2. Отправить несколько сообщений
3. Убедиться, что рендеринг работает корректно

**Step 4: Commit**

```bash
git add src/chrome/sidepanel.ts
git commit -m "perf(M9): replace JSON.stringify diffing with epoch-based comparison"
```

---

### Task 10: M10 — Лимит на количество сообщений в чате

**TDD scenario:** New feature — full TDD cycle

**Проблема:** Сообщения накапливаются без лимита.

**Files:**
- Modify: `src/chrome/sidepanelState.ts`
- Modify: `src/chrome/assistantState.ts`
- Test: `src/chrome/sidepanelState.test.ts`, `src/chrome/assistantState.test.ts`

**Step 1: Запустить существующие тесты**

Run: `npx vitest run src/chrome/sidepanelState.test.ts src/chrome/assistantState.test.ts`
Expected: All tests PASS

**Step 2: Написать failing test**

```typescript
// В sidepanelState.test.ts:
describe("message limit", () => {
  it("should keep only last 500 messages", () => {
    let state = createInitialSidePanelState();
    
    // Add 600 messages
    for (let i = 0; i < 600; i++) {
      state = startSendingUserMessage(state, `Message ${i}`, i);
    }
    
    expect(state.messages.length).toBe(500);
    // Should keep the latest messages
    expect(state.messages[0].text).toBe("Message 100");
    expect(state.messages[499].text).toBe("Message 599");
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/chrome/sidepanelState.test.ts -t "message limit"`
Expected: FAIL — 600 сообщений в массиве

**Step 4: Implement message limit**

```typescript
// В sidepanelState.ts, после imports:
const MAX_CHAT_MESSAGES = 500;

// Добавить helper:
function trimMessages(messages: SidepanelChatMessage[]): SidepanelChatMessage[] {
  if (messages.length <= MAX_CHAT_MESSAGES) {
    return messages;
  }
  return messages.slice(-MAX_CHAT_MESSAGES);
}

// Применить в startSendingUserMessage и других функциях, добавляющих сообщения:
export function startSendingUserMessage(
  state: SidePanelState,
  message: string,
  timestamp: number,
): SidePanelState {
  const text = message.trim();
  if (!text) return state;

  return {
    ...state,
    messages: trimMessages([
      ...state.messages,
      { role: "user", text, timestamp },
    ]),
    agentBusy: true,
    busyLabel: DEFAULT_BUSY_LABEL,
    sending: true,
    error: undefined,
  };
}

// Аналогично в reduceSidePanelChatEvent для assistant_message_start и error
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/chrome/sidepanelState.test.ts`
Expected: All tests PASS

**Step 6: Apply same limit to assistantState.ts**

Аналогичные изменения в `reduceAssistantState` для `chat.messages`.

**Step 7: Commit**

```bash
git add src/chrome/sidepanelState.ts src/chrome/assistantState.ts \
        src/chrome/sidepanelState.test.ts src/chrome/assistantState.test.ts
git commit -m "feat(M10): limit chat messages to 500 entries"
```

---

## Summary

### Phase 1 (блокеры до 1.0):
- [x] Task 1: M1 — Throttle broadcastSnapshot
- [x] Task 2: M2 — maxPayload 1MB
- [x] Task 3: M4 — Validate session.event
- [x] Task 4: M7 — execFileSync shell safety
- [x] Task 5: M8 — Document rsvg-convert

### Phase 2 (post-launch):
- [x] Task 6: M3 — Rate limiting
- [x] Task 7: M5 — On-demand content script
- [x] Task 8: M6 — Unify diagnostics via applyState
- [x] Task 9: M9 — Epoch-based diffing
- [x] Task 10: M10 — Message limit

---

## Checkpoint

После завершения Phase 1 — запустить полный тестовый набор:

```bash
npm test
```

Expected: All 358+ tests PASS

После Phase 2 — ещё раз:

```bash
npm test
npm run build:chrome
```

Убедиться, что Chrome-расширение загружается и работает корректно.
