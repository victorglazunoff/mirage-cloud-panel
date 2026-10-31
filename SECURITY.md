# Безопасность / Security

## Как сообщить об уязвимости

Пожалуйста, **не открывайте публичный issue** про уязвимость. Сообщите приватно через
[GitHub Security Advisories](https://github.com/victorglazunoff/mirage-cloud-panel/security/advisories/new)
этого репозитория (вкладка **Security → Report a vulnerability**).

Опишите:

- что не так и чем это грозит (например: вход без пароля, чтение чужих файлов, выполнение команд);
- как воспроизвести — версия (`mirage --version`), настройки, запросы или шаги;
- как панель была доступна: только `127.0.0.1`, за прокси, открыта в сеть.

Мы ответим в течение недели, договоримся о сроках исправления и упомянем вас в описании релиза, если вы не против.

Уязвимость в коде, который пришёл из оригинального CloudCLI UI без изменений, по возможности сообщите и
[его авторам](https://github.com/siteboon/claudecodeui/security).

## Поддерживаемые версии

Исправления выходят только для последнего релиза. Обновление — `git pull --ff-only && npm ci --include=dev && npm run build`
и перезапуск службы (см. README).

## Что считается уязвимостью

Панель по своей сути даёт владельцу полный доступ к серверу: терминал, файлы, запуск Claude Code. Уязвимость — это
когда такой доступ (или его часть) получает **кто-то, кроме владельца**: обход входа или 2FA, подделка сессии, чтение
файлов вне `WORKSPACES_ROOT` без входа, XSS, через который чужая страница действует от имени владельца, утечка
секретов интеграций и тому подобное.

Не уязвимость: то, что вошедший владелец может выполнять команды на сервере, и то, что первый посетитель
незарегистрированной панели становится владельцем (поэтому панель по умолчанию слушает только `127.0.0.1`).

---

**English.** Please do not open public issues for security problems. Report them privately via
[GitHub Security Advisories](https://github.com/victorglazunoff/mirage-cloud-panel/security/advisories/new)
(Security → Report a vulnerability) with the version, the setup and steps to reproduce. We aim to reply within a week.
Only the latest release receives fixes.
