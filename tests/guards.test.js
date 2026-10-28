"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const safety = fs.readFileSync(path.join(root, "real-trading-safety.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("live order switches default to disabled", () => {
  assert.match(server, /process\.env\.REAL_TRADING_ENABLED\s*\|\|\s*"false"/);
  assert.match(server, /const AJS_AUTO_B1_EXECUTION_ENABLED\s*=\s*false/);
});
test("order endpoint fails closed unless both live gates enabled", () => {
  assert.match(server, /if\s*\(!REAL_TRADING_ENABLED\s*\|\|\s*!AJS_AUTO_B1_EXECUTION_ENABLED\)\s*return res\.status\(403\)/);
});
test("preflight explicitly reports live orders disallowed", () => {
  assert.match(server, /app\.get\("\/api\/real\/preflight"/);
  assert.match(server, /liveOrdersAllowed:\s*false/);
  assert.match(server, /dailyLossEnforcement/);
  assert.match(server, /protectionManager/);
});
test("preflight is documented as read-only", () => {
  assert.match(server, /Read-only preflight/);
  const start = server.indexOf('app.get("/api/real/preflight"');
  const end = server.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start);
  const route = server.slice(start, end);
  assert.doesNotMatch(route, /placeOrder|submitOrder|cancelOrder|modifyOrder/i);
});
test("full test command is available", () => {
  assert.equal(typeof pkg.scripts["test:all"], "string");
  assert.match(safety, /function checkDailyLoss/);
});
