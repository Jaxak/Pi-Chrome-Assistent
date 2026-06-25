# Переписывание DOM picker на Crosshair Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Полностью заменить самописный механизм визуального выделения DOM-элементов в content script на адаптированный `crosshair.js`, сохранив отправку выбранного фрагмента в Pi.

**Architecture:** `crosshair.js` будет портирован в управляемый модуль content script с явным lifecycle (`updateTarget`, `select`, `reset`, `cleanup`) и без глобальных побочных эффектов после остановки picker. `contentScript.ts` продолжит владеть состоянием сессии, отправкой payload и панелью действий, но визуальная рамка/курсор и вычисление hovered target будут вынесены в Crosshair-адаптер. Функции `buildSelectionPayload`/`createCssSelector` сохраняются, а старые эвристики выбора кандидатов удаляются или минимизируются до fallback-навигации.

**Tech Stack:** TypeScript, Chrome Extension MV3 content scripts, Vite IIFE build, Vitest + jsdom.

---

## Контекст и ограничения

- Текущая ветка: `feature/rewrite-dom-selection-crosshair`.
- Новый исходник размещён как `src/chrome/crosshair.js`, чтобы находиться рядом с content script и попадать в область Chrome extension source. Сейчас он ещё не импортируется и не попадает в сборку до подключения через TypeScript/Vite import graph.
- Текущая логика находится в:
  - `src/chrome/contentScript.ts` — lifecycle DOM picker, hover/click/keyboard, выбранный target, отправка в runtime.
  - `src/chrome/selectionOverlay.ts` — самописная fixed-рамка, панель, модалка комментария.
  - `src/chrome/domPicker.ts` — scoring/candidate chain, payload/selector, parent/child/sibling navigation.
- Базовая проверка перед планированием: `npm test` → `21 passed`.
- GitNexus MCP tools в текущей сессии недоступны; перед реальной правкой символов по правилам проекта нужно выполнить impact analysis доступным GitNexus-инструментом или зафиксировать, что инструмент недоступен.

## Решение верхнего уровня

Адаптировать Crosshair как библиотеку визуального выделения, а не вставлять `crosshair.js` как глобальный скрипт без контроля. Оригинальный файл скрывает курсор для всей страницы, сам навешивает listeners на интерактивные элементы и не имеет cleanup — в extension content script это риск утечек и поломки UX страницы. Поэтому implementation должен:

1. Перенести Crosshair в `src/chrome/crosshairHighlighter.ts` с экспортируемым factory.
2. Добавить cleanup для style/node/listeners/`requestAnimationFrame`.
3. Заменить querySelectorAll-интерактивы на целевой API: content script передает элемент, который нужно подсветить.
4. Оставить весь UI на русском: панель, модалка, toast и ошибки.
5. Сохранить контракт отправки `SelectionPayload` без изменения протокола.

---

### Task 1: Зафиксировать контракт Crosshair highlighter тестами

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/chrome/crosshairHighlighter.ts`
- Create: `src/chrome/crosshairHighlighter.test.ts`

**Step 1: Write the failing test**

Создать тесты, которые описывают минимальный контролируемый контракт:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrosshairHighlighter } from "./crosshairHighlighter";

describe("createCrosshairHighlighter", () => {
  afterEach(() => {
    document.documentElement.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("creates cursor nodes and styles only while active", () => {
    document.body.innerHTML = `<button id="target">Кнопка</button>`;
    const highlighter = createCrosshairHighlighter({ enabled: true });

    expect(document.querySelector("[data-pi-crosshair-root]")).not.toBeNull();
    expect(document.querySelector("style[data-pi-crosshair-style]")).not.toBeNull();

    highlighter.cleanup();

    expect(document.querySelector("[data-pi-crosshair-root]")).toBeNull();
    expect(document.querySelector("style[data-pi-crosshair-style]")).toBeNull();
  });

  it("updates outline target from an element rect", () => {
    document.body.innerHTML = `<article id="target">Текст</article>`;
    const target = document.querySelector("#target") as HTMLElement;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 10,
      left: 20,
      width: 100,
      height: 40,
      right: 120,
      bottom: 50,
      x: 20,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);

    const highlighter = createCrosshairHighlighter({ enabled: true, animate: false });
    highlighter.updateTarget(target, { selected: false });

    const outline = document.querySelector("[data-pi-crosshair-outline]") as HTMLElement;
    expect(outline.style.width).toBe("115px");
    expect(outline.style.height).toBe("50px");

    highlighter.cleanup();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/chrome/crosshairHighlighter.test.ts`
Expected: FAIL because `./crosshairHighlighter` does not exist.

**Step 3: Commit failing test only**

```bash
git add src/chrome/crosshairHighlighter.test.ts
git commit -m "test: define crosshair highlighter contract"
```

---

### Task 2: Портировать `crosshair.js` в управляемый TypeScript-модуль

**TDD scenario:** Implement minimal code to pass Task 1 tests.

**Files:**
- Read: `src/chrome/crosshair.js`
- Modify/Create: `src/chrome/crosshairHighlighter.ts`
- Test: `src/chrome/crosshairHighlighter.test.ts`

**Step 1: Implement factory API**

Создать экспорт:

```ts
export type CrosshairHighlighterControls = {
  updatePointer(x: number, y: number): void;
  updateTarget(target: Element, options?: { selected?: boolean }): void;
  clearTarget(): void;
  cleanup(): void;
};

export function createCrosshairHighlighter(options?: {
  enabled?: boolean;
  animate?: boolean;
  dotSize?: number;
  outlineSpace?: number;
  hoverPadding?: { x: number; y: number };
}): CrosshairHighlighterControls;
```

Implementation notes:

- Использовать `data-pi-crosshair-*` атрибуты вместо классов из оригинала, чтобы `isPickerUiElement` мог игнорировать UI picker.
- Не применять глобальное `* { cursor: none !important; }` без возможности cleanup; стиль должен удаляться.
- Не использовать `querySelectorAll('a, button...')` и `MutationObserver` из оригинала — target задает `contentScript.ts`.
- `requestAnimationFrame` должен отменяться через `cancelAnimationFrame` в `cleanup()`.
- Для `animate: false` применять значения синхронно, чтобы тесты были стабильными.

**Step 2: Run focused tests**

Run: `npx vitest run src/chrome/crosshairHighlighter.test.ts`
Expected: PASS.

**Step 3: Run full suite**

Run: `npm test`
Expected: all tests pass.

**Step 4: Commit**

```bash
git add src/chrome/crosshairHighlighter.ts src/chrome/crosshairHighlighter.test.ts
git commit -m "feat: add managed crosshair highlighter"
```

---

### Task 3: Переподключить overlay к Crosshair вместо fixed highlightBox

**TDD scenario:** Modifying tested code — run existing tests first, then update tests.

**Files:**
- Modify: `src/chrome/selectionOverlay.ts`
- Modify: `src/chrome/selectionOverlay.test.ts`
- Test: `src/chrome/selectionOverlay.test.ts`

**Step 1: Run existing overlay tests**

Run: `npx vitest run src/chrome/selectionOverlay.test.ts`
Expected: PASS before changes.

**Step 2: Update tests**

Изменить тесты так, чтобы они больше не ожидали старый `highlightBox`, а проверяли:

- overlay root/panel/modal остаются с `data-pi-picker-ui`;
- `update(target, selected)` вызывает Crosshair highlighter или меняет DOM-ноды Crosshair;
- `cleanup()` удаляет панель и Crosshair-ноды.

**Step 3: Modify `createSelectionOverlay`**

- Убрать создание `highlightBox` из `container.append(...)`.
- Внутри `createSelectionOverlay` создать `const highlighter = createCrosshairHighlighter({ enabled: true });`.
- В `update(target, selected)` вызывать `highlighter.updateTarget(target, { selected })`.
- В `cleanup()` вызвать `highlighter.cleanup()` до/после удаления container.
- Сохранить русские тексты панели без изменений.

**Step 4: Run focused tests**

Run: `npx vitest run src/chrome/selectionOverlay.test.ts src/chrome/crosshairHighlighter.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/selectionOverlay.ts src/chrome/selectionOverlay.test.ts
git commit -m "refactor: render picker selection with crosshair"
```

---

### Task 4: Упростить hover/selection в content script под Crosshair

**TDD scenario:** Modifying tested code — update content script tests around hover/click behavior.

**Files:**
- Modify: `src/chrome/contentScript.ts`
- Modify: `src/chrome/contentScript.test.ts`
- Possibly Modify: `src/chrome/domPicker.ts`
- Test: `src/chrome/contentScript.test.ts`, `src/chrome/domPicker.test.ts`

**Step 1: Run current tests**

Run: `npx vitest run src/chrome/contentScript.test.ts src/chrome/domPicker.test.ts`
Expected: PASS.

**Step 2: Decide retained navigation scope**

Recommended for first implementation:

- Hover selects the exact DOM element under cursor, excluding picker UI.
- Click fixes the current element and opens the existing action panel.
- `Крупнее` / `Меньше` may stay for parent/best-child navigation using existing `getParentElement` and `findBestVisibleChild`.
- `Вверх` / `Вниз` may stay using existing sibling navigation.
- Remove dependency on `getSelectionCandidates` scoring for the initial hovered element, because Crosshair is now the source of visual selection.

**Step 3: Update tests**

Add/adjust tests:

```ts
it("highlights the exact hovered element before click", async () => {
  // mock createSelectionOverlay.update
  // dispatch mousemove on #start
  // expect update to be called with #start, false
});

it("click fixes the exact current element and sends that payload", async () => {
  // hover/click #start
  // confirm + submit
  // expect buildSelectionPayload(#start, comment)
});
```

Update older tests that asserted recommended candidate (`innerEl`) to expect direct hovered target or move those cases to navigation-specific tests.

**Step 4: Modify implementation**

In `contentScript.ts`:

- Replace `applyCandidates(hovered)` for hover with `currentElement = hovered; overlay.update(currentElement, false)`.
- On click, set `state = 'selected'`, persist the clicked/current element, call `overlay.update(currentElement, true)`, then `overlay.showPanel()`.
- Keep `onConfirm` calling `buildSelectionPayload(currentElement, comment)`.
- Ensure every document listener still uses capture phase and ignores `isPickerUiElement`.
- Keep Escape cleanup.

**Step 5: Run focused tests**

Run: `npx vitest run src/chrome/contentScript.test.ts src/chrome/domPicker.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/chrome/contentScript.ts src/chrome/contentScript.test.ts src/chrome/domPicker.ts src/chrome/domPicker.test.ts
git commit -m "refactor: use crosshair-driven DOM selection"
```

---

### Task 5: Удалить или законсервировать старый scoring-код

**TDD scenario:** Refactor with safety net.

**Files:**
- Modify: `src/chrome/domPicker.ts`
- Modify: `src/chrome/domPicker.test.ts`
- Search/Remove imports in: `src/chrome/contentScript.ts`

**Step 1: Identify unused exports**

Run:

```bash
rg -n "getSelectionCandidates|findLogicalSelectionElement|SelectionCandidates|scoreElement|MAX_SELECTION_CANDIDATE_DEPTH" src/chrome
```

Expected: after Task 4, scoring should only be referenced by old tests or `findBestVisibleChild`.

**Step 2: Remove only truly unused code**

- If `findBestVisibleChild` still uses `scoreElement`, keep the private scoring helpers needed for child navigation.
- Remove public exports and tests for `getSelectionCandidates`/`findLogicalSelectionElement` if no production code uses them.
- Keep `buildSelectionPayload`, `createCssSelector`, `findBestVisibleChild`, `getParentElement`, `findSiblingElements`.

**Step 3: Run tests**

Run: `npx vitest run src/chrome/domPicker.test.ts src/chrome/contentScript.test.ts`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/chrome/domPicker.ts src/chrome/domPicker.test.ts src/chrome/contentScript.ts
git commit -m "refactor: remove obsolete picker scoring API"
```

---

### Task 6: Проверить сборку Chrome extension и runtime cleanup

**TDD scenario:** Integration verification.

**Files:**
- Modify only if needed: `scripts/build-chrome.mjs`, `src/chrome/manifest.json`
- Test/Build: package scripts

**Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no TypeScript errors.

**Step 2: Build**

Run: `npm run build`
Expected: `dist/chrome` generated, content script includes Crosshair highlighter code through Vite import graph.

**Step 3: Inspect dist for accidental raw script omission/inclusion**

Run:

```bash
rg -n "data-pi-crosshair|cursorTochka|Crosshair" dist/chrome/contentScript.js
```

Expected: new `data-pi-crosshair` implementation exists; old global `class Crosshair` from `src/chrome/crosshair.js` is not copied blindly unless intentionally imported.

**Step 4: Manual browser smoke test**

Load unpacked extension from `dist/chrome`, then verify:

1. Popup запускает DOM picker на активной вкладке.
2. Курсор/рамка Crosshair двигаются при наведении.
3. Клик фиксирует элемент и показывает панель на русском.
4. `Крупнее`, `Меньше`, `Вверх`, `Вниз` работают или корректно disabled.
5. `Pi` открывает модалку комментария.
6. `Escape` и `Отмена` полностью удаляют cursor/outline/style, курсор страницы восстанавливается.
7. Повторный запуск picker не создает дублированные style/listeners.

**Step 5: Commit fixes if any**

```bash
git add <changed-files>
git commit -m "fix: stabilize crosshair picker build"
```

---

### Task 7: Финальная верификация и контроль изменений

**TDD scenario:** Verification before completion.

**Files:**
- No intentional source edits unless verification finds issues.

**Step 1: Run full verification**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all pass.

**Step 2: Run GitNexus change detection**

По правилам проекта перед завершением выполнить `gitnexus_detect_changes()` или CLI-аналог. Если MCP всё ещё недоступен, зафиксировать это в финальном отчете и выполнить fallback:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

**Step 3: Review affected files**

Expected changed files:

- `src/chrome/crosshairHighlighter.ts`
- `src/chrome/crosshairHighlighter.test.ts`
- `src/chrome/selectionOverlay.ts`
- `src/chrome/selectionOverlay.test.ts`
- `src/chrome/contentScript.ts`
- `src/chrome/contentScript.test.ts`
- `src/chrome/domPicker.ts` / `src/chrome/domPicker.test.ts` only if scoring API removed.
- Possibly docs/changelog if user asks for release note.

**Step 4: Final commit if needed**

```bash
git status --short
git add <final-files>
git commit -m "chore: verify crosshair DOM picker rewrite"
```

---

## Open Questions before implementation

1. Нужно ли выбирать ровно элемент под курсором или всё ещё нужен автоматический “умный” выбор ближайшего смыслового контейнера?
2. Должен ли Crosshair скрывать системный курсор на странице, как в оригинале, или лучше оставить системный курсор видимым для меньшего вмешательства в UX сайта?
3. Нужно ли сохранить кнопки `Крупнее`/`Меньше`/`Вверх`/`Вниз`, или новый механизм должен быть только hover → click → send?
