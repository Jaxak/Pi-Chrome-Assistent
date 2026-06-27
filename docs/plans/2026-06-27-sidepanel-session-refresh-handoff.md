# Handoff: стабилизация списка сессий sidepanel и ручное обновление

**Дата:** 2026-06-27  
**Ветка:** `feat/sidepanel-chat`  
**Контекст:** после перевода sidepanel на background-owned state остаются проблемы lifecycle broker/targets. Нужно продолжить в новой сессии без попытки снова чинить только realtime push.

---

## Текущее целевое устройство

После предыдущих изменений архитектура должна быть такой:

- `BackgroundAssistantStateServer` — единственный владелец интеграционного состояния:
  - browser token;
  - broker WebSocket;
  - connection state;
  - targets;
  - selected target;
  - chat state;
  - diagnostics;
  - DOM picker command path.
- `sidepanel.ts` — UI-only клиент:
  - открывает `chrome.runtime.connect({ name: "sidepanel" })`;
  - получает `assistant.snapshot`;
  - отправляет `assistant.*` команды;
  - не создаёт broker client;
  - не вызывает broker напрямую.

Последний UI-fix: header status удалён, потому что достаточно блока «Сессия».

---

## Баги, которые пользователь наблюдает сейчас

### Баг 1. Новая сессия не появляется после смерти последней Pi-сессии

Сценарий:

1. Закончилась последняя сессия Pi в терминале.
2. Broker на `ws://127.0.0.1:17345` умирает вместе с ней.
3. Через минуту появляется новая Pi-сессия / новый broker.
4. В sidepanel новая сессия не появляется динамически.
5. Она появляется только после закрытия/повторного открытия sidepanel.

Гипотеза:

- `BrokerClient` использует bounded reconnect:

```ts
DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1000]
```

- После смерти broker background делает несколько reconnect attempts, получает `ERR_CONNECTION_REFUSED`, затем перестаёт пытаться.
- Если новый broker появляется позже, активного reconnect уже нет.
- Reopen sidepanel создаёт новый lifecycle/start и поэтому сессия появляется.

Следствие:

- Pure push/WebSocket model не покрывает сценарий “broker умер, новый broker появился через минуту”.
- Нужен manual refresh или долгий/backoff probe.

---

### Баг 2. Быстрый выбор второй сессии не срабатывает

Сценарий:

1. Доступно две сессии.
2. Пользователь выбирает первую.
3. Затем сразу кликает вторую.
4. Вторая не выбирается, приходится нажимать несколько раз.

Гипотезы:

1. Sidepanel не мутирует выбор локально, а ждёт `assistant.snapshot` от background.
2. После первого клика snapshot вызывает `renderTargetList()`.
3. `renderTargetList()` сейчас пересоздаёт список через `replaceChildren()`.
4. Быстрый второй клик может попадать в момент удаления/пересоздания DOM-кнопок.
5. Поэтому UI ощущается как “неотзывчивый” или “клик потерялся”.

Возможное решение:

- Сделать optimistic selection в sidepanel:
  - при клике локально подсветить target как pending;
  - отправить `assistant.selectTarget`;
  - подтвердить/откатить по следующему snapshot.
- Или не пересоздавать весь список targets на каждый snapshot:
  - event delegation на `#target-container`;
  - обновлять DOM только при изменении набора `targetId`;
  - при изменении selectedTargetId менять только классы/aria-selected.

---

### Баг 3. После `ERR_CONNECTION_REFUSED` сессии пропадают

Сценарий:

1. Через какое-то время в DevTools появляется:

```text
WebSocket connection to 'ws://127.0.0.1:17345/' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED
```

2. После этого сессии пропадают из доступных.

Гипотезы:

- Несмотря на предыдущие fixes, где-то в state transition всё ещё очищаются `targets` при broker offline/token transition/reconnect exhaustion.
- Сейчас в модели нет явного разделения:
  - `liveTargets` — подтверждены текущим broker;
  - `knownTargets` — последние известные targets;
  - `targetsStale` — список устарел, но его лучше сохранить для контекста.

Правильная модель:

```ts
targets: TargetMetadata[];       // last known targets
connection.brokerOnline: boolean;
connection.targetsStale: boolean; // новое поле или derived state
```

UI policy:

- Если `targets.length > 0` и broker offline — не удалять список.
- Показывать рядом с блоком сессий предупреждение:

```text
Список может быть устаревшим. Нажмите «Обновить».
```

---

### Баг 4. Самый критичный: нельзя отправить сообщение после выбора сессии

Сценарий:

1. Пользователь выбирает сессию.
2. Система не даёт отправить сообщение в Pi.
3. Ключевая функциональность chat сломана.

Гипотезы:

- `isChatSendDisabled()` в `assistantState.ts` слишком строго завязан на:

```ts
connection.connecting === false
connection.brokerOnline === true
connection.bridgeOnline === true
connection.tokenConfigured === true
connection.browserAuthorized === true
selectedTargetId exists
target exists
!chat.sending
!chat.agentBusy
```

- Если после выбора target background находится в transient/offline/reconnect state, sidepanel может показывать session list, но chat send остаётся disabled.
- Также возможно, что `selectTarget()` в background не вызывает `brokerClient.setSelectedTargetId()` в нужный момент, если socket reconnect/subscription state ещё не готов.

Что проверить в новой сессии:

1. После клика target проверить snapshot:

```ts
selectedTargetId
targets
connection.brokerOnline
connection.bridgeOnline
connection.browserAuthorized
chat.sending
chat.agentBusy
```

2. Проверить, уходит ли в broker:

```ts
client.subscribeTarget
```

3. Проверить, вызывается ли `BrokerClient.setSelectedTargetId()` после:
   - выбора target;
   - reconnect socket open;
   - `client.targets` snapshot.

---

## Предлагаемый комбинированный вариант

Не продолжать пытаться сделать только realtime push идеальным. Добавить production fallback.

### A. Оставить WebSocket push как best-effort

Push работает, пока broker жив.

Если broker умер:

- не очищать last-known targets;
- не дёргать UI reconnect-churn;
- показать stale guidance;
- дать ручной refresh.

### B. Добавить кнопку «Обновить» в блок «Сессия»

UI в `sidepanel.html`:

```html
<div class="session-card__header">
  <label class="field-label" id="target-heading">Сессия</label>
  <button id="refresh-sessions-button" class="button-secondary button-compact" type="button">Обновить</button>
</div>
```

Команда sidepanel → background:

```ts
{ type: "assistant.sessions.refresh" }
```

Поведение:

- кнопка не требует reopen sidepanel;
- пользователь может вручную найти новый broker/new targets;
- во время refresh показывать:

```text
Обновляем список сессий…
```

### C. Реализовать `assistant.sessions.refresh` в `BackgroundAssistantStateServer`

Команда должна:

1. Принудительно остановить/закрыть текущий `BrokerClient`.
2. Создать новый `BrokerClient` с текущим browser token.
3. Сбросить reconnect exhaustion.
4. Выполнить broker handshake/listTargets через обычный BrokerClient flow.
5. Не очищать targets до получения успешного нового списка.
6. Если broker недоступен:
   - оставить last-known targets;
   - поставить `targetsStale=true` или diagnostic;
   - broadcast stable snapshot.
7. Если broker доступен:
   - обновить targets;
   - восстановить selectedTargetId, если target существует;
   - иначе сбросить selection.

### D. Сделать выбор сессии отзывчивым

Вариант 1: optimistic UI selection.

- В sidepanel добавить `pendingSelectedTargetId`.
- При клике:

```ts
pendingSelectedTargetId = targetId;
renderTargetSelectionOnly();
postAssistantCommand({ type: "assistant.selectTarget", targetId });
```

- При новом snapshot:

```ts
pendingSelectedTargetId = undefined;
currentSelectedTargetId = snapshot.selectedTargetId;
```

Вариант 2: не пересоздавать DOM списка.

- `renderTargetList()` должен обновлять список только при изменении target ids.
- При изменении selection обновлять только классы/aria-selected.

Лучше начать с варианта 1, он проще и быстрее снижает потерю кликов.

### E. Починить enable chat send

После выбора target и live broker connection кнопка «Отправить» должна включаться.

Добавить/проверить тест:

1. background emits targets;
2. sidepanel clicks target;
3. background confirms snapshot with selectedTargetId and brokerOnline/bridgeOnline/browserAuthorized true;
4. user enters text;
5. send button enabled;
6. click posts `assistant.sendChatMessage`.

Если этот тест уже есть — проверить, что он реалистично выставляет connection flags.

---

## Рекомендуемый порядок реализации

### Task 1. Session refresh command in background

Файлы:

- `src/chrome/backgroundStateServer.ts`
- `src/chrome/backgroundStateServer.test.ts`

Тесты:

- `assistant.sessions.refresh` recreates BrokerClient with same token.
- refresh keeps old targets while broker reconnect is pending/offline.
- refresh updates targets when broker returns `client.targets`.
- refresh preserves selected target if still present.
- refresh clears selected target if missing.

### Task 2. Session refresh button in sidepanel

Файлы:

- `src/chrome/sidepanel.html`
- `src/chrome/sidepanel.css`
- `src/chrome/sidepanel.ts`
- `src/chrome/sidepanelNavigation.test.ts`

Тесты:

- button exists in session block;
- click posts `assistant.sessions.refresh`;
- during stale/offline known targets remain visible;
- refresh unavailable state remains safe if port disconnected.

### Task 3. Optimistic target selection

Файлы:

- `src/chrome/sidepanel.ts`
- `src/chrome/sidepanelNavigation.test.ts`

Тесты:

- clicking target-1 marks it selected/pending immediately;
- clicking target-2 immediately after marks target-2 selected/pending immediately;
- snapshot confirmation clears pending state;
- snapshot rejection/target missing falls back to snapshot-selected state.

### Task 4. Chat send enablement regression

Файлы:

- `src/chrome/sidepanelNavigation.test.ts`
- `src/chrome/backgroundStateServer.test.ts`
- possibly `src/chrome/assistantState.test.ts`

Тесты:

- selected live target enables chat send;
- send posts `assistant.sendChatMessage`;
- background sends broker `client.sendChatMessage` only when selected target and connection ready;
- if broker offline but targets known, send disabled with stable UI.

---

## Acceptance criteria for next session

Считать проблему решённой только если вручную работает:

1. Последняя Pi-сессия закрылась → список не моргает и не исчезает без объяснения.
2. Через минуту новая Pi-сессия появилась → пользователь нажимает «Обновить» → новая сессия появляется без reopen sidepanel.
3. При двух сессиях быстрый клик target-1 → target-2 выбирает target-2 с первого раза.
4. После выбора live сессии можно отправить chat message в Pi.
5. Если broker умер, chat send disabled с понятной причиной, но список последних сессий не пропадает.
6. `ERR_CONNECTION_REFUSED` может появляться в DevTools как сетевой факт, но UI остаётся стабильным и recoverable через «Обновить».

---

## Команды проверки

Минимум:

```bash
npm test -- --run src/chrome/backgroundStateServer.test.ts src/chrome/sidepanelNavigation.test.ts src/chrome/sidepanelAuthLifecycle.test.ts src/chrome/brokerClient.test.ts
npm run typecheck
npm run build
```

Финально:

```bash
npm test
npm run typecheck
npm run build
npx gitnexus analyze
npx gitnexus detect-changes --repo Pi-Chrome-Assistent
git status --short
```

---

## Важное предупреждение

Не пытаться снова лечить только reconnect-churn. Проблема теперь продуктовая/lifecycle:

- broker может умереть надолго;
- новый broker может появиться позже bounded reconnect;
- пользователю нужен ручной recovery path;
- UI должен сохранять last-known context и не требовать reopen панели.
