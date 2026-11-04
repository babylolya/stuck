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
        { command: "edit", description: "Изменить стикер в архиве" },
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
      "\n\n/new · добавить стикер\n/edit · изменить или удалить стикер в архиве");
  }
  if (env.OWNER_ID && String(from) !== String(env.OWNER_ID)) return send(env, chat, "Это личный бот архива.");

  let st = await getState(env, chat);
  const data = cb?.data;
  if (cb) await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });

  if (msg?.text === "/cancel" || data === "cancel") { await dropState(env, chat); return send(env, chat, "Отменила. /new, чтобы начать заново."); }
  if (msg?.text === "/edit" || data === "edit") return editList(env, chat);
  if (data?.startsWith("e:")) return editOpen(env, chat, data.slice(2));
  if (data?.startsWith("f:")) return editField(env, chat, data.slice(2));
  if (data?.startsWith("del:")) return send(env, chat, "Точно удалить " + data.slice(4) + " из архива?", kb([[["Да, удалить", "delok:" + data.slice(4)], ["Нет", "e:" + data.slice(4)]]]));
  if (data?.startsWith("delok:")) { await saveItems(env, items => items.filter(i => i.id !== data.slice(6)), "archive: remove " + data.slice(6)); await dropState(env, chat); return send(env, chat, data.slice(6) + " удалён. Сайт обновится через минуту.", kb([[["К списку", "edit"]]])); }
  if (st?.step === "edit" && msg?.text) return editSave(env, chat, st, msg.text.trim());

  if (msg?.text === "/new" || data === "new" || (!st && msg && fileOf(msg))) {
    st = { step: "front", details: [], date: today() };
    await putState(env, chat, st);
    if (!(msg && fileOf(msg))) return send(env, chat, "1/6. Пришли ЛИЦЕВУЮ сторону.\nЛучше файлом (📎 → Файл), так без сжатия. Фон можно любой, он обрежется сам.");
  }
  if (!st) return send(env, chat, "Нажми /new, чтобы добавить стикер.");

  const f = msg && fileOf(msg);
  let loc = msg?.location || msg?.venue?.location;
  if (!loc && msg?.text && /google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\./i.test(msg.text)) {
    loc = await fromGoogleLink(msg.text);
    if (!loc) return send(env, chat, "Не смогла достать точку из этой ссылки. Пришли геопозицию через 📎 → Геопозиция.");
  }

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
      return send(env, chat, "3/6. Макро-фото деталей, сколько хочешь (можно альбомом).\nКогда всё, пришли ГЕОЛОКАЦИЮ места, где сняла стикер: 📎 → Геопозиция или ссылку-метку из Google Maps.",
        kb([[["Без макро, дальше", "nodetails"]]]));

    case "details":
      if (f) { st.details.push(f); await putState(env, chat, st); return; } // silent, albums come as many messages
      if (data === "nodetails") return send(env, chat, "Пришли геолокацию (📎 → Геопозиция) или ссылку-метку из Google Maps.", kb([[["Места не помню", "noloc"]]]));
      if (loc || data === "noloc") {
        if (loc) {
          st.lat = +loc.latitude.toFixed(5); st.lon = +loc.longitude.toFixed(5);
          Object.assign(st, await geocode(st.lat, st.lon));
        } else { st.city = "to be added"; st.street = "to be added"; st.country = ""; }
        st.step = "place"; await putState(env, chat, st);
        return send(env, chat, `4/6. Место:\n${st.city}, ${st.country}\n${st.street}\n\nВерно?`,
          kb([[["Да", "placeok"], ["Исправить", "placeedit"]]]));
      }
      return send(env, chat, "Жду макро-фото, геолокацию или ссылку из Google Maps.");

    case "place":
      if (data === "placeedit") { st.step = "placetext"; await putState(env, chat, st); return send(env, chat, "Напиши так: Город, улица\nНапример: Bangkok, Sukhumvit 22"); }
      if (data !== "placeok") return;
      return askType(env, chat, st);

    case "placetext": {
      if (!msg?.text) return;
      const [c, ...rest] = msg.text.split(",");
      const g = await geocodeCity(msg.text) || await geocodeCity(c);
      if (g) Object.assign(st, g); else st.city = c.trim();
      if (rest.length) st.street = rest.join(",").trim();
      await send(env, chat, `Записала: ${st.city}${st.country ? ", " + st.country : ""}${rest.length ? " · " + st.street : ""}`);
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
      st.step = "size"; await putState(env, chat, st);
      return send(env, chat, "Размер в сантиметрах: ширина и высота, например 4x2 или 10x10. Можно примерно, это нужно, чтобы на столбе стикеры были в настоящем масштабе.", kb([[["Не знаю", "skip"]]]));

    case "size":
      if (data !== "skip") {
        const cm = parseCm(msg?.text || "");
        if (!cm) return send(env, chat, "Напиши так: 4x2 (ширина x высота в см)");
        st.cm = cm;
      }
      st.step = "title"; await putState(env, chat, st);
      return send(env, chat, "Название стикера, если хочешь (например: Hello my name is). Можно пропустить.", kb([[["Пропустить", "skip"]]]));

    case "title":
      st.title = data === "skip" ? "" : (msg?.text || "").trim();
      st.step = "note"; await putState(env, chat, st);
      return send(env, chat, "Последнее: одна фраза о стикере по-английски (заметка в карточке). Можно пропустить.", kb([[["Пропустить", "skip"]]]));

    case "note":
      st.note = data === "skip" ? "" : (msg?.text || "").trim();
      st.step = "confirm"; await putState(env, chat, st);
      return send(env, chat,
        `Проверь:\n• ${st.title || "без названия"}\n• ${st.city}, ${st.street}\n• ${st.type}\n• ${st.date}\n• ${st.cm ? st.cm[0] + " × " + st.cm[1] + " см" : "размер не указан"}\n• фото: лицо${st.back ? ", оборот" : ""}${st.details.length ? ", макро ×" + st.details.length : ""}\n• ${st.note || "без заметки"}`,
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

function parseCm(t) {
  const m = t.replace(",", ".").match(/(\d+(?:\.\d+)?)\s*[xх×*на ]+\s*(\d+(?:\.\d+)?)/i);
  return m ? [+m[1], +m[2]] : null;
}

// ---------- edit menu ----------
const FIELDS = [["title", "Название"], ["city", "Город"], ["street", "Улица"], ["date", "Дата"], ["type", "Тема"],
  ["cm", "Размер"], ["note", "Заметка"], ["under", "Что было под ним"]];
const HINT = { title: "Напиши название", city: "Напиши город (можно по-русски), страна и точка на карте подставятся сами", street: "Напиши улицу или район", country: "Напиши страну",
  date: "Дата: ДД.ММ.ГГГГ", type: "Тема одним словом: Music, Ads, Lost…", cm: "Размер: ширина x высота в см, например 4x2",
  note: "Одна фраза по-английски для карточки", under: "Что было под стикером, когда ты его сняла (по-английски)" };

async function loadItems(env) {
  const f = await gh(env, "/contents/items.json?ref=main");
  const bytes = Uint8Array.from(atob(f.content.replace(/\n/g, "")), c => c.charCodeAt(0));
  return { items: JSON.parse(new TextDecoder().decode(bytes)), sha: f.sha };
}
async function saveItems(env, change, message) {
  for (let i = 0; i < 3; i++) {
    const { items, sha } = await loadItems(env);
    const next = change(items);
    try {
      await gh(env, "/contents/items.json", "PUT", { message, sha, branch: "main",
        content: b64(new TextEncoder().encode(JSON.stringify(next, null, 1))) });
      return;
    } catch (e) { if (!/409|422/.test(e.message)) throw e; }
  }
  throw new Error("GitHub занят, попробуй ещё раз через минуту");
}
const label = it => `${it.id}${it.title ? " · " + it.title : ""}${it.city && it.city !== "to be added" ? " · " + it.city : ""}`;

async function editList(env, chat) {
  const { items } = await loadItems(env);
  if (!items.length) return send(env, chat, "В архиве пока пусто. /new");
  return send(env, chat, "Какой стикер изменить?", kb(items.map(it => [[label(it).slice(0, 60), "e:" + it.id]])));
}
async function editOpen(env, chat, id) {
  const { items } = await loadItems(env);
  const it = items.find(i => i.id === id);
  if (!it) return send(env, chat, "Не нашла " + id);
  const show = v => (v == null || v === "" ? "·" : Array.isArray(v) ? v.join(" × ") + " см" : v);
  const text = it.id + "\n\n" + FIELDS.map(([k, n]) => `${n}: ${show(it[k])}`).join("\n") + "\n\nЧто поменять?";
  const btn = FIELDS.map(([k, n]) => [n, `f:${id}:${k}`]);
  const rows = []; for (let i = 0; i < btn.length; i += 3) rows.push(btn.slice(i, i + 3));
  rows.push([["Удалить стикер", "del:" + id], ["К списку", "edit"]]);
  return send(env, chat, text, kb(rows));
}
async function editField(env, chat, ref) {
  const [id, field, clear] = ref.split(":");
  if (clear) return editSave(env, chat, { id, field }, null);
  await putState(env, chat, { step: "edit", id, field });
  return send(env, chat, `${id} · ${FIELDS.find(f => f[0] === field)[1]}\n${HINT[field]}`, kb([[["Очистить", "f:" + ref + ":clear"]], [["Отмена", "e:" + id]]]));
}
async function editSave(env, chat, st, value) {
  let v = value;
  if (value === null) v = st.field === "cm" ? null : "";
  else if (st.field === "cm") { v = parseCm(value); if (!v) return send(env, chat, HINT.cm); }
  if (st.field === "date" && value !== null) {
    const m = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!m) return send(env, chat, HINT.date);
    v = `${m[1].padStart(2, "0")}.${m[2].padStart(2, "0")}.${m[3]}`;
  }
  const g = st.field === "city" && v ? await geocodeCity(v) : null;
  await saveItems(env, items => items.map(it => {
    if (it.id !== st.id) return it;
    const n = { ...it, [st.field]: v, ...(g || {}) };
    if (st.field === "date" && v) n.year = +v.slice(-4);
    return n;
  }), `archive: ${st.id} ${st.field}`);
  await dropState(env, chat);
  await send(env, chat, "Сохранила. Сайт обновится через минуту.");
  return editOpen(env, chat, st.id);
}

async function askType(env, chat, st) {
  st.step = "type"; await putState(env, chat, st);
  const rows = []; for (let i = 0; i < TYPES.length; i += 3) rows.push(TYPES.slice(i, i + 3).map(t => [t, "t:" + t]));
  rows.push([["Пропустить", "t:Other"]]);
  return send(env, chat, "Тема стикера (по ней можно фильтровать архив): реклама, музыка, пропажа и т.д. Выбери, напиши своё слово или пропусти.", kb(rows));
}

function today() {
  const d = new Date(Date.now() + 7 * 3600e3); // Bangkok time
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

// Google Maps link -> {latitude, longitude}. Short links (maps.app.goo.gl) are followed to the full one.
async function fromGoogleLink(text) {
  let url = (text.match(/https?:\/\/\S+/) || [])[0];
  if (!url) return null;
  for (let i = 0; i < 5 && /goo\.gl/.test(url); i++) {
    const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
    const next = r.headers.get("location");
    if (!next) { const body = await r.text(); const m = body.match(/https:\/\/www\.google\.[^"'\s]+\/maps[^"'\s]*/); url = m ? m[0] : url; break; }
    url = next;
  }
  try { url = decodeURIComponent(url); } catch {}
  const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&](?:q|ll|query|center|destination)=(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/, /\/(?:search|place|dir)\/(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/];
  for (const p of pats) { const m = url.match(p); if (m) return { latitude: +m[1], longitude: +m[2] }; }
  // a place link without coordinates: look the place name up in OpenStreetMap
  const name = (url.match(/\/place\/([^/@?]+)/) || url.match(/[?&]q=([^&]+)/) || [])[1];
  if (name) {
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(name.replace(/\+/g, " ")),
        { headers: { "User-Agent": "stuck-archive-bot/1.0" } });
      const j = await r.json(); if (j[0]) return { latitude: +j[0].lat, longitude: +j[0].lon };
    } catch {}
  }
  return null;
}

// city typed by hand (any language) -> English name, country and a point for the map
async function geocodeCity(q) {
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&accept-language=en&q=" + encodeURIComponent(q.trim()),
      { headers: { "User-Agent": "stuck-archive-bot/1.0" } });
    const j = (await r.json())[0];
    if (!j) return null;
    const a = j.address || {};
    return {
      city: a.city || a.town || a.village || a.island || a.municipality || a.county || a.state || j.name,
      country: a.country || "", lat: +(+j.lat).toFixed(5), lon: +(+j.lon).toFixed(5),
    };
  } catch { return null; }
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
    date: st.date, type: st.type || "Other", note: st.note || "", title: st.title || "", cm: st.cm || null, chat,
    files: files.map(([n]) => n),
  };
  tree.push({ path: `${dir}/meta.json`, mode: "100644", type: "blob", content: JSON.stringify(meta, null, 1) });

  const ref = await gh(env, "/git/ref/heads/main");
  const head = await gh(env, "/git/commits/" + ref.object.sha);
  const t = await gh(env, "/git/trees", "POST", { base_tree: head.tree.sha, tree });
  const c = await gh(env, "/git/commits", "POST", { message: `inbox: ${st.city} ${st.date}`, tree: t.sha, parents: [ref.object.sha] });
  await gh(env, "/git/refs/heads/main", "PATCH", { sha: c.sha });
}
