# Prompt for Next Session: Side Panel Chat Implementation

```text
Нужно реализовать side panel chat по плану:

docs/plans/2026-06-26-sidepanel-chat.md

Перед началом обязательно прочитай:
- AGENTS.md
- docs/plans/2026-06-26-sidepanel-chat.md
- docs/designs/sidepanel-chat-designs.html
- docs/architecture/chrome-extension.md
- docs/architecture/broker.md
- docs/architecture/pi-extension.md
- docs/architecture/protocol.md

Контекст:
- Итоговый дизайн выбран и зафиксирован: Ant Compact с оливковой палитрой.
- Финальный статический дизайн лежит в:
  docs/designs/sidepanel-chat-designs.html
- Реализовывать компоненты вручную, без React и без зависимости от Ant Design.
- Все UI/UX тексты должны быть на русском.
- Первая версия — только режим чата. Tool calls/tool results не показывать.
- Обязателен индикатор «Агент работает в фоне…»: без рамки и без фоновой плашки, слева три анимированные точки.
- Header kebab-меню:
  - «Настройки» disabled;
  - «Авторизация»;
  - «Dev-журнал».
- Composer kebab-меню:
  - «DOM picker».
- Существующие сценарии авторизации, выбора Pi-сессии и DOM picker нужно сохранить.

Важные правила проекта:
- Перед изменением функций/классов/методов выполнить GitNexus impact analysis по AGENTS.md.
- Перед завершением выполнить GitNexus detect changes.
- Использовать TDD где применимо.
- После изменений запускать:
  npm run test
  npm run typecheck
  npm run build

Начни с создания отдельной ветки:

git checkout -b feat/sidepanel-chat

Затем выполняй план task-by-task. Сначала реализуй Task 1 из плана: заменить popup entry point на side panel shell, сохранив текущую функциональность.
```
