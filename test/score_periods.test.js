"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { periodsContaining } = require("../src/score_periods");

const at = iso => Date.parse(iso);

test("a completion this week counts towards every score", () => {
  assert.deepEqual(periodsContaining(at("2026-10-27T09:00:00Z"), at("2026-10-29T12:00:00Z")), ["WScore", "MScore", "YScore"]);
});

test("the weekly reset at Monday 00:00 UTC drops last week's completions from WScore", () => {
  const mondayMorning = at("2026-10-26T01:00:00Z");
  assert.deepEqual(periodsContaining(at("2026-10-25T23:59:00Z"), mondayMorning), ["MScore", "YScore"]);
  assert.deepEqual(periodsContaining(at("2026-10-26T00:00:00Z"), mondayMorning), ["WScore", "MScore", "YScore"]);
});

test("a month boundary mid-week drops the completion from MScore", () => {
  assert.deepEqual(periodsContaining(at("2026-10-30T12:00:00Z"), at("2026-11-02T10:00:00Z")), ["YScore"]);
  assert.deepEqual(periodsContaining(at("2026-11-01T12:00:00Z"), at("2026-11-03T10:00:00Z")), ["MScore", "YScore"]);
});

test("a year boundary mid-week keeps the completion in WScore only", () => {
  assert.deepEqual(periodsContaining(at("2026-12-31T12:00:00Z"), at("2027-01-02T10:00:00Z")), ["WScore"]);
});

test("an unparseable completion date counts towards nothing", () => {
  assert.deepEqual(periodsContaining(NaN, Date.now()), []);
});
