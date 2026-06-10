# Ручная настройка browserToken

## Зачем это нужно

В текущем MVP расширение ещё не умеет само генерировать и привязывать браузерный токен через UI. Поэтому `browserToken` пока настраивается вручную: вы создаёте токен в браузере, сохраняете его в `chrome.storage.local`, а затем авторизуете этот же токен в Pi через `/chrome-assistent-auth`.

Без этого popup не даст начать отправку и покажет подсказку:

```text
Для отправки настройте browserToken в chrome.storage.local.
```

## Шаг 1. Создайте `browserToken` в браузере

Откройте DevTools service worker расширения и выполните:

```js
const browserToken = crypto.randomUUID();
await chrome.storage.local.set({ browserToken });
console.log(browserToken);
```

Скопируйте значение `browserToken` без лишних пробелов и переносов.

## Шаг 2. Проверьте, что значение сохранилось

```js
await chrome.storage.local.get("browserToken")
```

Ожидаемый результат:

```js
{ browserToken: "<тот же токен>" }
```

## Шаг 3. Авторизуйте токен в Pi

В нужной сессии Pi выполните:

```text
/chrome-assistent-auth
```

Когда Pi попросит токен, вставьте тот же `browserToken`.

## Шаг 4. Подключите нужную Pi-сессию

После авторизации браузера выполните:

```text
/chrome-assistent-connect [alias]
```

## Шаг 5. Обновите popup

Закройте и снова откройте popup расширения. После этого:

- сообщение про обязательный `browserToken` должно исчезнуть;
- кнопка **Отправить в Pi** станет доступной, если есть активные цели и выбрана цель.

## Как сменить токен

Если вы переключились на другой broker-контур или другой проект, нужно вручную заменить значение:

```js
await chrome.storage.local.set({
  browserToken: "<новый токен>"
});
```

## Как удалить токен

```js
await chrome.storage.local.remove("browserToken")
```

После удаления popup снова будет считать отправку недоступной.

## Важное ограничение текущего MVP

Сейчас это временный ручной flow:

- `browserToken` живёт в `chrome.storage.local` браузера;
- тот же токен нужно отдельно авторизовать в Pi через `/chrome-assistent-auth`;
- подключение конкретной Pi-сессии всё ещё выполняется отдельной командой `/chrome-assistent-connect`.

Если токен в браузере изменился, его нужно повторно авторизовать в Pi. Иначе popup будет видеть ошибки аутентификации или отсутствие доступных целей.

## Связанные документы

- [Установка и запуск](./setup.md)
- [Локальный broker](../architecture/broker.md)
- [Устранение неполадок](./troubleshooting.md)
