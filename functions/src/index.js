const { initializeApp } = require("firebase-admin/app");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const { parseUsagePayload } = require("./payload");
const { getKoreaTime, getMostRecentElevenAm, isPresenceWindow } = require("./time");

initializeApp();

exports.recordUsage = onRequest(
  {
    region: "asia-northeast3",
    timeoutSeconds: 10,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 3,
    invoker: "public",
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.set("Allow", "POST").status(405).end();
      return;
    }

    if (!request.is("application/json")) {
      response.status(415).end();
      return;
    }

    const payload = parseUsagePayload(request.body);
    if (!payload) {
      response.status(400).end();
      return;
    }

    const database = getFirestore();
    const now = Timestamp.now();
    const day = getKoreaTime(now.toDate()).date;
    const recordsPresence = payload.isPresence && isPresenceWindow(now.toDate());
    const installationRef = database
      .collection("anonymousInstalls")
      .doc(payload.installationIdHash);
    const dailyRef = database.collection("usageDaily").doc(day);
    const globalStatsRef = database.collection("usageStats").doc("global");

    try {
      await database.runTransaction(async (transaction) => {
        const installation = await transaction.get(installationRef);
        const isFirstReportToday =
          !installation.exists || installation.get("lastSeenDate") !== day;

        if (installation.exists) {
          const update = {
            lastSeenAt: now,
            lastSeenDate: day,
            lastVersion: payload.version,
          };
          if (recordsPresence) {
            update.lastPresenceAt = now;
          }
          transaction.update(installationRef, update);
        } else {
          const installationData = {
            firstSeenAt: now,
            lastSeenAt: now,
            lastSeenDate: day,
            firstVersion: payload.version,
            lastVersion: payload.version,
          };
          if (recordsPresence) {
            installationData.lastPresenceAt = now;
          }
          transaction.create(installationRef, installationData);
          transaction.set(
            globalStatsRef,
            {
              totalInstallations: FieldValue.increment(1),
              updatedAt: now,
            },
            { merge: true },
          );
        }

        if (isFirstReportToday) {
          transaction.set(
            dailyRef,
            {
              activeInstallations: FieldValue.increment(1),
              updatedAt: now,
            },
            { merge: true },
          );
        }
      });

      response.status(204).end();
    } catch (error) {
      logger.error("익명 사용 통계 저장 실패", {
        message: error instanceof Error ? error.message : "unknown",
      });
      response.status(500).end();
    }
  },
);

exports.getUsageSummary = onRequest(
  {
    region: "asia-northeast3",
    timeoutSeconds: 10,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 3,
    invoker: "public",
  },
  async (request, response) => {
    if (request.method !== "GET") {
      response.set("Allow", "GET").status(405).end();
      return;
    }

    const now = Timestamp.now();
    const trackingActive = isPresenceWindow(now.toDate());
    const referenceAt = trackingActive ? now.toDate() : getMostRecentElevenAm(now.toDate());

    try {
      const cutoff = Timestamp.fromMillis(referenceAt.getTime() - 40 * 60 * 1000);
      let query = getFirestore()
        .collection("anonymousInstalls")
        .where("lastPresenceAt", ">=", cutoff);
      if (!trackingActive) {
        query = query.where("lastPresenceAt", "<=", Timestamp.fromDate(referenceAt));
      }
      const snapshot = await query.count().get();
      const activeUsers = snapshot.data().count;

      response
        .set("Cache-Control", "public, max-age=60, s-maxage=60")
        .status(200)
        .json({
          activeUsers,
          windowMinutes: 40,
          trackingActive,
          referenceAt: referenceAt.toISOString(),
        });
    } catch (error) {
      logger.error("현재 사용자 수 조회 실패", {
        message: error instanceof Error ? error.message : "unknown",
      });
      response.status(500).end();
    }
  },
);
