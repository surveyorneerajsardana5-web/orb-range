require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
app.use(express.json());

// Serve frontend assets from whichever common build folder exists in Render.
const FRONTEND_DIRS = [
  path.join(__dirname, "public"),
  path.join(__dirname, "dist"),
  path.join(__dirname, "build")
];
for (const dir of FRONTEND_DIRS) {
  if (fs.existsSync(dir)) app.use(express.static(dir));
}
function resolveIndexFile() {
  const candidates = [
    path.join(__dirname, "public", "index.html"),
    path.join(__dirname, "dist", "index.html"),
    path.join(__dirname, "build", "index.html"),
    path.join(__dirname, "index.html")
  ];
  return candidates.find(file => fs.existsSync(file));
}

const PORT = Number(process.env.PORT || 3000);
const API = "https://api.upstox.com";
const TOKEN = (process.env.UPSTOX_ACCESS_TOKEN || "").trim();

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
const paper = { enabled: true, trades: [], nextId: 1 };

async function upstox(pathname) {
  if (!TOKEN) {
    const e = new Error("UPSTOX_ACCESS_TOKEN is missing. Add it to .env and restart the app.");
    e.status = 401; throw e;
  }
  const r = await fetch(API + pathname, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept:"application/json" }
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body?.errors?.[0]?.message || body?.message || `Upstox API returned ${r.status}`);
    e.status = r.status; throw e;
  }
  return body;
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
  if (frame !== "5m" && frame !== "15m") return candles;
  const duration = (frame === "5m" ? 5 : 15) * 60 * 1000;
  return candles.filter(c => {
    const start = new Date(c?.[0]).getTime();
    return Number.isFinite(start) && start + duration <= now;
  });
}

app.get("/api/status", (req,res) => res.json({
  tokenConfigured: !!TOKEN, paperTrading: paper.enabled, realOrders: false,
  message: TOKEN ? "Token configured; live API can be queried." : "Configure UPSTOX_ACCESS_TOKEN in .env.",
  instruments: instruments.map(({id,name,key,kind}) => ({id,name,key,kind,configured:!!key}))
}));
app.post("/api/instruments/:id/key", (req,res) => {
  const item = instruments.find(x=>x.id===req.params.id);
  const key = String(req.body?.key || "").trim();
  if (!item) return res.status(404).json({error:"Instrument not found"});
  if (!key) return res.status(400).json({error:"Instrument key cannot be empty"});
  if (key.length > 160 || !key.includes("|")) return res.status(400).json({error:"Enter the exact Upstox instrument_key, normally in EXCHANGE|... format"});
  item.key = key;
  res.json({ok:true, instrument:{id:item.id,name:item.name,key:item.key}});
});
app.get("/api/ltp/:id", async (req,res) => {
  const item = instruments.find(x=>x.id===req.params.id);
  if (!item) return res.status(404).json({error:"Instrument not found"});
  if (!item.key) return res.status(400).json({error:`Instrument key not configured for ${item.name}`});
  try {
    const data = await upstox(`/v2/market-quote/ltp?instrument_key=${encodeKey(item.key)}`);
    const value = data?.data?.[item.key] || Object.values(data?.data || {})[0];
    if (!value) return res.status(502).json({error:"No LTP returned for this instrument key"});
    res.json({id:item.id,name:item.name,key:item.key,ltp:value.last_price,close:value.cp,ts:new Date().toISOString(),source:"Upstox API"});
  } catch(e) { res.status(e.status||502).json({error:e.message}); }
});

app.get("/api/candles/:id/:frame", async (req,res) => {
  const item = instruments.find(x=>x.id===req.params.id);
  if (!item) return res.status(404).json({error:"Instrument not found"});
  if (!item.key) return res.status(400).json({error:`Instrument key not configured for ${item.name}`});
  const frame = req.params.frame;
  if (!["5m","15m","daily"].includes(frame))
    return res.status(400).json({error:"Frame must be 5m, 15m, or daily"});

  const today = istDate();
  try {
    let candles = [];
    let source = "Upstox V3 historical + intraday";
    let historicalWarning = null;

    if (frame === "5m" || frame === "15m") {
      const interval = frame === "5m" ? "5" : "15";
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
      candles = onlyCompletedCandles([...unique.values()], frame).sort((a,b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    } else {
      const fromDate = shiftDate(today, -365);
      const body = await upstox(`/v3/historical-candle/${encodeKey(item.key)}/days/1/${today}/${fromDate}`);
      candles = body?.data?.candles || [];
      candles = candles.filter(c => istDate(new Date(c[0])) < today)
        .sort((a,b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    }

    res.json({
      id:item.id, name:item.name, frame, candles, source,
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
  const allowed = ["NIFTY","BANKNIFTY"];
  if (!allowed.includes(underlying)) return res.status(400).json({error:"underlying must be NIFTY or BANKNIFTY"});
  const key = underlying==="NIFTY" ? "NSE_INDEX|Nifty 50" : "NSE_INDEX|Nifty Bank";
  try {
    const body = await upstox(`/v2/option/contract?instrument_key=${encodeKey(key)}`);
    res.json({underlying,data:body?.data||[],source:"Upstox API"});
  } catch(e) { res.status(e.status||502).json({error:e.message,help:"If your Upstox API plan/endpoint differs, use the option contract endpoint documented for your account."}); }
});
app.get("/api/paper", (req,res) => res.json({enabled:paper.enabled,realOrders:false,trades:paper.trades}));
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
  if(t.status==="OPEN") { t.status="CLOSED"; t.closedAt=new Date().toISOString(); }
  res.json({trade:t,realOrders:false});
});
app.get("*", (req,res,next) => {
  const indexFile = resolveIndexFile();
  if (!indexFile) {
    return res.status(500).type("text/plain").send(
      "Frontend index.html not found. Put it in public/index.html, dist/index.html, build/index.html, or the project root."
    );
  }
  return res.sendFile(indexFile);
});
app.listen(PORT, ()=>console.log(`AJS TRADING PRO running at http://localhost:${PORT}`));
