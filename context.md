# Code Context — Element Selection / Picking

## Files Retrieved
1. `src/chrome/domPicker.ts` (lines 1–268) — Ядро выбора элемента: скоринг кандидатов, CSS-селектор, сбор payload
2. `src/chrome/selectionOverlay.ts` (lines 1–310) — Визуальный overlay-интерфейс поверх страницы: подсветка, кнопки, модалка комментария
3. `src/chrome/contentScript.ts` (lines 1–228) — Content script: координация сессии picker, обработка событий мыши/клавиатуры, связь с background
4. `src/chrome/popup.ts` (lines 1–580) — Popup-интерфейс: запуск picker через background, выбор target, UI сессий
5. `src/chrome/background.ts` (lines 1–490) — Background service worker: маршрутизация сообщений popup↔content script, отправка selections в Pi через WebSocket
6. `src/shared/protocol.ts` (lines 1–130) — Типы и валидация: `SelectionPayload`, `TargetMetadata`, `DeliveryResult`, протокольные сообщения
7. `src/shared/constants.ts` (lines 1–10) — Константы: лимиты текста/HTML, версии протокола
8. `src/shared/formatSelectionMessage.ts` (lines 1–50) — Форматирование payload в markdown-сообщение для Pi
9. `src/chrome/contentScriptMessages.ts` (lines 1–80) — Форматирование toast-сообщений об ошибках
10. `src/chrome/toast.ts` (lines 1–60) — Toast-уведомления на странице
11. `src/chrome/manifest.json` — Manifest V3, content_scripts: [] (content script injectится динамически)
12. `src/chrome/popup.html` — HTML-шаблон popup

## Key Code

### 1. `SelectionPayload` — структура данных выбранного элемента
**`src/shared/protocol.ts` (строки 22–30):**
```ts
export type SelectionPayload = {
  url: string;
  title: string;
  selectedText: string;
  selectedHtml: string;
  selector?: string;      // CSS-селектор элемента
  comment?: string;       // пользовательский комментарий
  capturedAt: number;     // timestamp
};
```
Лимиты: `MAX_SELECTED_TEXT_BYTES = 50KB`, `MAX_SELECTED_HTML_BYTES = 100KB` (`src/shared/constants.ts`).

### 2. Как работает выбор элемента — полный поток

**Шаг 1 — Popup запускает picker:**
- Пользователь нажимает «Отправить в Pi» в popup → `popup.ts` строка ~449
- Popup шлёт `chrome.runtime.sendMessage({ type: "startDomPicker", targetId })` → `popup.ts` строка ~465

**Шаг 2 — Background инжектит content script:**
- Background получает `startDomPicker` → `background.ts` строка ~301
- Динамический injection: `chrome.scripting.executeScript({ target: { tabId }, files: ["contentScript.js"] })` → `background.ts` строка ~321
- Затем: `chrome.tabs.sendMessage(tabId, { type: "startDomPicker", targetId })` → `background.ts` строка ~324

**Шаг 3 — Content script запускает DOM picker:**
- Content script слушает `startDomPicker` → `contentScript.ts` строка ~195
- Вызывает `startDomPicker(targetId)` → `contentScript.ts` строка ~40

**Шаг 4 — Пользователь наводит/кликает на странице:**
- `mousemove` (capture phase) → `handleMouseMove` → `contentScript.ts` строка ~171
- При клике → `handleClick` → `contentScript.ts` строка ~186 → состояние меняется на `'selected'`, показывается панель

**Шаг 5 — Определение элемента:**
- `getSelectionCandidates(hovered)` → `domPicker.ts` строка ~213
- Поднимается по DOM вверх до `MAX_SELECTION_CANDIDATE_DEPTH = 8` уровней
- Каждый кандидат оценивается функцией `scoreElement()` → `domPicker.ts` строка ~159

**Шаг 6 — Подтверждение и отправка:**
- Пользователь нажимает «Pi» → `onConfirm` → `contentScript.ts` строка ~93
- Модалка комментария → `contentScript.ts` строка ~102
- `buildSelectionPayload(element, comment)` → `domPicker.ts` строка ~256
- `chrome.runtime.sendMessage({ type: "sendSelection", targetId, selection })` → `contentScript.ts` строка ~116
- Background получает `sendSelection` → `background.ts` строка ~389
- WebSocket к Pi broker → `deliverSelection()` → `background.ts` строка ~229

### 3. Скоринг кандидатов и определение "соседнего" элемента

**Кандидаты — это родительские элементы, а не соседи!**
**`src/chrome/domPicker.ts` (строки 200–213):**
```ts
function collectCandidateChain(start: Element): Element[] {
  // Поднимается по parentElement вверх до 8 уровней
  while (current && depth < MAX_SELECTION_CANDIDATE_DEPTH) {
    candidates.push(current);
    current = current.parentElement;
  }
  return candidates;
}
```

Система навигации «Крупнее/Меньше» перебирает **уровни вложенности** (родитель/потомок), а не соседние элементы на том же уровне:
- «Меньше» = `currentIndex -= 1` → более глубокий (ближе к кликнутому)
- «Крупнее» = `currentIndex += 1` → более высокий (ближе к `<html>`)

**Скоринг учитывает:**
- Длина текста (`getTextLengthScore`) — `domPicker.ts` строка ~57
- Тип тега: `<pre>`(+160), `<code>`(+150), `<table>`(+90), `<article>`(+110), `<span>`(-28) и т.д.
- ARIA role: `role="article"`(+110), `role="code"`(+150)
- Размер rect и покрытие viewport-а
- Плотность текста (текст / кол-во детей)
- Штрафы за пустые/слишком большие контейнеры

**Результат:**
```ts
export type SelectionCandidates = {
  candidates: Element[];
  recommendedIndex: number;
};
```

### 4. Кнопки Вверх/Вниз — **заглушки, функциональности нет!**

**`src/chrome/selectionOverlay.ts` (строки 146–160):**
```ts
// Row 2: Вверх | Вниз (функциональность добавим позже)
const upButton = document.createElement("button");
upButton.textContent = "Вверх";
upButton.disabled = true;
upButton.title = "Переключиться на блок выше (скоро)";

const downButton = document.createElement("button");
downButton.textContent = "Вниз";
downButton.disabled = true;
downButton.title = "Переключиться на блок ниже (скоро)";
```

Кнопки **созданы в DOM**, но:
- ✅ Визуально присутствуют в overlay-панели
- ❌ `disabled = true`, `aria-disabled = "true"`
- ❌ Нет обработчиков `click` (в отличие от «Крупнее/Меньше» которые имеют `callbacks.onNarrow/onWiden`)
- ❌ Нет callback-параметров `onUp`/`onDown` в `createSelectionOverlay(callbacks)`
- ❌ Comment явно говорит "функциональность добавим позже"
- ✅ Тесты проверяют, что кнопки disabled (`selectionOverlay.test.ts` строки 161–166)

**Существующая навигация:**
- `setNavigationState(state: { canNarrow: boolean; canWiden: boolean })` управляет только «Крупнее/Меньше»
- Нет `canGoUp`/`canGoDown` в типизации

### 5. Передача сообщений popup ↔ content script

**Popup → Background → Content Script:**
```
popup.ts
  └─ chrome.runtime.sendMessage({ type: "startDomPicker", targetId })
       ↓
background.ts
  ├─ chrome.scripting.executeScript({ files: ["contentScript.js"] })  // dynamic injection
  └─ chrome.tabs.sendMessage(tabId, { type: "startDomPicker", targetId })
       ↓
contentScript.ts
  └─ chrome.runtime.onMessage.addListener — обрабатывает "startDomPicker"
```

**Content Script → Background → Pi Broker:**
```
contentScript.ts
  └─ chrome.runtime.sendMessage({ type: "sendSelection", targetId, selection })
       ↓
background.ts
  ├─ validateSelectionPayload(selection)
  ├─ deliverSelection(token, targetId, selection)  // WebSocket → Pi broker
  └─ sendResponse({ ok: true, error?: string })
       ↓
contentScript.ts
  └─ showToast(result) — toast-уведомление на странице
```

### 6. Архитектура overlay-панели

**`src/chrome/selectionOverlay.ts`** создаёт панель с кнопками в сетке 2 колонки:
```
┌─────────────┬─────────────┐
│   Крупнее   │   Меньше    │  ← навигация по вложенности (работает)
├─────────────┼─────────────┤
│   Вверх     │   Вниз      │  ← заглушки (disabled, нет обработчиков)
├─────────────┼─────────────┤
│  Изменить   │  Отменить   │  ← Изменить = вернуться к hover-режиму
├─────────────┴─────────────┤
│         Pi                │  ← отправить (primary кнопка)
└───────────────────────────┘
```

Состояния picker-сессии: `'hover'` → наведение мыши, подсветка | `'selected'` → клик, показ панели

## Architecture

```
┌──────────────┐       ┌──────────────────┐       ┌──────────────────┐
│   Popup UI   │──────▶│  Background SW   │──────▶│   Pi Broker (WS) │
│  (popup.ts)  │◀──────│  (background.ts) │◀──────│  127.0.0.1:17345 │
└──────────────┘       └──────────────────┘       └──────────────────┘
                            │
                     executeScript +
                     tabs.sendMessage
                            │
                            ▼
                     ┌──────────────────┐
                     │ Content Script   │
                     │ (contentScript.ts)│
                     │                  │
                     │  domPicker.ts    │← скоринг, CSS selector
                     │  selectionOverlay│← overlay UI на странице
                     │  toast.ts        │← уведомления
                     └──────────────────┘
```

Контент-скрипт **не декларируется** в manifest-е (`"content_scripts": []`), а injectится динамически через `chrome.scripting.executeScript()` при каждом запуске picker.

## Start Here

**`src/chrome/contentScript.ts`** — центральная точка координации picker-сессии. Здесь видно:
- как запускается сессия (`startDomPicker`)
- как переключаются состояния (`hover`/`selected`)
- как работает навигация «Крупнее/Меньше» (существующая)
- где нет навигации «Вверх/Вниз» (заглушки в overlay)
- как передаётся payload в background

## Key Observations for Implementation

1. **"Соседний" элемент не определён.** Сейчас навигация — это только вложенность (DOM tree parents). Для кнопок Вверх/Вниз нужно определить, что значит "блок выше/ниже" — скорее всего соседние элементы на том же уровне вёрстки (DOM siblings или visual neighbors).

2. **Типизация `SelectionOverlayControls`** (`selectionOverlay.ts` строка 12) и callback-интерфейс `createSelectionOverlay` (строка 115) не включают `onUp`/`onDown`.

3. **`setNavigationState`** принимает только `{ canNarrow, canWiden }` — нужно расширить до `{ canNarrow, canWiden, canGoUp, canGoDown }`.

4. **В `contentScript.ts`** нужно добавить логику поиска соседних элементов и обработку нажатий Вверх/Вниз.

5. **`getSelectionCandidates`** работает только вверх по DOM. Для "соседних" элементов нужна новая функция — поиск siblings/visual neighbors выбранного элемента.
