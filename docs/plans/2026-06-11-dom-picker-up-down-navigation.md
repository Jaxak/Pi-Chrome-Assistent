# Навигация Вверх/Вниз в DOM Picker Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Реализовать кнопки «Вверх»/«Вниз» в панели выбора элемента, чтобы переключаться между соседними (siblings) элементами на том же уровне вложенности.

**Architecture:** Добавим функцию `findSiblingElements` в `domPicker.ts`, которая находит видимых siblings текущего элемента. В `contentScript.ts` добавим состояние для siblings навигации и обработчики `onUp`/`onDown`. В `selectionOverlay.ts` добавим callbacks и обновим `setNavigationState` для управления disabled состоянием кнопок.

**Tech Stack:** TypeScript, Chrome Extension Manifest V3, Vitest + jsdom

---

### Task 1: Добавить функцию `findSiblingElements` в domPicker.ts (TDD)

**TDD scenario:** Новая функция — полный TDD цикл.

**Files:**
- Modify: `src/chrome/domPicker.ts`
- Test: `src/chrome/domPicker.test.ts`

**Step 1: Написать тесты для `findSiblingElements`**

В `src/chrome/domPicker.test.ts` добавить новый `describe("findSiblingElements", ...)`:

```ts
describe("findSiblingElements", () => {
  it("returns visible siblings in DOM order with previous first", () => {
    document.body.innerHTML = `
      <div id="container">
        <div id="s1">First</div>
        <div id="s2">Second</div>
        <div id="target">Target</div>
        <div id="s3">Fourth</div>
        <div id="s4">Fifth</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    expect(result.elements.map(e => e.id)).toEqual(["s2", "s1", "s3", "s4"]);
    expect(result.currentIndex).toBe(0); // first previous sibling
  });

  it("returns empty array when no siblings exist", () => {
    document.body.innerHTML = `
      <div id="only">Only child</div>
    `;
    const target = document.querySelector("#only")!;
    const result = findSiblingElements(target);
    expect(result.elements).toEqual([]);
  });

  it("skips hidden elements (display:none or zero dimensions)", () => {
    document.body.innerHTML = `
      <div>
        <div id="visible1">Visible</div>
        <div id="hidden" style="display:none">Hidden</div>
        <div id="target">Target</div>
        <div id="visible2">Also visible</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    expect(result.elements.map(e => e.id)).toEqual(["visible1", "visible2"]);
    expect(result.elements.every(e => e.id !== "hidden")).toBe(true);
  });

  it("prefers previous sibling as initial selection when going up", () => {
    document.body.innerHTML = `
      <div>
        <div id="prev">Previous</div>
        <div id="target">Target</div>
        <div id="next">Next</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    // First element should be the previous sibling (for "up" direction)
    expect(result.elements[0]?.id).toBe("prev");
  });

  it("orders siblings: previous first (closest to farthest), then next (closest to farthest)", () => {
    document.body.innerHTML = `
      <div>
        <div id="a">A</div>
        <div id="b">B</div>
        <div id="target">Target</div>
        <div id="c">C</div>
        <div id="d">D</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    expect(result.elements.map(e => e.id)).toEqual(["b", "a", "c", "d"]);
  });
});
```

**Step 2: Запустить тесты — должны упасть**

```bash
npx vitest run src/chrome/domPicker.test.ts -t "findSiblingElements"
```

Ожидаемо: FAIL — `findSiblingElements` не определён.

**Step 3: Реализовать `findSiblingElements`**

В `src/chrome/domPicker.ts` добавить новый тип и функцию:

```ts
export type SiblingNavigation = {
  elements: Element[];
  currentIndex: number;
};

function isElementVisible(element: Element): boolean {
  if (element.offsetWidth === 0 && element.offsetHeight === 0) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  return true;
}

export function findSiblingElements(target: Element): SiblingNavigation {
  const parent = target.parentElement;
  if (!parent) {
    return { elements: [], currentIndex: 0 };
  }

  const allSiblings = Array.from(parent.children);
  const targetIndex = allSiblings.indexOf(target);
  if (targetIndex === -1) {
    return { elements: [], currentIndex: 0 };
  }

  // Filter to visible, non-target siblings
  const visibleSiblings = allSiblings
    .filter((el, i) => i !== targetIndex && el !== target && isElementVisible(el))
    .map((el) => ({ element: el, domIndex: allSiblings.indexOf(el) }));

  if (visibleSiblings.length === 0) {
    return { elements: [], currentIndex: 0 };
  }

  // Separate previous and next siblings
  const previous = visibleSiblings
    .filter((s) => s.domIndex < targetIndex)
    .sort((a, b) => b.domIndex - a.domIndex) // closest first
    .map((s) => s.element);

  const next = visibleSiblings
    .filter((s) => s.domIndex > targetIndex)
    .sort((a, b) => a.domIndex - b.domIndex) // closest first
    .map((s) => s.element);

  return {
    elements: [...previous, ...next],
    currentIndex: 0, // default to first previous sibling (closest)
  };
}
```

**Step 4: Запустить тесты — должны пройти**

```bash
npx vitest run src/chrome/domPicker.test.ts -t "findSiblingElements"
```

**Step 5: Коммит**

```bash
git add src/chrome/domPicker.ts src/chrome/domPicker.test.ts
git commit -m "feat: add findSiblingElements for visible siblings navigation"
```

---

### Task 2: Обновить selectionOverlay.ts — добавить `onUp`/`onDown` callbacks и навигационное состояние

**TDD scenario:** Модификация тестируемого кода — сначала запустить существующие тесты.

**Files:**
- Modify: `src/chrome/selectionOverlay.ts`
- Test: `src/chrome/selectionOverlay.test.ts`

**Step 1: Запустить существующие тесты**

```bash
npx vitest run src/chrome/selectionOverlay.test.ts
```

Ожидаемо: PASS все существующие тесты.

**Step 2: Обновить тип и интерфейс `createSelectionOverlay`**

В `selectionOverlay.ts`:

2a. Обновить тип `SelectionOverlayControls.setNavigationState`:
```ts
// Было:
setNavigationState(state: { canNarrow: boolean; canWiden: boolean }): void;

// Стало:
setNavigationState(state: { canNarrow: boolean; canWiden: boolean; canGoUp: boolean; canGoDown: boolean }): void;
```

2b. Обновить callbacks в `createSelectionOverlay`:
```ts
export function createSelectionOverlay(callbacks: {
  onNarrow(): void;
  onWiden(): void;
  onChange(): void;
  onConfirm(): void;
  onCancel(): void;
  onUp(): void;
  onDown(): void;
}): SelectionOverlayControls {
```

2c. Заменить заглушки кнопок Вверх/Вниз на рабочие:
```ts
// Row 2: Вверх | Вниз
const upButton = document.createElement("button");
const downButton = document.createElement("button");
upButton.dataset.testid = "picker-up";
upButton.textContent = "Вверх";
upButton.title = "Переключиться на предыдущий блок";
upButton.addEventListener("click", callbacks.onUp);
applyControlButtonStyles(upButton, "secondary");
downButton.dataset.testid = "picker-down";
downButton.textContent = "Вниз";
downButton.title = "Переключиться на следующий блок";
downButton.addEventListener("click", callbacks.onDown);
applyControlButtonStyles(downButton, "secondary");
```

Изначально кнопки disabled — это будет управляться через `setNavigationState`.

2d. Обновить `setNavigationState` для управления всеми 4 кнопками:
```ts
setNavigationState(state) {
  narrowButton.disabled = !state.canNarrow;
  widenButton.disabled = !state.canWiden;
  upButton.disabled = !state.canGoUp;
  downButton.disabled = !state.canGoDown;
  narrowButton.setAttribute("aria-disabled", String(!state.canNarrow));
  widenButton.setAttribute("aria-disabled", String(!state.canWiden));
  upButton.setAttribute("aria-disabled", String(!state.canGoUp));
  downButton.setAttribute("aria-disabled", String(!state.canGoDown));
},
```

**Step 3: Обновить тесты**

В `selectionOverlay.test.ts`:
- Обновить все вызовы `createSelectionOverlay` чтобы включить `onUp: vi.fn()` и `onDown: vi.fn()`
- Обновить тест `setNavigationState` чтобы проверять canGoUp/canGoDown
- Обновить тест который проверял disabled кнопки Вверх/Вниз — теперь они enabled по умолчанию и управляются через `setNavigationState`

```ts
// Обновлённый тест:
it("enables up/down buttons when navigation state allows", () => {
  const overlay = createSelectionOverlay({
    onNarrow: vi.fn(),
    onWiden: vi.fn(),
    onChange: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onUp: vi.fn(),
    onDown: vi.fn(),
  });

  // Initially disabled (default state)
  let upButton = document.querySelector('[data-testid="picker-up"]') as HTMLButtonElement;
  let downButton = document.querySelector('[data-testid="picker-down"]') as HTMLButtonElement;
  expect(upButton.disabled).toBe(true);
  expect(downButton.disabled).toBe(true);

  overlay.setNavigationState({ canNarrow: true, canWiden: true, canGoUp: true, canGoDown: true });
  expect(upButton.disabled).toBe(false);
  expect(downButton.disabled).toBe(false);

  overlay.setNavigationState({ canNarrow: true, canWiden: true, canGoUp: false, canGoDown: false });
  expect(upButton.disabled).toBe(true);
  expect(downButton.disabled).toBe(true);

  overlay.cleanup();
});

it("calls onUp and onDown callbacks when buttons are clicked", () => {
  const onUp = vi.fn();
  const onDown = vi.fn();
  const overlay = createSelectionOverlay({
    onNarrow: vi.fn(),
    onWiden: vi.fn(),
    onChange: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onUp,
    onDown,
  });

  overlay.setNavigationState({ canNarrow: true, canWiden: true, canGoUp: true, canGoDown: true });

  const upButton = document.querySelector('[data-testid="picker-up"]') as HTMLButtonElement;
  const downButton = document.querySelector('[data-testid="picker-down"]') as HTMLButtonElement;

  upButton.click();
  expect(onUp).toHaveBeenCalledTimes(1);

  downButton.click();
  expect(onDown).toHaveBeenCalledTimes(1);

  overlay.cleanup();
});
```

Также нужно обновить тест `"disables the narrow button at the smallest candidate"` чтобы включал canGoUp/canGoDown.

**Step 4: Запустить тесты**

```bash
npx vitest run src/chrome/selectionOverlay.test.ts
```

**Step 5: Коммит**

```bash
git add src/chrome/selectionOverlay.ts src/chrome/selectionOverlay.test.ts
git commit -m "feat: wire up up/down buttons in selection overlay with callbacks"
```

---

### Task 3: Добавить логику siblings-навигации в contentScript.ts

**TDD scenario:** Модификация тестируемого кода.

**Files:**
- Modify: `src/chrome/contentScript.ts`
- Test: `src/chrome/contentScript.test.ts`

**Step 1: Запустить существующие тесты**

```bash
npx vitest run src/chrome/contentScript.test.ts
```

**Step 2: Добавить siblings-навигацию в `startDomPicker`**

В `contentScript.ts` в функции `startDomPicker`:

2a. Добавить import:
```ts
import { buildSelectionPayload, findSiblingElements, getSelectionCandidates } from "./domPicker";
```

2b. Добавить состояние для siblings:
```ts
let siblingElements: Element[] = [];
let siblingIndex = -1;
```

2c. Добавить функцию для синхронизации siblings с текущим выбором:
```ts
function syncSiblingsForCurrentSelection(): void {
  const current = getCurrentSelection();
  if (!current) {
    siblingElements = [];
    siblingIndex = -1;
    return;
  }
  const siblings = findSiblingElements(current);
  siblingElements = siblings.elements;
  siblingIndex = siblings.elements.length > 0 ? 0 : -1;
}
```

2d. Вызывать `syncSiblingsForCurrentSelection()` в `updateCurrentSelection()` после обновления overlay.

2e. Обновить `setNavigationState` вызов чтобы включать canGoUp/canGoDown:
```ts
overlay.setNavigationState({
  canNarrow: currentIndex > 0,
  canWiden: currentIndex < currentCandidates.length - 1,
  canGoUp: siblingIndex >= 0 && siblingElements.length > 0,
  canGoDown: siblingIndex >= 0 && siblingIndex < siblingElements.length - 1,
});
```

2f. Добавить обработчики `onUp` и `onDown`:

```ts
onUp: () => {
  if (state !== 'selected' || !isActive || modalOpen) return;
  if (siblingIndex <= 0 || siblingElements.length === 0) return;
  
  // "Вверх" = перемещаемся назад по массиву (предыдущий sibling)
  // При первом нажатии: перейти на первый предыдущий sibling
  // При повторном: двигаться дальше назад
  const currentSelection = getCurrentSelection();
  if (!currentSelection) return;
  
  // Если это первое нажатие (siblingIndex === 0, но мы уже проверили <= 0)
  // Значит нужно найти новый sibling выше
  // Логика: нажатие Вверх ищет предыдущего видимого sibling
  // от текущего выбранного элемента
  const freshSiblings = findSiblingElements(currentSelection);
  if (freshSiblings.elements.length === 0) return;
  
  // Заменяем текущего кандидата на выбранный sibling
  const newSelection = freshSiblings.elements[0]; // ближайший предыдущий
  currentCandidates.splice(currentIndex, 1); // убираем старый
  currentCandidates.splice(currentIndex, 0, newSelection); // вставляем новый на то же место
  siblingElements = [];
  siblingIndex = -1;
  
  // После замены синхронизируем siblings для нового элемента
  const newFreshSiblings = findSiblingElements(newSelection);
  siblingElements = newFreshSiblings.elements;
  siblingIndex = newFreshSiblings.elements.length > 0 ? 0 : -1;
  
  updateCurrentSelection();
},
onDown: () => {
  if (state !== 'selected' || !isActive || modalOpen) return;
  
  const currentSelection = getCurrentSelection();
  if (!currentSelection) return;
  
  // "Вниз" = ищем следующего видимого sibling
  const freshSiblings = findSiblingElements(currentSelection);
  if (freshSiblings.elements.length === 0) return;
  
  // Для Вниз берём最后一个 sibling (это ближайший следующий, так как массив: [предыдущие..., следующие...])
  // На самом деле проще: ищем следующего sibling отдельно
  // Но findSiblingElements уже группирует: previous (closest first), then next (closest first)
  // Так что последний элемент массива — это самый дальний next
  // Нам нужен ближайший next — это элемент после всех previous
  
  const allSiblings = Array.from(currentSelection.parentElement?.children ?? []);
  const currentIdx = allSiblings.indexOf(currentSelection);
  
  // Ищем ближайший видимый следующий sibling
  let foundNext: Element | null = null;
  for (let i = currentIdx + 1; i < allSiblings.length; i++) {
    const sibling = allSiblings[i];
    if (sibling !== currentSelection && isElementVisibleForPicker(sibling)) {
      foundNext = sibling;
      break;
    }
  }
  if (!foundNext) return;
  
  currentCandidates.splice(currentIndex, 1);
  currentCandidates.splice(currentIndex, 0, foundNext);
  
  const newFreshSiblings = findSiblingElements(foundNext);
  siblingElements = newFreshSiblings.elements;
  siblingIndex = newFreshSiblings.elements.length > 0 ? 0 : -1;
  
  updateCurrentSelection();
},
```

2g. Добавить вспомогательную функцию (export из domPicker или inline):

```ts
function isElementVisibleForPicker(element: Element): boolean {
  if (element.offsetWidth === 0 && element.offsetHeight === 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}
```

**Step 3: Запустить тесты**

```bash
npx vitest run src/chrome/contentScript.test.ts
```

**Step 4: Коммит**

```bash
git add src/chrome/contentScript.ts
git commit -m "feat: implement up/down sibling navigation in content script"
```

---

### Task 4: Добавить клавиатурные сокращения и регрессионную проверку

**TDD scenario:** Добавление нового поведения + регрессионная проверка.

**Files:**
- Modify: `src/chrome/contentScript.ts`
- Test: Все тестовые файлы

**Step 1: Добавить keyboard shortcuts в `handleKeyDown`**

В `handleKeyDown` добавить:
```ts
if (state === 'selected' && event.key === "ArrowUp") {
  event.preventDefault();
  event.stopPropagation();
  // Триггерим onUp логику
  // ... (дублируем логику onUp или выносим в отдельную функцию)
}

if (state === 'selected' && event.key === "ArrowDown") {
  event.preventDefault();
  event.stopPropagation();
  // Триггерим onDown логику
}
```

Для чистоты кода, вынести логику up/down в отдельные функции `navigateUp()` и `navigateDown()`, которые вызываются и из overlay callbacks и из keyboard handler.

**Step 2: Запустить все тесты**

```bash
npm test
```

Ожидаемо: PASS все 208+ тестов.

**Step 3: Коммит**

```bash
git add src/chrome/contentScript.ts src/chrome/contentScript.test.ts
git commit -m "feat: add keyboard shortcuts ArrowUp/ArrowDown for sibling navigation"
```

---

## Summary

| # | Task | Files | Key Changes |
|---|------|-------|-------------|
| 1 | `findSiblingElements` | `domPicker.ts`, `domPicker.test.ts` | Алгоритм поиска видимых siblings с упорядочиванием |
| 2 | UI callbacks | `selectionOverlay.ts`, `selectionOverlay.test.ts` | `onUp`/`onDown` в overlay, обновление `setNavigationState` |
| 3 | Picker логика | `contentScript.ts` | Интеграция siblings в picker session |
| 4 | Keyboard + регрессия | `contentScript.ts` | ArrowUp/ArrowDown, вынос функций, регрессионный прогон |
