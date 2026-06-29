# Разработка

## Требования

- Node.js ≥ 24.0.0
- rsvg-convert (для генерации PNG-иконок из SVG при сборке)

| ОС | Установка rsvg-convert |
|----|------------------------|
| Ubuntu/Debian | `sudo apt install librsvg2-bin` |
| macOS | `brew install librsvg` |
| Fedora | `sudo dnf install librsvg2-tools` |

## Команды

```bash
npm install          # установка зависимостей
npm test             # запуск тестов (vitest)
npm run test:watch   # тесты в watch-режиме
npm run typecheck    # проверка типов (tsc --noEmit)
npm run build:chrome # сборка Chrome-расширения в dist/chrome
```

## Структура проекта

```
src/
├── chrome/              # Chrome-расширение (MV3)
│   ├── background.ts           # Service worker (точка входа)
│   ├── backgroundStateServer.ts # State management + WebSocket client
│   ├── sessionClient.ts        # WebSocket client к Pi
│   ├── sidepanel.ts            # UI боковой панели
│   ├── sidepanelState.ts       # Chat state reducer
│   ├── sidepanelRender.ts      # DOM render helpers
│   ├── assistantState.ts       # Global state + reducer
│   ├── contentScript.ts        # Content script (DOM picker)
│   ├── domPicker.ts            # Интерактивный выбор DOM-элемента
│   ├── selectionOverlay.ts     # Overlay UI для DOM picker
│   ├── crosshairHighlighter.ts # Подсветка элемента
│   ├── markdown.ts             # Markdown → HTML
│   ├── diagnostics.ts          # Diagnostic logging
│   └── toast.ts                # Toast-уведомления
├── pi/                  # Pi extension (серверная часть)
│   ├── browserConnectExtension.ts  # Основное расширение Pi
│   ├── sessionServer.ts            # WebSocket server
│   ├── chromeAssistentPaths.ts     # Runtime paths
│   ├── logging.ts                  # File logger
│   └── secureFilesystem.ts         # Filesystem security
└── shared/              # Общий код (browser + node)
    ├── protocol.ts              # Protocol types + validation
    ├── constants.ts             # Shared constants
    ├── formatSelectionMessage.ts # Selection → text formatter
    └── truncation.ts            # UTF-8 truncation
```

## Тесты

Тесты расположены рядом с исходниками (`*.test.ts`). Используется Vitest.

```bash
npm test                              # все тесты
npx vitest run src/chrome/            # только Chrome-часть
npx vitest run src/pi/                # только Pi-часть
npx vitest run src/shared/            # только shared
```

## Сборка Chrome-расширения

```bash
npm run build:chrome
```

Результат: `dist/chrome/` — готовое расширение для загрузки в Chrome.

Скрипт сборки (`scripts/build-chrome.mjs`):
- Bundlит TypeScript через esbuild
- Генерирует PNG-иконки из SVG
- Копирует manifest.json, HTML, CSS
