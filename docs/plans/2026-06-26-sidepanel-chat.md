# Side Panel Chat Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Заменить popup Chrome-расширения на боковую панель и добавить минимальный чат с Pi-ассистентом, включая визуальный индикатор «агент работает в фоне».

**Architecture:** Сохраняем текущую broker/target-архитектуру и существующий DOM picker. Добавляем постоянное WebSocket-подключение side panel к broker, чатовые сообщения browser → broker → Pi target и потоковые события assistant → broker → side panel. Первая версия intentionally не переносит перегруженные browser automation функции из `../web_ui_sidepage/pi-web-ui-chrome-extension`.

**Tech Stack:** Chrome Extension Manifest V3, TypeScript, WebSocket `ws`, Pi Extension API events (`message_start`, `message_update`, `message_end`), Vitest, ручной DOM UI без React/Vue.

---

## Выбранное визуальное направление

Базовый дизайн для реализации: **Ant Compact** из `docs/designs/sidepanel-chat-designs.html`. В дизайн-файле оставлен только итоговый вариант со светлым и тёмным режимом.

Компоненты верстаем вручную без React и без зависимости от Ant Design, но визуально следуем Ant Design compact tokens: плотные отступы, `Card`, `Select`, `Input.TextArea`, `Button primary`, `Badge`, светлая и тёмная темы. Primary/accent палитра — **оливковая**, не синяя. Для светлой и тёмной темы используется одинаковый primary-оливковый оттенок `#6f7f2a`, чтобы белый текст на кнопках и аватаре оставался читаемым.

Финальные элементы управления:

- Header: название **«Ассистент»**, подпись **«Pi подключён»**, статус **«готов»**, справа kebab-меню `⋯`.
- Header kebab-меню:
  - **Настройки** — отображается disabled, потому что в текущей версии настроек нет;
  - **Авторизация**;
  - **Dev-журнал** — для чтения логов/диагностического журнала.
- Composer: вместо текстовой кнопки «Фрагмент» используем kebab-меню `⋯`. В первой версии в меню один пункт: **DOM picker**. Меню проектируется как расширяемая точка для будущей функциональности.
- Индикатор фоновой работы: текст **«Агент работает в фоне…»** без рамки и без фоновой плашки; слева три анимированные точки.

## Scope первой версии

### Входит

- Chrome Side Panel вместо popup.
- Сохранение текущих сценариев:
  - список Pi-сессий/целей;
  - авторизация browser token;
  - запуск DOM picker и отправка выделения в выбранную Pi-сессию.
- Новый режим чата:
  - пользователь вводит текст в side panel;
  - сообщение доставляется в выбранную Pi-сессию;
  - ответ ассистента отображается в чате;
  - во время работы показывается заметный индикатор с русским текстом, например: **«Агент работает в фоне…»**.
- Plain text rendering. Markdown и tool calls не нужны в первой версии.

### Не входит

- Вывод tool calls/tool results.
- Cookies/storage/CDP/network automation из референсного проекта.
- Slash autocomplete, выбор cwd, resume sessions внутри side panel.
- Сложная история чата между перезапусками браузера.

---

## Архитектура целевого потока

```text
Chrome Side Panel
  ├─ status/session/auth UI
  ├─ chat messages
  ├─ textarea + send button
  └─ visual busy indicator: «Агент работает в фоне…»
        │ persistent WS
        ▼
Broker
  ├─ authenticated browser sockets
  ├─ registered Pi targets
  ├─ browser subscriptions by targetId
  └─ chat event fan-out
        │ target WS
        ▼
Pi target extension
  ├─ receives target.deliverChatMessage
  ├─ calls pi.sendUserMessage(...)
  └─ forwards assistant lifecycle events as target.chatEvent
```

---

## Proposed protocol additions

Modify `src/shared/protocol.ts`.

Add message types:

```ts
"client.subscribeTarget"
"client.unsubscribeTarget"
"client.sendChatMessage"
"client.chatAccepted"
"client.chatEvent"
"target.deliverChatMessage"
"target.chatEvent"
```

Minimal payloads:

```ts
export type BrowserClientSubscribeTargetPayload = {
  token: string;
  targetId: string;
};

export type BrowserClientSendChatMessagePayload = {
  token: string;
  targetId: string;
  message: string;
};

export type TargetDeliverChatMessagePayload = {
  message: string;
  sentAt: number;
};

export type ChatEvent =
  | { kind: "user_message"; text: string; timestamp: number }
  | { kind: "agent_busy"; busy: boolean; label: string; timestamp: number }
  | { kind: "assistant_message_start"; messageId: string; timestamp: number }
  | { kind: "assistant_text_delta"; messageId: string; delta: string; timestamp: number }
  | { kind: "assistant_message_end"; messageId: string; timestamp: number }
  | { kind: "error"; message: string; timestamp: number };
```

Important UX rule: side panel must set busy immediately after sending a message and clear it only after `assistant_message_end`, `agent_busy(false)`, or `error`.

---

## Task 1: Replace popup entry point with side panel shell

**TDD scenario:** Modifying browser entry points — update tests first where practical, then implementation.

**Files:**

- Modify: `src/chrome/manifest.json`
- Modify: `src/chrome/background.ts`
- Create: `src/chrome/sidepanel.html`
- Create: `src/chrome/sidepanel.css`
- Create: `src/chrome/sidepanel.ts`
- Update build if needed: `scripts/build-chrome.mjs`
- Test: `src/chrome/background.test.ts`

**Steps:**

1. Run GitNexus impact analysis before editing symbols:

   ```bash
   # Use GitNexus MCP/CLI per AGENTS.md for affected symbols: background listener setup, build script entry list.
   ```

2. Update `manifest.json`:

   - add permission `sidePanel`;
   - remove `action.default_popup`;
   - add:

   ```json
   "side_panel": { "default_path": "sidepanel.html" }
   ```

3. Update `background.ts` to open side panel on extension icon click and configure `openPanelOnActionClick`.

4. Add side panel files initially mirroring current popup features.

5. Keep all visible strings in Russian.

6. Run:

   ```bash
   npm run test -- src/chrome/background.test.ts
   npm run build
   ```

7. Commit:

   ```bash
   git add src/chrome/manifest.json src/chrome/background.ts src/chrome/sidepanel.* scripts/build-chrome.mjs src/chrome/background.test.ts
   git commit -m "feat: replace popup with chrome side panel shell"
   ```

---

## Task 2: Extract reusable side panel state for chat UI

**TDD scenario:** New feature — full TDD cycle.

**Files:**

- Create: `src/chrome/sidepanelState.ts`
- Create: `src/chrome/sidepanelState.test.ts`
- Modify: `src/chrome/sidepanel.ts`

**State model:**

```ts
type SidepanelChatMessage =
  | { role: "user"; text: string; timestamp: number }
  | { role: "assistant"; messageId: string; text: string; streaming: boolean; timestamp: number }
  | { role: "system"; text: string; tone: "info" | "warning" | "error"; timestamp: number };

type SidepanelState = {
  bridgeOnline: boolean;
  selectedTargetId?: string;
  messages: SidepanelChatMessage[];
  agentBusy: boolean;
  busyLabel: string;
  sending: boolean;
  error?: string;
};
```

**Required tests:**

- `user_message` appends user message and enables busy indicator.
- `assistant_message_start` creates streaming assistant message.
- `assistant_text_delta` appends text to the matching assistant message.
- `assistant_message_end` marks message non-streaming and clears busy.
- `error` appends system error and clears busy/sending.

**Commands:**

```bash
npm run test -- src/chrome/sidepanelState.test.ts
```

**Commit:**

```bash
git add src/chrome/sidepanelState.ts src/chrome/sidepanelState.test.ts src/chrome/sidepanel.ts
git commit -m "feat: add side panel chat state"
```

---

## Task 3: Add chat protocol validation

**TDD scenario:** New protocol behavior — tests first.

**Files:**

- Modify: `src/shared/protocol.ts`
- Modify: `src/shared/protocol.test.ts`
- Modify: `docs/architecture/protocol.md`

**Steps:**

1. Add protocol message types listed above.
2. Add payload types and validation helpers:

   - `validateSendChatMessagePayload`
   - `validateSubscribeTargetPayload`
   - `validateChatEvent`

3. Tests:

   - known chat message types pass `isProtocolEnvelope`;
   - empty chat message is rejected;
   - missing `targetId` is rejected;
   - valid `assistant_text_delta` event is accepted;
   - unknown chat event kind is rejected.

4. Run:

   ```bash
   npm run test -- src/shared/protocol.test.ts
   npm run typecheck
   ```

5. Commit:

   ```bash
   git add src/shared/protocol.ts src/shared/protocol.test.ts docs/architecture/protocol.md
   git commit -m "feat: add chat protocol messages"
   ```

---

## Task 4: Extend broker with browser subscriptions and chat forwarding

**TDD scenario:** New broker behavior — tests first.

**Files:**

- Modify: `src/pi/broker.ts`
- Modify: `src/pi/broker.test.ts`

**Required behavior:**

- Browser must authenticate via `client.hello` before subscribing or sending chat.
- `client.subscribeTarget` stores browser socket under `targetId`.
- `client.unsubscribeTarget` removes subscription.
- `client.sendChatMessage` forwards to the active target socket as `target.deliverChatMessage`.
- Target can send `target.chatEvent`; broker forwards as `client.chatEvent` to subscribed browser sockets only.
- Socket close removes subscriptions.
- If target is missing, broker returns `client.error` and emits an error chat event where useful.

**Tests:**

- unauthenticated `client.sendChatMessage` is rejected;
- subscribed browser receives `client.chatEvent`;
- unsubscribed browser does not receive events;
- chat message is delivered only to selected target;
- closing browser socket cleans subscription.

**Commands:**

```bash
npm run test -- src/pi/broker.test.ts
npm run typecheck
```

**Commit:**

```bash
git add src/pi/broker.ts src/pi/broker.test.ts
git commit -m "feat: forward chat events through broker"
```

---

## Task 5: Extend target client and Pi extension for chat messages

**TDD scenario:** New target behavior — tests first.

**Files:**

- Modify: `src/pi/targetClient.ts`
- Modify: `src/pi/targetClient.test.ts`
- Modify: `src/pi/browserConnectExtension.ts`
- Modify: `src/pi/browserConnectExtension.test.ts`

**Implementation notes from Pi docs:**

- Pi extension events support `message_start`, `message_update`, `message_end`.
- `message_update` exposes `assistantMessageEvent`, including `text_delta`.
- Existing code already uses `pi.sendUserMessage(...)` and `ctx.isIdle()`.

**Required behavior:**

- On `target.deliverChatMessage`, call `pi.sendUserMessage(message, options)`.
- If Pi is idle: send directly.
- If Pi is not idle: either reject with clear Russian error or queue as follow-up. Recommendation for v1: queue as follow-up and keep indicator text `Агент работает в фоне…`.
- Emit chat events to broker:
  - `agent_busy(true)` before/when accepted;
  - `assistant_message_start` on assistant start;
  - `assistant_text_delta` on assistant text delta;
  - `assistant_message_end` on assistant end;
  - `agent_busy(false)` after assistant end or error.

**Open implementation detail to verify during execution:**

The extension API event handlers are global for the loaded extension. Filter events so only the currently connected target broadcasts them, and avoid duplicate subscriptions on repeated `/chrome-assistent-connect`.

**Commands:**

```bash
npm run test -- src/pi/targetClient.test.ts src/pi/browserConnectExtension.test.ts
npm run typecheck
```

**Commit:**

```bash
git add src/pi/targetClient.ts src/pi/targetClient.test.ts src/pi/browserConnectExtension.ts src/pi/browserConnectExtension.test.ts
git commit -m "feat: stream assistant chat events to browser"
```

---

## Task 6: Add persistent broker client in side panel

**TDD scenario:** New browser module — tests first.

**Files:**

- Create: `src/chrome/sidepanelBrokerClient.ts`
- Create: `src/chrome/sidepanelBrokerClient.test.ts`
- Modify: `src/chrome/sidepanel.ts`

**Behavior:**

- Open WebSocket to existing broker URL.
- Authenticate with browser token.
- Request target list.
- Subscribe to selected target.
- Send chat messages.
- Reconnect with small bounded retry loop.
- Surface connection state to side panel state.

**Russian status strings:**

- `Подключаемся к Pi…`
- `Pi подключён`
- `Pi недоступен`
- `Браузер не авторизован в Pi`
- `Агент работает в фоне…`

**Commands:**

```bash
npm run test -- src/chrome/sidepanelBrokerClient.test.ts
npm run typecheck
```

**Commit:**

```bash
git add src/chrome/sidepanelBrokerClient.ts src/chrome/sidepanelBrokerClient.test.ts src/chrome/sidepanel.ts
git commit -m "feat: connect side panel chat to broker"
```

---

## Task 7: Render chat UI and busy indicator

**TDD scenario:** UI behavior — test pure state/render helpers first, then manual browser check.

**Files:**

- Modify: `src/chrome/sidepanel.html`
- Modify: `src/chrome/sidepanel.css`
- Modify: `src/chrome/sidepanel.ts`
- Test: `src/chrome/sidepanelState.test.ts` or `src/chrome/sidepanel.test.ts`

**UI requirements:**

- Chat area is the primary panel content.
- Visual style follows selected **Ant Compact** mockup.
- User messages aligned visually separate from assistant messages.
- Plain text only via `textContent`, not `innerHTML`.
- Composer actions include primary **«Отправить»** and kebab-menu `⋯` with one v1 item: **DOM picker**.
- Header actions include status **«готов»** and kebab-menu `⋯` with items: disabled **«Настройки»**, **«Авторизация»**, **«Dev-журнал»**.
- Busy indicator visible while `agentBusy === true`; it must be inline/minimal, without border/background wrapper, with three animated dots to the left of the text:

```html
<div class="agent-working" role="status" aria-live="polite">
  <span class="agent-working__dots"><i></i><i></i><i></i></span>
  Агент работает в фоне…
</div>
```

- Send button disabled when:
  - no selected target;
  - no browser token;
  - broker offline;
  - message text is empty.
- Textarea placeholder: `Сообщение ассистенту`.
- Use final visual reference from `docs/designs/sidepanel-chat-designs.html`.

**Manual checks:**

1. Open extension side panel.
2. Authorize browser token.
3. Run `/chrome-assistent-connect` in Pi.
4. Select target.
5. Send `Привет, ответь одним предложением`.
6. Confirm:
   - user message appears immediately;
   - busy indicator appears;
   - assistant text appears in chat;
   - busy indicator disappears after completion.

**Commands:**

```bash
npm run test
npm run typecheck
npm run build
```

**Commit:**

```bash
git add src/chrome/sidepanel.html src/chrome/sidepanel.css src/chrome/sidepanel.ts src/chrome/sidepanelState.test.ts
git commit -m "feat: render side panel assistant chat"
```

---

## Task 8: Preserve DOM picker integration in side panel

**TDD scenario:** Modifying existing flow — run existing tests first, then update.

**Files:**

- Modify: `src/chrome/sidepanel.ts`
- Modify if needed: `src/chrome/background.ts`
- Existing tests: `src/chrome/contentScript.test.ts`, `src/chrome/domPicker.test.ts`, `src/chrome/selectionOverlay.test.ts`, `src/chrome/toast.test.ts`

**Requirement:**

Existing DOM picker flow must still work from side panel. The action is placed inside the composer kebab-menu `⋯` as the first and only v1 item: **DOM picker**. Header kebab-menu is separate and contains disabled **Настройки**, **Авторизация**, and **Dev-журнал**.

**Commands:**

```bash
npm run test -- src/chrome/contentScript.test.ts src/chrome/domPicker.test.ts src/chrome/selectionOverlay.test.ts src/chrome/toast.test.ts
npm run test
```

**Commit:**

```bash
git add src/chrome/sidepanel.ts src/chrome/background.ts
git commit -m "fix: preserve dom picker from side panel"
```

---

## Task 9: Documentation and final verification

**TDD scenario:** Documentation and verification.

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/architecture/chrome-extension.md`
- Modify: `docs/architecture/broker.md`
- Modify: `docs/architecture/pi-extension.md`

**Steps:**

1. Document side panel chat in Russian.
2. Document that first version does not show tool calls.
3. Document busy indicator behavior.
4. Run GitNexus change detection before final commit per `AGENTS.md`:

   ```bash
   # Use gitnexus_detect_changes() / npx gitnexus analyze if stale.
   ```

5. Run full verification:

   ```bash
   npm run test
   npm run typecheck
   npm run build
   ```

6. Commit:

   ```bash
   git add README.md CHANGELOG.md docs/architecture/chrome-extension.md docs/architecture/broker.md docs/architecture/pi-extension.md
   git commit -m "docs: describe side panel chat mode"
   ```

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pi Extension API не даёт напрямую session object | Use documented extension lifecycle events `message_start/message_update/message_end`, already available to extensions. |
| Duplicate event forwarding after reconnect | Keep one active target connection, clear previous connection, guard broadcasts by active connection. |
| Browser side panel disconnects during agent response | Broker should ignore closed sockets and keep Pi session running. On reconnect, v1 may not replay missed deltas. |
| Agent busy indicator can get stuck | Clear busy on `assistant_message_end`, `agent_busy(false)`, `error`, socket disconnect, and send timeout. |
| Popup tests become obsolete | Replace or migrate popup tests to side panel helper tests. |

---

## Final acceptance criteria

- Extension opens as Chrome Side Panel, not popup.
- Existing auth/session/DOM picker workflows still work.
- User can send plain text message from side panel to selected Pi target.
- Assistant response appears in side panel chat.
- While response is running, side panel visibly shows **«Агент работает в фоне…»**.
- No tool calls/tool results are shown in v1.
- All user-visible UI and documentation text is Russian.
- `npm run test`, `npm run typecheck`, and `npm run build` pass.
