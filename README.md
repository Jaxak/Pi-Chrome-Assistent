# Pi Chrome Assistent

Боковая панель Chrome с чатом для [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Позволяет общаться с Pi прямо из браузера и отправлять выбранные DOM-фрагменты страниц в активную сессию.

**Ключевые возможности:**

- 💬 Полноценный чат с Pi в боковой панели Chrome
- 🎯 DOM Picker — выбор и отправка элементов страницы с контекстом (URL, HTML, CSS-селектор)
- ⚡ Реальтайм-стриминг ответов и индикация активности агента
- 🔒 Только localhost — всё работает локально, без облачных серверов

---

## Быстрый старт

### 1. Установите пакет Pi

```bash
pi install git:https://github.com/Jaxak/Pi-Chrome-Assistent.git
```

Перезагрузите расширения, если Pi уже запущен:
```
/reload
```

### 2. Установите Chrome-расширение

**Из Chrome Web Store:**
- [Pi Chrome Assistent](https://chromewebstore.google.com/detail/jpdbpapfbagejkgbkpfdabaogmhmheom)

**Или для разработки (из исходников):**
```bash
npm install
npm run build:chrome
```
Затем: `chrome://extensions` → Режим разработчика → Загрузить распакованное → `dist/chrome`

### 3. Подключитесь

В терминале Pi выполните:
```
/chrome-assistent-connect
```

Откройте боковую панель (клик по иконке расширения) — чат подключится автоматически.

---

## Документация

| Тема | Файл |
|------|------|
| Chrome-расширение (sidepanel, background, content script) | [docs/chrome-extension.md](docs/chrome-extension.md) |
| Pi-расширение (серверная часть, events, команды) | [docs/pi-extension.md](docs/pi-extension.md) |
| Разработка (сборка, тесты, структура проекта) | [docs/development.md](docs/development.md) |

---

## Благодарности

- [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) — основа агентского SDK
- [CrosshairJs](https://github.com/CodCatDev/CrosshairJs) — инспирация для DOM Picker
- [pi-web-ui](https://github.com/nicepkg/pi-web-ui) — референсная реализация mirror-server паттерна
