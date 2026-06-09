# Browser Connect MVP Design

Date: 2026-06-08
Branch: `feat/browser-to-pi-messages`

## Goal

Build a minimal Chrome extension + Pi extension integration that lets a user send selected DOM content from a browser page into an already running interactive Pi terminal session.

The first version only confirms delivery in the browser. Pi responses are read in the terminal.

## User Scenarios

### Scenario 1: Send page fragment to current Pi

1. User starts `pi` in a terminal.
2. User runs `/browser-connect`.
3. User opens a browser page with useful information.
4. User clicks the browser extension button.
5. In the popup, user clicks **Send to Pi**.
6. Popup closes and interactive DOM selection mode starts.
7. User hovers over page elements; the nearest logical DOM block is highlighted with a translucent green frame.
8. User clicks the desired block.
9. A small comment dialog appears with **Cancel** and **Send** buttons.
10. User optionally enters a comment.
11. User clicks **Send**.
12. The selected DOM fragment and optional comment are delivered to the running Pi terminal.
13. Pi processes the request according to the comment.
14. User continues working in the terminal.

### Scenario 2: Choose between multiple Pi terminals

1. User works with Pi in one or more terminals.
2. User needs a code example or other web fragment.
3. User runs `/browser-connect` in the desired Pi terminals.
4. In the browser extension popup, user selects the active terminal/console instance.
5. User clicks **Send to Pi**.
6. User selects a code block or page fragment.
7. Payload is sent to the selected Pi instance.
8. User returns to Pi and continues development.

## Recommended Architecture

MVP has two major parts:

1. **Chrome extension**
   - Popup UI.
   - Target selection.
   - DOM picker content script.
   - Comment overlay.
   - Success/error toast.
   - Browser-side diagnostics.

2. **Pi `browser-connect` extension**
   - Registers `/browser-connect [alias]`.
   - Starts or joins a local broker.
   - Registers the current Pi terminal as an active target.
   - Receives selected DOM payloads.
   - Calls `pi.sendUserMessage(...)` into the already running TUI session.
   - Logs broker/Pi-side errors.

Communication uses a local WebSocket broker bound to `127.0.0.1:<fixed-port>`.

```text
Chrome Extension
        ⇅ ws://127.0.0.1:<fixed-port>
Browser Connect Broker
        ⇅
Pi target A / Pi target B / Pi target C
```

The first Pi instance that runs `/browser-connect` starts the broker. Other Pi instances connect to that broker and register themselves as additional targets.

Chrome extension always connects to the fixed local broker address, gets active targets, lets the user select one, then sends browser selections to that target.

## Pi Target Registration

When user runs:

```text
/browser-connect [alias]
```

The current Pi instance registers metadata like:

```json
{
  "targetId": "uuid",
  "alias": "frontend",
  "cwd": "/path/to/project",
  "gitBranch": "feat/x",
  "pid": 12345,
  "sessionName": "optional",
  "connectedAt": 1710000000000,
  "lastSeenAt": 1710000000000
}
```

The alias is optional.

Display logic in Chrome popup:

- Primary label: alias when provided.
- Secondary label: project directory, git branch, PID, optional session name.

Example with alias:

```text
frontend
pi-chrome-extension · feat/browser-to-pi-messages · pid 12345
```

Example without alias:

```text
pi-chrome-extension · feat/browser-to-pi-messages
/home/.../pi-chrome-extension · pid 12345
```

Chrome stores the last selected `targetId` in `chrome.storage.local`. If that target is still active when popup opens again, it is preselected. Otherwise the user must choose another target.

## Target Liveness

Pi targets send heartbeat messages to the broker. If heartbeat stops, broker removes the target from the active list.

Pi extension also tries to send an unregister message during shutdown, but heartbeat timeout is the authoritative cleanup mechanism.

MVP limitation: if the first Pi instance that owns the broker exits, the broker may disappear. Other clients reconnect only after user runs `/browser-connect` again. This is acceptable for MVP and must be documented.

## DOM Picker UX

Popup contains:

- Connection status.
- Active Pi target selector.
- **Send to Pi** button.
- Diagnostics / last error affordance.

After **Send to Pi**:

1. Popup closes.
2. Content script starts interactive selection in the active tab.
3. Mouse hover highlights the nearest logical DOM block.
4. Highlight is a translucent green overlay frame, not direct mutation of selected element styling.
5. Click selects the block.
6. A small overlay dialog appears with:
   - comment textarea;
   - **Cancel** button;
   - **Send** button.
7. Escape cancels selection mode.

Logical DOM block heuristic for MVP:

1. Prefer semantic or content-heavy elements such as `article`, `section`, `main`, `pre`, `code`, `blockquote`, `table`, elements with meaningful ARIA roles.
2. Otherwise walk up parent chain until finding a block-level container with reasonable area and text density.
3. Avoid selecting tiny inline spans unless they are inside code/pre-like content.
4. Avoid selecting `body`/`html` unless no better candidate exists.

## Selection Payload

Content script sends payload like:

```json
{
  "url": "https://example.com/page",
  "title": "Page title",
  "selectedText": "...",
  "selectedHtml": "<div>...</div>",
  "selector": "main article pre:nth-of-type(1)",
  "comment": "Как применить это в текущем проекте?",
  "capturedAt": 1710000000000
}
```

Payload limits for MVP:

- `selectedText`: 30–50 KB.
- `selectedHtml`: up to 100 KB.
- If truncated, include explicit truncation marker.

This prevents accidental huge page selection from overloading the Pi context.

## Delivery to Pi

Pi extension receives `target.deliverSelection`, formats it as a user message, and calls `pi.sendUserMessage(...)`.

If Pi is idle, message is delivered immediately and triggers a turn.

If Pi is already processing, use `deliverAs: "followUp"`, so the browser fragment is handled after the current Pi response instead of interrupting the current turn.

Message format:

````md
Пользователь отправил фрагмент страницы из браузера.

Источник:
- URL: ...
- Title: ...

Комментарий пользователя:
...

Выбранный текст:
```text
...
```

HTML-фрагмент:
```html
...
```
````

## Browser Success/Error UX

Browser does not wait for the model's answer in MVP. It only waits until broker/Pi confirms that the payload was accepted and `pi.sendUserMessage(...)` was invoked or queued.

Toast messages:

- Success: **Отправлено в Pi**.
- General failure: **Не удалось отправить в Pi** + short reason.
- Missing selected target: **Выбранный терминал Pi недоступен. Выберите другой.**
- Broker unavailable: **Pi не подключён. Выполните `/browser-connect` в терминале.**

## Logging and Diagnostics

### Chrome extension logging

Store last N errors in `chrome.storage.local`.

Log fields:

- timestamp;
- phase: `connect`, `listTargets`, `domPick`, `sendPayload`, etc.;
- message;
- stack when available;
- targetId;
- url.

Popup includes compact diagnostics / last errors view.

### Pi extension / broker logging

Write a local log file, for example:

- project-local: `.pi/browser-connect.log`; or
- user-level: `~/.pi/browser-connect/logs/...`.

Log:

- registration/unregistration;
- heartbeats / target timeout;
- connection failures;
- invalid protocol messages;
- rejected payloads;
- `sendUserMessage` errors.

Avoid logging full sensitive payload content. For payloads, log URL, title, sizes, targetId, and optionally a short preview only in debug mode.

## Security

MVP security model:

- broker binds only to `127.0.0.1`;
- `/browser-connect` generates or exposes a session token;
- Chrome extension must send token when connecting/sending;
- broker rejects messages without valid token;
- payload size is capped;
- protocol rejects unknown message types and malformed payloads.

This is not a replacement for Chrome Native Messaging security, but is acceptable for local MVP.

## WebSocket Protocol

All messages are JSON objects with:

```ts
{
  version: 1,
  type: string,
  requestId?: string,
  payload?: unknown
}
```

Minimum message types:

Chrome → broker:

- `client.hello`
- `client.listTargets`
- `client.sendSelection`

Pi target → broker:

- `target.register`
- `target.heartbeat`
- `target.unregister`
- `target.sendSelectionResult`

Broker → Chrome:

- `client.targets`
- `client.sendResult`
- `client.error`

Broker → Pi target:

- `target.deliverSelection`

## MVP Scope

Included:

- `/browser-connect [alias]`;
- multiple Pi targets;
- concrete terminal/console target selection in popup;
- DOM picker with hover highlight;
- optional user comment;
- delivery to already open Pi TUI;
- success/error toast;
- browser-side diagnostics;
- Pi/broker-side logging;
- local token;
- payload size limits.

Excluded from MVP:

- rendering Pi answer in browser;
- streaming responses back to browser;
- Chrome Native Messaging;
- autostarting Pi;
- full send history;
- cross-browser/session sync;
- Chrome Web Store publication flow;
- AI-based semantic extraction in browser.

## Testing Strategy

Layered testing:

1. Unit tests for:
   - payload formatting;
   - payload truncation;
   - DOM candidate selection heuristics;
   - protocol validation.
2. Integration tests for broker protocol:
   - target registration;
   - target listing;
   - delivery result;
   - target timeout;
   - invalid token / invalid payload.
3. Manual E2E:
   - load unpacked extension;
   - run `pi`;
   - run `/browser-connect test`;
   - select browser DOM;
   - confirm message appears and runs in terminal;
   - verify success/error toast;
   - inspect logs on failure.
