// STUCK · Telegram bot on Cloudflare Workers (free plan).
// Receives a sticker (front, back, close-ups, location, a few answers),
// then puts everything into the GitHub repo in ONE commit under inbox/.
// GitHub Actions cuts the background, adds the sticker to items.json and publishes the site.
//
// Settings (Cloudflare → Worker → Settings → Variables and Secrets):
//   TG_TOKEN       secret  token from @BotFather
//   GH_TOKEN       secret  GitHub fine-grained token, repo "Contents: Read and write"
//   HOOK_SECRET    secret  any random word, protects the webhook
//   GH_REPO        text    e.g. babylolya/stuck
//   OWNER_ID       text    your Telegram user id (the bot tells you on /start)
// KV binding:      STATE   (a KV namespace, any name)

const TYPES = ["Music", "Party", "Loans", "Rent", "Lost", "Love", "Slogans", "Name tag", "Portrait", "Art", "Ads", "Other"];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/setup") {
      const r = await tg(env, "setWebhook", {
        url: url.origin + "/hook",
        secret_token: env.HOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      await tg(env, "setMyCommands", { commands: [
        { command: "new", description: "Новый стикер" },
        { command: "cancel", description: "Отменить текущий" },
      ]});
      return new Response(JSON.stringify(r, null, 2), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/hook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.HOOK_SECRET) return new Response("no", { status: 403 });
      const u = await req.json();
      try { await handle(u, env); }
      catch (e) {
        const chat = u.message?.chat.id || u.callback_query?.message.chat.id;
        if (chat) await send(env, chat, "Ошибка: " + (e.message || e));
      }
      return new Response("ok");
    }
    return new Response("STUCK bot", { status: 200 });
  },
};

// ---------- telegram helpers ----------
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows.map(r => r.map(([text, data]) => ({ text, callback_data: data }))) } });
const send = (env, chat, text, extra = {}) => tg(env, "sendMessage", { chat_id: chat, text, ...extra });

const getState = async (env, chat) => JSON.parse((await env.STATE.get("s:" + chat)) || "null");
const putState = (env, chat, st) => env.STATE.put("s:" + chat, JSON.stringify(st), { expirationTtl: 60 * 60 * 24 * 3 });
const dropState = (env, chat) => env.STATE.delete("s:" + chat);

function fileOf(msg) {
  if (msg.photo) return { id: msg.photo[msg.photo.length - 1].file_id, ext: "jpg" };
  if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
    const n = (msg.document.file_name || "x.jpg").toLowerCase();
    return { id: msg.document.file_id, ext: (n.split(".").pop() || "jpg").replace("jpeg", "jpg") };
  }
  return null;
}

// ---------- conversation ----------
async function handle(u, env) {
  const msg = u.message, cb = u.callback_query;
  const from = (msg || cb).from.id, chat = msg ? msg.chat.id : cb.message.chat.id;

  if (msg && msg.text === "/start") {
    return send(env, chat,
      "Это бот архива STUCK.\n\nТвой Telegram id: " + from +
      "\n(впиши его в OWNER_ID, если ещё не вписала)\n\nНажми /new, чтобы добавить стикер.");
  }
  if (env.OWNER_ID && String(from) !== String(env.OWNER_ID)) return send(env, chat, "Это личный бот архива.");

  let st = await getState(env, chat);
  const data = cb?.data;
  if (cb) await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });

  if (msg?.text === "/cancel" || data === "cancel") { await dropState(env, chat); return send(env, chat, "Отменила. /new, чтобы начать заново."); }
  if (msg?.text === "/new" || data === "new" || (!st && msg && fileOf(msg))) {
    st = { step: "front", details: [], date: today() };
    await putState(env, chat, st);
    if (!(msg && fileOf(msg))) return send(env, chat, "1/6. Пришли ЛИЦЕВУЮ сторону.\nЛучше файлом (📎 → Файл), так без сжатия. Фон можно любой, он обрежется сам.");
  }
  if (!st) return send(env, chat, "Нажми /new, чтобы добавить стикер.");

  const f = msg && fileOf(msg);
  const loc = msg?.location || msg?.venue?.location;

  switch (st.step) {
    case "front":
      if (!f) return send(env, chat, "Жду фото лицевой стороны.");
      st.front = f; st.step = "back"; await putState(env, chat, st);
      return send(env, chat, "2/6. Теперь ОБОРОТ (клеевую сторону).", kb([[["Оборота нет", "noback"]]]));

    case "back":
      if (data === "noback") st.back = null;
      else if (f) st.back = f;
      else return send(env, chat, "Жду фото оборота или нажми «Оборота нет».");
      st.step = "details"; await putState(env, chat, st);
      return send(env, chat, "3/6. Макро-фото деталей, сколько хочешь (можно альбомом).\nКогда всё, пришли ГЕОЛОКАЦИЮ места, где сняла стикер (📎 → Геопозиция, можно передвинуть точку).",
        kb([[["Без макро, дальше", "nodetails"]]]));

    case "details":
      if (f) { st.details.push(f); await putState(env, chat, st); return; } // silent, albums come as many messages
      if (data === "nodetails") return send(env, chat, "Пришли геолокацию (📎 → Геопозиция).", kb([[["Места не помню", "noloc"]]]));
      if (loc || data === "noloc") {
        if (loc) {
          st.lat = +loc.latitude.toFixed(5); st.lon = +loc.longitude.toFixed(5);
          Object.assign(st, await geocode(st.lat, st.lon));
        } else { st.city = "to be added"; st.street = "to be added"; st.country = ""; }
        st.step = "place"; await putState(env, chat, st);
        return send(env, chat, `4/6. Место:\n${st.city}, ${st.country}\n${st.street}\n\nВерно?`,
          kb([[["Да", "placeok"], ["Исправить", "placeedit"]]]));
      }
      return send(env, chat, "Жду макро-фото или геолокацию.");

    case "place":
      if (data === "placeedit") { st.step = "placetext"; await putState(env, chat, st); return send(env, chat, "Напиши так: Город, улица\nНапример: Bangkok, Sukhumvit 22"); }
      if (data !== "placeok") return;
      return askType(env, chat, st);

    case "placetext": {
      if (!msg?.text) return;
      const [c, ...rest] = msg.text.split(",");
      st.city = c.trim(); if (rest.length) st.street = rest.join(",").trim();
      return askType(env, chat, st);
    }

    case "type":
      if (data?.startsWith("t:")) st.type = data.slice(2);
      else if (msg?.text) st.type = msg.text.trim();
      else return;
      st.step = "date"; await putState(env, chat, st);
      return send(env, chat, "5/6. Когда сняла?\nНапиши дату ДД.ММ.ГГГГ или нажми кнопку.", kb([[["Сегодня, " + st.date, "today"]]]));

    case "date":
      if (data !== "today") {
        const m = (msg?.text || "").match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
        if (!m) return send(env, chat, "Формат: 24.10.2026");
        st.date = `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
      }
      st.step = "note"; await putState(env, chat, st);
      return send(env, chat, "6/6. Одна фраза о стикере по-английски (заметка в карточке). Можно пропустить.", kb([[["Пропустить", "skip"]]]));

    case "note":
      st.note = data === "skip" ? "" : (msg?.text || "").trim();
      st.step = "confirm"; await putState(env, chat, st);
      return send(env, chat,
        `Проверь:\n• ${st.city}, ${st.street}\n• ${st.type}\n• ${st.date}\n• фото: лицо${st.back ? ", оборот" : ""}${st.details.length ? ", макро ×" + st.details.length : ""}\n• ${st.note || "без заметки"}`,
        kb([[["Отправить в архив", "go"]], [["Отменить", "cancel"]]]));

    case "confirm":
      if (data !== "go") return;
      st.step = "sending"; await putState(env, chat, st);
      await send(env, chat, "Загружаю…");
      await commitToGitHub(env, st, chat);
      await dropState(env, chat);
      return send(env, chat, "Готово. Обрезаю фон и публикую, это 2–4 минуты. Пришлю ссылку.");
  }
}

async function askType(env, chat, st) {
  st.step = "type"; await putState(env, chat, st);
  const rows = []; for (let i = 0; i < TYPES.length; i += 3) rows.push(TYPES.slice(i, i + 3).map(t => [t, "t:" + t]));
  return send(env, chat, "Что это за стикер? Выбери или напиши своё слово.", kb(rows));
}

function today() {
  const d = new Date(Date.now() + 7 * 3600e3); // Bangkok time
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

async function geocode(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=en&zoom=17`,
      { headers: { "User-Agent": "stuck-archive-bot/1.0" } });
    const j = await r.json(), a = j.address || {};
    return {
      city: a.city || a.town || a.village || a.municipality || a.state || "to be added",
      street: a.road || a.pedestrian || a.suburb || a.neighbourhood || "to be added",
      country: a.country || "",
    };
  } catch { return { city: "to be added", street: "to be added", country: "" }; }
}

// ---------- GitHub: all files in one commit ----------
async function gh(env, path, method = "GET", body) {
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: "Bearer " + env.GH_TOKEN, accept: "application/vnd.github+json", "user-agent": "stuck-bot", "content-type": "application/json" },
  });
  if (!r.ok) throw new Error("GitHub " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}
function b64(buf) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function download(env, f) {
  const info = await tg(env, "getFile", { file_id: f.id });
  if (!info.ok) throw new Error("Telegram не отдал файл (больше 20 МБ?)");
  const r = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${info.result.file_path}`);
  return r.arrayBuffer();
}
async function commitToGitHub(env, st, chat) {
  const dir = "inbox/" + Date.now();
  const files = [["front." + st.front.ext, st.front]];
  if (st.back) files.push(["back." + st.back.ext, st.back]);
  st.details.forEach((d, i) => files.push([`detail${i + 1}.${d.ext}`, d]));

  const tree = [];
  for (const [name, f] of files) {
    const blob = await gh(env, "/git/blobs", "POST", { content: b64(await download(env, f)), encoding: "base64" });
    tree.push({ path: `${dir}/${name}`, mode: "100644", type: "blob", sha: blob.sha });
  }
  const meta = {
    city: st.city, street: st.street, country: st.country || "", lat: st.lat ?? null, lon: st.lon ?? null,
    date: st.date, type: st.type || "Other", note: st.note || "", chat,
    files: files.map(([n]) => n),
  };
  tree.push({ path: `${dir}/meta.json`, mode: "100644", type: "blob", content: JSON.stringify(meta, null, 1) });

  const ref = await gh(env, "/git/ref/heads/main");
  const head = await gh(env, "/git/commits/" + ref.object.sha);
  const t = await gh(env, "/git/trees", "POST", { base_tree: head.tree.sha, tree });
  const c = await gh(env, "/git/commits", "POST", { message: `inbox: ${st.city} ${st.date}`, tree: t.sha, parents: [ref.object.sha] });
  await gh(env, "/git/refs/heads/main", "PATCH", { sha: c.sha });
}
