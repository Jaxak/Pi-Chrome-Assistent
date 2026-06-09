# START HERE IN A NEW SESSION

> **INSTRUCTION FOR IMPLEMENTATION START:** Open a **new Pi session** on the current feature branch before making changes. In that new session, first run:
>
> ```bash
> git status --short
> npm test
> npm run typecheck
> npm run build:chrome
> ```
>
> Then execute this plan task-by-task using the **executing-plans** skill or the same subagent-driven workflow used for the main implementation. Do **not** change scope until the review findings below are resolved and re-verified.

# Browser Connect Review Fixes and Docs Refresh Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Resolve the external review findings, harden broker/client behavior, and restructure project documentation so the MVP is accurate, navigable, and ready for follow-up work.

**Architecture:** Keep the current MVP architecture intact (Pi extension + localhost broker + Chrome MV3 extension), but fix the three main issues found in review: broker target enumeration auth, popup token-readiness UX, and broker start race. In parallel, refactor documentation into a modular `docs/` structure and rewrite `README.md` as a short entrypoint that links to those docs. Add a root `CHANGELOG.md` to track MVP evolution.

**Tech Stack:** TypeScript, Vitest, Chrome Manifest V3, Node.js + `ws`, Pi extension API, Markdown docs.

## Mandatory language requirement

- **All UI/UX must be in Russian.** This includes popup text, button labels, status text, diagnostics labels, toast messages, overlay text, modal copy, placeholders, error messages, and any other user-visible interface strings.
- **All user-facing documentation must be in Russian.** This includes `README.md`, `CHANGELOG.md`, setup instructions, troubleshooting guides, and other end-user documents under `docs/`.
- Internal engineering artifacts such as plan/review files may remain in English if needed for workflow compatibility, but product UI and user documentation must be Russian.

---

## Review Findings This Plan Must Address

Source reviews:

- `docs/reviews/2026-06-08-gpt-5.4-solution-review.md`
- `docs/reviews/2026-06-08-gpt-5.4-solution-review.ru.md`

Primary implementation issues:

1. **Broker target enumeration is effectively unauthenticated**
   - `client.listTargets` currently exposes local metadata without an authenticated session.
2. **Popup still fails too late when broker token is missing**
   - User can enter picker flow and only fail later, instead of being blocked early.
3. **Broker startup race across multiple Pi sessions is not resilient**
   - If one Pi session wins the bind race, another can fail instead of reconnecting to the now-running broker.

Primary documentation issues:

4. **`README.md` still mixes current MVP docs with stale/incomplete wording**
5. **No modular architecture/operations docs under `docs/`**
6. **No `CHANGELOG.md` exists**

---

## Desired Documentation Structure

Create and maintain the following docs layout:

```text
docs/
  architecture/
    overview.md
    broker.md
    pi-extension.md
    chrome-extension.md
    protocol.md
  operations/
    setup.md
    token-setup.md
    testing.md
    troubleshooting.md
  security/
    security-model.md
  reviews/
    2026-06-08-gpt-5.4-solution-review.md
    2026-06-08-gpt-5.4-solution-review.ru.md
  plans/
    2026-06-08-browser-connect-mvp-design.md
    2026-06-08-browser-connect-mvp-implementation-plan.md
    2026-06-09-review-fixes-and-docs-plan.md
README.md
CHANGELOG.md
```

Intent:

- `README.md` becomes the concise entrypoint.
- Deep technical details move into modular docs under `docs/`.
- `CHANGELOG.md` records meaningful milestones/fixes.

---

## README Target Structure

`README.md` should be rewritten to this structure:

1. **Project description and capabilities**
   - What the project is
   - What the MVP can do today
   - What the MVP explicitly does not do yet

2. **Quick start**
   - install dependencies
   - build Chrome extension
   - load unpacked extension
   - start Pi
   - run `/reload`
   - run `/browser-connect [alias]`
   - set up `brokerToken`
   - use popup and picker

3. **Links to modular documentation in `docs/`**
   - architecture overview
   - broker/protocol details
   - Pi extension details
   - Chrome extension details
   - token setup
   - testing/troubleshooting
   - security model

4. **Current MVP limitations**
   - token provisioning is still manual
   - browser-side Pi response streaming is not implemented
   - broker lifecycle limitation
   - local-only transport assumptions

Do **not** leave stale `TBD — development in progress` wording after this rewrite.

---

## Task 1: Lock down broker target enumeration

**TDD scenario:** Modifying already tested code — add failing integration tests first.

**Files:**
- Modify: `src/pi/broker.ts`
- Modify: `src/pi/broker.test.ts`
- Modify: `src/shared/protocol.ts` if protocol message contract needs adjustment
- Modify: `src/shared/protocol.test.ts` if protocol assumptions change

**Step 1: Add failing broker tests**

Add integration tests in `src/pi/broker.test.ts` for:

1. `client.listTargets` without prior successful auth is rejected.
2. `client.hello` with valid token authenticates the client, and only then `client.listTargets` succeeds.
3. `client.hello` with invalid token is rejected and listing still fails.

Use the existing real WebSocket broker test style.

**Step 2: Run focused tests and verify failure**

```bash
npm test -- src/pi/broker.test.ts
```

Expected: FAIL because the current broker allows unauthenticated listing.

**Step 3: Fix broker auth model**

In `src/pi/broker.ts`:

- require authenticated client state for `client.listTargets`;
- keep `client.hello` as the auth handshake;
- preserve target-side auth rules;
- ensure unauthorized list attempts return a structured error and/or closed connection consistently with existing broker behavior.

If needed, update `src/chrome/background.ts` later to perform `client.hello` before listing and sending.

**Step 4: Re-run focused tests**

```bash
npm test -- src/pi/broker.test.ts
npm run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pi/broker.ts src/pi/broker.test.ts src/shared/protocol.ts src/shared/protocol.test.ts
git commit -m "fix: require auth for broker target listing"
```

---

## Task 2: Make Chrome background perform authenticated broker handshake

**TDD scenario:** Modifying tested code — add failing background tests first.

**Files:**
- Modify: `src/chrome/background.ts`
- Modify: `src/chrome/background.test.ts`

**Step 1: Add failing background tests**

Add tests covering:

1. `listTargets` performs `client.hello` before `client.listTargets` when `brokerToken` exists.
2. missing token causes a clear early failure before any broker request is attempted.
3. `sendSelection` uses the same authenticated path.

Use the existing mocked WebSocket background test setup.

**Step 2: Run focused tests and verify failure**

```bash
npm test -- src/chrome/background.test.ts
```

Expected: FAIL.

**Step 3: Implement authenticated broker client flow**

In `src/chrome/background.ts`:

- add an authenticated broker session helper that sends `client.hello` first;
- use it in both `listTargets` and `sendSelection`;
- keep current timeout/error handling intact.

**Step 4: Re-run tests**

```bash
npm test -- src/chrome/background.test.ts
npm run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/background.ts src/chrome/background.test.ts
git commit -m "fix: authenticate chrome broker requests"
```

---

## Task 3: Fail early in popup when token is missing

**TDD scenario:** Modifying tested code — add failing popup tests first.

**Files:**
- Modify: `src/chrome/popup.ts`
- Modify: `src/chrome/popup.test.ts`
- Modify: `src/chrome/popup.html` only if copy/UI hints need adjustment
- Modify: `src/chrome/popup.css` only if UI state styling needs adjustment

**Step 1: Add failing popup tests**

Add tests for:

1. when targets exist but `tokenConfigured === false`, Send to Pi stays disabled;
2. popup shows an explicit token-required message instead of letting the user proceed;
3. when token becomes configured, the disabled state is lifted if target selection is valid.

**Step 2: Run tests and verify failure**

```bash
npm test -- src/chrome/popup.test.ts
```

Expected: FAIL.

**Step 3: Implement early token-readiness UX**

In `src/chrome/popup.ts`:

- treat token availability as part of send readiness;
- add a clear message that sending requires manual token setup for MVP;
- preserve current target-selection behavior.

Recommended copy should be concise and consistent with README.

**Step 4: Re-run tests**

```bash
npm test -- src/chrome/popup.test.ts
npm run typecheck
npm run build:chrome
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/popup.ts src/chrome/popup.test.ts src/chrome/popup.html src/chrome/popup.css
git commit -m "fix: block popup send when broker token is missing"
```

---

## Task 4: Harden broker startup race across multiple Pi sessions

**TDD scenario:** Modifying tested code — add regression tests first.

**Files:**
- Modify: `src/pi/browserConnectExtension.ts`
- Modify: `src/pi/browserConnectExtension.test.ts`
- Modify: `src/pi/targetClient.ts` only if needed

**Step 1: Add failing tests**

Add tests for:

1. first connect attempt fails, broker startup loses bind race (`EADDRINUSE`), extension retries connect successfully instead of failing;
2. existing owned-broker recovery paths still behave correctly.

Because fully reproducing bind race may be awkward, use helper-level mocks around `startBrokerServer(...)` and `connectTargetToBroker(...)`.

**Step 2: Run focused tests and verify failure**

```bash
npm test -- src/pi/browserConnectExtension.test.ts
```

Expected: FAIL.

**Step 3: Implement race-resilient fallback**

In `src/pi/browserConnectExtension.ts`:

- when broker startup fails with address-in-use style error, retry normal broker connection before surfacing failure;
- do not regress the existing owned-broker close/recovery logic.

**Step 4: Re-run tests**

```bash
npm test -- src/pi/browserConnectExtension.test.ts
npm run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pi/browserConnectExtension.ts src/pi/browserConnectExtension.test.ts src/pi/targetClient.ts
git commit -m "fix: recover from broker startup race"
```

---

## Task 5: Rewrite README.md into a concise entrypoint

**TDD scenario:** Docs change — verify links/commands and remove stale wording.

**Files:**
- Modify: `README.md`

**Step 1: Rewrite README structure**

Create sections in this order:

```md
# Pi Chrome Extension

## Project description and capabilities

## Quick start

## Documentation

## Current MVP limitations

## Development

## License
```

Content requirements:

- remove stale `TBD — разработка в процессе` installation wording;
- explain what the extension can do today;
- explain that Pi replies remain in terminal in MVP;
- add short quick-start with manual token setup;
- keep README concise and move deep technical details to `docs/`.

**Step 2: Verify the README is accurate against the code**

Check:

- broker host/port;
- token file path;
- logs path;
- manual token requirement;
- no browser-side streaming.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for MVP usage"
```

---

## Task 6: Add modular docs under `docs/`

**TDD scenario:** Docs architecture work — verify links and cross-references.

**Files:**
- Create: `docs/architecture/overview.md`
- Create: `docs/architecture/broker.md`
- Create: `docs/architecture/pi-extension.md`
- Create: `docs/architecture/chrome-extension.md`
- Create: `docs/architecture/protocol.md`
- Create: `docs/operations/setup.md`
- Create: `docs/operations/token-setup.md`
- Create: `docs/operations/testing.md`
- Create: `docs/operations/troubleshooting.md`
- Create: `docs/security/security-model.md`

**Step 1: Write modular docs**

Required doc focus:

- `overview.md` — high-level architecture and user flows;
- `broker.md` — broker ownership, auth flow, lifecycle, known limitations;
- `pi-extension.md` — `/browser-connect`, token file, broker start/join flow;
- `chrome-extension.md` — popup/background/content-script responsibilities;
- `protocol.md` — message types, handshake expectations, target/client responsibilities;
- `setup.md` — install/build/load instructions;
- `token-setup.md` — exact manual `brokerToken` provisioning flow for MVP;
- `testing.md` — automated commands and practical manual smoke steps;
- `troubleshooting.md` — common failure cases and expected user-facing messages;
- `security-model.md` — localhost boundary, token auth, metadata leakage risk, current mitigations.

**Step 2: Link docs from README**

Ensure `README.md` links to all relevant modular docs.

**Step 3: Sanity-check links**

Run a simple grep/manual pass to ensure referenced files exist.

**Step 4: Commit**

```bash
git add docs/architecture docs/operations docs/security README.md
git commit -m "docs: add modular architecture and operations docs"
```

---

## Task 7: Add `CHANGELOG.md`

**TDD scenario:** Docs change.

**Files:**
- Create: `CHANGELOG.md`

**Step 1: Create changelog skeleton**

Recommended structure:

```md
# Changelog

## [Unreleased]
### Added
### Changed
### Fixed
### Security

## [2026-06-09] Browser Connect MVP review hardening
...

## [2026-06-08] Browser Connect MVP implementation
...
```

Populate with:

- initial MVP implementation milestones;
- review-driven hardening work;
- docs restructuring;
- security/auth fixes.

Keep entries concise and user-meaningful.

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add changelog"
```

---

## Task 8: Final verification and audit closeout

**TDD scenario:** Verification + docs accuracy.

**Files:**
- Modify only if final verification reveals real defects

**Step 1: Full verification**

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
- working tree clean.

**Step 2: Review docs accuracy**

Manually verify that:

- README quick-start is executable and honest;
- modular docs exist and links are correct;
- changelog entries match actual implemented work;
- review findings 1–3 are resolved and described.

**Step 3: Record closeout note**

Append a short note to:
- `docs/plans/2026-06-09-review-fixes-and-docs-plan.md`

Include:
- what review findings were fixed;
- what still requires manual browser GUI verification;
- final verification command results.

**Step 4: Final commit**

```bash
git add README.md CHANGELOG.md docs src package.json package-lock.json
git commit -m "docs: close out review fixes"
```

---

## Task 9: Complete Russian UI copy cleanup in the popup

**TDD scenario:** Modifying tested code — add failing popup/UI tests first.

**Files:**
- Modify: `src/chrome/popup.ts`
- Modify: `src/chrome/popup.test.ts`
- Modify: `src/chrome/popup.html`
- Modify: `src/chrome/popup.css` only if layout/styling needs small adjustments after copy updates

**Step 1: Add failing popup tests**

Add focused tests that assert the popup no longer exposes stale English UI copy. Cover at least:

1. static labels/buttons rendered from `popup.html` are shown in Russian;
2. status/help/diagnostic strings produced by `popup.ts` are shown in Russian for the main MVP states;
3. disabled button titles and picker guidance are shown in Russian.

Prefer extending the existing popup DOM tests rather than creating a new harness.

**Step 2: Run focused tests and verify failure**

```bash
npm test -- src/chrome/popup.test.ts
```

Expected: FAIL because the current popup still contains English labels and/or diagnostics strings.

**Step 3: Implement the minimal UI copy cleanup**

In `src/chrome/popup.ts` and `src/chrome/popup.html`:

- replace remaining English user-visible strings with concise Russian copy;
- keep terminology consistent with `README.md` and `docs/operations/troubleshooting.md`;
- preserve current popup behavior and state logic;
- keep technical identifiers such as `brokerToken`, `Pi`, `/browser-connect`, and `DOM picker` only where they are product terms or commands, but ensure the surrounding UI text is Russian.

If Russian copy causes cramped layout, make only minimal styling adjustments in `src/chrome/popup.css`.

**Step 4: Re-run verification**

```bash
npm test -- src/chrome/popup.test.ts
npm run typecheck
npm run build:chrome
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/popup.ts src/chrome/popup.test.ts src/chrome/popup.html src/chrome/popup.css
git commit -m "fix: complete popup russian ui copy"
```

---

## Completion Criteria

This plan is complete when:

- broker target enumeration requires authentication;
- popup blocks sending early when token is missing;
- broker startup race falls back cleanly to reconnect;
- all popup user-visible copy is Russian, with no stale English labels, button text, status text, diagnostics headings, or guidance messages left in the MVP UI;
- `README.md` is concise, current, and structured as:
  - project description and capabilities
  - quick start
  - links to modular docs under `docs/`
- modular technical docs exist under `docs/`;
- `CHANGELOG.md` exists and reflects MVP + hardening history;
- `npm test`, `npm run typecheck`, and `npm run build:chrome` pass;
- working tree is clean after final verification.

---

## Suggested Execution Order

1. Task 1 — broker auth for listing
2. Task 2 — authenticated Chrome broker client
3. Task 3 — popup token-readiness UX
4. Task 4 — broker startup race
5. Task 5 — README rewrite
6. Task 6 — modular docs in `docs/`
7. Task 7 — changelog
8. Task 9 — popup Russian UI copy cleanup
9. Task 8 — final verification and closeout

---

## Closeout Note — 2026-06-09

### Fixed review findings

- `client.listTargets` now requires authenticated client state before broker target enumeration succeeds.
- Chrome background now performs `client.hello` before broker listing and send requests, and fails early when `brokerToken` is missing.
- Popup now blocks sending early when `brokerToken` is not configured.
- Broker startup now recovers from `EADDRINUSE` bind-race scenarios by retrying a normal connection path.
- Popup UI copy was additionally cleaned up so user-visible popup labels and guidance are Russian.
- MVP documentation was rewritten into a concise `README.md`, modular docs under `docs/`, and a root `CHANGELOG.md`.

### Still requires manual browser GUI verification

- End-to-end manual smoke test in Chrome with the unpacked extension loaded.
- Manual verification that popup Russian labels, titles, diagnostics text, and picker guidance render correctly in the real extension UI.
- Manual verification that target selection, DOM picker start, and selection send still behave correctly against a running Pi session.
- Manual verification that broker token setup instructions in the docs match the real extension workflow.

### Final verification command results

```text
npm test              PASS (15 test files, 135 tests)
npm run typecheck     PASS
automation build      npm run build:chrome PASS
git status --short    NOT CLEAN
```

Residual workspace state at closeout time:

```text
 M AGENTS.md
?? docs/plans/2026-06-09-review-fixes-and-docs-plan.md
?? docs/reviews/
```

The implementation and verification work for this plan passed, but the overall working tree was not clean because unrelated pre-existing workspace files remained outside the scoped task commits.
