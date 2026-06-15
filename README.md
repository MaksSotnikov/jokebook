# notes-app

Аналог Obsidian: локальные markdown-заметки со связями (`[[wiki-links]]`),
backlinks, полнотекстовым поиском и тегами, с синхронизацией между десктопом и
телефоном через собственный бэкенд.

## Стек

- **Клиент:** Tauri 2.0 + React + TypeScript (desktop + iOS/Android, единый UI).
- **Бэкенд:** Node + TypeScript (Fastify) + PostgreSQL, sync-API.
- **Локальное хранилище:** `.md`-файлы на диске + SQLite-индекс (поиск/связи/мета).
- **Конфликты:** поверсионно + timestamp (last-write-wins + conflict-копии).

## Структура (монорепо, pnpm workspaces)

```
apps/app/        Tauri 2.0 приложение (desktop + mobile)
  src/           React + TS фронтенд (общий)
  src-tauri/     Rust-слой: ФС, SQLite, нативные API
packages/core/   Чистая TS-логика: парсинг markdown, wiki-links, sync-движок
server/          Node + TS бэкенд (Fastify), PostgreSQL, sync-API
```

## Требования

- Node 20+ и pnpm 9+
- Rust (rustup) + Microsoft C++ Build Tools — для сборки Tauri
- Docker (для локального PostgreSQL)

## Команды

```bash
pnpm install          # установить зависимости
pnpm build            # собрать все пакеты
pnpm test             # запустить тесты
pnpm typecheck        # проверка типов
pnpm lint             # линт

# бэкенд
docker compose -f server/docker-compose.yml up -d   # поднять Postgres
pnpm --filter @notes/server dev                      # запустить сервер

# клиент (после установки Rust)
pnpm --filter @notes/app tauri dev                   # десктоп-дев
```

## Статус

- ✅ **Этап 0** — каркас монорепо (core / server / app), сборка, тесты, типы, линт зелёные.
- ✅ **core** — парсер заметок (`[[wiki-links]]`, `#tags`, frontmatter), граф ссылок/backlinks,
  движок синхронизации (LWW + conflict-копии). 25 юнит-тестов.
- ✅ **server (Этап 3, бэкенд)** — Fastify + Drizzle + Postgres, auth (argon2 + JWT),
  sync-API `pull`/`push` с разрешением конфликтов. 6 интеграционных тестов на PGlite
  (Postgres в WASM, без Docker).
- ⏳ **Tauri-клиент (Этапы 1–2 UI, Этап 4)** — ожидает установки **Rust + MSVC Build Tools**.
  Фронтенд `apps/app` уже собирается (Vite), но нативная часть требует Rust.

### Заметки по окружению (Windows)

- `pnpm` установлен глобально через `npm i -g pnpm` (corepack упёрся в права на
  `C:\Program Files\nodejs`). Путь `…\AppData\Roaming\npm` добавлен в user PATH.
- Tauri требует **Rust (rustup, MSVC-тулчейн)** и **MS C++ Build Tools** — пока не установлены.
  WebView2 уже присутствует.
- Тесты сервера используют PGlite, поэтому Docker для разработки не обязателен;
  для прод-подобного запуска — `docker compose -f server/docker-compose.yml up -d`.

См. план разработки: этапы 0–4.
