# Установка и запуск

## Требования

Перед запуском MVP убедитесь, что у вас есть:

- Node.js `>=24.0.0`;
- установленный Chrome или совместимый Chromium-браузер;
- установленный и рабочий Pi Coding Agent;
- проект, в котором вы запускаете `pi`.

## 1. Установите зависимости

В корне репозитория выполните:

```bash
npm install
```

## 2. Соберите браузерное расширение

```bash
npm run build:chrome
```

После сборки в `dist/chrome` должны быть файлы:

- `manifest.json`
- `popup.html`
- `popup.css`
- `background.js`
- `popup.js`
- `contentScript.js`

## 3. Загрузите расширение в браузер

1. Откройте `chrome://extensions`.
2. Включите **Режим разработчика**.
3. Нажмите **Load unpacked** / **Загрузить распакованное расширение**.
4. Выберите папку `dist/chrome`.

## 4. Запустите Pi

Откройте терминал в нужном проекте и запустите `pi`.

Если локальное расширение Pi было добавлено уже после старта Pi, выполните:

```text
/reload
```

## 5. Создайте и сохраните `browserToken` в браузере

Сейчас это ручной шаг MVP. Один из рабочих вариантов — DevTools service worker расширения:

```js
const browserToken = crypto.randomUUID();
await chrome.storage.local.set({ browserToken });
console.log(browserToken);
```

Скопируйте выведенный токен.

## 6. Авторизуйте браузер в Pi

Внутри Pi выполните:

```text
/chrome-assistent-auth
```

Когда Pi запросит токен, вставьте тот же `browserToken`.

## 7. Подключите текущую Pi-сессию к broker

Внутри Pi выполните:

```text
/chrome-assistent-connect [alias]
```

Примеры:

```text
/chrome-assistent-connect
/chrome-assistent-connect frontend
/chrome-assistent-connect docs
```

После этого Pi-сессия:

- прочитает или создаст глобальный broker token в `~/.pi/chrome-assistent/broker.token`;
- попробует подключиться к локальному broker на `127.0.0.1:17345`;
- при необходимости поднимет broker сама;
- покажет статус подключения в UI Pi.

## 8. Проверьте работу popup

1. Откройте popup расширения.
2. Убедитесь, что появилась хотя бы одна цель Pi.
3. Выберите цель.
4. Нажмите **Send to Pi**.
5. Выберите элемент на странице.
6. При необходимости добавьте комментарий и подтвердите отправку.
7. Перейдите в терминал Pi и прочитайте ответ там.

## Полезные пути и адреса

- WebSocket broker: `ws://127.0.0.1:17345`
- Глобальный broker token Pi: `~/.pi/chrome-assistent/broker.token`
- Логи Pi/broker: `~/.pi/chrome-assistent/chrome-assistent.log`
- Сборка Chrome-расширения: `dist/chrome`

## Что не делает setup автоматически

- не генерирует `browserToken` за пользователя;
- не создаёт UI для привязки браузера к токену;
- не возвращает ответы Pi в popup.

## Связанные документы

- [Обзор архитектуры](../architecture/overview.md)
- [Ручная настройка токена](./token-setup.md)
- [Тестирование](./testing.md)
- [Устранение неполадок](./troubleshooting.md)
