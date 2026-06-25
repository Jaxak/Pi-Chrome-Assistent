# Удаление popup уточнения DOM-выбора Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Удалить отдельную панель DOM picker с кнопками `Крупнее` / `Меньше` / `Вверх` / `Вниз` / `Изменить` / `Pi`, чтобы после клика по выбранному элементу сразу открывалось окно комментария.

**Architecture:** `contentScript.ts` остаётся владельцем lifecycle DOM picker, hover-подсветки, модалки комментария и отправки payload. `selectionOverlay.ts` превращается из overlay+панель+модалка в overlay+модалка: Crosshair-подсветка сохраняется, а вся панель уточнения и callbacks навигации удаляются. `domPicker.ts` сохраняет только payload/selector-функции; helper-ы parent/child/sibling-навигации и их тесты удаляются как больше неиспользуемые.

**Tech Stack:** TypeScript, Chrome Extension MV3 content scripts, Vite IIFE build, Vitest + jsdom.

---

## Контекст

Текущая задача продолжает ветку после повышения точности DOM-выбора. Теперь пользовательский путь должен быть короче:

1. Пользователь запускает DOM picker из Chrome extension popup.
2. Наводит курсор на нужный DOM-элемент, Crosshair подсвечивает текущую цель.
3. Кликает по элементу.
4. Сразу открывается модальное окно комментария `Отправить в Pi`.
5. После отправки content script строит `SelectionPayload` для именно кликнутого элемента и отправляет `sendSelection` в background/runtime.

Удаляемый путь:

- отдельная панель `Выбор блока`;
- кнопки `Крупнее`, `Меньше`, `Вверх`, `Вниз`, `Изменить`, `Отменить`, `Pi`;
- callbacks `onNarrow`, `onWiden`, `onChange`, `onConfirm`, `onUp`, `onDown`;
- keyboard sibling navigation через `ArrowUp` / `ArrowDown`;
- tests, которые проверяют эту панель и навигацию.

Не удаляем:

- Chrome extension popup `src/chrome/popup.*` для выбора Pi-сессии;
- Crosshair-подсветку;
- модальное окно комментария;
- отправку `sendSelection`;
- `Escape` для отмены активного picker.

## Impact analysis / риск

Перед планированием GitNexus index был stale; выполнено:

```bash
npx gitnexus analyze
```

Затем выполнен upstream impact analysis:

- `Function:src/chrome/selectionOverlay.ts:createSelectionOverlay` — risk LOW, direct caller/test: `src/chrome/selectionOverlay.test.ts`.
- `startDomPicker` — risk LOW, affected: `src/chrome/contentScript.ts`, `src/chrome/contentScript.test.ts`.
- `findBestVisibleChild` — risk CRITICAL, affected processes: `onNarrow`, `onWiden`, `onUp`, `onDown`, `handleMouseMove`, `handleClick`, `handleKeyDown`.
- `findSiblingElements` — risk CRITICAL, affected processes: `onUp`, `onDown`, `handleKeyDown`, `handleMouseMove`, `handleClick`, `onWiden`, `onNarrow`.
- `getParentElement` — risk CRITICAL, affected processes: `onWiden`, `onNarrow`, `onUp`, `onDown`, `handleMouseMove`, `handleClick`, `handleKeyDown`.

CRITICAL риск ожидаемый: эти helper-ы являются ядром удаляемой функциональности уточнения выбора. Реализацию нужно делать как удаление целого flow с тестовой страховкой, а не как точечную правку.

Baseline перед планированием:

```bash
npm test
# PASS: 22 passed
```

---

### Task 1: Зафиксировать новый click-to-comment контракт в content script tests

**TDD scenario:** Modifying tested code — run existing focused tests first, then change tests to describe new behavior.

**Files:**
- Modify: `src/chrome/contentScript.test.ts`
- Test: `src/chrome/contentScript.test.ts`

**Step 1: Run current focused tests**

```bash
npx vitest run src/chrome/contentScript.test.ts
```

Expected: PASS before edits.

**Step 2: Replace panel-first tests with click-to-comment tests**

Update/remove tests that expect panel behavior:

- remove or rewrite `click fixes selection and shows the panel`;
- remove tests around `onChange`, `onNarrow`, `onWiden`, `onUp`, `onDown`;
- remove tests around `ArrowUp` / `ArrowDown` sibling navigation;
- keep tests for startup, hover update, send success/error, diagnostics, cleanup, Escape cancel.

Add/ensure a test with this behavior:

```ts
it("opens the comment modal immediately after clicking the hovered element", async () => {
  // mock createSelectionOverlay with showCommentModal
  // start picker
  // mousemove over #start -> update(#start, false)
  // click #start
  // expect event default prevented and propagation stopped if asserted in current style
  // expect showCommentModal toHaveBeenCalledTimes(1)
  // expect no showPanel API is needed
});
```

Add/ensure send test asserts the exact clicked element is used without `onConfirm`:

```ts
// after click, capture onSubmit from showCommentModal
onSubmit?.("Explain this");
await flushAsyncWork();
expect(buildSelectionPayload).toHaveBeenCalledWith(startEl, "Explain this");
expect(runtimeSendMessage).toHaveBeenCalledWith({
  type: "sendSelection",
  targetId: "target-123",
  selection: selectionPayload,
});
```

**Step 3: Run to verify expected failure**

```bash
npx vitest run src/chrome/contentScript.test.ts
```

Expected: FAIL because implementation still shows the panel and opens modal only via `onConfirm`.

**Step 4: Commit test contract**

```bash
git add src/chrome/contentScript.test.ts
git commit -m "test: require comment modal immediately after DOM click"
```

---

### Task 2: Упростить `selectionOverlay` до Crosshair + comment modal

**TDD scenario:** Modifying tested code — remove tests for deleted UI, keep tests for retained UI.

**Files:**
- Modify: `src/chrome/selectionOverlay.ts`
- Modify: `src/chrome/selectionOverlay.test.ts`
- Test: `src/chrome/selectionOverlay.test.ts`

**Step 1: Run current overlay tests**

```bash
npx vitest run src/chrome/selectionOverlay.test.ts
```

Expected: PASS before edits.

**Step 2: Update public types in `selectionOverlay.ts`**

Change `SelectionOverlayControls` to only expose retained controls:

```ts
export type SelectionOverlayControls = {
  update(target: Element, selected?: boolean): void;
  updatePointer(x: number, y: number): void;
  showCommentModal(options: {
    onSubmit(comment: string): void;
    onCancel(): void;
  }): CommentModalControls;
  cleanup(): void;
};
```

Change `createSelectionOverlay` signature to need no adjustment callbacks:

```ts
export function createSelectionOverlay(): SelectionOverlayControls {
```

Remove from implementation:

- `panel`, `title`, `description`, `actions` for `Выбор блока`;
- buttons `narrowButton`, `widenButton`, `changeButton`, `confirmButton`, `cancelButton`, `upButton`, `downButton`;
- `applyOverlayStyles` parameters and style code for panel/title/description;
- `showPanel()`, `hidePanel()`, `setNavigationState()`;
- callback type `{ onNarrow, onWiden, onChange, onConfirm, onCancel, onUp, onDown }`.

Keep:

- root `#pi-dom-picker-overlay-root` with `data-pi-picker-ui="true"` and `pointerEvents = "none"`;
- `createCrosshairHighlighter({ animate: false })`;
- `showCommentModal` implementation;
- `isPickerUiElement`.

**Step 3: Update overlay tests**

Keep/rewrite tests for:

- managed Crosshair selection frame exists and cleanup removes it;
- comment modal Russian labels and light olive theme;
- `update(target, true)` marks Crosshair as selected;
- `isPickerUiElement` still recognizes overlay/modal UI, if currently covered or worth adding.

Delete tests that assert:

- `Выбор блока` panel labels;
- `Меньше`, `Крупнее`, `Вверх`, `Вниз`, `Изменить`, `Pi` in panel;
- panel hidden/shown behavior;
- 2-column action grid/divider/full-width confirm;
- `setNavigationState` enable/disable behavior;
- `onUp`/`onDown` button callbacks.

**Step 4: Run focused tests**

```bash
npx vitest run src/chrome/selectionOverlay.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/selectionOverlay.ts src/chrome/selectionOverlay.test.ts
git commit -m "refactor: remove DOM picker adjustment panel"
```

---

### Task 3: Переписать `contentScript.ts` на immediate comment modal

**TDD scenario:** Implement minimal code to pass Task 1 tests.

**Files:**
- Modify: `src/chrome/contentScript.ts`
- Modify: `src/chrome/contentScript.test.ts`
- Test: `src/chrome/contentScript.test.ts`

**Step 1: Simplify imports**

Change import from `./domPicker` to only use payload builder:

```ts
import { buildSelectionPayload } from "./domPicker";
```

Remove imports:

- `findBestVisibleChild`;
- `findSiblingElements`;
- `getParentElement`.

**Step 2: Simplify session state**

Inside `startDomPicker` keep:

```ts
let isActive = true;
let modalOpen = false;
let currentSelection: Element | undefined;
```

Remove:

```ts
let state: "hover" | "selected" = "hover";
```

Use:

```ts
const overlay = createSelectionOverlay();
```

**Step 3: Extract/open comment modal for current element**

Create local helper, reusing existing send logic from old `onConfirm`:

```ts
function openCommentModal(logicalSelection: Element): void {
  if (!isActive || modalOpen) return;

  modalOpen = true;
  overlay.update(logicalSelection, true);

  overlay.showCommentModal({
    onCancel: () => {
      cleanup();
    },
    onSubmit: (comment) => {
      modalOpen = false;
      void (async () => {
        try {
          const activeTargetId = pickerWindow[PICKER_SESSION_KEY]?.targetId;
          if (!activeTargetId) {
            throw new Error("No selected target configured for picker session");
          }

          const selection = buildSelectionPayload(logicalSelection, comment);
          const response = (await chrome.runtime.sendMessage({
            type: "sendSelection",
            targetId: activeTargetId,
            selection,
          })) as SendSelectionResponse;

          if (response?.ok) {
            showToast(SEND_SELECTION_SUCCESS_TOAST_MESSAGE, "success");
          } else {
            const rawErrorMessage = response?.error ?? "Unable to send selection to Pi.";
            showToast(formatSendSelectionErrorToastMessage(rawErrorMessage), "error");
            await reportPickerFailure("sendSelection", rawErrorMessage);
          }
        } catch (error) {
          showToast(formatSendSelectionErrorToastMessage(error), "error");
          await reportPickerFailure("sendSelection", error);
        } finally {
          cleanup();
        }
      })();
    },
  });
}
```

Do not introduce new user-facing English strings except existing internal diagnostics.

**Step 4: Simplify selection updates**

Replace `updateCurrentSelection`, `applySelection`, sibling helpers, and parent/child navigation with:

```ts
function applySelection(target: Element, selected = false): void {
  currentSelection = target;
  overlay.update(target, selected);
}
```

**Step 5: Change click behavior**

Update `handleClick`:

```ts
const handleClick = (event: MouseEvent) => {
  if (!isActive || modalOpen) return;
  const target = event.target instanceof Element ? event.target : currentSelection;
  if (!target || isPickerUiElement(target)) return;

  event.preventDefault();
  event.stopPropagation();

  applySelection(target, true);
  openCommentModal(target);
};
```

**Step 6: Simplify keyboard behavior**

Keep only Escape cancel:

```ts
const handleKeyDown = (event: KeyboardEvent) => {
  if (!isActive) return;

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cleanup();
  }
};
```

Remove ArrowUp/ArrowDown navigation.

**Step 7: Run focused tests**

```bash
npx vitest run src/chrome/contentScript.test.ts
```

Expected: PASS after test updates and implementation.

**Step 8: Commit**

```bash
git add src/chrome/contentScript.ts src/chrome/contentScript.test.ts
git commit -m "feat: open comment modal immediately after DOM click"
```

---

### Task 4: Удалить неиспользуемые DOM navigation helper-ы и тесты

**TDD scenario:** Dead-code deletion with typecheck/test verification.

**Files:**
- Modify: `src/chrome/domPicker.ts`
- Modify: `src/chrome/domPicker.test.ts`
- Test: `src/chrome/domPicker.test.ts`

**Step 1: Confirm references are gone**

```bash
rg -n "findBestVisibleChild|getParentElement|findSiblingElements|SiblingNavigation|scoreElement|isElementVisible" src/chrome
```

Expected before this task: remaining references should be in `domPicker.ts` and `domPicker.test.ts` only.

**Step 2: Remove navigation exports from `domPicker.ts`**

Delete:

- `export type SiblingNavigation`;
- scoring constants/functions used only by removed child selection:
  - `HIGH_PRIORITY_TAG_SCORES`;
  - `SEMANTIC_TAG_SCORES`;
  - `WEB_APP_CONTAINER_SCORES`;
  - `INLINE_TAG_PENALTIES`;
  - `MEANINGFUL_ARIA_ROLE_SCORES`;
  - `getTextLengthScore`, `getMeaningfulRoleScore`, `getViewportCoveragePenalty`, `getRectScore`, `getTextDensityScore`, `getWrapperPenalty`, `getContainerComplexityPenalty`, `scoreElement`;
- `isElementVisible`;
- `findBestVisibleChild`;
- `getParentElement`;
- `findSiblingElements`.

Keep:

- `normalizeWhitespace`;
- `getElementText`;
- `escapeIdentifier`;
- `createCssSelector`;
- `buildSelectionPayload`.

**Step 3: Remove navigation tests from `domPicker.test.ts`**

Delete imports and describes for:

- `findSiblingElements`;
- `findBestVisibleChild`;
- `getParentElement`.

Keep tests for:

- `createCssSelector`;
- `buildSelectionPayload`;
- truncation.

**Step 4: Run focused tests**

```bash
npx vitest run src/chrome/domPicker.test.ts
```

Expected: PASS.

**Step 5: Verify no deleted UI strings remain in source tests**

```bash
rg -n "Крупнее|Меньше|Вверх|Вниз|Изменить|Выбор блока|picker-(narrow|widen|up|down|change|panel)|showPanel|hidePanel|setNavigationState|onNarrow|onWiden|onChange|onUp|onDown|ArrowUp|ArrowDown|findBestVisibleChild|getParentElement|findSiblingElements" src/chrome
```

Expected: no matches, except if a deliberate changelog/docs mention is added outside `src/chrome`.

**Step 6: Commit**

```bash
git add src/chrome/domPicker.ts src/chrome/domPicker.test.ts
git commit -m "refactor: delete unused DOM picker navigation helpers"
```

---

### Task 5: Build, generated Chrome dist, and full verification

**TDD scenario:** Integration verification after behavior change.

**Files:**
- Modify generated if build changes them: `dist/chrome/contentScript.js`
- Possibly generated unchanged: other `dist/chrome/*`

**Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

**Step 2: Full test suite**

```bash
npm test
```

Expected: PASS.

**Step 3: Chrome extension build**

```bash
npm run build:chrome
```

Expected: PASS and generated `dist/chrome/contentScript.js` no longer contains removed panel strings/buttons.

**Step 4: Verify generated output**

```bash
rg -n "Крупнее|Меньше|Вверх|Вниз|Изменить|Выбор блока|picker-(narrow|widen|up|down|change|panel)|ArrowUp|ArrowDown" dist/chrome src/chrome
```

Expected: no matches.

**Step 5: GitNexus changed-scope check**

Project rule requires this before commit/finish:

```bash
npx gitnexus detect-changes --repo Pi-Chrome-Assistent
```

Expected: affected symbols are limited to Chrome content script/overlay/domPicker tests and generated dist. If tool reports unexpected Pi/broker/shared protocol impact, stop and investigate.

**Step 6: Commit generated output and verification result**

```bash
git add dist/chrome/contentScript.js
git commit -m "build: update chrome content script bundle"
```

If build updates additional dist files, review diff first and include only expected generated files.

---

## Manual QA checklist

В GUI окружении проверить вручную:

1. Открыть страницу с несколькими вложенными блоками.
2. Запустить DOM picker из Chrome extension popup.
3. Навести курсор на блок: Crosshair следует за наведением.
4. Кликнуть по блоку: панель `Выбор блока` не появляется.
5. Сразу появляется модалка `Отправить в Pi` с textarea комментария.
6. Ввести комментарий и отправить: появляется toast `Отправлено в Pi`, в Pi приходит выбранный DOM-фрагмент.
7. Повторить с пустым комментарием.
8. Нажать `Escape` до клика: picker закрывается.
9. Нажать `Отмена` в модалке: picker закрывается, отправки нет.

## Definition of Done

- В `src/chrome` и `dist/chrome` нет строк/селекторов удалённой панели: `Крупнее`, `Меньше`, `Вверх`, `Вниз`, `Изменить`, `Выбор блока`, `picker-narrow`, `picker-widen`, `picker-up`, `picker-down`, `picker-change`, `picker-panel`.
- После клика по DOM-элементу модалка комментария открывается сразу.
- `buildSelectionPayload` вызывается для кликнутого элемента.
- Удалены tests, которые закрепляли старую панель и navigation flow.
- `npm run typecheck`, `npm test`, `npm run build:chrome` проходят.
- `npx gitnexus detect-changes --repo Pi-Chrome-Assistent` выполнен и не показывает неожиданный scope.
