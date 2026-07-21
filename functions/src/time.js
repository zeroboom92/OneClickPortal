const KOREA_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000;
const PRESENCE_START_MINUTES = 7 * 60;
const PRESENCE_END_MINUTES = 11 * 60;

function getKoreaTime(date) {
  const koreaDate = new Date(date.getTime() + KOREA_OFFSET_MILLISECONDS);
  return {
    date: koreaDate.toISOString().slice(0, 10),
    minutes: koreaDate.getUTCHours() * 60 + koreaDate.getUTCMinutes(),
  };
}

function isPresenceWindow(date) {
  const { minutes } = getKoreaTime(date);
  return minutes >= PRESENCE_START_MINUTES && minutes < PRESENCE_END_MINUTES;
}

function getMostRecentElevenAm(date) {
  const koreaDate = new Date(date.getTime() + KOREA_OFFSET_MILLISECONDS);
  let referenceAsKoreaUtc = Date.UTC(
    koreaDate.getUTCFullYear(),
    koreaDate.getUTCMonth(),
    koreaDate.getUTCDate(),
    11,
  );

  if (koreaDate.getUTCHours() < 11) {
    referenceAsKoreaUtc -= 24 * 60 * 60 * 1000;
  }

  return new Date(referenceAsKoreaUtc - KOREA_OFFSET_MILLISECONDS);
}

module.exports = { getKoreaTime, getMostRecentElevenAm, isPresenceWindow };
