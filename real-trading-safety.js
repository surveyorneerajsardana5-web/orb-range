"use strict";

// Pure, broker-independent safeguards. These functions never submit orders.
function validateProfile(profile) {
  const errors = [];
  if (!Number.isInteger(Number(profile.lots)) || Number(profile.lots) < 1 || Number(profile.lots) > 100)
    errors.push("lots must be an integer between 1 and 100");
  if (!Number.isFinite(Number(profile.dailyLossLimit)) || Number(profile.dailyLossLimit) <= 0)
    errors.push("dailyLossLimit must be positive");
  if (profile.entryTrigger !== "B1") errors.push("entryTrigger must be B1");
  if (profile.requireStopLoss !== true || profile.requireTarget !== true || profile.requireTrailingStop !== true)
    errors.push("stop loss, target and trailing stop must all be required");
  return { ok: errors.length === 0, errors };
}

// Daily loss is expressed as a positive loss amount. Block at or beyond the limit.
function checkDailyLoss(realizedPnl, unrealizedPnl, limit) {
  const realized = Number(realizedPnl), unrealized = Number(unrealizedPnl), cap = Number(limit);
  if (![realized, unrealized, cap].every(Number.isFinite) || cap <= 0)
    return { ok: true, blocked: true, loss: null, reason: "invalid risk inputs" };
  const loss = Math.max(0, -(realized + unrealized));
  return { ok: loss < cap, blocked: loss >= cap, loss, limit: cap,
    reason: loss >= cap ? "daily loss limit reached" : null };
}

// Long-option trailing stop: stop can only move upward, never downward.
function updateTrailingStop({ entry, ltp, currentStop, trailDistance }) {
  const e=Number(entry), p=Number(ltp), s=Number(currentStop), d=Number(trailDistance);
  if (![e,p,s,d].every(Number.isFinite) || e <= 0 || p <= 0 || d <= 0)
    return { ok:false, stop:null, reason:"invalid trailing-stop inputs" };
  const candidate = Math.max(e, p - d);
  return { ok:true, stop:Math.max(s, candidate), changed:Math.max(s,candidate)>s };
}

// B1 de-duplication helper. A signal ID should be stable across retries.
function acceptNewSignal(signalId, seen) {
  if (typeof signalId !== "string" || !signalId.trim()) return { ok:false, reason:"missing signal id" };
  if (seen.has(signalId)) return { ok:false, duplicate:true, reason:"signal already handled" };
  seen.add(signalId);
  return { ok:true, duplicate:false };
}

module.exports = { validateProfile, checkDailyLoss, updateTrailingStop, acceptNewSignal };
