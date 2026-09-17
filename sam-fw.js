// Cloudflare Worker: cek firmware Samsung, notif Telegram kalau ada versi baru.
// Sumber: endpoint FOTA resmi Samsung (version.xml) — sama yg dipakai SamMobile/SamFW.
//
// KV binding (WAJIB): buat KV namespace, bind dengan nama  FW
//
// Env vars (Settings -> Variables and Secrets):
//   BOT_TOKEN     (Secret)  token bot dari @BotFather
//   CHAT_ID       (Text)    chat id tujuan notif
//   DEVICES       (Text)    daftar device: "MODEL/REGION[/Nama]" dipisah koma
//                           contoh: SM-A556E/XID/Galaxy A55
//   SECRET_TOKEN  (Secret)  string acak; buat verifikasi webhook (command /latest)
//
// Cron Trigger (WAJIB, buat auto-cek): mis. "0 */6 * * *" (tiap 6 jam)
// Webhook (opsional, buat command /latest,/start):
//   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<SECRET_TOKEN>"

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
    const msg = update.message;
    if (msg && msg.text) {
      const chatId = msg.chat.id;
      const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
      try {
        if (cmd === "/latest")      await cmdLatest(env, chatId);
        else if (cmd === "/devices") await sendMessage(env, chatId, devicesList(env));
        else if (cmd === "/check")   await checkAll(env, true, chatId);
        else if (cmd === "/start" || cmd === "/help") await sendMessage(env, chatId, helpText());
      } catch (e) {
        await sendMessage(env, chatId, "⚠️ " + (e.message || "error"));
      }
    }
    return new Response("ok");
  },
};

function parseDevices(env) {
  return (env.DEVICES || "SM-A556E/XID/Galaxy A55")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [model, region, ...rest] = s.split("/");
      return { model: model.trim(), region: (region || "").trim(), name: rest.join("/").trim() || model.trim() };
    })
    .filter((d) => d.model && d.region);
}

async function fetchFirmware(model, region) {
  const url = `https://fota-cloud-dn.ospserver.net/firmware/${region}/${model}/version.xml`;
  const r = await fetch(url, { headers: { "User-Agent": "Kies2.0_FUS" } });
  if (!r.ok) throw new Error(`FOTA ${model}/${region} HTTP ${r.status}`);
  const xml = await r.text();
  const tag = xml.match(/<latest\b[^>]*>([^<]*)<\/latest>/i);
  const version = tag ? tag[1].trim() : "";
  const oAttr = xml.match(/<latest\b[^>]*\bo="([^"]*)"/i);
  const android = oAttr ? oAttr[1] : "?";
  return { version, android };
}

function fmt(name, model, region, info) {
  return [
    `📱 <b>Firmware baru</b> — ${esc(name)}`,
    ``,
    `Model: <b>${esc(model)}</b>`,
    `Region: <b>${esc(region)}</b>`,
    `Versi: <code>${esc(info.version)}</code>`,
    `Android: <b>${esc(info.android)}</b>`,
  ].join("\n");
}

async function checkAll(env, manual, chatId) {
  const devices = parseDevices(env);
  const changed = [];
  for (const d of devices) {
    let info;
    try { info = await fetchFirmware(d.model, d.region); } catch (e) { continue; }
    if (!info.version) continue;
    const key = `fw:${d.model}/${d.region}`;
    const prev = env.FW ? await env.FW.get(key) : null;
    if (info.version !== prev) {
      if (prev !== null) {
        await sendMessage(env, env.CHAT_ID, fmt(d.name, d.model, d.region, info));
        changed.push(d.name);
      }
      if (env.FW) await env.FW.put(key, info.version);
    }
  }
  if (manual && chatId) {
    await sendMessage(env, chatId,
      changed.length ? `✅ Ada update: ${changed.join(", ")}` : "Belum ada firmware baru sejak cek terakhir.");
  }
}

async function cmdLatest(env, chatId) {
  const devices = parseDevices(env);
  const blocks = [];
  for (const d of devices) {
    try {
      const info = await fetchFirmware(d.model, d.region);
      blocks.push(
        `📱 <b>${esc(d.name)}</b> (${esc(d.model)} · ${esc(d.region)})\n` +
        `Versi: <code>${esc(info.version || "?")}</code>\n` +
        `Android: <b>${esc(info.android)}</b>`
      );
    } catch (e) {
      blocks.push(`📱 <b>${esc(d.name)}</b> — ⚠️ ${esc(e.message)}`);
    }
  }
  await sendMessage(env, chatId, blocks.join("\n\n") || "Belum ada device dikonfigurasi.");
}

function devicesList(env) {
  const d = parseDevices(env);
  return "<b>Device dipantau:</b>\n" + d.map((x) => `• ${esc(x.name)} (${esc(x.model)}/${esc(x.region)})`).join("\n");
}

function helpText() {
  return [
    "<b>Samsung Firmware Checker</b>",
    "",
    "/latest — versi firmware terkini sekarang",
    "/check — paksa cek update sekarang",
    "/devices — daftar device dipantau",
    "/help — bantuan",
    "",
    "<i>Auto-notif jalan otomatis via jadwal (Cron).</i>",
  ].join("\n");
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendMessage(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
}
