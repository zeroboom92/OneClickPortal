const assert = require("node:assert/strict");
const test = require("node:test");
const { parseUsagePayload } = require("../src/payload");

test("accepts an anonymous installation hash, version, and presence flag", () => {
  const installationIdHash = "a".repeat(64);

  assert.deepEqual(
    parseUsagePayload({ installationIdHash, version: "0.1.4", isPresence: true }),
    { installationIdHash, version: "0.1.4", isPresence: true },
  );
});

test("rejects invalid or excessive input", () => {
  assert.equal(parseUsagePayload(null), null);
  assert.equal(parseUsagePayload([]), null);
  assert.equal(
    parseUsagePayload({ installationIdHash: "not-a-hash", version: "0.1.3" }),
    null,
  );
  assert.equal(
    parseUsagePayload({ installationIdHash: "a".repeat(64), version: "학교 이름" }),
    null,
  );
  assert.equal(
    parseUsagePayload({
      installationIdHash: "a".repeat(64),
      version: "0.1.4",
      isPresence: "true",
    }),
    null,
  );
});
