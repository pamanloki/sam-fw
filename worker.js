// Cloudflare Worker: cek firmware Samsung, notif Telegram kalau ada versi baru.
// Sumber: endpoint FOTA resmi Samsung (version.xml) — sama yg dipakai SamMobile/SamFW.
//
// KV binding (WAJIB): buat KV namespace, bind dengan nama  FW
//   Selain nyimpen versi terakhir, KV juga nyimpen device yg ditambah lewat /add.
//
// Env vars (Settings -> Variables and Secrets):
//   BOT_TOKEN     (Secret)  token bot dari @BotFather
//   CHAT_ID       (Text)    chat id tujuan notif; bisa banyak, dipisah koma.
//                           Cuma chat id di daftar ini yg boleh pakai command.
//   DEVICES       (Text)    daftar device bawaan: "MODEL/REGION[/Nama]" dipisah koma
//                           contoh: SM-A556E/XID/Galaxy A55
//   SECRET_TOKEN  (Secret)  string acak; buat verifikasi webhook (command /latest)
//   INCLUDE_BETA  (Text)    "true" (default) ikut notif firmware beta; "false" cuma stabil
//
// Cron Trigger (WAJIB, buat auto-cek): mis. "0 */6 * * *" (tiap 6 jam)
// Webhook (opsional, buat command /latest,/start):
//   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<SECRET_TOKEN>"

const FETCH_TIMEOUT_MS = 10000;
const FETCH_ATTEMPTS = 3;
const FAIL_ALERT_THRESHOLD = 3; // alert kalau device gagal cek N kali berturut-turut
const KV_DEVICES = "cfg:devices";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export default {
  // Auto-cek terjadwal (Cron Trigger)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAll(env, false));
  },

  // Webhook Telegram (command manual) + route debug GET
  async fetch(request, env) {
    if (request.method !== "POST") {
      // Debug: buka  <worker-url>/?fw=SM-A556E/XID  buat cek reachability dari IP Worker.
      const q = new URL(request.url).searchParams.get("fw");
      if (q) {
        const [model, region] = q.split("/");
        try {
          const info = await fetchFirmware(model, region);
          return new Response(
            `OK ${model}/${region}\nversion=${info.version || "(kosong)"}\nandroid=${info.android}`,
            { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
        } catch (e) {
          return new Response("ERROR: " + (e.message || e), {
            status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
      }
      return new Response("samfw bot: OK", { status: 200 });
    }
    if (env.SECRET_TOKEN &&
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try { update = await request.json(); } catch { return new Response("ok"); }

    // Tombol inline (callback dari reply_markup)
    if (update.callback_query) {
      await handleCallback(env, update.callback_query);
      return new Response("ok");
    }

    const msg = update.message;
    if (msg && msg.text) {
      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
      const arg = text.slice(text.split(/\s+/)[0].length).trim();

      // /id boleh dipakai siapa aja — buat cari chat id sendiri pas setup.
      if (cmd === "/id") {
        await sendMessage(env, chatId, `Chat ID kamu: <code>${chatId}</code>`);
        return new Response("ok");
      }

      // Batasi command cuma buat chat id resmi. Kalau CHAT_ID kosong, biarin (belum diset).
      const allowed = parseChatIds(env);
      if (allowed.length && !allowed.includes(String(chatId))) {
        return new Response("ok");
      }
      try {
        if (cmd === "/latest")       await cmdLatest(env, chatId);
        else if (cmd === "/devices") await sendMessage(env, chatId, await devicesList(env), mainKeyboard());
        else if (cmd === "/check")   await checkAll(env, true, chatId);
        else if (cmd === "/add")     await cmdAdd(env, chatId, arg);
        else if (cmd === "/remove")  await cmdRemove(env, chatId, arg);
        else if (cmd === "/start" || cmd === "/help") await sendMessage(env, chatId, helpText(), mainKeyboard());
      } catch (e) {
        await sendMessage(env, chatId, "⚠️ " + (e.message || "error"));
      }
    }
    return new Response("ok");
  },
};

async function handleCallback(env, cq) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
  const allowed = parseChatIds(env);
  if (allowed.length && chatId !== null && !allowed.includes(String(chatId))) {
    await answerCallback(env, cq.id, "Nggak diizinkan");
    return;
  }
  await answerCallback(env, cq.id);
  if (chatId === null) return;
  try {
    if (cq.data === "check")       await checkAll(env, true, chatId);
    else if (cq.data === "latest") await cmdLatest(env, chatId);
    else if (cq.data === "devices") await sendMessage(env, chatId, await devicesList(env), mainKeyboard());
  } catch (e) {
    await sendMessage(env, chatId, "⚠️ " + (e.message || "error"));
  }
}

function mainKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🔄 Cek update", callback_data: "check" },
      { text: "📋 Versi terkini", callback_data: "latest" },
    ], [
      { text: "📱 Daftar device", callback_data: "devices" },
    ]],
  };
}

// Parse string daftar device -> [{model, region, name}]
function parseDevices(str) {
  return String(str || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [model, region, ...rest] = s.split("/");
      return {
        model: (model || "").trim(),
        region: (region || "").trim(),
        name: rest.join("/").trim() || (model || "").trim(),
      };
    })
    .filter((d) => d.model && d.region);
}

function parseChatIds(env) {
  return String(env.CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Gabungan device dari env DEVICES + yg disimpan di KV (via /add). Dedupe by model/region.
async function getDevices(env) {
  const base = parseDevices(env.DEVICES);
  let extra = [];
  if (env.FW) {
    try {
      const raw = await env.FW.get(KV_DEVICES);
      if (raw) extra = parseDevices(JSON.parse(raw).join(","));
    } catch (e) {
      console.log("getDevices KV parse failed", e.message || e);
    }
  }
  const map = new Map();
  for (const d of [...base, ...extra]) map.set(`${d.model}/${d.region}`.toUpperCase(), d);
  return [...map.values()];
}

async function kvGetDeviceStrings(env) {
  if (!env.FW) return [];
  try {
    const raw = await env.FW.get(KV_DEVICES);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function fetchWithRetry(url, opts) {
  let lastErr;
  for (let i = 0; i < FETCH_ATTEMPTS; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) return r;
      lastErr = new Error(`HTTP ${r.status}`);
      if (r.status < 500) throw lastErr; // 4xx: percuma diulang
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError" ? new Error("timeout") : e;
    }
    if (i < FETCH_ATTEMPTS - 1) await sleep(500 * (i + 1));
  }
  throw lastErr;
}

async function fetchFirmware(model, region) {
  const url = `https://fota-cloud-dn.ospserver.net/firmware/${region}/${model}/version.xml`;
  let r;
  try {
    r = await fetchWithRetry(url, { headers: { "User-Agent": "Kies2.0_FUS" } });
  } catch (e) {
    throw new Error(`FOTA ${model}/${region}: ${e.message || e}`);
  }
  const xml = await r.text();
  const tag = xml.match(/<latest\b[^>]*>([^<]*)<\/latest>/i);
  const version = tag ? tag[1].trim() : "";
  const oAttr = xml.match(/<latest\b[^>]*\bo="([^"]*)"/i);
  const android = oAttr ? oAttr[1] : "?";
  // Versi Samsung = PDA/CSC/CP (kadang ada DATA di akhir). Pecah biar kebaca.
  const parts = version.split("/").map((s) => s.trim());
  const pda = parts[0] || "";
  return { version, android, pda, csc: parts[1] || "", cp: parts[2] || "", beta: isBeta(pda) };
}

// Deteksi build beta dari kode PDA: huruf tepat setelah digit bootloader = "Z".
// Contoh beta: S928BXXU1ZXI9 (…U1[Z]…), stabil: A556EXXU7BYG3 (…U7[B]…).
function isBeta(pda) {
  const m = String(pda || "").match(/[A-Z]{3}\d([A-Z])/);
  return !!m && m[1] === "Z";
}

function includeBeta(env) {
  const v = String(env.INCLUDE_BETA == null ? "true" : env.INCLUDE_BETA).trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(v);
}

function infoLines(info) {
  const lines = [`Android: <b>${esc(info.android)}</b>`];
  if (info.pda) lines.push(`PDA (AP): <code>${esc(info.pda)}</code>`);
  if (info.csc) lines.push(`CSC: <code>${esc(info.csc)}</code>`);
  if (info.cp)  lines.push(`CP (modem): <code>${esc(info.cp)}</code>`);
  return lines;
}

function fmt(name, model, region, info, prev) {
  return [
    `📱 <b>Firmware baru</b> — ${esc(name)}${info.beta ? " 🧪 <b>Beta</b>" : ""}`,
    ``,
    `Model: <b>${esc(model)}</b>`,
    `Region: <b>${esc(region)}</b>`,
    prev
      ? `Versi: <code>${esc(prev)}</code> → <code>${esc(info.version)}</code>`
      : `Versi: <code>${esc(info.version)}</code>`,
    ...infoLines(info),
  ].join("\n");
}

// Catat kegagalan cek device; alert sekali kalau gagal berturut-turut.
async function noteFailure(env, key, d, errMsg) {
  if (!env.FW) return;
  let state = { count: 0, alerted: false };
  try { const raw = await env.FW.get(key); if (raw) state = JSON.parse(raw); } catch {}
  state.count = (state.count || 0) + 1;
  if (state.count >= FAIL_ALERT_THRESHOLD && !state.alerted) {
    for (const cid of parseChatIds(env)) {
      await sendMessage(env, cid,
        `⚠️ <b>Gagal cek firmware</b> — ${esc(d.name)}\n` +
        `Model: <b>${esc(d.model)}</b> · Region: <b>${esc(d.region)}</b>\n` +
        `Gagal ${state.count}× berturut-turut.\n<code>${esc(errMsg)}</code>\n` +
        `Cek lagi model/region-nya bener atau nggak.`);
    }
    state.alerted = true;
  }
  await env.FW.put(key, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 30 });
}

async function checkAll(env, manual, chatId) {
  const devices = await getDevices(env);
  const results = await Promise.all(devices.map(async (d) => {
    const errKey = `err:${d.model}/${d.region}`;
    let info;
    try {
      info = await fetchFirmware(d.model, d.region);
    } catch (e) {
      console.log("checkAll fetch failed", d.model, d.region, e.message || e);
      await noteFailure(env, errKey, d, e.message || String(e));
      return null;
    }
    if (env.FW) await env.FW.delete(errKey); // sukses -> reset status gagal
    if (!info.version) return null;
    if (info.beta && !includeBeta(env)) return null; // INCLUDE_BETA=false: abaikan beta
    const key = `fw:${d.model}/${d.region}`;
    const prev = env.FW ? await env.FW.get(key) : null;
    if (info.version === prev) return null;
    if (prev !== null) {
      for (const cid of parseChatIds(env)) {
        await sendMessage(env, cid, fmt(d.name, d.model, d.region, info, prev), mainKeyboard());
      }
    }
    if (env.FW) await env.FW.put(key, info.version);
    return prev !== null ? d.name : null;
  }));
  const changed = results.filter(Boolean);
  if (manual && chatId) {
    await sendMessage(env, chatId,
      changed.length ? `✅ Ada update: ${changed.join(", ")}` : "Belum ada firmware baru sejak cek terakhir.",
      mainKeyboard());
  }
}

async function cmdLatest(env, chatId) {
  const devices = await getDevices(env);
  const blocks = await Promise.all(devices.map(async (d) => {
    try {
      const info = await fetchFirmware(d.model, d.region);
      return [
        `📱 <b>${esc(d.name)}</b> (${esc(d.model)} · ${esc(d.region)})${info.beta ? " 🧪 <b>Beta</b>" : ""}`,
        `Versi: <code>${esc(info.version || "?")}</code>`,
        ...infoLines(info),
      ].join("\n");
    } catch (e) {
      return `📱 <b>${esc(d.name)}</b> — ⚠️ ${esc(e.message)}`;
    }
  }));
  await sendMessage(env, chatId, blocks.join("\n\n") || "Belum ada device dikonfigurasi.", mainKeyboard());
}

async function cmdAdd(env, chatId, arg) {
  if (!env.FW) return sendMessage(env, chatId, "⚠️ KV (FW) belum di-bind, nggak bisa simpan device.");
  const parsed = parseDevices(arg);
  if (!parsed.length) {
    return sendMessage(env, chatId, "Format: <code>/add MODEL/REGION[/Nama]</code>\nContoh: <code>/add SM-A556E/XID/Galaxy A55</code>");
  }
  const list = await kvGetDeviceStrings(env);
  const known = new Set(list.map((s) => {
    const p = parseDevices(s)[0];
    return p ? `${p.model}/${p.region}`.toUpperCase() : "";
  }));
  const added = [];
  for (const d of parsed) {
    const kkey = `${d.model}/${d.region}`.toUpperCase();
    if (known.has(kkey)) continue;
    list.push(`${d.model}/${d.region}/${d.name}`);
    known.add(kkey);
    added.push(d.name);
  }
  await env.FW.put(KV_DEVICES, JSON.stringify(list));
  return sendMessage(env, chatId, added.length ? `✅ Ditambah: ${esc(added.join(", "))}` : "Device sudah ada.");
}

async function cmdRemove(env, chatId, arg) {
  if (!env.FW) return sendMessage(env, chatId, "⚠️ KV (FW) belum di-bind.");
  const target = arg.trim().toUpperCase();
  if (!target) return sendMessage(env, chatId, "Format: <code>/remove MODEL/REGION</code>  (atau <code>/remove MODEL</code>)");
  const list = await kvGetDeviceStrings(env);
  const kept = [];
  const removed = [];
  for (const s of list) {
    const p = parseDevices(s)[0];
    const full = p ? `${p.model}/${p.region}`.toUpperCase() : "";
    const modelOnly = p ? p.model.toUpperCase() : "";
    if (full === target || modelOnly === target) removed.push(p ? p.name : s);
    else kept.push(s);
  }
  await env.FW.put(KV_DEVICES, JSON.stringify(kept));
  return sendMessage(env, chatId,
    removed.length
      ? `🗑️ Dihapus: ${esc(removed.join(", "))}`
      : "Nggak ada yang cocok. (device dari env DEVICES nggak bisa dihapus lewat chat)");
}

async function devicesList(env) {
  const d = await getDevices(env);
  if (!d.length) return "Belum ada device dipantau. Tambah pakai <code>/add MODEL/REGION/Nama</code>.";
  return "<b>Device dipantau:</b>\n" + d.map((x) => `• ${esc(x.name)} (${esc(x.model)}/${esc(x.region)})`).join("\n");
}

function helpText() {
  return [
    "<b>Samsung Firmware Checker</b>",
    "",
    "/latest — versi firmware terkini sekarang",
    "/check — paksa cek update sekarang",
    "/devices — daftar device dipantau",
    "/add MODEL/REGION/Nama — tambah device",
    "/remove MODEL/REGION — hapus device",
    "/id — lihat chat id kamu",
    "/help — bantuan",
    "",
    "<i>Auto-notif jalan otomatis via jadwal (Cron).</i>",
  ].join("\n");
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function answerCallback(env, id, text) {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text: text || "" }),
    });
  } catch (e) {
    console.log("answerCallback failed", e.message || e);
  }
}

async function sendMessage(env, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.log("telegram sendMessage failed", chatId, r.status, await r.text().catch(() => ""));
  }
  return r;
}
