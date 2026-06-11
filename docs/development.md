# Разработка и сборка

## Требования

- Node.js `>=24.0.0`
- npm `>=11`
- Chrome или совместимый Chromium-браузер
- Pi Coding Agent (установлен и работает)

## Установка зависимостей

```bash
npm install
```

## Сборка Chrome-расширения

```bash
npm run build:chrome
```

Результат собирается в `dist/chrome/`:

| Файл              | Назначение                               |
|-------------------|------------------------------------------|
| `manifest.json`   | Manifest V3 расширения                   |
| `popup.html`      | HTML popup (3 вкладки)                   |
| `popup.css`       | Стили popup                              |
| `popup.js`        | Логика popup (выбор сессий, авторизация) |
| `background.js`   | Service worker (фоновые задачи)           |
| `contentScript.js`| DOM picker, overlay, отправка контента   |

## Загрузка в браузер

1. Откройте `chrome://extensions`
2. Включите **Режим разработчика**
3. Нажмите **Загрузить распакованное расширение**
4. Выберите папку `dist/chrome`

## Проверка

```bash
# Запустить тесты
npm test

# Проверка типов TypeScript
npm run typecheck

# Полный цикл
npm test && npm run typecheck && npm run build:chrome
```

## Структура проекта

```
src/
├── chrome/                    # Chrome-расширение
│   ├── popup.ts / popup.html  # Popup интерфейс
│   ├── background.ts          # Service worker
│   ├── contentScript.ts       # DOM picker + overlay
│   ├── domPicker.ts           # Логика выбора элементов
│   ├── selectionOverlay.ts    # Overlay навигации
│   ├── toast.ts               # Toast-уведомления
│   └── diagnostics.ts         # Диагностика подключения
├── pi/                        # Pi-расширение (SDK)
│   ├── browserConnectExtension.ts  # Расширение Pi
│   ├── broker.ts              # WebSocket broker
│   ├── targetClient.ts        # Клиент к Pi-сессиям
│   └── ...
├── shared/                    # Общие модули
│   ├── protocol.ts            # Типы сообщений
│   ├── constants.ts           # Константы
│   └── truncation.ts          # Обрезка данных
└── scripts/
    └── build-chrome.mjs       # Скрипт сборки
```

## Полезные пути

| Путь                                     | Назначение                       |
|-------------------------------------------|----------------------------------|
| `~/.pi/chrome-assistent/`                 | Глобальный runtime Pi            |
| `~/.pi/chrome-assistent/trusted-browsers.json` | Реестр доверенных браузеров   |
| `~/.pi/chrome-assistent/chrome-assistent.log`   | Логи Pi/broker                |
| `dist/chrome/`                            | Собранное Chrome-расширение      |

Брокер слушает на `ws://127.0.0.1:17345`.

## Связанные документы

- [Установка и запуск](./operations/setup.md)
- [Авторизация браузера](./operations/token-setup.md)
- [Тестирование](./operations/testing.md)
- [Устранение неполадок](./operations/troubleshooting.md)
- [Обзор архитектуры](./architecture/overview.md)
