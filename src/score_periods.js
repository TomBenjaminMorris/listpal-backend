"use strict";

// These boundaries must match the score reset crons in terraform/cronjob.tf (00:00 UTC).
function periodStarts(nowMs) {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  return {
    WScore: Date.UTC(year, month, now.getUTCDate() - daysSinceMonday),
    MScore: Date.UTC(year, month, 1),
    YScore: Date.UTC(year, 0, 1)
  };
}

// The score fields a completion at completedMs still counts towards, given the resets so far.
function periodsContaining(completedMs, nowMs) {
  if (!Number.isFinite(completedMs)) return [];
  const starts = periodStarts(nowMs);
  return Object.keys(starts).filter(field => completedMs >= starts[field]);
}

module.exports = { periodStarts, periodsContaining };
