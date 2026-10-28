# AJS TRADING PRO — Indicator & NIFTY Premium Correction

## बदलाव
- 5-minute chart पर EMA 9 green, EMA 21 blue, VWAP black, EMA 50 orange, DMA 200 purple और SuperTrend green/red lines।
- Chart के नीचे RSI(14), EMA, VWAP, DMA 200 और SuperTrend values।
- NIFTY ATM CALL/PUT premium के लिए option-chain के बाद exact option instrument key से अलग LTP quote fallback।
- अगर Upstox valid premium न दे, तो `LTP unavailable` दिखेगा और उस side का buy button नहीं दिखेगा। Fake/zero premium से buy नहीं होगा।

## Run (Windows 11)
1. ZIP Extract करें।
2. `.env.example` की copy बनाकर `.env` नाम दें।
3. `.env` में अपना valid `UPSTOX_ACCESS_TOKEN` रखें; token किसी से share न करें।
4. CMD में project folder खोलें और `npm install`, फिर `npm start` चलाएँ।
5. Chrome में `http://localhost:3000` खोलें।

## ध्यान दें
Live premium/indicator verification के लिए valid Upstox token, API permissions और market session आवश्यक हैं। DMA 200 के लिए 200 candles चाहिए। यह application indicator lines दिखाती है; trading signals/profit guaranteed नहीं हैं।


## नया Market Index Overview
- Dashboard के ऊपर NIFTY 50 और BANK NIFTY की live LTP तथा previous close से daily change/% दिखता है।
- Previous trading day का High, Low और Close दिखता है।
- आज 09:15–09:45 IST की पहली 30-minute range बनाने के लिए छह completed 5-minute candles चाहिए।
- LTP range high के ऊपर होने पर BREAKOUT और range low के नीचे होने पर BREAKDOWN alert दिखता है। Browser notifications के लिए अनुमति दें।
- Market summary server-side 30 seconds cache होती है; UI refresh हर 5 seconds होता है। Live values के लिए valid Upstox token और market data access जरूरी है।


## Chart और Free WhatsApp Top Setup Alert
- 5-minute chart अब stock workspace खुलने के बाद layout-ready frame में redraw होता है; canvas responsive sizing इस्तेमाल करता है। Chart के लिए Upstox token और instrument key/permissions जरूरी हैं।
- Instrument row या card पर click करके `Analysis & chart` खोलें।
- `Instrument settings` में mobile number save करें। Settings में अधिकतम 5 WhatsApp नंबर country code सहित save करें। Confirmed top setup पर “Prepare WhatsApp for N contacts” दबाएँ; हर contact की prefilled WhatsApp chat खुलेगी। हर chat में Send दबाना जरूरी है; browser pop-up permission दें।
- Top setup WhatsApp message तभी तैयार होता है जब confirmed CALL/PUT score >= 70 हो; प्रत्येक candle/signal key के लिए duplicate requests रोकी जाती हैं। Provider acceptance का अर्थ handset delivery guarantee नहीं है।
- `.env` और WhatsApp message भेजने से पहले setup की पुष्टि करें. Real orders remain disabled; trades are paper only.


## Rate-limit fix (AJS update)
- Browser refresh default is now 15 seconds (instead of 5 seconds).
- Upstox requests are queued with a minimum gap, to avoid burst traffic.
- HTTP 429 activates a short cooldown; recent valid NIFTY/BANK NIFTY LTP is shown during a temporary rate limit.
- Index overview is cached/throttled; candles are cached longer in the browser.
- If 429 persists, wait for the cooldown and verify Upstox API quota/token. Do not create multiple app tabs or start multiple server instances.


## Upstox V3 WebSocket update
- Added a central Upstox V3 WebSocket connection using the official V3 authorization endpoint and Protobuf feed schema.
- Browser receives ticks over Server-Sent Events (`/api/live/events`); no per-browser LTP polling is required for configured instruments.
- Live LTP is served from the WebSocket cache; REST remains available as fallback and for historical candles.
- Live 5-minute OHLC is built from ticks for the chart's running candle. Signals still use completed historical candles only.
- Auto-reconnect uses backoff. Check the terminal for `[AJS_WS] CONNECTED`, decode errors, and close codes.
- Set exact Upstox instrument keys in Settings; NIFTY and BANK NIFTY are prefilled. Equity keys are intentionally not guessed.
- Live verification requires a valid Upstox access token, working network, and active market feed entitlement. Outside market hours, a socket may connect but ticks may not update.


## Broker UI update
- NIFTY 50 and BANK NIFTY index cards now show live price, daily change/percent and separate CALL/PUT scores.
- CALL/PUT score remains WAITING until enough candle data is available; no score is invented.
- Responsive broker-terminal styling has been enhanced for desktop and mobile screens.
- Upstox V3 subscription request is sent as a binary WebSocket frame.


## UI/chart correction
- Reduced NIFTY and BANK NIFTY summary cards and compacted spacing to show more information above the fold.
- Added 5m, 15m, 30m and 1 Day chart controls.
- Added actual zoom behavior (visible candle count changes), IST time labels beneath the chart, and click-to-place horizontal price levels.
- Compressed stock table rows and improved sticky table header/responsive layout.
- 30-minute candle endpoint support added. Live API/UI behavior still requires a valid Upstox token and local browser verification.


## NIFTY/BANK NIFTY score WAITING correction
- Re-applies cached scores after the index-card renderer finishes, preventing the card render from resetting scores to WAITING.
- Shows the exact readiness reason and completed-candle count under each index score.
- Scoring requires 55 completed candles for the selected score timeframe; if the message shows insufficient candles or an API error, fix data/token/instrument-key/rate-limit first rather than displaying a fake score.


## नया BOX 1: NIFTY Opening Range + ATM Option Chain
- 09:15–09:45 IST की opening range, high/low और range size 5-minute candles से।
- Current NIFTY से range high/low तक points की दूरी और breakout/breakdown watch।
- दिशा संकेत heuristic है, validated probability नहीं; breakout के लिए completed 5-minute close/volume confirm करें।
- Nearest-expiry ATM CALL/PUT premium, ATM OI, expiry/strike, aggregate option-chain PCR और aggregate Call OI vs Put OI।
- ATM OI change पिछली सफल refresh से तुलना है; पहली refresh baseline बनाती है। ऐप restart पर baseline reset होगा।
- डेटा Upstox से आता है। Token/API/market data अनुपलब्ध होने पर WAITING/Unavailable दिखेगा; values fabricate नहीं की जातीं।


## OI FLOW PRO — Futures Positioning (नया)
- Dashboard में OI FLOW PRO सेक्शन जोड़ा गया है। यह Upstox के public NSE instrument master से nearest-expiry NSE futures contracts खोजता है, जिनमें NIFTY, BANK NIFTY और eligible F&O stock futures शामिल हैं।
- `/api/oi-flow` futures quotes से LTP और OI लेता है और consecutive completed 5-minute intervals के last available snapshots की तुलना करता है।
- Signals: LONG BUILD-UP (Price ↑ / OI ↑), SHORT BUILD-UP (Price ↓ / OI ↑), SHORT COVERING (Price ↑ / OI ↓), LONG UNWINDING (Price ↓ / OI ↓); छोटे changes configurable neutral threshold के भीतर NEUTRAL रहेंगे।
- Initial warm-up, missing OI, token/API error और contract rollover पर WAITING दिख सकता है। First load पर historical OI snapshots उपलब्ध नहीं होने के कारण पुराने signal का अनुमान नहीं लगाया जाता।
- OI FLOW, existing CALL/PUT scoring logic को modify नहीं करता। यह independent informational panel है।
- `.env` में optional thresholds: `OI_FLOW_MIN_PRICE_CHANGE_PCT=0.01` और `OI_FLOW_MIN_OI_CHANGE_PCT=0.1`।
- Live confirmation के लिए valid Upstox token, futures quote permissions, network और market hours जरूरी हैं। Instrument master/API behavior को deploy के बाद live market में verify करें। Signals trading recommendation या profit guarantee नहीं हैं।

## Correction: NIFTY Box 1 5-minute CALL/PUT confirmation
- Box 1 now treats the next completed 5-minute candle CLOSE beyond the breakout candle's high (CALL) or low (PUT) as confirmation; an intrabar high/low touch alone is not enough.
- On the first confirmed trigger, the Box 1 status turns green and a one-time flower/fireworks-style celebration and ATM CALL/PUT welcome popup appears.
- The popup fetches the current NIFTY ATM option premium from the existing Upstox option-chain endpoint and displays an illustrative premium entry, 20% premium-risk stop and 2R target estimate when a valid live quote is available.
- The popup never places an order automatically. Confirm live data, spread, lot size and risk yourself; estimates are not guarantees. If Upstox data is unavailable, entry/SL/target remain pending rather than being fabricated.


## AJS AI Assistant (optional OpenAI integration)

- Ranked stock/index cards are clickable. Clicking a card opens its workspace with CALL/PUT scores, 5-minute entry state and the AI Stock Analysis panel.
- Select **Analyse with AI** for a structured analysis. Type a question in the AI assistant box and press **Ask** for follow-up.
- Without `OPENAI_API_KEY`, the app deliberately uses a transparent rule-based fallback; it is not generative AI.
- To enable generative answers, copy `.env.example` to `.env`, set `OPENAI_API_KEY` on the server, optionally set `OPENAI_MODEL`, restart the server, and keep the key secret. Never put the key in `public/` or client-side JavaScript.
- AI explanations use only supplied app values. They are not a live-data oracle, do not guarantee outcomes and must not trigger real orders automatically.
- The app must have valid Upstox configuration/instrument keys for accurate live prices/candles. If data is missing, the assistant should report that limitation.

## Upstox Real Account Box (new)
- Dashboard mein **Real Trading · Upstox Account Box** se funds, positions, P&L aur recent orders refresh kiye ja sakte hain.
- Is build mein **automatic B1 real entry, automatic target exit, server-side trailing stop-loss, aur restart-safe trade protection abhi implemented/validated nahi hain**. Isliye ise full auto-trading system na samjhein.
- Real order API default se locked hai. `.env.example` mein `REAL_TRADING_ENABLED=false` rakhein. Sirf account data dekhne ke liye ise `true` karne ki zaroorat nahi hai.
- Broker token ko `.env` mein hi rakhein; kisi ko share na karein. Live orders se pehle paper testing aur broker order-status verification zaroor karein.
- Real account box mein funds/positions/orders blank ya error aaye to Upstox token permissions, token expiry, aur API response check karein. Account endpoints Upstox permissions par depend karte hain.

## Upstox token ko app mein save karna
1. `npm start` se app chalayein aur `http://localhost:3000` kholein.
2. `⚙ Instrument settings` par click karein.
3. `Upstox API Connection` mein access token paste karein aur `Verify & Save Token` dabayein.
4. App token ko Upstox profile API se verify karega; valid token hone par server ke local `.upstox-credentials.json` file mein save karega. Browser mein token wapas display nahi hota.
5. App/server folder ko private rakhein aur is credential file ko kisi ko share na karein. `.gitignore` mein file excluded hai.
6. Upstox access token aam taur par agle din 3:30 AM IST par expire hota hai; token file mein rehne ke bawajood expiry ke baad naya token generate karke isi screen se dobara save karna hoga.
7. Token save karna **real order ya auto B1 trading enable nahi karta**. Real orders aur auto-entry locked rahenge.
