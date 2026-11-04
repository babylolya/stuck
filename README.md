# STUCK · сайт + Telegram-бот

Как это работает:
ты отправляешь стикер боту → бот кладёт фото в GitHub → GitHub сам обрезает фон, присваивает номер STK-000N и публикует сайт → бот присылает ссылку.
Всё бесплатно. Настраивается один раз, примерно за 20 минут.

Что в папке:
- `index.html`, `items/`, `tape/`, `fonts/`, `pole_tile.jpg`, `items.json` · сам сайт
- `tools/process.py` · обрезка фона (rembg), выпрямление, номера
- `.github/workflows/build.yml` · запускает обработку и публикует сайт
- `worker/worker.js` · код бота для Cloudflare

---

## 1. Бот в Telegram (1 минута)

1. Открой **@BotFather** → `/newbot`.
2. Имя: `STUCK archive`. Username: например `stuck_archive_bot` (должен кончаться на `bot`).
3. BotFather пришлёт **токен** вида `123456:ABC...`. Сохрани его, он понадобится два раза.

## 2. GitHub (10 минут)

1. Открой **github.com/new**. Название `stuck`, тип **Public**, нажми *Create repository*.
2. На странице репозитория нажми ссылку **uploading an existing file**.
3. Распакуй архив и перетащи в окно **всё содержимое папки `stuck`**.
   Важно: там есть скрытая папка `.github`. На Mac в Finder нажми **Cmd + Shift + .** (точка), она появится, перетащи и её.
   Внизу нажми **Commit changes**.
4. **Settings → Pages** → в поле *Source* выбери **GitHub Actions**.
5. **Settings → Secrets and variables → Actions → New repository secret**
   Name: `TG_TOKEN`, Secret: токен бота. *Add secret*.
6. Токен, чтобы бот мог класть фото: открой **github.com/settings/personal-access-tokens/new**
   - Token name: `stuck-bot`, Expiration: максимум (или *No expiration*)
   - Repository access: **Only select repositories** → `stuck`
   - Permissions → Repository permissions → **Contents: Read and write**
   - *Generate token*, скопируй (`github_pat_...`).
7. Вкладка **Actions** → слева **archive** → **Run workflow**. Через 1–2 минуты сайт будет на
   `https://ТВОЙ-ЛОГИН.github.io/stuck/`

## 3. Cloudflare (7 минут)

1. Зарегистрируйся на **dash.cloudflare.com** (бесплатно, только почта).
2. Слева **Storage & Databases → KV → Create** → название `stuck-state`.
3. Слева **Compute (Workers) → Create → Start with Hello World** → имя `stuck-bot` → *Deploy*.
4. **Edit code** → удали всё → вставь целиком `worker/worker.js` → **Deploy**.
5. Вернись в воркер → **Settings → Bindings → Add → KV namespace**
   Variable name: `STATE`, namespace: `stuck-state`.
6. **Settings → Variables and Secrets → Add**:
   | Name | Type | Value |
   |---|---|---|
   | `TG_TOKEN` | Secret | токен бота |
   | `GH_TOKEN` | Secret | `github_pat_...` |
   | `HOOK_SECRET` | Secret | любое слово латиницей, например `peeledpole77` |
   | `GH_REPO` | Text | `ТВОЙ-ЛОГИН/stuck` |
7. Открой в браузере `https://stuck-bot.ТВОЙ-ПОДДОМЕН.workers.dev/setup`
   (адрес видно на странице воркера). Должно быть `"ok": true`.

## 4. Привязать бота к себе

1. Напиши боту `/start`. Он ответит твоим **Telegram id**.
2. В Cloudflare добавь ещё одну переменную: `OWNER_ID` (Text) = этот номер. Теперь бот слушается только тебя.

## Как добавлять стикер

`/new` → лицевая сторона → оборот → макро (сколько хочешь) → геолокация → подтвердить город → тип → дата → заметка → **Отправить в архив**.

- Фото лучше слать **файлом** (📎 → Файл): без сжатия, фон обрежется чище.
- Фон любой. Прямоугольные стикеры выпрямляются сами, фигурные и рваные вырезаются по контуру.
- Через 2–4 минуты бот пришлёт ссылку на карточку стикера.

## Мелочи

- Убрать временные (нарисованные) стикеры: в `index.html` поменяй `SHOW_PLACEHOLDERS = true` на `false`.
- Исправить город или заметку у готового стикера: `items.json` на GitHub → карандаш → правишь → *Commit*. Сайт обновится сам.
- Если обработка упала: вкладка **Actions** → красный запуск → там видна ошибка. Пришли мне скрин.
