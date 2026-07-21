const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getKoreaTime,
  getMostRecentElevenAm,
  isPresenceWindow,
} = require("../src/time");

test("uses the Korean calendar date around the UTC boundary", () => {
  assert.equal(getKoreaTime(new Date("2026-07-20T15:30:00Z")).date, "2026-07-21");
});

test("tracks presence from 07:00 inclusive until 11:00 exclusive in Korea", () => {
  assert.equal(isPresenceWindow(new Date("2026-07-20T21:59:59Z")), false);
  assert.equal(isPresenceWindow(new Date("2026-07-20T22:00:00Z")), true);
  assert.equal(isPresenceWindow(new Date("2026-07-21T01:59:59Z")), true);
  assert.equal(isPresenceWindow(new Date("2026-07-21T02:00:00Z")), false);
});

test("uses today's 11:00 after the window and yesterday's 11:00 before it", () => {
  assert.equal(
    getMostRecentElevenAm(new Date("2026-07-21T06:00:00Z")).toISOString(),
    "2026-07-21T02:00:00.000Z",
  );
  assert.equal(
    getMostRecentElevenAm(new Date("2026-07-20T21:00:00Z")).toISOString(),
    "2026-07-20T02:00:00.000Z",
  );
});
