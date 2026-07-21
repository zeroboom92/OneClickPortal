const INSTALLATION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+_-]{1,32}$/;

function parseUsagePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const installationIdHash = body.installationIdHash;
  const version = body.version;
  const isPresence = body.isPresence;
  if (
    typeof installationIdHash !== "string" ||
    !INSTALLATION_HASH_PATTERN.test(installationIdHash) ||
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version) ||
    (isPresence !== undefined && typeof isPresence !== "boolean")
  ) {
    return null;
  }

  return { installationIdHash, version, isPresence: isPresence === true };
}

module.exports = { parseUsagePayload };
