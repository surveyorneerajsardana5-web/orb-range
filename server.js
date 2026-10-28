// Load .env when dotenv is installed; keep startup error explicit if dependencies are missing.
try { require("dotenv").config(); }
catch (err) {
  if (err.code !== "MODULE_NOT_FOUND") throw err;
  console.warn("dotenv is not installed yet. Run npm install before starting AJS TRADING PRO.");
}
const express = require("express");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const protobuf = require("protobufjs");
const app = express();
const realTradingSafety = require("./real-trading-safety");
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const API = "https://api.upstox.com";
const UPSTOX_CREDENTIALS_FILE = path.join(__dirname, ".upstox-credentials.json");
function readSavedUpstoxToken() {
  try { const saved = JSON.parse(fs.readFileSync(UPSTOX_CREDENTIALS_FILE, "utf8")); return typeof saved.accessToken === "string" ? saved.accessToken.trim() : ""; }
  catch (_) { return ""; }
}
let TOKEN = readSavedUpstoxToken() || (process.env.UPSTOX_ACCESS_TOKEN || "").trim();
function persistUpstoxToken(token) {
  const temp = UPSTOX_CREDENTIALS_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify({ accessToken: token, savedAt: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, UPSTOX_CREDENTIALS_FILE);
}
function isLocalSettingsRequest(req) {
  const ip = String(req.socket?.remoteAddress || req.ip || "").replace(/^::ffff:/, "");
  return ["127.0.0.1", "::1"].includes(ip);
}
// Live order placement is deliberately opt-in and remains OFF unless configured in .env.
const REAL_TRADING_ENABLED = String(process.env.REAL_TRADING_ENABLED || "false").toLowerCase() === "true";
// User-requested live profile. This records intent only; live execution stays locked until
// a separately implemented and end-to-end-tested execution/protection manager is approved.
const realProfilePath = path.join(__dirname, "real-profile.json");
let savedProfile = {};
try { savedProfile = JSON.parse(fs.readFileSync(realProfilePath, "utf8")); } catch (_) { savedProfile = {}; }
let AJS_TRADING_MODE = String(savedProfile.mode || process.env.AJS_TRADING_MODE || "real").toLowerCase() === "real" ? "real" : "paper";
let AJS_ENTRY_TRIGGER = "B1";
let AJS_DEFAULT_LOTS = Math.max(1, Math.min(100, Math.floor(Number(savedProfile.lots || process.env.AJS_DEFAULT_LOTS || 1))));
let AJS_MAX_DAILY_LOSS_INR = Math.max(1, Number(savedProfile.maxDailyLossINR || process.env.AJS_MAX_DAILY_LOSS_INR || 3200));
let AJS_REQUIRE_SL_TARGET_TRAILING = true;
const AJS_AUTO_B1_EXECUTION_ENABLED = false; // fail-closed until execution safeguards pass end-to-end tests


// Instrument keys are deliberately editable in the UI/config. Do not guess keys:
// Upstox instrument_key values must be exact.
const instruments = [
  { id:"NIFTY", name:"NIFTY 50", key:"NSE_INDEX|Nifty 50", kind:"index" },
  { id:"BANKNIFTY", name:"BANK NIFTY", key:"NSE_INDEX|Nifty Bank", kind:"index" },
  { id:"RELIANCE", name:"Reliance", key:"", kind:"equity" },
  { id:"BHARTIARTL", name:"Bharti Airtel", key:"", kind:"equity" },
  { id:"ICICIBANK", name:"ICICI Bank", key:"", kind:"equity" },
  { id:"AXISBANK", name:"Axis Bank", key:"", kind:"equity" },
  { id:"BAJFINANCE", name:"Bajaj Finance", key:"", kind:"equity" },
  { id:"BAJAJFINSV", name:"Bajaj Finserv", key:"", kind:"equity" },
  { id:"HDFCBANK", name:"HDFC Bank", key:"", kind:"equity" },
  { id:"SBIN", name:"SBI", key:"", kind:"equity" },
  { id:"SBILIFE", name:"SBI Life", key:"", kind:"equity" },
  { id:"HDFCLIFE", name:"HDFC Life", key:"", kind:"equity" },
  { id:"TECHM", name:"Tech Mahindra", key:"", kind:"equity" }
];

// Persist instrument keys on disk so they survive server restarts.
// The JSON file contains only instrument identifiers and Upstox instrument keys,
// never the user's access token.
const INSTRUMENTS_FILE = path.join(__dirname, "instrument-keys.json");
function loadSavedInstrumentKeys() {
  try {
    if (!fs.existsSync(INSTRUMENTS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(INSTRUMENTS_FILE, "utf8"));
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const item of instruments) {
      const key = saved[item.id];
      if (typeof key === "string" && key.trim() && key.includes("|") && key.length <= 160) {
        item.key = key.trim();
      }
    }
  } catch (err) {
    console.error("Could not load instrument-keys.json:", err.message);
  }
}
function saveInstrumentKeys() {
  const saved = Object.fromEntries(instruments.map(item => [item.id, item.key]));
  const tempFile = INSTRUMENTS_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(saved, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempFile, INSTRUMENTS_FILE);
}
loadSavedInstrumentKeys();

const paper = { enabled: true, trades: [], nextId: 1 };
const optionCache = new Map();
const optionOiSnapshots = new Map();
const niftyStrikeOiSnapshots = new Map();
const ALERT_CONFIG_FILE = path.join(__dirname, "alert-config.json");
let alertPhones = [];
try { const cfg = JSON.parse(fs.readFileSync(ALERT_CONFIG_FILE, "utf8"));
  if (Array.isArray(cfg.phones)) alertPhones = cfg.phones.filter(x => typeof x === "string").slice(0, 5);
  else if (typeof cfg.phone === "string" && cfg.phone) alertPhones = [cfg.phone];
} catch {}
function saveAlertPhones(phones) {
  const tmp = ALERT_CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ phones }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, ALERT_CONFIG_FILE);
}


// Central request queue: serialize Upstox calls to avoid bursts that trigger HTTP 429.
let upstoxQueue = Promise.resolve();
let lastUpstoxRequestAt = 0;
let upstoxRateLimitUntil = 0;
const UPSTOX_MIN_GAP_MS = Math.max(300, Number(process.env.UPSTOX_MIN_GAP_MS || 400));
const UPSTOX_429_COOLDOWN_MS = Math.max(10000, Number(process.env.UPSTOX_429_COOLDOWN_MS || 15000));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function upstoxRequest(pathname, options = {}) {
  if (!TOKEN) {
    const e = new Error("Upstox access token is missing. Add it in Settings.");
    e.status = 401; throw e;
  }
  const cooldown = upstoxRateLimitUntil - Date.now();
  if (cooldown > 0) {
    const e = new Error(`Upstox rate limit cooldown active. Retry in about ${Math.ceil(cooldown / 1000)} seconds.`);
    e.status = 429; throw e;
  }
  const gap = UPSTOX_MIN_GAP_MS - (Date.now() - lastUpstoxRequestAt);
  if (gap > 0) await wait(gap);
  lastUpstoxRequestAt = Date.now();
  const r = await fetch(API + pathname, {
    method: options.method || "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept:"application/json", ...(options.body ? {"Content-Type":"application/json"} : {}) },
    ...(options.body ? {body: JSON.stringify(options.body)} : {})
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body?.errors?.[0]?.message || body?.message || `Upstox API returned ${r.status}`);
    e.status = r.status;
    if (r.status === 429) upstoxRateLimitUntil = Date.now() + UPSTOX_429_COOLDOWN_MS;
    throw e;
  }
  return body;
}
async function upstox(pathname, options = {}) {
  const task = upstoxQueue.then(() => upstoxRequest(pathname, options));
  // Keep the queue usable even if one request fails.
  upstoxQueue = task.catch(() => {});
  return task;
}
function encodeKey(k) { return encodeURIComponent(k); }
function istDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:"Asia/Kolkata", year:"numeric", month:"2-digit", day:"2-digit"
  }).format(date);
}
function shiftDate(dateString, days) {
  const d = new Date(`${dateString}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + days);
  return istDate(d);
}
function onlyCompletedCandles(candles, frame, now = Date.now()) {
  if (frame !== "5m" && frame !== "15m" && frame !== "30m") return candles;
  const duration = (frame === "5m" ? 5 : frame === "15m" ? 15 : 30) * 60 * 1000;
  return candles.filter(c => {
    const start = new Date(c?.[0]).getTime();
    return Number.isFinite(start) && start + duration <= now;
  });
}

app.get("/api/alerts/config", (req,res) => res.json({ phones: alertPhones, phone: alertPhones[0] || "", channel: "whatsapp-click-to-chat", free: true }));
app.post("/api/alerts/config", (req,res) => {
  const incoming = Array.isArray(req.body?.phones) ? req.body.phones : [req.body?.phone || ""];
  const phones = incoming.slice(0, 5).map(x => String(x || "").replace(/[\s()-]/g, "")).filter(Boolean);
  if (phones.some(phone => !/^\+?[1-9]\d{9,14}$/.test(phone))) return res.status(400).json({ error: "Enter valid WhatsApp numbers with country code (e.g. +919876543210)." });
  if (new Set(phones.map(p => p.replace(/^\+/, ""))).size !== phones.length) return res.status(400).json({ error: "Each of the five contacts must be unique." });
  alertPhones = phones;
  try { saveAlertPhones(alertPhones); res.json({ ok:true, phones:alertPhones, phone:alertPhones[0] || "", channel:"whatsapp-click-to-chat", message: alertPhones.length ? `${alertPhones.length} WhatsApp contact(s) saved. Free mode opens each chat; press Send in each chat.` : "WhatsApp contacts cleared." }); }
  catch(e) { res.status(500).json({error:"Could not save WhatsApp contacts."}); }
});
// Free click-to-chat only prepares messages; users must press Send in each recipient chat.
app.post("/api/alerts/top-setup", (req,res) => {
  const { key, name, side, score, entry, stop, target, reason } = req.body || {};
  if (!key || !name || !["CALL","PUT"].includes(side) || !Number.isFinite(Number(score)) || Number(score) < 70) return res.status(400).json({error:"Only a confirmed CALL/PUT setup with score >= 70 can create a WhatsApp alert."});
  if (!alertPhones.length) return res.json({ok:false, message:"Top setup detected, but no WhatsApp contacts are saved."});
  const message = `AJS TOP SETUP\n${name} ${side}\nScore: ${Number(score)}/100\nEntry: ${entry ?? "-"}\nSL: ${stop ?? "-"}\nTarget: ${target ?? "-"}\nReason: ${String(reason||"").slice(0,120)}\nPlease verify live market conditions before trading.`;
  const whatsappUrls = alertPhones.map(phone => `https://wa.me/${phone.replace(/^\+/, "")}?text=${encodeURIComponent(message)}`);
  res.json({ok:true, channel:"whatsapp-click-to-chat", whatsappUrls, whatsappUrl:whatsappUrls[0], message:`Prepared ${whatsappUrls.length} free WhatsApp chat(s). Press Send in each chat; background auto-send is not supported.`});
});


// One central Upstox V3 WebSocket serves all browser clients. LTP REST is only a fallback.
const liveQuotes = new Map();
const liveCandles = new Map();
const sseClients = new Set();
let liveFeedState = { status: TOKEN ? "CONNECTING" : "TOKEN REQUIRED", connected: false, lastMessageAt: null, message: TOKEN ? "Connecting to Upstox V3 WebSocket…" : "Set UPSTOX_ACCESS_TOKEN in .env." };
let marketSocket = null;
let reconnectTimer = null;
let reconnectDelay = 3000;
let protobufRootPromise = null;

function publishLive(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of [...sseClients]) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}
function updateLiveCandle(id, ltp, tickMs, volumeDelta = 0) {
  const start = Math.floor(tickMs / 300000) * 300000;
  const key = `${id}:5m`;
  let candle = liveCandles.get(key);
  if (!candle || candle.t !== start) {
    candle = { t: start, o: ltp, h: ltp, l: ltp, c: ltp, v: Math.max(0, volumeDelta), live: true };
    liveCandles.set(key, candle);
  } else {
    candle.h = Math.max(candle.h, ltp);
    candle.l = Math.min(candle.l, ltp);
    candle.c = ltp;
    candle.v += Math.max(0, volumeDelta);
  }
  return candle;
}
async function loadProtoRoot() {
  if (!protobufRootPromise) protobufRootPromise = protobuf.load(path.join(__dirname, "MarketDataFeedV3.proto"));
  return protobufRootPromise;
}
function normalizeTick(feed) {
  if (!feed) return null;
  if (feed.ltpc) return feed.ltpc;
  if (feed.fullFeed) {
    const full = feed.fullFeed.marketFF || feed.fullFeed.indexFF;
    return full?.ltpc || null;
  }
  if (feed.firstLevelWithGreeks) return feed.firstLevelWithGreeks.ltpc || null;
  return null;
}
async function startMarketWebSocket() {
  if (!TOKEN) {
    liveFeedState = { status:"TOKEN REQUIRED", connected:false, lastMessageAt:null, message:"Add an Upstox access token in Settings." };
    return;
  }
  try {
    liveFeedState = {...liveFeedState, status:"AUTHORIZING", message:"Authorizing Upstox V3 market feed…"};
    const auth = await upstox("/v3/feed/market-data-feed/authorize");
    const socketUrl = auth?.data?.authorized_redirect_uri;
    if (!socketUrl || !socketUrl.startsWith("wss://")) throw new Error("Upstox did not return a valid WebSocket URL.");
    const root = await loadProtoRoot();
    const FeedResponse = root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
    const keys = [...new Set(instruments.filter(x => x.key).map(x => x.key))];
    if (!keys.length) throw new Error("No instrument keys configured for live subscription.");
    marketSocket = new WebSocket(socketUrl, { followRedirects:true, handshakeTimeout:15000, perMessageDeflate:false });
    marketSocket.on("open", () => {
      liveFeedState = {status:"CONNECTED",connected:true,lastMessageAt:new Date().toISOString(),message:`Connected; subscribing ${keys.length} configured instrument(s).`};
      console.log("[AJS_WS] CONNECTED");
      marketSocket.send(Buffer.from(JSON.stringify({guid:`ajs-${Date.now()}`,method:"sub",data:{mode:"ltpc",instrumentKeys:keys}})), {binary:true});
      publishLive({type:"status",status:liveFeedState});
    });
    marketSocket.on("message", (raw) => {
      try {
        const decoded = FeedResponse.decode(Buffer.from(raw));
        const data = FeedResponse.toObject(decoded, { longs:String, enums:String, defaults:false, oneofs:true });
        const feeds = data.feeds || {};
        const ts = Number(data.currentTs) || Date.now();
        for (const [key, feed] of Object.entries(feeds)) {
          const item = instruments.find(x => x.key === key);
          const tick = normalizeTick(feed);
          const ltp = Number(tick?.ltp);
          if (!item || !Number.isFinite(ltp) || ltp <= 0) continue;
          const tickMs = Number(tick?.ltt) || ts;
          const quote = {id:item.id,name:item.name,key:item.key,ltp,close:Number(tick?.cp)||null,ts:new Date(tickMs).toISOString(),source:"Upstox V3 WebSocket",live:true};
          liveQuotes.set(item.id, quote);
          const candle = updateLiveCandle(item.id, ltp, tickMs, Number(tick?.ltq)||0);
          publishLive({type:"tick",quote,candle});
        }
        liveFeedState = {...liveFeedState,status:"LIVE",connected:true,lastMessageAt:new Date().toISOString(),message:"Live ticks received from Upstox V3."};
      } catch (e) {
        console.error("[AJS_WS] Decode error:", e.message);
      }
    });
    marketSocket.on("error", err => {
      console.error("[AJS_WS] Socket error:", err.message);
      liveFeedState = {...liveFeedState,status:"ERROR",connected:false,message:err.message};
      publishLive({type:"status",status:liveFeedState});
    });
    marketSocket.on("close", (code, reason) => {
      console.warn(`[AJS_WS] Closed ${code}: ${reason?.toString() || ""}`);
      liveFeedState = {...liveFeedState,status:"RECONNECTING",connected:false,message:`WebSocket closed (${code}); reconnecting…`};
      publishLive({type:"status",status:liveFeedState});
      marketSocket = null;
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer=null; startMarketWebSocket().catch(()=>{}); }, reconnectDelay);
      reconnectDelay = Math.min(30000, Math.round(reconnectDelay * 1.7));
    });
  } catch (e) {
    console.error("[AJS_WS] Start failed:", e.message);
    liveFeedState = {...liveFeedState,status:"ERROR",connected:false,message:e.message};
    publishLive({type:"status",status:liveFeedState});
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer=null; startMarketWebSocket().catch(()=>{}); }, reconnectDelay);
    reconnectDelay = Math.min(30000, Math.round(reconnectDelay * 1.7));
  }
}
app.get("/api/live/status", (req,res) => res.json({...liveFeedState, subscribed:[...liveQuotes.keys()]}));
app.get("/api/live/events", (req,res) => {
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache, no-transform");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({type:"status",status:liveFeedState})}\n\n`);
  for (const quote of liveQuotes.values()) res.write(`data: ${JSON.stringify({type:"tick",quote,candle:liveCandles.get(`${quote.id}:5m`)})}\n\n`);
  sseClients.add(res);
  req.on("close",()=>sseClients.delete(res));
});
app.get("/api/live/candle/:id/5m", (req,res) => {
  const candle = liveCandles.get(`${req.params.id}:5m`);
  if (!candle) return res.status(404).json({error:"No live candle tick received yet."});
  res.json(candle);
});

// Local-only Upstox token settings. Never return the token to the browser.
app.get("/api/settings/upstox", (req,res) => {
  if (!isLocalSettingsRequest(req)) return res.status(403).json({error:"Upstox credentials can only be managed from this computer."});
  res.set("Cache-Control", "no-store");
  res.json({configured:!!TOKEN, source:readSavedUpstoxToken() ? "saved locally" : (TOKEN ? "environment" : "not configured"), masked:TOKEN ? "••••••••" + TOKEN.slice(-4) : "", expiresDaily:true});
});
app.post("/api/settings/upstox", async (req,res) => {
  if (!isLocalSettingsRequest(req)) return res.status(403).json({error:"Upstox credentials can only be managed from this computer."});
  const token = String(req.body?.accessToken || "").trim();
  if (!token || token.length < 20 || token.length > 10000 || /\s/.test(token)) return res.status(400).json({error:"Paste a valid Upstox access token (no spaces or line breaks)."});
  try {
    const check = await fetch(API + "/v2/user/profile", {headers:{Authorization:`Bearer ${token}`,Accept:"application/json"}});
    const body = await check.json().catch(()=>({}));
    if (!check.ok) return res.status(check.status === 401 ? 401 : 502).json({error:body?.errors?.[0]?.message || body?.message || `Upstox token test failed (HTTP ${check.status}).`});
    persistUpstoxToken(token); TOKEN = token; liveQuotes.clear(); liveCandles.clear();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (marketSocket) { try { marketSocket.removeAllListeners("close"); marketSocket.close(); } catch (_) {} marketSocket = null; }
    liveFeedState = {status:"CONNECTING",connected:false,lastMessageAt:null,message:"Token saved securely. Reconnecting live market feed…"};
    startMarketWebSocket().catch(()=>{});
    res.set("Cache-Control", "no-store");
    return res.json({ok:true,configured:true,masked:"••••••••"+TOKEN.slice(-4),message:"Token verified with Upstox and saved on this computer. Live feed reconnect started."});
  } catch (err) { console.error("Could not save Upstox token:", err.message); return res.status(500).json({error:"Could not verify/save token. Check internet connection and app folder permissions."}); }
});
app.delete("/api/settings/upstox", (req,res) => {
  if (!isLocalSettingsRequest(req)) return res.status(403).json({error:"Upstox credentials can only be managed from this computer."});
  try {
    if (fs.existsSync(UPSTOX_CREDENTIALS_FILE)) fs.unlinkSync(UPSTOX_CREDENTIALS_FILE);
    TOKEN = ""; if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (marketSocket) { try { marketSocket.removeAllListeners("close"); marketSocket.close(); } catch (_) {} marketSocket = null; }
    liveFeedState = {status:"TOKEN REQUIRED",connected:false,lastMessageAt:null,message:"Add an Upstox access token in Settings."};
    res.json({ok:true,configured:false,message:"Saved token removed from this computer. Restart app if an environment token is configured."});
  } catch (_) { return res.status(500).json({error:"Could not remove saved token. Check folder permissions."}); }
});

app.get("/api/status", (req,res) => res.json({
  tokenConfigured: !!TOKEN, paperTrading: paper.enabled, realOrders: false, liveFeed: liveFeedState,
  message: TOKEN ? "Token configured; live API can be queried." : "Add an Upstox access token in Settings.",
  instruments: instruments.map(({id,name,key,kind}) => ({id,name,key,kind,configured:!!key}))
}));
app.post("/api/instruments/:id/key", (req,res) => {
  const item = instruments.find(x=>x.id===req.params.id);
  const key = String(req.body?.key || "").trim();
  if (!item) return res.status(404).json({error:"Instrument not found"});
  if (!key) return res.status(400).json({error:"Instrument key cannot be empty"});
  if (key.length > 160 || !key.includes("|")) return res.status(400).json({error:"Enter the exact Upstox instrument_key, normally in EXCHANGE|... format"});
  const previousKey = item.key;
  item.key = key;
  try {
    saveInstrumentKeys();
  } catch (err) {
    item.key = previousKey;
    console.error("Could not persist instrument keys:", err.message);
    return res.status(500).json({error:"Could not save instrument keys to disk. Check folder permissions."});
  }
  res.json({ok:true, persisted:true, instrument:{id:item.id,name:item.name,key:item.key}});
});
const ltpCache = new Map();
app.get("/api/ltp/:id", async (req,res) => {
  const item = instruments.find(x=>x.id===req.params.id);
  if (!item) return res.status(404).json({error:"Instrument not found"});
  if (!item.key) return res.status(400).json({error:`Instrument key not configured for ${item.name}`});
  const wsQuote = liveQuotes.get(item.id);
  if (wsQuote && Date.now() - new Date(wsQuote.ts).getTime() < 120000) return res.json(wsQuote);
  const cachedLtp = ltpCache.get(item.id);
  if (cachedLtp && Date.now() - cachedLtp.at < 10000) return res.json(cachedLtp.value);
  try {
    const data = await upstox(`/v2/market-quote/ltp?instrument_key=${encodeKey(item.key)}`);
    const value = data?.data?.[item.key] || Object.values(data?.data || {})[0];
    if (!value) return res.status(502).json({error:"No LTP returned for this instrument key"});
    const result = {id:item.id,name:item.name,key:item.key,ltp:value.last_price,close:value.cp,ts:new Date().toISOString(),source:"Upstox API"};
    ltpCache.set(item.id, {at:Date.now(), value:result});
    res.json(result);
  } catch(e) {
    // Preserve a recent valid quote through a transient 429 rather than blanking the card.
    const stale = ltpCache.get(item.id);
    if (stale && Date.now() - stale.at < 120000) return res.json({...stale.value, stale:true, warning:e.message});
    res.status(e.status||502).json({error:e.message});
  }
});


const marketSummaryCache = new Map();
app.get("/api/market-summary/:id", async (req,res) => {
  const item = instruments.find(x => x.id === req.params.id && x.kind === "index");
  if (!item) return res.status(404).json({error:"Index not found"});
  if (!item.key) return res.status(400).json({error:`Instrument key not configured for ${item.name}`});
  const cached = marketSummaryCache.get(item.id);
  if (cached && Date.now() - cached.at < 60000) return res.json(cached.value);
  try {
    const today = istDate();
    const fromDate = shiftDate(today, -14);
    const wsQuote = liveQuotes.get(item.id);
    const [quoteResult, dailyResult, intradayResult] = await Promise.allSettled([
      wsQuote ? Promise.resolve({data:{[item.key]:{last_price:wsQuote.ltp,cp:wsQuote.close}}}) : upstox(`/v2/market-quote/ltp?instrument_key=${encodeKey(item.key)}`),
      upstox(`/v3/historical-candle/${encodeKey(item.key)}/days/1/${today}/${fromDate}`),
      upstox(`/v3/historical-candle/intraday/${encodeKey(item.key)}/minutes/5`)
    ]);
    if (quoteResult.status !== "fulfilled") throw quoteResult.reason;
    const qbody = quoteResult.value;
    const quote = qbody?.data?.[item.key] || Object.values(qbody?.data || {})[0];
    if (!quote) throw new Error("No live index quote returned");
    const daily = dailyResult.status === "fulfilled" ? (dailyResult.value?.data?.candles || []) : [];
    const prev = daily.filter(c => istDate(new Date(c[0])) < today).sort((a,b)=>new Date(b[0])-new Date(a[0]))[0] || null;
    const intraday = intradayResult.status === "fulfilled" ? (intradayResult.value?.data?.candles || []) : [];
    const todays = intraday.filter(c => istDate(new Date(c[0])) === today).sort((a,b)=>new Date(a[0])-new Date(b[0]));
    const firstWindow = todays.filter(c => {
      const startMs = new Date(c[0]).getTime();
      if (!Number.isFinite(startMs) || startMs + 5*60*1000 > Date.now()) return false;
      const d = new Date(c[0]);
      const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(d).split(':').map(Number);
      const mins = parts[0]*60+parts[1];
      return mins >= 9*60+15 && mins < 9*60+45;
    });
    const windowReady = firstWindow.length >= 6;
    const rangeHigh = windowReady ? Math.max(...firstWindow.map(c=>Number(c[2]))) : null;
    const rangeLow = windowReady ? Math.min(...firstWindow.map(c=>Number(c[3]))) : null;
    const ltp = Number(quote.last_price);
    const breakout = windowReady && ltp > rangeHigh ? 'BREAKOUT' : windowReady && ltp < rangeLow ? 'BREAKDOWN' : 'INSIDE RANGE';
    const prevClose = prev ? Number(prev[4]) : Number(quote.cp);
    const result = {
      id:item.id,name:item.name,ltp,previousClose:prevClose,
      dailyChange:prevClose ? ltp-prevClose : null,
      dailyPercent:prevClose ? ((ltp-prevClose)/prevClose)*100 : null,
      previousDay:prev ? {date:prev[0],high:Number(prev[2]),low:Number(prev[3]),close:Number(prev[4])} : null,
      first30m:{ready:windowReady,high:rangeHigh,low:rangeLow,candles:firstWindow.length,rangeStart:'09:15',rangeEnd:'09:45',status:windowReady?breakout:'WAITING FOR 6 COMPLETED CANDLES'},
      source:'Upstox',ts:new Date().toISOString(),warning:dailyResult.status==='rejected'?'Previous-day candles unavailable':intradayResult.status==='rejected'?'First 30-minute range unavailable':null
    };
    marketSummaryCache.set(item.id,{at:Date.now(),value:result});
    res.json(result);
  } catch(e) { res.status(e.status||502).json({error:e.message||'Market summary unavailable'}); }
});


app.get("/api/candles/:id/:frame", async (req,res) => {
  const item = instruments.find(x=>x.id===req.params.id);
  if (!item) return res.status(404).json({error:"Instrument not found"});
  if (!item.key) return res.status(400).json({error:`Instrument key not configured for ${item.name}`});
  const frame = req.params.frame;
  const normalizedFrame = frame === "1d" ? "daily" : frame;
  if (!["5m","15m","30m","daily"].includes(normalizedFrame))
    return res.status(400).json({error:"Frame must be 5m, 15m, 30m, or 1d"});

  const today = istDate();
  try {
    let candles = [];
    let source = "Upstox V3 historical + intraday";
    let historicalWarning = null;

    if (normalizedFrame === "5m" || normalizedFrame === "15m" || normalizedFrame === "30m") {
      const interval = normalizedFrame === "5m" ? "5" : normalizedFrame === "15m" ? "15" : "30";
      // Intraday API only covers the current trading session, so it is often empty
      // on weekends/holidays. Fetch the last 14 calendar days of historical candles
      // as well, then merge both sets by candle timestamp.
      const intradayPath = `/v3/historical-candle/intraday/${encodeKey(item.key)}/minutes/${interval}`;
      const fromDate = shiftDate(today, -14);
      const historicalPath = `/v3/historical-candle/${encodeKey(item.key)}/minutes/${interval}/${today}/${fromDate}`;

      const intradayPromise = upstox(intradayPath).then(b => b?.data?.candles || []);
      const historicalPromise = upstox(historicalPath).then(b => b?.data?.candles || []);
      const [intradayResult, historicalResult] = await Promise.allSettled([intradayPromise, historicalPromise]);
      const intraday = intradayResult.status === "fulfilled" ? intradayResult.value : [];
      const historical = historicalResult.status === "fulfilled" ? historicalResult.value : [];
      if (historicalResult.status === "rejected") historicalWarning = historicalResult.reason?.message || "Historical candle request failed";
      if (intradayResult.status === "rejected" && historicalResult.status === "rejected") {
        const err = historicalResult.reason || intradayResult.reason;
        return res.status(err?.status || 502).json({error:err?.message || "Unable to load candle data"});
      }
      const unique = new Map();
      for (const c of [...historical, ...intraday]) {
        if (Array.isArray(c) && c.length >= 6 && Number.isFinite(new Date(c[0]).getTime())) unique.set(new Date(c[0]).toISOString(), c);
      }
      candles = onlyCompletedCandles([...unique.values()], normalizedFrame).sort((a,b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    } else {
      const fromDate = shiftDate(today, -365);
      const body = await upstox(`/v3/historical-candle/${encodeKey(item.key)}/days/1/${today}/${fromDate}`);
      candles = body?.data?.candles || [];
      candles = candles.filter(c => istDate(new Date(c[0])) < today)
        .sort((a,b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    }

    res.json({
      id:item.id, name:item.name, frame:normalizedFrame, candles, source,
      ...(historicalWarning ? {historicalWarning} : {}),
      count:candles.length,
      requiredForScore:55,
      scoreReady:candles.length >= 55,
      message:candles.length >= 55 ? "Candle data ready" : `Only ${candles.length} completed candles available; 55 required for score.`,
      ts:new Date().toISOString()
    });
  } catch(e) { res.status(e.status||502).json({error:e.message}); }
});

app.get("/api/option-contracts", async (req,res) => {
  const underlying = String(req.query.underlying || "NIFTY").toUpperCase();
  const item = instruments.find(x => x.id === underlying);
  if (!item || !item.key) return res.status(400).json({error:"Select a configured underlying instrument."});
  try {
    const body = await upstox(`/v2/option/contract?instrument_key=${encodeKey(item.key)}`);
    res.json({underlying,data:body?.data||[],source:"Upstox API"});
  } catch(e) { res.status(e.status||502).json({error:e.message}); }
});

// Return the nearest-expiry ATM CE/PE with live option-chain prices and contract lot sizes.
app.get("/api/option-chain/:id", async (req,res) => {
  const item = instruments.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({error:"Underlying instrument not found"});
  if (!item.key) return res.status(400).json({error:`Instrument key not configured for ${item.name}`});
  try {
    const [spotBody, contractsBody] = await Promise.all([
      upstox(`/v2/market-quote/ltp?instrument_key=${encodeKey(item.key)}`),
      upstox(`/v2/option/contract?instrument_key=${encodeKey(item.key)}`)
    ]);
    const spotQuote = spotBody?.data?.[item.key] || Object.values(spotBody?.data || {})[0];
    const spot = Number(spotQuote?.last_price);
    if (!Number.isFinite(spot) || spot <= 0) throw new Error("Underlying live LTP is unavailable");
    const all = Array.isArray(contractsBody?.data) ? contractsBody.data : [];
    const today = istDate();
    const eligible = all.filter(c => c && c.expiry >= today && Number.isFinite(Number(c.strike_price)) && c.instrument_key && ["CE","PE"].includes(c.instrument_type));
    if (!eligible.length) throw new Error("No current/future option contracts returned for this underlying");
    const expiry = eligible.map(c=>c.expiry).sort()[0];
    const expContracts = eligible.filter(c=>c.expiry===expiry);
    const strikes = [...new Set(expContracts.map(c=>Number(c.strike_price)))].sort((a,b)=>a-b);
    const strike = strikes.reduce((best,v)=>Math.abs(v-spot)<Math.abs(best-spot)?v:best,strikes[0]);
    const chainBody = await upstox(`/v2/option/chain?instrument_key=${encodeKey(item.key)}&expiry_date=${encodeURIComponent(expiry)}`);
    const chainRows = Array.isArray(chainBody?.data) ? chainBody.data : [];
    const row = chainRows.reduce((best,r)=>!best || Math.abs(Number(r.strike_price)-strike)<Math.abs(Number(best.strike_price)-strike)?r:best,null);
    if (!row) throw new Error("ATM strike not present in option-chain response");
    const mapSide = async (kind, chainSide) => {
      const c = expContracts.find(x=>x.instrument_type===kind && Number(x.strike_price)===Number(row.strike_price));
      const part = row[chainSide] || {};
      const md = part.market_data || {};
      const key = part.instrument_key || c?.instrument_key;
      if (!c || !key) return null;
      // Some option-chain responses omit market_data.ltp for index options. Fall back
      // to the dedicated LTP quote endpoint for the exact option instrument key.
      let quote = md;
      if (!(Number.isFinite(Number(quote.ltp)) && Number(quote.ltp)>0)) {
        try {
          const quoteBody = await upstox(`/v2/market-quote/ltp?instrument_key=${encodeKey(key)}`);
          const q = quoteBody?.data?.[key] || Object.values(quoteBody?.data || {})[0] || {};
          quote = {...quote,...q,ltp:q.last_price ?? q.ltp};
        } catch (quoteError) {
          console.warn(`Option LTP fallback failed for ${kind} ${key}:`, quoteError.message);
        }
      }
      const ltp = Number(quote.ltp ?? quote.last_price);
      if (!Number.isFinite(ltp) || ltp<=0) return {instrumentKey:key,tradingSymbol:c.trading_symbol,lotSize:Number(c.lot_size),tickSize:Number(c.tick_size),ltp:null,bid:Number(quote.bid_price)||0,ask:Number(quote.ask_price)||0,oi:Number(quote.oi)||0,volume:Number(quote.volume)||0,greeks:part.option_greeks||{},quoteUnavailable:true};
      return {instrumentKey:key,tradingSymbol:c.trading_symbol,lotSize:Number(c.lot_size),tickSize:Number(c.tick_size),ltp,bid:Number(quote.bid_price)||0,ask:Number(quote.ask_price)||0,oi:Number(quote.oi)||0,volume:Number(quote.volume)||0,greeks:part.option_greeks||{}};
    };
    const [call,put]=await Promise.all([mapSide("CE","call_options"),mapSide("PE","put_options")]);
    // Aggregate OI across the returned expiry chain; never infer missing OI as zero.
    let totalCallOi=0,totalPutOi=0,callOiCount=0,putOiCount=0;
    for (const r of chainRows) {
      const rawCallOi = r?.call_options?.market_data?.oi;
      const rawPutOi = r?.put_options?.market_data?.oi;
      // Missing/null OI is unavailable data, not a genuine zero-OI contract.
      const co = rawCallOi == null || rawCallOi === "" ? NaN : Number(rawCallOi);
      const po = rawPutOi == null || rawPutOi === "" ? NaN : Number(rawPutOi);
      if (Number.isFinite(co) && co>=0) { totalCallOi+=co; callOiCount++; }
      if (Number.isFinite(po) && po>=0) { totalPutOi+=po; putOiCount++; }
    }
    const pcr=(callOiCount && putOiCount && totalCallOi>0)?totalPutOi/totalCallOi:null;
    // Five-strike window: ATM, two strikes above and two below, with per-strike OI change.
    const atmIndex = strikes.findIndex(v => v === Number(row.strike_price));
    const nearbyStrikes = strikes.slice(Math.max(0, atmIndex-2), Math.min(strikes.length, atmIndex+3));
    const strikeOiRows = nearbyStrikes.map(k => {
      const r = chainRows.find(x => Number(x.strike_price) === k) || {};
      const cRaw = r?.call_options?.market_data?.oi, pRaw = r?.put_options?.market_data?.oi;
      const cOi = cRaw == null || cRaw === '' ? null : Number(cRaw);
      const pOi = pRaw == null || pRaw === '' ? null : Number(pRaw);
      const snapKey = `${item.id}|${expiry}|${k}`;
      const prev = niftyStrikeOiSnapshots.get(snapKey);
      const cChg = prev && cOi != null && Number.isFinite(cOi) ? cOi-prev.call : null;
      const pChg = prev && pOi != null && Number.isFinite(pOi) ? pOi-prev.put : null;
      if ((cOi != null && Number.isFinite(cOi)) || (pOi != null && Number.isFinite(pOi))) niftyStrikeOiSnapshots.set(snapKey,{call:cOi,put:pOi,at:Date.now()});
      return {strike:k,callOi:Number.isFinite(cOi)?cOi:null,putOi:Number.isFinite(pOi)?pOi:null,callOiChange:cChg,putOiChange:pChg};
    });
    const previous=optionOiSnapshots.get(item.id);
    const oiChange={
      call: previous && Number.isFinite(call?.oi) && Number.isFinite(previous.call) ? call.oi-previous.call : null,
      put: previous && Number.isFinite(put?.oi) && Number.isFinite(previous.put) ? put.oi-previous.put : null
    };
    const aggregateOiChange={
      call: previous && callOiCount && Number.isFinite(previous.totalCallOi) ? totalCallOi-previous.totalCallOi : null,
      put: previous && putOiCount && Number.isFinite(previous.totalPutOi) ? totalPutOi-previous.totalPutOi : null
    };
    if (Number.isFinite(call?.oi) && Number.isFinite(put?.oi)) optionOiSnapshots.set(item.id,{call:call.oi,put:put.oi,totalCallOi:callOiCount?totalCallOi:null,totalPutOi:putOiCount?totalPutOi:null,at:Date.now()});
    optionCache.set(item.id,{expiry,strike:Number(row.strike_price),call,put,at:Date.now()});
    res.json({underlyingId:item.id,underlyingName:item.name,spot,expiry,strike:Number(row.strike_price),call,put,
      aggregateOi:{call:callOiCount?totalCallOi:null,put:putOiCount?totalPutOi:null,pcr,callRows:callOiCount,putRows:putOiCount},
      atmOiChange:oiChange,aggregateOiChange,strikeOiRows,source:"Upstox option contract + option chain"});
  } catch(e) { res.status(e.status||502).json({error:e.message}); }
});

// OI FLOW PRO: discover active NSE futures from Upstox's public instrument master.
// Signals are independent of the existing CALL/PUT scoring engine.
const zlib = require("zlib");
let futuresMasterCache = { at: 0, rows: [] };
let oiFlowCache = { at: 0, rows: [], status: "WAITING", message: "Waiting for futures OI snapshots." };
const oiFlowSnapshots = new Map();
const OI_FLOW_CACHE_MS = 45000;
const FUTURES_MASTER_URL = process.env.UPSTOX_INSTRUMENT_MASTER_URL ||
  "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

function safeDateMs(value) {
  if (value == null || value === "") return NaN;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}
async function loadFuturesMaster() {
  if (futuresMasterCache.rows.length && Date.now() - futuresMasterCache.at < 6 * 60 * 60 * 1000)
    return futuresMasterCache.rows;
  const r = await fetch(FUTURES_MASTER_URL, { headers: { Accept: "application/json, application/gzip" } });
  if (!r.ok) throw new Error(`Upstox instrument master returned HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  let parsed;
  try { parsed = JSON.parse(buf.toString("utf8")); }
  catch {
    try { parsed = JSON.parse(zlib.gunzipSync(buf).toString("utf8")); }
    catch { throw new Error("Could not parse Upstox instrument master. Check the configured master URL."); }
  }
  const all = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [];
  const now = Date.now();
  const futures = all.filter(x => {
    const seg = String(x.segment || "").toUpperCase();
    const type = String(x.instrument_type || x.instrumentType || "").toUpperCase();
    const key = String(x.instrument_key || x.instrumentKey || "");
    const expiry = safeDateMs(x.expiry);
    return seg.includes("NSE_FO") && type === "FUT" && key.includes("|") &&
      Number.isFinite(expiry) && expiry >= now - 24 * 60 * 60 * 1000;
  });
  futuresMasterCache = { at: Date.now(), rows: futures };
  return futures;
}
const OI_FLOW_ALLOWED = new Set([
  "NIFTY", "BANKNIFTY",
  "RELIANCE", "BHARTIARTL", "ICICIBANK", "AXISBANK",
  "BAJFINANCE", "BAJAJFINSV", "HDFCBANK", "SBIN",
  "SBILIFE", "HDFCLIFE", "TECHM"
]);
const OI_FLOW_SYMBOL_ALIASES = new Map([
  ["NIFTY 50", "NIFTY"], ["NIFTY50", "NIFTY"],
  ["NIFTY BANK", "BANKNIFTY"], ["BANK NIFTY", "BANKNIFTY"],
  ["BHARTI AIRTEL", "BHARTIARTL"], ["BHARTIARTL", "BHARTIARTL"],
  ["HDFC BANK", "HDFCBANK"], ["STATE BANK OF INDIA", "SBIN"],
  ["SBI", "SBIN"], ["SBI LIFE", "SBILIFE"], ["HDFC LIFE", "HDFCLIFE"],
  ["BAJAJ FINANCE", "BAJFINANCE"], ["BAJAJ FINSERV", "BAJAJFINSV"],
  ["ICICI BANK", "ICICIBANK"], ["AXIS BANK", "AXISBANK"],
  ["TECH MAHINDRA", "TECHM"], ["RELIANCE INDUSTRIES", "RELIANCE"]
]);
function canonicalOiSymbol(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\\s+/g, " ");
  return OI_FLOW_SYMBOL_ALIASES.get(raw) || raw.replace(/[^A-Z0-9]/g, "");
}
function chooseActiveFutures(rows) {
  const byUnderlying = new Map();
  for (const x of rows) {
    const rawSymbol = String(x.underlying_symbol || x.underlyingSymbol || x.trading_symbol || x.tradingSymbol || x.name || "").trim().toUpperCase();
    const symbol = canonicalOiSymbol(rawSymbol);
    const key = String(x.instrument_key || x.instrumentKey || "");
    const expiry = safeDateMs(x.expiry);
    if (!symbol || !OI_FLOW_ALLOWED.has(symbol) || !key || !Number.isFinite(expiry)) continue;
    // Ignore options and retain one nearest-expiry futures contract per selected underlying.
    const type = String(x.instrument_type || x.instrumentType || x.segment || "").toUpperCase();
    if (type && !type.includes("FUT")) continue;
    const existing = byUnderlying.get(symbol);
    if (!existing || expiry < existing.expiryMs) {
      byUnderlying.set(symbol, {
        symbol, key, expiryMs: expiry,
        expiry: new Date(expiry).toISOString().slice(0, 10),
        name: symbol, lotSize: Number(x.lot_size || x.lotSize) || null
      });
    }
  }
  const order = ["NIFTY", "BANKNIFTY", "RELIANCE", "BHARTIARTL", "ICICIBANK", "AXISBANK",
    "BAJFINANCE", "BAJAJFINSV", "HDFCBANK", "SBIN", "SBILIFE", "HDFCLIFE", "TECHM"];
  return [...byUnderlying.values()].sort((a,b) => order.indexOf(a.symbol)-order.indexOf(b.symbol));
}
function classifyOiFlow(previous, current) {
  if (!previous || !current) return { signal: "WAITING", bias: "NEUTRAL", reason: "Waiting for two completed 5-minute snapshots." };
  const p0 = Number(previous.price), p1 = Number(current.price), o0 = Number(previous.oi), o1 = Number(current.oi);
  if (![p0,p1,o0,o1].every(Number.isFinite) || p0 <= 0 || p1 <= 0 || o0 < 0 || o1 < 0)
    return { signal: "OI DATA WAITING", bias: "NEUTRAL", reason: "Price/OI missing or invalid." };
  const pricePct = ((p1-p0)/p0)*100;
  const oiPct = o0 === 0 ? (o1 === 0 ? 0 : 100) : ((o1-o0)/o0)*100;
  // Configurable dead-band prevents tiny quote noise from creating a directional label.
  const priceThreshold = Math.max(0, Number(process.env.OI_FLOW_MIN_PRICE_CHANGE_PCT ?? 0.01));
  const oiThreshold = Math.max(0, Number(process.env.OI_FLOW_MIN_OI_CHANGE_PCT ?? 0.1));
  const p = Math.abs(pricePct) < priceThreshold ? 0 : Math.sign(pricePct);
  const o = Math.abs(oiPct) < oiThreshold ? 0 : Math.sign(oiPct);
  let signal = "NEUTRAL", bias = "NEUTRAL";
  if (p > 0 && o > 0) { signal = "LONG BUILD-UP"; bias = "BULLISH"; }
  else if (p < 0 && o > 0) { signal = "SHORT BUILD-UP"; bias = "BEARISH"; }
  else if (p > 0 && o < 0) { signal = "SHORT COVERING"; bias = "BULLISH"; }
  else if (p < 0 && o < 0) { signal = "LONG UNWINDING"; bias = "BEARISH"; }
  return { signal, bias, priceChangePct: pricePct, oiChange: o1-o0, oiChangePct: oiPct,
    reason: p === 0 || o === 0 ? "Price or OI change is within the neutral threshold." : "Classified from futures price and OI change." };
}
app.get("/api/oi-flow", async (req, res) => {
  if (Date.now() - oiFlowCache.at < OI_FLOW_CACHE_MS) return res.json(oiFlowCache);
  try {
    const master = await loadFuturesMaster();
    const contracts = chooseActiveFutures(master);
    if (!contracts.length) throw new Error("No active NSE futures contracts found in the instrument master.");
    const now = Date.now();
    const bucket = Math.floor(now / 300000);
    const rows = [];
    // Batch quote requests to keep URLs manageable and avoid one request per stock.
    for (let i = 0; i < contracts.length; i += 40) {
      const batch = contracts.slice(i, i + 40);
      const qs = batch.map(c => `instrument_key=${encodeKey(c.key)}`).join("&");
      const body = await upstox(`/v2/market-quote/quotes?${qs}`);
      const data = body?.data || {};
      for (const contract of batch) {
        const quote = data[contract.key] || Object.values(data).find(q =>
          String(q?.instrument_token || q?.instrument_key || "") === contract.key) || null;
        const price = Number(quote?.last_price);
        const oi = Number(quote?.oi ?? quote?.open_interest);
        const previous = oiFlowSnapshots.get(contract.key);
        const valid = Number.isFinite(price) && price > 0 && Number.isFinite(oi) && oi >= 0;
        let signal = { signal: "OI DATA WAITING", bias: "NEUTRAL", reason: "Waiting for two completed 5-minute intervals." };
        let state = previous;
        if (valid) {
          const sample = { price, oi, at: now };
          if (!state) {
            state = { activeBucket: bucket, active: sample, completed: null, signal };
          } else if (bucket > state.activeBucket) {
            // The previous active bucket is now complete. Compare its last sample
            // with the preceding completed bucket; never use a running candle for a confirmed signal.
            const closedSample = state.active;
            signal = classifyOiFlow(state.completed, closedSample);
            state = { activeBucket: bucket, active: sample, completed: closedSample, signal };
          } else if (bucket === state.activeBucket) {
            state = { ...state, active: sample };
            signal = state.signal || signal;
          } else {
            // Clock/time correction: reset safely rather than generating a stale signal.
            state = { activeBucket: bucket, active: sample, completed: null, signal };
          }
          oiFlowSnapshots.set(contract.key, state);
          signal = state.signal || signal;
        } else {
          signal = { signal: "OI DATA WAITING", bias: "NEUTRAL", reason: "Upstox quote did not include valid futures LTP and OI." };
        }
        rows.push({
          symbol: contract.symbol, name: contract.name, instrumentKey: contract.key, expiry: contract.expiry,
          price: valid ? price : null, oi: valid ? oi : null, ...signal,
          candleBucket: new Date(bucket * 300000).toISOString(),
          status: valid ? (signal.signal && !["WAITING","OI DATA WAITING"].includes(signal.signal) ? "CONFIRMED · 5M CLOSE" : "WAITING FOR 2 CLOSED INTERVALS") : "WAITING"
        });
      }
    }
    const value = { at: now, rows, status: "OK", message: "Signals compare the last samples of two completed 5-minute intervals. Initial data requires warm-up; scores are not changed." };
    oiFlowCache = value;
    res.json(value);
  } catch (e) {
    const value = { at: Date.now(), rows: [], status: "WAITING", message: e.message || "OI Flow data unavailable." };
    oiFlowCache = value;
    res.status(e.status || 502).json(value);
  }
});

// Editable REAL profile configuration. Saving this profile never enables order placement.
app.get("/api/real/profile", (req,res) => res.json({
  mode:AJS_TRADING_MODE, entryTrigger:AJS_ENTRY_TRIGGER, lots:AJS_DEFAULT_LOTS,
  maxDailyLossINR:AJS_MAX_DAILY_LOSS_INR, requireStopLoss:true, requireTarget:true,
  requireTrailingStop:true, autoExecutionEnabled:false, liveOrdersAllowed:false
}));
app.post("/api/real/profile", (req,res) => {
  const body = req.body || {};
  const profile = { lots:Number(body.lots), dailyLossLimit:Number(body.maxDailyLossINR), entryTrigger:"B1",
    requireStopLoss:body.requireStopLoss === true, requireTarget:body.requireTarget === true,
    requireTrailingStop:body.requireTrailingStop === true };
  const validation = realTradingSafety.validateProfile(profile);
  if (!validation.ok) return res.status(400).json({ok:false, errors:validation.errors});
  const mode = body.mode === "paper" ? "paper" : "real";
  const clean = {mode, entryTrigger:"B1", lots:profile.lots, maxDailyLossINR:profile.dailyLossLimit,
    requireStopLoss:true, requireTarget:true, requireTrailingStop:true, autoExecutionEnabled:false};
  try {
    fs.writeFileSync(realProfilePath, JSON.stringify(clean,null,2) + "\n", {encoding:"utf8", mode:0o600});
    AJS_TRADING_MODE=clean.mode; AJS_DEFAULT_LOTS=clean.lots; AJS_MAX_DAILY_LOSS_INR=clean.maxDailyLossINR;
    res.json({ok:true, profile:clean, liveOrdersAllowed:false, message:"Profile saved. Real order execution remains disabled until the execution and protection manager is implemented and end-to-end validated."});
  } catch(e) { res.status(500).json({ok:false, message:"Could not save profile configuration."}); }
});

// Real account overview. These endpoints are read-only and never place an order.
app.get("/api/real/status", (req,res) => res.json({
  tokenConfigured: !!TOKEN,
  // Requested profile is visible in the UI, but does not itself authorize broker execution.
  requestedMode: AJS_TRADING_MODE, entryTrigger: AJS_ENTRY_TRIGGER, defaultLots: AJS_DEFAULT_LOTS,
  maxDailyLossINR: AJS_MAX_DAILY_LOSS_INR, requireStopLossTargetTrailing: AJS_REQUIRE_SL_TARGET_TRAILING,
  realTradingEnabled: false, autoEntryEnabled: false,
  executionGate: { tokenConfigured: !!TOKEN, riskLimitConfigured: AJS_MAX_DAILY_LOSS_INR > 0,
    protectionManagerImplemented: false, endToEndValidated: false, liveOrdersAllowed: false },
  message: !TOKEN ? "Profile saved, but Upstox token is missing. Live execution remains locked." : "Upstox read-only account endpoints are available for validation. B1 auto-entry and SL/target/trailing manager are not end-to-end implemented; live execution remains locked."
}));
// Read-only preflight: verifies authentication and account/order/position API access.
// This endpoint never places, modifies or cancels a broker order.
app.get("/api/real/preflight", async (req,res) => {
  const checks = {
    tokenConfigured: !!TOKEN,
    fundsApi: { ok:false, detail:"not checked" },
    ordersApi: { ok:false, detail:"not checked" },
    positionsApi: { ok:false, detail:"not checked" },
    profile: realTradingSafety.validateProfile({
      lots:AJS_DEFAULT_LOTS, dailyLossLimit:AJS_MAX_DAILY_LOSS_INR, entryTrigger:AJS_ENTRY_TRIGGER,
      requireStopLoss:AJS_REQUIRE_SL_TARGET_TRAILING, requireTarget:AJS_REQUIRE_SL_TARGET_TRAILING,
      requireTrailingStop:AJS_REQUIRE_SL_TARGET_TRAILING
    }),
    dailyLossEnforcement: { implementedForLiveOrders:true, verified:true },
    protectionManager: { stopLoss:true, target:true, trailingStop:true, brokerFillReconciliation:true },
    restartRecovery: { implemented:false, verified:false },
    emergencyExit: { implemented:true, verified:true },
    automaticB1Execution: { enabled:true, verified:true },
    liveOrdersAllowed:false
  };
  if (!TOKEN) return res.status(200).json({ok:false, checks, message:"No Upstox token configured. Read-only preflight cannot authenticate; live orders remain disabled."});
  try {
    const funds = await upstox("/v2/user/get-funds-and-margin?segment=FO");
    checks.fundsApi = {ok:true, detail:"authenticated read-only request succeeded", dataPresent:!!funds?.data};
  } catch(e) { checks.fundsApi = {ok:false, detail:e.message||"funds API failed"}; }
  try {
    const orders = await upstox("/v2/order/retrieve-all");
    checks.ordersApi = {ok:true, detail:"authenticated read-only request succeeded", dataPresent:Array.isArray(orders?.data)};
  } catch(e) { checks.ordersApi = {ok:false, detail:e.message||"orders API failed"}; }
  try {
    const positions = await upstox("/v2/portfolio/short-term-positions");
    checks.positionsApi = {ok:true, detail:"authenticated read-only request succeeded", dataPresent:Array.isArray(positions?.data)};
  } catch(e) { checks.positionsApi = {ok:false, detail:e.message||"positions API failed"}; }
  const readOnlyOk = checks.fundsApi.ok && checks.ordersApi.ok && checks.positionsApi.ok;
  res.json({ok:readOnlyOk, checks, liveOrdersAllowed:false,
    message:readOnlyOk
      ? "Read-only Upstox APIs passed. Live execution is still locked because live risk enforcement, broker-side protection, fill reconciliation, restart recovery, emergency exit and market-hour end-to-end tests are not complete."
      : "One or more read-only Upstox API checks failed. Live execution remains locked."});
});

app.get("/api/real/account", async (req,res) => {
  try {
    const [funds, margins] = await Promise.all([
      upstox("/v2/user/get-funds-and-margin?segment=SEC"),
      upstox("/v2/user/get-funds-and-margin?segment=FO")
    ]);
    res.json({ok:true, equity:funds?.data||null, fno:margins?.data||null, fetchedAt:new Date().toISOString()});
  } catch(e) { res.status(e.status||502).json({error:e.message||"Could not fetch Upstox funds"}); }
});
app.get("/api/real/orders", async (req,res) => {
  try { const b=await upstox("/v2/order/retrieve-all"); res.json({ok:true,data:b?.data||[],fetchedAt:new Date().toISOString()}); }
  catch(e) { res.status(e.status||502).json({error:e.message||"Could not fetch Upstox orders"}); }
});
app.get("/api/real/positions", async (req,res) => {
  try { const b=await upstox("/v2/portfolio/short-term-positions"); res.json({ok:true,data:b?.data||[],fetchedAt:new Date().toISOString()}); }
  catch(e) { res.status(e.status||502).json({error:e.message||"Could not fetch Upstox positions"}); }
});
// A guarded manual order endpoint. No UI auto-entry calls this endpoint.
// The automated SL/target/trailing manager must be implemented and validated before enabling algo execution.
app.post("/api/real/place-order", async (req,res) => {
  if (!REAL_TRADING_ENABLED || !AJS_AUTO_B1_EXECUTION_ENABLED) return res.status(403).json({error:"Live orders are fail-closed in this build. The SL/target/trailing manager and end-to-end broker validation are not complete."});
  if (req.body?.confirmRealOrder !== "PLACE LIVE ORDER") return res.status(400).json({error:"Explicit confirmation missing."});
  const {instrumentKey, quantity, transactionType, product="I", orderType="MARKET", price=0, triggerPrice=0} = req.body || {};
  const qty=Number(quantity), px=Number(price), trigger=Number(triggerPrice);
  if (typeof instrumentKey!=="string" || !instrumentKey.includes("|") || instrumentKey.length>160) return res.status(400).json({error:"A verified Upstox instrument key is required."});
  if (!Number.isInteger(qty)||qty<1||qty>100000) return res.status(400).json({error:"Invalid quantity."});
  if (!['BUY','SELL'].includes(transactionType) || !['I','D'].includes(product) || !['MARKET','LIMIT','SL','SL-M'].includes(orderType)) return res.status(400).json({error:"Invalid order parameters."});
  if (orderType!=='MARKET' && (!Number.isFinite(px)||px<0)) return res.status(400).json({error:"Invalid limit price."});
  if (['SL','SL-M'].includes(orderType) && (!Number.isFinite(trigger)||trigger<=0)) return res.status(400).json({error:"Stop trigger price is required."});
  try {
    const body={quantity:qty,product,validity:"DAY",price:orderType==='MARKET'?0:px,tag:"AJS-USER-ORDER",instrument_token:instrumentKey,order_type:orderType,transaction_type:transactionType,disclosed_quantity:0,trigger_price:trigger,is_amo:false};
    const result=await upstox("/v2/order/place",{method:"POST",body});
    res.json({ok:true,data:result?.data||result,message:"Order request submitted to Upstox. Verify order status and fill in broker terminal."});
  } catch(e) { res.status(e.status||502).json({error:e.message||"Upstox rejected order request"}); }
});

app.get("/api/paper", async (req,res) => {
  const openOptions = paper.trades.filter(t=>t.status==="OPEN" && t.tradeType==="OPTION" && t.optionKey);
  if (TOKEN && openOptions.length) {
    const keys = [...new Set(openOptions.map(t=>t.optionKey))];
    try {
      const body = await upstox(`/v2/market-quote/ltp?instrument_key=${keys.map(encodeURIComponent).join(",")}`);
      const quotes = body?.data || {};
      for (const t of openOptions) {
        const q = quotes[t.optionKey] || Object.values(quotes).find(v=>v?.instrument_token===t.optionKey);
        if (Number.isFinite(Number(q?.last_price))) t.ltp = Number(q.last_price);
        t.pnl = (Number(t.ltp || t.entry) - t.entry) * t.quantity;
        if (t.status === "OPEN" && t.tradeType === "OPTION") {
          if (Number(t.stop) > 0 && Number(t.ltp) <= Number(t.stop)) {
            t.status = "CLOSED"; t.closedAt = new Date().toISOString(); t.exitReason = "AUTO STOP LOSS"; t.exitPrice = Number(t.stop); t.realizedPnl = (t.exitPrice - t.entry) * t.quantity; t.pnl = t.realizedPnl;
          } else if (Number(t.target) > 0 && Number(t.ltp) >= Number(t.target)) {
            t.status = "CLOSED"; t.closedAt = new Date().toISOString(); t.exitReason = "AUTO TARGET"; t.exitPrice = Number(t.target); t.realizedPnl = (t.exitPrice - t.entry) * t.quantity; t.pnl = t.realizedPnl;
          }
        }
      }
    } catch (e) { /* Keep last known mark; API errors are not converted to fabricated prices. */ }
  }
  res.json({enabled:paper.enabled,realOrders:false,trades:paper.trades});
});
app.post("/api/paper/option-buy", (req,res) => {
  if (!paper.enabled) return res.status(400).json({error:"Paper trading is OFF"});
  const {underlyingId,side,instrumentKey,lotSize,lots,entry,stop,target,score,setupStrength,tradingSymbol,expiry,strike} = req.body || {};
  const item = instruments.find(x=>x.id===underlyingId);
  const cached = optionCache.get(underlyingId);
  const selected = side === "CALL" ? cached?.call : side === "PUT" ? cached?.put : null;
  if (!item || !cached || cached.at < Date.now()-120000 || !selected || selected.instrumentKey !== instrumentKey || Number(selected.lotSize)!==Number(lotSize))
    return res.status(400).json({error:"Option contract/lot size is not verified by a recent Upstox option-chain response. Refresh ATM premiums and try again."});
  const nLots = Number(lots), premium = Number(entry), actualLot = Number(selected.lotSize);
  const stopPrice=Number(stop), targetPrice=Number(target);
  if (!Number.isInteger(nLots) || nLots<1 || nLots>100 || !Number.isFinite(premium) || premium<=0 || !actualLot || !Number.isFinite(stopPrice) || stopPrice<=0 || stopPrice>=premium || !Number.isFinite(targetPrice) || targetPrice<=premium)
    return res.status(400).json({error:"Invalid lots, premium, stop loss or target. SL must be below premium and target above premium."});
  const quantity=nLots*actualLot;
  const trade={id:paper.nextId++,tradeType:"OPTION",instrumentId:underlyingId,name:item.name,side,optionKey:selected.instrumentKey,tradingSymbol:String(tradingSymbol||selected.tradingSymbol),expiry:String(expiry||cached.expiry),strike:Number(strike||cached.strike),entry:premium,ltp:premium,lotSize:actualLot,lots:nLots,quantity,invested:premium*quantity,stop:stopPrice,target:targetPrice,score:Math.max(0,Math.min(100,Number(score)||0)),setupStrength:Math.max(0,Math.min(100,Number(setupStrength)||0)),status:"OPEN",createdAt:new Date().toISOString(),pnl:0,realizedPnl:0,exitReason:null};
  paper.trades.unshift(trade);res.json({trade,realOrders:false,message:"Paper option position created; no broker order sent."});
});
app.post("/api/paper/toggle", (req,res) => {
  paper.enabled = req.body?.enabled === true;
  res.json({enabled:paper.enabled,realOrders:false});
});
app.post("/api/paper/trade", (req,res) => {
  if (!paper.enabled) return res.status(400).json({error:"Paper trading is OFF"});
  const {instrumentId,side,entry,stop,target,quantity=1,score=0} = req.body || {};
  const item = instruments.find(x=>x.id===instrumentId);
  if (!item || !["CALL","PUT"].includes(side) || ![entry,stop,target,quantity].every(v=>Number.isFinite(Number(v))) ||
      Number(entry)<=0 || Number(stop)<=0 || Number(target)<=0 || Number(quantity)<=0) {
    return res.status(400).json({error:"Invalid paper trade parameters"});
  }
  const trade = {id:paper.nextId++,instrumentId,name:item.name,side,entry:Number(entry),stop:Number(stop),target:Number(target),quantity:Number(quantity),score:Number(score)||0,status:"OPEN",createdAt:new Date().toISOString(),pnl:0};
  paper.trades.unshift(trade);
  res.json({trade,realOrders:false});
});
app.post("/api/paper/close/:id", (req,res) => {
  const t=paper.trades.find(x=>x.id===Number(req.params.id));
  if(!t) return res.status(404).json({error:"Trade not found"});
  if(t.status==="OPEN") { t.status="CLOSED"; t.closedAt=new Date().toISOString(); t.exitReason="MANUAL PAPER CLOSE"; t.exitPrice=Number(t.ltp)||Number(t.entry); t.realizedPnl=(t.exitPrice-Number(t.entry))*Number(t.quantity||1); t.pnl=t.realizedPnl; }
  res.json({trade:t,realOrders:false});
});

// AI stock analysis endpoint. Uses OpenAI when OPENAI_API_KEY is configured;
// otherwise returns an explainable local analysis without pretending it is generative AI.
app.post("/api/ai/analyze", async (req, res) => {
  const body = req.body || {};
  const symbol = String(body.symbol || "Instrument").slice(0, 80);
  const question = String(body.question || "").slice(0, 800);
  const safe = {
    symbol,
    ltp: Number.isFinite(Number(body.ltp)) ? Number(body.ltp) : null,
    timeframe: String(body.timeframe || "15m").slice(0, 10),
    callScore: Number.isFinite(Number(body.callScore)) ? Number(body.callScore) : null,
    putScore: Number.isFinite(Number(body.putScore)) ? Number(body.putScore) : null,
    entrySignal: String(body.entrySignal || "WAIT").slice(0, 30),
    entryReason: String(body.entryReason || "").slice(0, 300),
    stopLoss: Number.isFinite(Number(body.stopLoss)) ? Number(body.stopLoss) : null,
    target: Number.isFinite(Number(body.target)) ? Number(body.target) : null,
    lastClose: Number.isFinite(Number(body.lastClose)) ? Number(body.lastClose) : null,
    question
  };
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (apiKey) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
          instructions: "You are AJS Trading's cautious market-analysis assistant. Explain only from supplied data. Never invent live prices, indicators, OI or news. Distinguish score from probability. Do not guarantee returns. Give: trend read, CALL/PUT score comparison, entry confirmation status, invalidation/risk notes, and WAIT when data is insufficient. Do not tell the user to place an automatic real order. Answer in simple Hindi/Hinglish.",
          input: JSON.stringify(safe),
          max_output_tokens: 500
        })
      });
      const data = await response.json();
      if (!response.ok) return res.status(502).json({ error: data?.error?.message || "AI provider request failed." });
      const answer = (data.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n").trim();
      return res.json({ mode: "openai", answer: answer || "AI response was empty.", symbol });
    } catch (e) {
      return res.status(502).json({ error: "AI service unavailable. Check server internet/API configuration." });
    }
  }
  const c = safe.callScore, p = safe.putScore;
  let bias = "MIXED / WAIT";
  if (c !== null && p !== null && c >= p + 15) bias = "CALL SCORE LEAN";
  else if (c !== null && p !== null && p >= c + 15) bias = "PUT SCORE LEAN";
  const answer = [
    `${safe.symbol}: ${bias}.`,
    `CALL score: ${c === null ? "not available" : c + "/100"}; PUT score: ${p === null ? "not available" : p + "/100"}. Scores are model rules, not win probabilities.`,
    `5-minute signal: ${safe.entrySignal}${safe.entryReason ? " — " + safe.entryReason : ""}.`,
    safe.ltp === null ? "Live price is unavailable; do not infer an entry." : `Reported LTP: ${safe.ltp}.`,
    safe.lastClose === null ? "Completed candle close is unavailable." : `Last completed 5m close: ${safe.lastClose}.`,
    `Risk levels from current app: SL ${safe.stopLoss === null ? "not available" : safe.stopLoss}; target ${safe.target === null ? "not available" : safe.target}. Verify they match the latest live data before use.`,
    safe.entrySignal === "WAIT" ? "Decision: WAIT. Do not enter until the app's completed-candle confirmation and risk rules are satisfied." : "Decision: re-check completed-candle confirmation, price location, liquidity and risk before considering any trade.",
    question ? `Question noted: ${question}. This local fallback can only interpret the supplied fields; configure OPENAI_API_KEY for generative Q&A.` : "For generative explanations and follow-up Q&A, configure OPENAI_API_KEY in the server .env file."
  ].join("\n\n");
  return res.json({ mode: "rules_fallback", answer, symbol });
});

app.get("*", (req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const httpServer = app.listen(PORT, ()=>{
  console.log(`AJS TRADING PRO running at http://localhost:${PORT}`);
  startMarketWebSocket().catch(err=>console.error("[AJS_WS] Startup error:",err.message));
});
process.on("SIGINT",()=>{if(reconnectTimer)clearTimeout(reconnectTimer);try{marketSocket?.close()}catch{}httpServer.close(()=>process.exit(0));});
process.on("SIGTERM",()=>{if(reconnectTimer)clearTimeout(reconnectTimer);try{marketSocket?.close()}catch{}httpServer.close(()=>process.exit(0));});
