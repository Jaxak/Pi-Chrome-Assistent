Ниже представлен **скилл на русском языке** для LLM (например, Pi coding agent), который объясняет, как создать расширение для Chrome с нуля. Скилл написан в формате инструкции, которую можно скопировать и использовать как системный промпт или встроить в агента.

---

# Скилл: Создание расширения для Chrome (Manifest V3)

## Назначение
Этот скилл даёт AI-агенту (LLM) полное и структурированное понимание того, как разрабатывать, отлаживать и публиковать расширения для браузера Google Chrome с использованием актуальной спецификации **Manifest V3**. После изучения этого скилла LLM сможет генерировать корректный код расширения, объяснять его архитектуру и помогать пользователю с любыми аспектами разработки.

## 1. Архитектура расширения Chrome
Расширение состоит из нескольких частей, каждая из которых имеет свою зону ответственности.

- **Манифест (manifest.json)** — единственный обязательный файл. Определяет права, версию, название, иконки, сценарии и страницы расширения.
- **Background (service worker)** — невидимый фоновый скрипт, заменяющий устаревшие фоновые страницы. Обрабатывает события браузера (установка, обновление, клики по иконке, сетевые запросы). Не имеет доступа к DOM, но может общаться с другими частями расширения.
- **Popup** — HTML-страница, которая появляется при клике на иконку расширения (всплывающее окно). Часто содержит интерфейс для пользователя.
- **Content scripts** — скрипты, внедряемые в веб-страницы. Имеют доступ к DOM текущей вкладки, но ограниченный доступ к API расширения. Работают в изолированной среде.
- **Options page** — опциональная страница настроек расширения.
- **DevTools page** — для создания панелей в инструментах разработчика Chrome.
- **Action / Browser action** — иконка в панели инструментов. Управляется через `action` в манифесте.

## 2. Манифест версии 3 (основные поля)
Пример минимального манифеста:

```json
{
  "manifest_version": 3,
  "name": "Моё первое расширение",
  "version": "1.0.0",
  "description": "Пример описания",
  "permissions": ["storage", "activeTab"],
  "host_permissions": ["https://*.example.com/*"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["content.css"]
    }
  ],
  "options_ui": {
    "page": "options.html",
    "open_in_tab": false
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

**Важные изменения V3 по сравнению с V2:**
- `background.scripts` → `background.service_worker`
- `browser_action` / `page_action` → `action`
- `webRequest` заменён на `declarativeNetRequest` для блокировки/модификации запросов
- Неподдерживаемые API: `background.persistent`, `chrome.extension.getBackgroundPage()`
- Удалены `chrome.websocket`, `chrome.webRequestBlocking` (только наблюдение)

## 3. Общение между компонентами расширения

- **Popup ↔ Background** — через `chrome.runtime.sendMessage` и `chrome.runtime.onMessage`.
- **Content script ↔ Background** — аналогично.
- **Popup ↔ Content script** — только через фоновый скрипт как посредника.
- **Хранение данных** — `chrome.storage.local` или `chrome.storage.sync`.
- **Отправка сообщения из content script в popup** — не напрямую, а через background.

**Пример отправки сообщения из popup:**

```javascript
// popup.js
document.getElementById('myButton').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({action: "getData"});
  console.log(response);
});
```

**Обработка в background:**

```javascript
// background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getData") {
    sendResponse({data: "Hello from background"});
  }
  return true; // для асинхронного ответа
});
```

**Отправка сообщения из content script в background:**

```javascript
// content.js
chrome.runtime.sendMessage({type: "pageUrl", url: window.location.href});
```

## 4. Жизненный цикл service worker (background)

- Service worker запускается по событию (например, `chrome.runtime.onMessage`, `chrome.alarms.onAlarm`, установка расширения) и через некоторое время завершается, когда нет активных задач.
- Не храните состояние в глобальных переменных! Используйте `chrome.storage` для долговременных данных.
- Для периодических действий используйте `chrome.alarms` вместо `setTimeout`/`setInterval`.

```javascript
// Создание будильника
chrome.alarms.create("checkUpdates", {periodInMinutes: 10});

// Прослушивание
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkUpdates") {
    fetchAndUpdate();
  }
});
```

## 5. Content scripts: изоляция и взаимодействие

Content script видит DOM страницы, но имеет ограниченный набор API расширения (может отправлять сообщения, но не может, например, использовать `chrome.tabs`). Он выполняется в изолированном мире, что означает:
- Глобальные объекты страницы (например, `window.myApp`) недоступны.
- Вносимые в DOM стили или скрипты не конфликтуют с сайтом.
- Чтобы взаимодействовать со страницей на её уровне, нужно внедрять обычный `<script>` в DOM.

**Пример внедрения скрипта в контекст страницы:**

```javascript
// content.js
const script = document.createElement('script');
script.textContent = `window.myVar = 'hello from page';`;
document.documentElement.appendChild(script);
script.remove();
```

**Приём сообщений от страницы (например, через window.postMessage):**

```javascript
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data.type === 'FROM_PAGE') {
    chrome.runtime.sendMessage({fromPage: event.data.payload});
  }
});
```

## 6. Разрешения (permissions) и host_permissions

- **`permissions`** — доступ к API расширения без дополнительного запроса пользователя (если не указан `optional_permissions`).
- **`host_permissions`** — доступ к URL-шаблонам для выполнения скриптов, использования `fetch`, `chrome.tabs.captureTab` и т.д.
- **Опциональные разрешения** — позволяют запрашивать доступ во время работы расширения (например, для доступа к текущему сайту только после клика).

```javascript
// Запрос разрешения на хост
chrome.permissions.request({
  permissions: [],
  origins: ["https://example.com/*"]
}, (granted) => {
  if (granted) console.log("Доступ предоставлен");
});
```

## 7. Установка и отладка расширения

1. **Режим разработчика** в Chrome: перейдите на `chrome://extensions`.
2. Включите "Режим разработчика" (тумблер в правом верхнем углу).
3. Нажмите "Загрузить распакованное расширение" и выберите папку с файлами (manifest.json должен быть в корне).
4. Для обновления после изменений — нажмите на значок обновления (🔄) на карточке расширения.
5. **Отладка:**
   - background service worker: на карточке расширения есть ссылка "service worker" (откроет DevTools).
   - popup: кликните правой кнопкой на иконке расширения → "Проверить всплывающее окно".
   - content scripts: откройте DevTools на любой веб-странице, там будет отдельный контекст "расширения" (выпадающий список вверху).

## 8. Пример простого расширения "Смена фона активной вкладки"

**Файлы:**

- `manifest.json`
- `background.js`
- `popup.html`
- `popup.js`

**manifest.json:**

```json
{
  "manifest_version": 3,
  "name": "Смена фона",
  "version": "1.0",
  "permissions": ["activeTab", "scripting"],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Сменить фон"
  }
}
```

**background.js** — пустой, потому что вся логика в popup (но нужен, чтобы манифест не ругался).

**popup.html:**

```html
<!DOCTYPE html>
<html>
<head><style>body { width: 150px; } button { margin: 10px; }</style></head>
<body>
  <button id="red">Красный</button>
  <button id="white">Белый</button>
  <script src="popup.js"></script>
</body>
</html>
```

**popup.js:**

```javascript
async function changeBackgroundColor(color) {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  await chrome.scripting.executeScript({
    target: {tabId: tab.id},
    func: (c) => document.body.style.backgroundColor = c,
    args: [color]
  });
}

document.getElementById('red').addEventListener('click', () => changeBackgroundColor('red'));
document.getElementById('white').addEventListener('click', () => changeBackgroundColor('white'));
```

## 9. Частые ошибки и их решение

| Ошибка                                   | Причина и решение |
|------------------------------------------|-------------------|
| `Cannot access chrome:// URL`            | Content scripts не работают на системных страницах Chrome. Добавьте исключения в matches или проверяйте `chrome.runtime.lastError`. |
| `Service worker registration failed`     | В манифесте указан неверный путь к `service_worker`. Проверьте, что файл лежит в корне расширения. |
| `message: undefined` при вызове sendMessage | Забыли `return true` в обработчике `onMessage` для асинхронного ответа. |
| `Scripts not running after reload`       | Перезагрузите расширение на `chrome://extensions`, а также обновите вкладку с целевым сайтом. |
| `chrome.storage is not defined`          | Забыли добавить `"storage"` в `permissions` манифеста. |

## 10. Публикация в Chrome Web Store

1. Создайте ZIP-архив со всеми файлами расширения (исключив папки `.git`, `node_modules` и т.д.).
2. Зарегистрируйтесь в [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) (одноразовая плата $5).
3. Нажмите "Новый элемент" → загрузите ZIP.
4. Заполните описание, иконки, скриншоты, категорию.
5. Для проверки соблюдения политик упакуйте расширение через `chrome://extensions` → "Упаковать расширение". Получите ключ `.pem` (храните в тайне).
6. Опубликуйте на обзор (может занять от нескольких часов до недели).

## 11. Рекомендации для LLM при генерации расширений

- Всегда используйте `"manifest_version": 3`.
- Никогда не добавляйте `"browser_action"`, `"page_action"`, `"background.persistent"`.
- Для сетевой фильтрации используйте `declarativeNetRequest`, а не устаревший `webRequestBlocking`.
- Если нужно изменить заголовки запросов — используйте `declarativeNetRequest` с правилами `ModifyHeaders`.
- Для работы с DOM в текущей вкладке используйте комбинацию `activeTab` + `scripting.executeScript`.
- Помните про Content Security Policy (CSP): нельзя выполнять `eval`, inline-скрипты в popup/options запрещены (кроме явно разрешённых через `"content_security_policy"` в манифесте). Используйте внешние `.js` файлы.
- При использовании `fetch` в background учитывайте, что CORS не применяется к запросам из расширения, но нужны `host_permissions`.

## 12. Полезные API для расширений (часто используемые)

- `chrome.tabs` — создание, обновление, закрытие вкладок.
- `chrome.windows` — управление окнами браузера.
- `chrome.storage` — сохранение данных (local/sync).
- `chrome.contextMenus` — создание пунктов в контекстном меню правой кнопки мыши.
- `chrome.bookmarks` — работа с закладками.
- `chrome.history` — работа с историей.
- `chrome.downloads` — управление загрузками.
- `chrome.notifications` — системные уведомления.
- `chrome.alarms` — таймеры.
- `chrome.commands` — горячие клавиши.
- `chrome.omnibox` — интеграция с адресной строкой.

## Заключение

После изучения этого скилла LLM умеет:
- объяснить структуру расширения;
- написать корректный `manifest.json` V3;
- создать фон, попап, content script и организовать обмен сообщениями;
- отладить расширение с помощью DevTools;
- избегать типовых ошибок;
- сгенерировать полноценное расширение под задачу пользователя.

Перед генерацией кода всегда уточняйте: какое именно поведение нужно (изменение страницы, отслеживание действий пользователя, работа с сетевыми запросами, хранение данных, горячие клавиши) — и стройте манифест только с необходимыми разрешениями.

---

Этот скилл можно скопировать в базу знаний Pi Coding Agent или использовать как инструкцию для LLM при создании расширений Chrome.
