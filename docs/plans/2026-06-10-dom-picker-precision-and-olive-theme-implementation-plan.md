# DOM picker и светлая оливковая тема UI Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Повысить точность выбора DOM-блоков на сложных web-app страницах, добавить ручную коррекцию «Мельче / Крупнее» и перевести весь UI расширения на светлую тёпло-оливковую тему.

**Architecture:** Логику выбора нужно перевести от одиночного `findLogicalSelectionElement()` к модели цепочки кандидатов с рекомендованным стартовым индексом. `selectionOverlay` станет управляемым UI-слоем с кнопками навигации и подтверждения, а `contentScript` будет координировать hover, изменение текущего кандидата и отправку выделения. Визуальная часть объединяется общей светлой оливковой палитрой для popup, overlay, модалки и toast.

**Tech Stack:** TypeScript, Chrome Extension Manifest V3, Vitest, jsdom, CSS.

---

## Перед началом

- Рабочая ветка уже создана: `feat/dom-picker-precision-and-olive-theme`.
- Дизайн зафиксирован в `docs/plans/2026-06-10-dom-picker-precision-and-olive-theme-design.md`.
- Для общей верификации использовать команды из `docs/operations/testing.md`.
- Пользовательские тексты должны оставаться на русском языке.

## Phase 1 — Логика выбора DOM

### Task 1: Ввести модель цепочки кандидатов для picker

**TDD scenario:** Modifying tested code — run existing tests first.

**Files:**
- Modify: `src/chrome/domPicker.ts`
- Modify: `src/chrome/domPicker.test.ts`
- Test: `src/chrome/domPicker.test.ts`

**Step 1: Запустить текущие тесты picker как baseline**

Run:
```bash
npx vitest run src/chrome/domPicker.test.ts
```
Expected: PASS на текущем наборе тестов.

**Step 2: Добавить failing-тесты на цепочку кандидатов и анти-регрессии для крупных контейнеров**

Add to `src/chrome/domPicker.test.ts` tests такого вида:

```ts
it("returns ordered selection candidates from smaller to larger blocks", () => {
  document.body.innerHTML = `
    <section id="shell">
      <article id="card">
        <h3>Заголовок карточки</h3>
        <p id="start">Осмысленный текст внутри карточки.</p>
      </article>
    </section>
  `;

  const start = document.querySelector("#start") as Element;
  const result = getSelectionCandidates(start);

  expect(result.candidates.map((element) => element.id)).toEqual(["start", "card", "shell"]);
  expect(result.recommendedIndex).toBe(1);
});

it("prefers a compact text block over a large layout wrapper", () => {
  document.body.innerHTML = `
    <div id="app">
      <div id="layout">
        <div id="card">
          <div class="title">Сводка</div>
          <div id="start">Нужный локальный текстовый блок для отправки.</div>
        </div>
      </div>
    </div>
  `;

  const start = document.querySelector("#start") as Element;
  const result = getSelectionCandidates(start);

  expect(result.candidates[result.recommendedIndex]?.id).toBe("card");
  expect(findLogicalSelectionElement(start)).toBe(document.querySelector("#card"));
});
```

**Step 3: Запустить только новые тесты**

Run:
```bash
npx vitest run src/chrome/domPicker.test.ts -t "ordered selection candidates"
npx vitest run src/chrome/domPicker.test.ts -t "compact text block"
```
Expected: FAIL, потому что `getSelectionCandidates()` и новая эвристика ещё не реализованы.

**Step 4: Реализовать минимальную модель кандидатов в `src/chrome/domPicker.ts`**

Introduce API уровня:

```ts
export type SelectionCandidates = {
  candidates: Element[];
  recommendedIndex: number;
};

export function getSelectionCandidates(start: Element): SelectionCandidates {
  const rawChain = collectCandidateChain(start);
  const candidates = dedupeCandidates(rawChain);
  const recommendedIndex = chooseRecommendedCandidateIndex(candidates);
  return { candidates, recommendedIndex };
}

export function findLogicalSelectionElement(start: Element): Element {
  const { candidates, recommendedIndex } = getSelectionCandidates(start);
  return candidates[recommendedIndex] ?? start;
}
```

Implementation notes:
- строить цепочку от стартового элемента вверх до разумного лимита;
- убрать дубли;
- сильнее штрафовать `body/html` и почти полноэкранные контейнеры;
- добавить сигнал за локальный текстовый блок и текстовую плотность;
- сохранить текущую совместимость `buildSelectionPayload()`.

**Step 5: Запустить весь файл тестов picker**

Run:
```bash
npx vitest run src/chrome/domPicker.test.ts
```
Expected: PASS.

**Step 6: Commit**

```bash
git add src/chrome/domPicker.ts src/chrome/domPicker.test.ts
git commit -m "feat: add DOM picker candidate chain"
```

### Task 2: Усилить эвристику для web-app карточек, таблиц и служебных обёрток

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/chrome/domPicker.ts`
- Modify: `src/chrome/domPicker.test.ts`
- Test: `src/chrome/domPicker.test.ts`

**Step 1: Добавить failing-тесты на web-app сценарии**

Add tests вроде:

```ts
it("prefers a table cell or row over the whole table wrapper", () => {
  document.body.innerHTML = `
    <div id="table-shell">
      <table>
        <tbody>
          <tr id="row">
            <td id="cell"><span id="start">Критичный статус</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  const start = document.querySelector("#start") as Element;
  expect(findLogicalSelectionElement(start).id).toBe("cell");
});

it("does not escalate to a giant dashboard wrapper when a card exists", () => {
  document.body.innerHTML = `
    <div id="dashboard">
      <div id="column">
        <section id="card">
          <h2>Платёж</h2>
          <p id="start">Просрочен на 3 дня</p>
        </section>
      </div>
    </div>
  `;

  const start = document.querySelector("#start") as Element;
  expect(findLogicalSelectionElement(start).id).toBe("card");
});
```

**Step 2: Запустить новые тесты**

Run:
```bash
npx vitest run src/chrome/domPicker.test.ts -t "table cell or row"
npx vitest run src/chrome/domPicker.test.ts -t "giant dashboard wrapper"
```
Expected: FAIL.

**Step 3: Минимально доработать scoring**

В `src/chrome/domPicker.ts` добавить/уточнить:

```ts
const WEB_APP_CONTAINER_SCORES: Record<string, number> = {
  td: 70,
  th: 65,
  tr: 40,
  article: 110,
  section: 80,
  li: 35,
};

function getContainerComplexityPenalty(element: Element): number {
  const childCount = element.children.length;
  return childCount > 12 ? -30 : childCount > 6 ? -12 : 0;
}

function getViewportCoveragePenalty(element: Element): number {
  // heavier penalty for large wrappers
}
```

Also ensure:
- карточка/ячейка выигрывает у layout-wrapper;
- пустые `div/span` без текста и без семантики дополнительно штрафуются;
- результат цепочки остаётся стабильным и без дублей.

**Step 4: Запустить весь файл тестов picker**

Run:
```bash
npx vitest run src/chrome/domPicker.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/domPicker.ts src/chrome/domPicker.test.ts
git commit -m "feat: improve DOM picker scoring for web apps"
```

## Phase 2 — Overlay и интеграция content script

### Task 3: Расширить `selectionOverlay` кнопками «Мельче / Крупнее / Отправить / Отмена»

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Modify: `src/chrome/selectionOverlay.ts`
- Modify: `src/chrome/selectionOverlay.test.ts`
- Test: `src/chrome/selectionOverlay.test.ts`

**Step 1: Добавить failing-тесты на control panel и русские тексты**

Add tests вроде:

```ts
it("renders picker controls with Russian labels", () => {
  createSelectionOverlay({
    onNarrow: () => {},
    onWiden: () => {},
    onConfirm: () => {},
    onCancel: () => {},
  });

  expect(document.body.textContent).toContain("Выбор блока");
  expect(document.body.textContent).toContain("Мельче");
  expect(document.body.textContent).toContain("Крупнее");
  expect(document.body.textContent).toContain("Отправить");
  expect(document.body.textContent).toContain("Отмена");
});

it("disables the narrow button at the smallest candidate", () => {
  const overlay = createSelectionOverlay({
    onNarrow: () => {},
    onWiden: () => {},
    onConfirm: () => {},
    onCancel: () => {},
  });

  overlay.setNavigationState({ canNarrow: false, canWiden: true });

  const narrowButton = document.querySelector('[data-testid="picker-narrow"]') as HTMLButtonElement;
  expect(narrowButton.disabled).toBe(true);
});
```

**Step 2: Запустить тесты overlay**

Run:
```bash
npx vitest run src/chrome/selectionOverlay.test.ts
```
Expected: FAIL.

**Step 3: Реализовать новый API overlay**

Refactor `src/chrome/selectionOverlay.ts` к интерфейсу вроде:

```ts
export type SelectionOverlayControls = {
  update(target: Element): void;
  setNavigationState(state: { canNarrow: boolean; canWiden: boolean }): void;
  showCommentModal(options: { onSubmit(comment: string): void; onCancel(): void }): CommentModalControls;
  cleanup(): void;
};

export function createSelectionOverlay(callbacks: {
  onNarrow(): void;
  onWiden(): void;
  onConfirm(): void;
  onCancel(): void;
}): SelectionOverlayControls {
  // render fixed panel with Russian buttons
}
```

Implementation notes:
- control panel держать закреплённым в правом верхнем углу;
- сохранить защиту `data-pi-picker-ui`;
- `Отмена` должна вызывать общий cancel-flow;
- `Отправить` не должно само строить payload, только делегировать confirm callback.

**Step 4: Запустить тесты overlay ещё раз**

Run:
```bash
npx vitest run src/chrome/selectionOverlay.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/selectionOverlay.ts src/chrome/selectionOverlay.test.ts
git commit -m "feat: add DOM picker overlay controls"
```

### Task 4: Подключить цепочку кандидатов и кнопки overlay в `contentScript`

**TDD scenario:** Modifying tested code — run existing tests first, then add new coverage.

**Files:**
- Modify: `src/chrome/contentScript.ts`
- Modify: `src/chrome/contentScript.test.ts`
- Possibly modify: `src/chrome/domPicker.ts`
- Test: `src/chrome/contentScript.test.ts`

**Step 1: Запустить текущий integration-тест content script**

Run:
```bash
npx vitest run src/chrome/contentScript.test.ts
```
Expected: PASS.

**Step 2: Добавить failing-тесты на навигацию между кандидатами и confirm-flow**

Extend `src/chrome/contentScript.test.ts` тестами такого вида:

```ts
it("uses the recommended candidate first and widens selection on overlay request", async () => {
  let overlayCallbacks!: {
    onNarrow(): void;
    onWiden(): void;
    onConfirm(): void;
    onCancel(): void;
  };
  const update = vi.fn();

  vi.doMock("./selectionOverlay", () => ({
    createSelectionOverlay: (callbacks: typeof overlayCallbacks) => {
      overlayCallbacks = callbacks;
      return {
        update,
        setNavigationState: vi.fn(),
        showCommentModal: vi.fn(() => ({ close: vi.fn() })),
        cleanup: vi.fn(),
      };
    },
    isPickerUiElement: () => false,
  }));

  vi.doMock("./domPicker", () => ({
    getSelectionCandidates: vi.fn(() => ({
      candidates: [smallEl, mediumEl, largeEl],
      recommendedIndex: 1,
    })),
    buildSelectionPayload: vi.fn(() => selectionPayload),
    findLogicalSelectionElement: vi.fn(),
  }));

  // start picker, trigger mousemove, call overlayCallbacks.onWiden(), assert update called with largeEl
});
```

Also add test that `onConfirm()` opens modal and sends payload for the **current** candidate, not the original clicked node.

**Step 3: Запустить новые content-script тесты**

Run:
```bash
npx vitest run src/chrome/contentScript.test.ts -t "recommended candidate"
npx vitest run src/chrome/contentScript.test.ts -t "current candidate"
```
Expected: FAIL.

**Step 4: Реализовать минимальную интеграцию в `src/chrome/contentScript.ts`**

Refactor flow примерно так:

```ts
let currentCandidates: Element[] = [];
let currentIndex = 0;

function applyCandidates(hovered: Element): void {
  const result = getSelectionCandidates(hovered);
  currentCandidates = result.candidates;
  currentIndex = result.recommendedIndex;
  overlay.update(currentCandidates[currentIndex] ?? hovered);
  overlay.setNavigationState({
    canNarrow: currentIndex > 0,
    canWiden: currentIndex < currentCandidates.length - 1,
  });
}
```

And wire callbacks:
- `onNarrow()` → `currentIndex -= 1`, `overlay.update(...)`;
- `onWiden()` → `currentIndex += 1`, `overlay.update(...)`;
- `onConfirm()` → открыть `showCommentModal(...)` и отправить payload для `currentCandidates[currentIndex]`;
- `Escape` оставить как общий cancel;
- hover во время открытой модалки игнорировать.

**Step 5: Запустить tests for content script**

Run:
```bash
npx vitest run src/chrome/contentScript.test.ts
```
Expected: PASS.

**Step 6: Commit**

```bash
git add src/chrome/contentScript.ts src/chrome/contentScript.test.ts src/chrome/domPicker.ts
git commit -m "feat: wire candidate navigation into DOM picker"
```

## Phase 3 — Светлая оливковая тема

### Task 5: Перевести popup на светлую тёпло-оливковую палитру

**TDD scenario:** Trivial change — use judgment, but verify no behavior regressions.

**Files:**
- Modify: `src/chrome/popup.css`
- Verify: `src/chrome/popup.html`
- Regression test: `src/chrome/popup.test.ts`

**Step 1: Зафиксировать baseline по popup-логике**

Run:
```bash
npx vitest run src/chrome/popup.test.ts
```
Expected: PASS.

**Step 2: Обновить CSS-токены и состояния в `src/chrome/popup.css`**

Use a palette along these lines:

```css
:root {
  color-scheme: light;
  --bg: #f6f4ea;
  --panel: #fffdf7;
  --panel-alt: #eeefdf;
  --border: #cfd5b8;
  --text: #304127;
  --muted: #66745a;
  --accent: #6f7f3a;
  --accent-strong: #59682f;
  --accent-soft: #dde5c2;
  --danger: #b2564a;
}
```

Update:
- фон страницы и панелей;
- tab buttons;
- status pills;
- primary/secondary/danger buttons;
- focus ring;
- placeholders и output blocks.

Do **not** change popup copy unless needed for consistency.

**Step 3: Повторно прогнать popup tests**

Run:
```bash
npx vitest run src/chrome/popup.test.ts
```
Expected: PASS.

**Step 4: Commit**

```bash
git add src/chrome/popup.css
git commit -m "style: apply light olive popup theme"
```

### Task 6: Перевести overlay, модалку и toast на ту же палитру

**TDD scenario:** New feature — add targeted UI tests where practical.

**Files:**
- Modify: `src/chrome/selectionOverlay.ts`
- Modify: `src/chrome/selectionOverlay.test.ts`
- Modify: `src/chrome/toast.ts`
- Create: `src/chrome/toast.test.ts`
- Test: `src/chrome/selectionOverlay.test.ts`
- Test: `src/chrome/toast.test.ts`

**Step 1: Добавить failing-тесты на новую палитру overlay и toast**

Add tests like:

```ts
it("uses olive highlight colors for the selection frame", () => {
  const overlay = createSelectionOverlay({
    onNarrow: () => {},
    onWiden: () => {},
    onConfirm: () => {},
    onCancel: () => {},
  });

  const highlightBox = document.querySelector("#pi-dom-picker-overlay-root")?.firstElementChild as HTMLDivElement;
  expect(highlightBox.style.border).toBe("2px solid rgb(111, 127, 58)");
  expect(highlightBox.style.background).toBe("rgba(205, 216, 164, 0.28)");

  overlay.cleanup();
});
```

Create `src/chrome/toast.test.ts` with checks like:

```ts
it("renders success toast in the light olive theme", () => {
  showToast("Отправлено в Pi", "success");
  const toast = document.querySelector("#pi-dom-picker-toast-root > div") as HTMLDivElement;
  expect(toast.style.background).toBe("rgba(111, 127, 58, 0.96)");
  expect(toast.style.color).toBe("rgb(255, 253, 247)");
});
```

**Step 2: Запустить UI-тесты**

Run:
```bash
npx vitest run src/chrome/selectionOverlay.test.ts src/chrome/toast.test.ts
```
Expected: FAIL.

**Step 3: Обновить theme implementation**

In `src/chrome/selectionOverlay.ts`:
- светлая панель управления;
- мягкая оливковая подсветка;
- светлая модалка комментария;
- русские тексты: `Выбор блока`, `Добавьте комментарий (необязательно)`, `Отправить в Pi`, `Отмена`.

In `src/chrome/toast.ts`:

```ts
const background = kind === "success"
  ? "rgba(111, 127, 58, 0.96)"
  : "rgba(178, 86, 74, 0.96)";
```

Adjust box-shadow/text colors to match the light theme.

**Step 4: Прогнать targeted UI tests again**

Run:
```bash
npx vitest run src/chrome/selectionOverlay.test.ts src/chrome/toast.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/chrome/selectionOverlay.ts src/chrome/selectionOverlay.test.ts src/chrome/toast.ts src/chrome/toast.test.ts
git commit -m "style: apply light olive picker and toast theme"
```

## Phase 4 — Документация и финальная проверка

### Task 7: Обновить документацию и выполнить полную верификацию

**TDD scenario:** Trivial change — verify with project commands and manual smoke.

**Files:**
- Modify: `docs/architecture/chrome-extension.md`
- Modify: `docs/operations/testing.md`

**Step 1: Обновить архитектурную документацию**

In `docs/architecture/chrome-extension.md` add/adjust sections:
- что content script теперь использует candidate chain;
- что overlay поддерживает `Мельче / Крупнее / Отправить / Отмена`;
- что UI расширения использует светлую оливковую тему.

Suggested text fragment:

```md
Content script больше не выбирает единственный DOM-узел напрямую. Он строит упорядоченную цепочку кандидатов вокруг элемента под курсором, стартует с рекомендованного уровня и позволяет пользователю перейти к более мелкому или более крупному контейнеру перед отправкой.
```

**Step 2: Обновить smoke-сценарий тестирования**

In `docs/operations/testing.md` add manual checks:
- навигация `Мельче / Крупнее` на сложной web-app странице;
- проверка, что не выбирается весь layout без необходимости;
- визуальная проверка светлой оливковой темы в popup и overlay.

**Step 3: Выполнить полную автоматическую верификацию**

Run:
```bash
npm test
npm run typecheck
npm run build:chrome
```
Expected: все команды PASS.

**Step 4: Выполнить ручной smoke-test**

Manual checklist:
1. Собрать расширение и загрузить `dist/chrome` как unpacked extension.
2. Открыть сложную web-app страницу с карточками или таблицей.
3. Запустить picker через popup.
4. Проверить стартовый автоподбор.
5. Нажать `Мельче` / `Крупнее` и убедиться, что уровни переключаются предсказуемо.
6. Подтвердить отправку, ввести комментарий и убедиться, что toast и modal в светлой оливковой теме.
7. Проверить `Esc` и `Отмена`.

**Step 5: Commit**

```bash
git add docs/architecture/chrome-extension.md docs/operations/testing.md
git commit -m "docs: document improved picker flow and olive theme"
```

## Финальная сводка проверки перед merge

После выполнения всех задач ещё раз прогнать:

```bash
npm test
npm run typecheck
npm run build:chrome
```

И проверить `git status` — рабочее дерево должно быть чистым.
