# Как превратить старый ноутбук в сервер для Joke book

Инструкция под конкретное железо (Intel Celeron J4125, 12 ГБ RAM, x64) и под
это приложение (Fastify-сервер + веб-клиент в одном Docker-образе + Postgres).

Цель в конце: приложение крутится на ноутбуке дома 24/7 и доступно с телефона
по адресу вида `https://jokes.твойдомен.com`. Это единственный прод приложения.

---

## Коротко про план

1. Поставить на ноутбук **Ubuntu Server** (лёгкая ОС без графики — идеально для
   Celeron с 12 ГБ; будет летать).
2. Настроить, чтобы ноут **не засыпал с закрытой крышкой**.
3. Поставить **Docker**.
4. Запустить **Postgres + приложение** одной командой (`docker compose up`).
5. Открыть доступ из интернета через **Tailscale Funnel** — бесплатно, без
   домена и без «проброса портов», бесплатный HTTPS, домашний IP не светится.
6. Настроить **бэкапы БД** и **автозапуск** после перезагрузки/света.

Celeron J4125 + 12 ГБ для этого приложения — с большим запасом. Оно почти
ничего не ест: Node-процесс + Postgres на паре пользователей — это единицы
процентов CPU и пара сотен мегабайт RAM.

---

## Что понадобится

- Сам ноутбук.
- USB-флешка на 8 ГБ (для установки Ubuntu) — **всё с неё сотрётся**.
- Второй компьютер, чтобы записать флешку и потом подключаться к серверу.
- Кабель Ethernet (желательно! Wi-Fi для сервера менее надёжен) в роутер.
- Бесплатный аккаунт Tailscale (регистрация через Google/Microsoft/email —
  ничего покупать не нужно, домен не требуется).

---

## Важное решение: Linux или оставить Windows?

Рекомендую **Ubuntu Server (Linux)**:

- на Celeron/12 ГБ Windows 11 съест заметную часть ресурсов на себя, Ubuntu
  Server — почти ничего (нет графики вообще);
- не будет самопроизвольных перезагрузок на обновления Windows посреди ночи;
- вся серверная экосистема (Docker, автозапуск, cron-бэкапы) в Linux проще.

Если совсем не хочется трогать Windows — в самом конце есть короткий
**Вариант Б: остаться на Windows**. Но основной путь ниже — Ubuntu.

> ⚠️ Установка Ubuntu **сотрёт всё** с диска ноутбука. Если там есть нужные
> файлы — сначала скопируйте их на другой диск/флешку.

---

## Шаг 1. Записать загрузочную флешку с Ubuntu Server

На своём обычном компьютере:

1. Скачайте **Ubuntu Server 24.04 LTS** (файл `.iso`) с
   <https://ubuntu.com/download/server>. Берите именно **Server**, не Desktop.
2. Скачайте **balenaEtcher** с <https://etcher.balena.io> (простая программа для
   записи флешек).
3. Вставьте флешку, откройте Etcher → *Flash from file* (выберите `.iso`) →
   *Select target* (выберите флешку) → *Flash*. Подождите пару минут.

---

## Шаг 2. Установить Ubuntu на ноутбук

1. Вставьте флешку в ноутбук, включите его и сразу жмите клавишу входа в
   **Boot Menu** (обычно `F12`, `F9`, `Esc` или `F2` — зависит от модели;
   мелькает подсказка при включении). Выберите загрузку с USB.
2. Запустится установщик Ubuntu Server. Пройдите шаги (стрелки + Enter):
   - язык — English (проще гуглить ошибки);
   - раскладку оставьте по умолчанию;
   - тип установки — **Ubuntu Server** (не minimized);
   - сеть — если воткнут кабель, адрес получится сам (запомните/сфоткайте
     показанный IP, напр. `192.168.1.42`);
   - proxy — пусто, Enter;
   - зеркало — по умолчанию;
   - диск — **Use an entire disk** (весь диск), подтвердите — тут данные и
     стираются;
   - **Profile**: придумайте имя, имя сервера (напр. `jokebook`), логин и
     **пароль** — запишите их, они понадобятся;
   - **важно**: на экране «SSH Setup» поставьте галочку **Install OpenSSH
     server** (пробел). Без неё нельзя будет подключаться удалённо;
   - Featured snaps — ничего не выбирайте, просто Done.
3. Дождитесь установки, выберите **Reboot**, **выньте флешку** когда попросит.

После перезагрузки ноут покажет чёрный экран с приглашением ввести логин. Это
нормально — дальше мы будем управлять им **с другого компьютера по SSH**, а этот
экран можно не трогать.

---

## Шаг 3. Подключиться к серверу по SSH и настроить сон

С вашего обычного компьютера откройте терминал (на Windows — PowerShell) и
подключитесь (подставьте свой логин и IP из шага 2):

```bash
ssh jokebook@192.168.1.42
```

Введите пароль. Вы «внутри» сервера. Дальше все команды выполняются здесь.

Сначала обновим систему:

```bash
sudo apt update && sudo apt upgrade -y
```

**Чтобы ноут не засыпал с закрытой крышкой** (это критично — иначе сервер
«уснёт»):

```bash
sudo sed -i 's/^#*HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
sudo sed -i 's/^#*HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
```

И на всякий случай запретим засыпание системы:

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Теперь можно закрывать крышку — ноут продолжит работать как сервер.

---

## Шаг 4. Установить Docker

Выполните по одной (официальный скрипт установки Docker):

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

Чтобы запускать docker без `sudo` — добавьте себя в группу и перезайдите:

```bash
sudo usermod -aG docker $USER
```

Выйдите (`exit`) и снова подключитесь по SSH. Проверьте:

```bash
docker --version
docker compose version
```

Обе команды должны показать версии — значит всё стоит.

---

## Шаг 5. Забрать код приложения на сервер

Приложение собирается прямо из вашего репозитория. Поставим git и склонируем
(подставьте свой адрес репозитория на GitHub):

```bash
sudo apt install -y git
git clone https://github.com/MaksSotnikov/jokebook.git
cd jokebook
```

> Если репозиторий приватный — git спросит логин и **токен** (не пароль).
> Токен создаётся на GitHub: Settings → Developer settings → Personal access
> tokens → *Generate new token (classic)*, галочка `repo`.

---

## Шаг 6. Файл запуска (Postgres + приложение)

Создадим один файл, который поднимает у вас дома и базу, и приложение.

Сначала сгенерируем два секрета (**сохраните вывод** — пригодится):

```bash
echo "DB_PASSWORD=$(openssl rand -hex 16)"
echo "JWT_SECRET=$(openssl rand -hex 32)"
```

Создайте файл:

```bash
nano docker-compose.prod.yml
```

Вставьте туда следующее (в редакторе nano: вставка — правая кнопка мыши или
`Ctrl+Shift+V`; сохранить — `Ctrl+O`, Enter; выйти — `Ctrl+X`). **Замените**
`ПАРОЛЬ_БД` и `СЕКРЕТ_JWT` на значения из команды выше:

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: notes
      POSTGRES_PASSWORD: ПАРОЛЬ_БД
      POSTGRES_DB: notes
    volumes:
      - notes_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U notes']
      interval: 5s
      timeout: 5s
      retries: 5

  app:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://notes:ПАРОЛЬ_БД@db:5432/notes
      JWT_SECRET: СЕКРЕТ_JWT
      PORT: 3001
    ports:
      - '3001:3001'
    depends_on:
      db:
        condition: service_healthy

volumes:
  notes_pgdata:
```

Запустите (первый раз соберётся образ — несколько минут на Celeron, это
нормально):

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Проверьте, что оба контейнера живы и приложение отвечает:

```bash
docker compose -f docker-compose.prod.yml ps
curl http://localhost:3001
```

`curl` должен вернуть HTML страницы. Если да — приложение работает локально.
С другого устройства в той же домашней сети оно уже доступно по
`http://192.168.1.42:3001` (ваш IP). Осталось открыть доступ из интернета.

Смотреть логи, если что-то не так:

```bash
docker compose -f docker-compose.prod.yml logs -f app
```

---

## Шаг 7. Доступ из интернета через Tailscale Funnel (бесплатно, без домена)

Tailscale Funnel даёт вашему серверу постоянный публичный HTTPS-адрес вида
`https://jokebook.tailXXXX.ts.net` — **бесплатно, без домена и без настройки
роутера**, и работает даже если провайдер не даёт «белый» IP. Любой телефон
открывает этот адрес в браузере как обычный сайт.

Единственный минус — адрес длинный и несимпатичный. Если позже захочется
красивый (`jokes.твойдомен.com`), в конце файла есть раздел «Свой домен +
Cloudflare» — на Funnel это никак не влияет, можно перейти в любой момент.

### 7.1. Установить Tailscale на сервер

По SSH на сервере:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Команда `tailscale up` напечатает ссылку — откройте её в браузере на любом
устройстве и войдите (Google/Microsoft/email). Это бесплатный **Personal**-план.
После входа сервер появится в вашей сети Tailscale.

### 7.2. Включить HTTPS в панели Tailscale (один раз)

Funnel выдаёт настоящий HTTPS-сертификат, но эту возможность надо включить в
веб-панели:

1. Откройте <https://login.tailscale.com/admin/dns>.
2. Убедитесь, что включён **MagicDNS**.
3. Включите **HTTPS Certificates** (кнопка *Enable HTTPS*). Здесь же увидите имя
   своей сети — часть адреса вида `tailXXXX.ts.net`.

### 7.3. Разрешить Funnel

Funnel по умолчанию выключен. Проще всего: просто выполните команду из
следующего шага — если Funnel не разрешён, Tailscale напечатает **ссылку**,
по которой одним кликом включается Funnel для вашего сервера. Откройте её,
подтвердите — и повторите команду.

(Если предпочитаете вручную: <https://login.tailscale.com/admin/acls> →
в политике добавить `nodeAttrs` с атрибутом `funnel` для `autogroup:member`.)

### 7.4. Опубликовать приложение

Ваш контейнер уже слушает порт `3001` на сервере (из compose). Отдаём его
в Funnel и оставляем работать в фоне (сохранится после перезагрузок):

```bash
sudo tailscale funnel --bg 3001
```

Проверьте статус — он покажет ваш публичный адрес:

```bash
tailscale funnel status
```

Увидите строку вида `https://jokebook.tailXXXX.ts.net → http://127.0.0.1:3001`.

Откройте этот адрес с телефона — должно открыться приложение с настоящим HTTPS.
На экране входа **Server URL оставьте пустым** (API и клиент на одном адресе),
зарегистрируйтесь.

Полезные команды:

```bash
tailscale funnel status      # показать текущий публичный адрес
sudo tailscale funnel --bg off   # выключить публичный доступ
tailscale status             # список устройств в вашей сети Tailscale
```

---

## Шаг 8. Бэкапы базы данных

Данные (аккаунты, заметки, шутки) лежат в Postgres. Раз в сутки будем делать
дамп в файл.

Создайте папку и скрипт:

```bash
mkdir -p ~/backups
nano ~/backup-db.sh
```

Вставьте:

```bash
#!/usr/bin/env bash
set -e
cd "$HOME/jokebook"
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U notes notes | gzip > "$HOME/backups/notes-$STAMP.sql.gz"
# держим только последние 14 копий
ls -1t "$HOME"/backups/notes-*.sql.gz | tail -n +15 | xargs -r rm --
```

Сделайте исполняемым и добавьте в расписание (каждый день в 3 ночи):

```bash
chmod +x ~/backup-db.sh
( crontab -l 2>/dev/null; echo "0 3 * * * $HOME/backup-db.sh" ) | crontab -
```

Иногда копируйте файлы из `~/backups` на другой диск/в облако — на случай если с
диском ноутбука что-то случится.

**Восстановление** из бэкапа (если понадобится):

```bash
gunzip -c ~/backups/notes-ГГГГММДД-ЧЧММСС.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T db psql -U notes -d notes
```

---

## Шаг 9. Обновление приложения

Когда вы что-то меняете в коде и пушите в GitHub, на сервере:

```bash
cd ~/jokebook
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Пересоберётся образ, миграции БД накатятся сами при старте (это делает ваш
`server/src/index.ts`). Данные в Postgres при этом не теряются — они в отдельном
volume.

---

## Автозапуск после отключения света

`restart: unless-stopped` в compose означает: контейнеры сами поднимутся, как
только загрузится Docker. А Docker стартует при загрузке Ubuntu автоматически.
То есть после перебоя электричества и включения ноутбука приложение поднимется
само. Проверить можно, перезагрузив сервер: `sudo reboot`, подождать минуту и
открыть сайт.

---

## Что делать НЕ надо (безопасность)

- Не открывайте порт 5432 (Postgres) в интернет и не пробрасывайте его на
  роутере. В нашей схеме наружу Funnel отдаёт только порт 3001 (само приложение).
- Не оставляйте пароль БД/`JWT_SECRET` дефолтными — мы их сгенерировали в шаге 6.
- Держите систему в актуальном состоянии: раз в пару недель
  `sudo apt update && sudo apt upgrade -y`.

---

## Вариант Б: остаться на Windows (если Linux совсем не хочется)

Можно не переустанавливать ОС:

1. Поставьте **Docker Desktop for Windows** (он поставит WSL2 сам).
2. В *Настройки Windows → Питание* → «При закрытии крышки» и «Спящий режим» →
   поставьте **«Действие не требуется» / Никогда** (иначе сервер уснёт).
3. В Docker Desktop → Settings → General включите **Start Docker Desktop when
   you log in**, и настройте автовход в Windows (иначе после перезагрузки
   контейнеры не поднимутся, пока кто-то не залогинится).
4. Шаги 5–9 (клонирование репо, `docker compose ... up`, Tailscale Funnel,
   бэкапы) — те же; Tailscale ставится через установщик для Windows с сайта
   tailscale.com, остальные команды выполняются в PowerShell из папки с проектом.

Минусы против Ubuntu: Windows заметно тяжелее для Celeron, сам перезагружается
на обновления, и автозапуск сервера завязан на вход пользователя. Поэтому для
«поставил и забыл» Ubuntu Server надёжнее.

---

## Если что-то не работает — куда смотреть

| Симптом | Команда для диагностики |
|---|---|
| Сайт не открывается | `docker compose -f docker-compose.prod.yml ps` — все ли `Up` |
| Приложение падает | `docker compose -f docker-compose.prod.yml logs -f app` |
| БД не стартует | `docker compose -f docker-compose.prod.yml logs -f db` |
| Публичный адрес не работает | `tailscale funnel status` (есть ли строка `→ 127.0.0.1:3001`) и `tailscale status` |
| Funnel «не разрешён» | выполните `sudo tailscale funnel --bg 3001` ещё раз и откройте ссылку, которую она напечатает |
| Локально (в сети) работает, извне нет | проверьте, что включён HTTPS в панели Tailscale (Шаг 7.2) |

---

## На будущее: свой домен + Cloudflare (красивый адрес)

Если позже захотите адрес вида `jokes.твойдомен.com` вместо `*.ts.net`:

1. Купите дешёвый домен (Namecheap/Porkbun, бывают зоны ~1–3$/год) — нужен именно
   **корневой** домен, который вы регистрируете сами (Cloudflare не принимает
   чужие поддомены на бесплатном плане).
2. Заведите аккаунт на <https://dash.cloudflare.com> → *Add a site* →
   *Connect a domain* → введите домен → план **Free** → пропишите выданные
   Cloudflare **nameserver'ы** у регистратора.
3. В панели: **Zero Trust** → **Networks** → **Tunnels** → *Create a tunnel* →
   тип **Cloudflared** → скопируйте `TUNNEL_TOKEN` из показанной команды.
4. Добавьте в `docker-compose.prod.yml` сервис `cloudflared`:

   ```yaml
     cloudflared:
       image: cloudflare/cloudflared:latest
       restart: unless-stopped
       command: tunnel run
       environment:
         TUNNEL_TOKEN: ВАШ_ТОКЕН
       depends_on:
         - app
   ```
5. В туннеле → **Public Hostnames** → *Add*: Subdomain `jokes`, ваш домен,
   Type `HTTP`, URL `app:3001`. Сохраните и `docker compose -f
   docker-compose.prod.yml up -d`.

Funnel и Cloudflare можно держать одновременно — приложение будет доступно по
обоим адресам.
