const test = require("node:test");
const assert = require("node:assert/strict");
const { validateProfile, checkDailyLoss, updateTrailingStop, acceptNewSignal } = require("../real-trading-safety");

test("requested real profile validates", () => {
  assert.equal(validateProfile({lots:1,dailyLossLimit:3200,entryTrigger:"B1",requireStopLoss:true,requireTarget:true,requireTrailingStop:true}).ok, true);
});
test("daily loss limit blocks at and above ₹3200", () => {
  assert.equal(checkDailyLoss(-2500,-700,3200).blocked, true);
  assert.equal(checkDailyLoss(-2500,-699,3200).blocked, false);
});
test("invalid risk data fails closed", () => {
  assert.equal(checkDailyLoss(NaN,0,3200).blocked, true);
});
test("trailing stop only moves up", () => {
  assert.equal(updateTrailingStop({entry:100,ltp:130,currentStop:110,trailDistance:10}).stop,120);
  assert.equal(updateTrailingStop({entry:100,ltp:105,currentStop:110,trailDistance:10}).stop,110);
});
test("B1 signal cannot be accepted twice", () => {
  const seen = new Set();
  assert.equal(acceptNewSignal("NIFTY:B1:2026-10-24T10:00",seen).ok,true);
  assert.equal(acceptNewSignal("NIFTY:B1:2026-10-24T10:00",seen).duplicate,true);
});
test("invalid real profile is rejected", () => {
  const result = validateProfile({lots:0,dailyLossLimit:0,entryTrigger:"B2",requireStopLoss:false,requireTarget:false,requireTrailingStop:false});
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
});
test("positive and zero PnL do not count as losses", () => {
  assert.equal(checkDailyLoss(500,200,3200).loss, 0);
  assert.equal(checkDailyLoss(0,0,3200).blocked, false);
});
test("invalid trailing stop inputs fail closed", () => {
  assert.equal(updateTrailingStop({entry:100,ltp:0,currentStop:90,trailDistance:10}).ok, false);
});
test("missing B1 signal ID is rejected", () => {
  assert.equal(acceptNewSignal("",new Set()).ok, false);
});
