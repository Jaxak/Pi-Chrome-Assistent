# Текущая инструкция по запуску и подключению

## 1. Установить зависимости и собрать расширение

```bash
npm install
npm run build:chrome
```

## 2. Загрузить расширение в Chrome

1. Откройте `chrome://extensions`.
2. Включите **Режим разработчика**.
3. Нажмите **Загрузить распакованное расширение**.
4. Выберите папку:

```text
dist/chrome
```

## 3. Запустить Pi

В корне проекта:

```bash
pi
```

Если локальное расширение Pi не подхватилось сразу:

```text
/reload
```

## 4. Сгенерировать браузерный токен

Откройте DevTools у service worker расширения:

1. Откройте `chrome://extensions`.
2. Найдите **Pi Chrome Assistent**.
3. Нажмите **Service Worker** / **Inspect**.

В консоли DevTools выполните:

```js
const browserToken = crypto.randomUUID();
await chrome.storage.local.set({ browserToken });
console.log(browserToken);
```

Скопируйте выведенный `browserToken`.

## 5. Авторизовать браузер в Pi

Внутри Pi:

```text
/chrome-assistent-auth
```

Когда Pi запросит токен, вставьте тот же `browserToken`.

## 6. Подключить текущую сессию Pi

Внутри Pi:

```text
/chrome-assistent-connect test
```

## 7. Проверить отправку

1. Откройте любую страницу.
2. Нажмите на иконку расширения **Pi Chrome Assistent**.
3. В popup выберите цель `test`.
4. Нажмите **Отправить в Pi**.
5. Кликните по элементу на странице.
6. Подтвердите отправку.

## 8. Где смотреть результат

- В браузере виден статус отправки.
- Ответ Pi нужно читать в терминале, где запущен `pi`.

## Если не работает

Проверьте:

- Pi всё ещё запущен;
- команда `/chrome-assistent-connect test` была выполнена в текущей сессии;
- один и тот же `browserToken` сохранён в `chrome.storage.local` и авторизован через `/chrome-assistent-auth`;
- расширение загружено именно из `dist/chrome`.
