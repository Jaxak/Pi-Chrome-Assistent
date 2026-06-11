# DOM Picker: Клик-фиксация выбора — Implementation Plan

> **Дизайн:** `docs/plans/2026-06-11-dom-picker-click-selection-design.md`
> **Ветка:** `feat/dom-picker-precision-and-olive-theme`

## Перед началом

- Рабочая ветка: `feat/dom-picker-precision-and-olive-theme`
- Прогнать baseline: `npm test && npm run typecheck`

---

## Task 1: selectionOverlay — скрытая панель по умолчанию + кнопка «Изменить» + border 1px/2px

**Файлы:**
- Modify: `src/chrome/selectionOverlay.ts`
- Modify: `src/chrome/selectionOverlay.test.ts`
- Test: `src/chrome/selectionOverlay.test.ts`

### Step 1: Baseline

```bash
npx vitest run src/chrome/selectionOverlay.test.ts
```
Expected: PASS.

### Step 2: Failing-тесты

Добавить в `src/chrome/selectionOverlay.test.ts`:

```ts
it("hides the panel by default", () => {
  const overlay = createSelectionOverlay({...});
  const panel = document.querySelector("#pi-dom-picker-overlay-root > div:nth-child(2)"); // panel после highlightBox
  expect(panel?.style.display).toBe("none");
  overlay.cleanup();
});

it("shows the panel when showPanel is called", () => {
  const overlay = createSelectionOverlay({...});
  overlay.showPanel();
  const panel = ...;
  expect(panel?.style.display).not.toBe("none");
  overlay.cleanup();
});

it("hides the panel when hidePanel is called", () => {
  const overlay = createSelectionOverlay({...});
  overlay.showPanel();
  overlay.hidePanel();
  const panel = ...;
  expect(panel?.style.display).toBe("none");
  overlay.cleanup();
});

it("renders the change button", () => {
  const overlay = createSelectionOverlay({...});
  expect(document.body.textContent).toContain("Изменить");
  const changeBtn = document.querySelector('[data-testid="picker-change"]');
  expect(changeBtn).toBeInstanceOf(HTMLButtonElement);
  overlay.cleanup();
});

it("renders 4 buttons in a row", () => {
  const overlay = createSelectionOverlay({...});
  const actions = document.querySelector("#pi-dom-picker-overlay-root > div:nth-child(2) > div");
  expect(actions?.style.gridTemplateColumns).toContain("4");
  overlay.cleanup();
});

it("uses 1px border by default and 2px when selected", () => {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const overlay = createSelectionOverlay({...});
  overlay.update(div);
  expect(highlightBox.style.borderWidth).toBe("1px");
  overlay.update(div, true);
  expect(highlightBox.style.borderWidth).toBe("2px");
  overlay.cleanup();
});
```

### Step 3: Реализация

**`selectionOverlay.ts`:**

1. `panel.style.display = "none"` в `applyOverlayStyles`
2. `highlightBox.style.border = "1px solid #6f7f3a"` по умолчанию
3. `update(target, selected?)`:
   - если `selected` — `box.style.border = "2px solid #6f7f3a"`
   - иначе — `box.style.border = "1px solid #6f7f3a"`
4. `showPanel()`: `panel.style.display = "grid"`
5. `hidePanel()`: `panel.style.display = "none"`
6. Добавить кнопку «Изменить» с `data-testid="picker-change"` и callback `onChange`
7. `actions.style.gridTemplateColumns = "repeat(4, minmax(0, 1fr))"`
8. Обновить тип:

```ts
export type SelectionOverlayControls = {
  update(target: Element, selected?: boolean): void;
  showPanel(): void;
  hidePanel(): void;
  setNavigationState(state: { canNarrow: boolean; canWiden: boolean }): void;
  showCommentModal(options: { ... }): CommentModalControls;
  cleanup(): void;
};
```

### Step 4: Тесты

```bash
npx vitest run src/chrome/selectionOverlay.test.ts
```
Expected: PASS.

### Step 5: Commit

```bash
git add src/chrome/selectionOverlay.ts src/chrome/selectionOverlay.test.ts
git commit -m "feat: hide picker panel until selection + add change button"
```

---

## Task 2: contentScript — клик-фиксация + режим hover/selected

**Файлы:**
- Modify: `src/chrome/contentScript.ts`
- Modify: `src/chrome/contentScript.test.ts`
- Test: `src/chrome/contentScript.test.ts`

### Step 1: Baseline

```bash
npx vitest run src/chrome/contentScript.test.ts
```
Expected: PASS.

### Step 2: Failing-тесты

Добавить в `src/chrome/contentScript.test.ts`:

**Тест 1 — клик фиксирует выбор:**
```ts
it("clicks fix selection and show the panel", async () => {
  // Мокировать overlay с showPanel/hidePanel
  // Запустить picker, сделать mousemove, затем click
  // Убедиться: showPanel вызван, update вызван с selected=true
});
```

**Тест 2 — mousemove игнорируется после фиксации:**
```ts
it("ignores mousemove after click selection", async () => {
  // Запустить picker, mousemove + click (фиксация)
  // Ещё один mousemove на другой элемент
  // Убедиться: update не вызван после click
});
```

**Тест 3 — onChange возвращает в hover:**
```ts
it("change button returns to hover mode", async () => {
  // Запустить picker, fix selection
  // Вызвать onChange callback
  // Убедиться: hidePanel вызван, mousemove снова работает
});
```

**Тест 4 — narrow/widen работают с фиксацией:**
```ts
it("narrow and widen work after selection", async () => {
  // Запустить picker, fix selection
  // Вызвать onNarrow / onWiden
  // Убедиться: update вызван с новым элементом
});
```

### Step 3: Реализация

**`contentScript.ts`:**

1. Добавить state: `let state: 'hover' | 'selected' = 'hover';`
2. Добавить `click` handler (capture phase):
   ```ts
   const handleClick = (event: MouseEvent) => {
     if (state !== 'hover' || !isActive || modalOpen) return;
     const target = event.target instanceof Element ? event.target : null;
     if (!target || isPickerUiElement(target)) return;
     
     state = 'selected';
     applyCandidates(target);  // перестраивает кандидатов
     overlay.update(getCurrentSelection(), true);
     overlay.showPanel();
   };
   ```
3. `handleMouseMove` — добавить guard `if (state !== 'hover') return;`
4. `onNarrow`/`onWiden` — добавить guard `if (state !== 'selected') return;` (кнопки только в режиме selected)
5. `onChange` (новый callback):
   ```ts
   onChange: () => {
     if (!isActive) return;
     state = 'hover';
     overlay.hidePanel();
     // Обновить рамку на 1px для текущего элемента
     const current = getCurrentSelection();
     if (current) overlay.update(current, false);
   }
   ```
6. `onCancel` (в модалке) — должен cleanup целиком (уже так работает)
7. `cleanup` — добавить `document.removeEventListener("click", handleClick, true)`

### Step 4: Тесты

```bash
npx vitest run src/chrome/contentScript.test.ts
```
Expected: PASS.

### Step 5: Commit

```bash
git add src/chrome/contentScript.ts src/chrome/contentScript.test.ts
git commit -m "feat: click to fix selection with hover/selected modes"
```

---

## Task 3: Полная верификация

**Файлы:** все затронутые

### Step 1: Полный прогон

```bash
npm test
npm run typecheck
npm run build:chrome
```
Expected: все PASS.

### Step 2: Commit

```bash
git add -A
git commit -m "test: verify click-selection implementation"
```
(если нет изменений, пропустить)
