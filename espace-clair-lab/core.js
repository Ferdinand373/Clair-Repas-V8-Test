(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClairEspaceLabCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TEST_APP_ID = "clair-repas-v8-test";
  const FAVORITES_KEY = "crFavMeals";
  const NOTES_KEY = "crRecipeNotesV31";
  const OBSERVED_KEYS = Object.freeze([FAVORITES_KEY, NOTES_KEY]);
  const SELECTED_COLUMNS = "user_id,app_id,data_key,payload,updated_at,deleted_at";

  function isPlainRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function usefulNoteValue(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function parseObservedValue(row, expectedShape) {
    if (!row || row.deleted_at) {
      return Object.freeze({ state: "empty", count: 0 });
    }

    const rawValue = row.payload?.value;
    if (typeof rawValue !== "string") {
      return Object.freeze({ state: "unreadable", count: null });
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (
        expectedShape === "array" &&
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "string")
      ) {
        return Object.freeze({ state: "ready", count: parsed.length });
      }
      if (expectedShape === "record" && isPlainRecord(parsed)) {
        const count = Object.values(parsed).filter(usefulNoteValue).length;
        return Object.freeze({ state: "ready", count });
      }
    } catch (_) {
      // Le Lab observe seulement. Une valeur illisible n'est jamais corrigée.
    }

    return Object.freeze({ state: "unreadable", count: null });
  }

  function safeSourceDevice(row) {
    const source = row?.payload?.source_device;
    if (typeof source !== "string") return null;
    const normalized = source.trim().replace(/\s+/g, " ");
    return normalized ? normalized.slice(0, 80) : null;
  }

  function summarizeRows(rows) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const byKey = new Map();

    for (const row of safeRows) {
      if (!OBSERVED_KEYS.includes(row?.data_key)) continue;
      const current = byKey.get(row.data_key);
      const currentTime = Date.parse(current?.updated_at || "") || 0;
      const candidateTime = Date.parse(row?.updated_at || "") || 0;
      if (!current || candidateTime >= currentTime) byKey.set(row.data_key, row);
    }

    const favoritesRow = byKey.get(FAVORITES_KEY) || null;
    const notesRow = byKey.get(NOTES_KEY) || null;
    const observedRows = [favoritesRow, notesRow].filter(Boolean);
    const latestRow = observedRows.reduce((latest, row) => {
      if (!latest) return row;
      const latestTime = Date.parse(latest.updated_at || "") || 0;
      const rowTime = Date.parse(row.updated_at || "") || 0;
      return rowTime >= latestTime ? row : latest;
    }, null);

    return Object.freeze({
      favorites: parseObservedValue(favoritesRow, "array"),
      notes: parseObservedValue(notesRow, "record"),
      hasData: observedRows.length > 0,
      lastSyncAt: latestRow?.updated_at || null,
      sourceDevice: safeSourceDevice(latestRow)
    });
  }

  async function validateSessionUser(client, session) {
    const sessionUser = session?.user;
    if (!sessionUser?.id) return null;

    const result = await client.auth.getUser();
    const verifiedUser = result?.data?.user;
    if (result?.error || !verifiedUser?.id) return null;
    return verifiedUser.id === sessionUser.id ? verifiedUser : null;
  }

  function createReadOnlyObserver(client) {
    let validatedUser = null;
    let validationGeneration = 0;

    return Object.freeze({
      async validateSession(session) {
        const generation = ++validationGeneration;
        validatedUser = null;
        const user = await validateSessionUser(client, session);
        if (generation !== validationGeneration) return null;
        if (!user) {
          return null;
        }
        validatedUser = Object.freeze({ id: user.id });
        return user;
      },

      clearValidatedUser() {
        validationGeneration += 1;
        validatedUser = null;
      },

      async read() {
        if (!validatedUser) {
          return Object.freeze({ state: "signed-out", rows: Object.freeze([]) });
        }

        const user = validatedUser;
        const result = await client
          .from("clair_data")
          .select(SELECTED_COLUMNS)
          .eq("user_id", user.id)
          .eq("app_id", TEST_APP_ID)
          .in("data_key", OBSERVED_KEYS)
          .is("deleted_at", null);

        if (result.error) throw result.error;
        const rows = result.data || [];
        if (rows.some((row) => (
          row?.user_id !== user.id ||
          row?.app_id !== TEST_APP_ID ||
          !OBSERVED_KEYS.includes(row?.data_key)
        ))) {
          throw new Error("forbidden-row-boundary");
        }
        return Object.freeze({
          state: "ready",
          userId: user.id,
          rows: Object.freeze([...rows])
        });
      }
    });
  }

  function createViewBoundary() {
    let authEpoch = 0;
    let readGeneration = 0;
    let userId = null;

    return Object.freeze({
      beginAuth() {
        authEpoch += 1;
        readGeneration += 1;
        userId = null;
        return authEpoch;
      },

      isAuthCurrent(epoch) {
        return epoch === authEpoch;
      },

      acceptAuth(epoch, nextUserId) {
        if (epoch !== authEpoch || typeof nextUserId !== "string" || !nextUserId) {
          return false;
        }
        userId = nextUserId;
        return true;
      },

      beginRead() {
        if (!userId) return null;
        return Object.freeze({
          authEpoch,
          userId,
          generation: ++readGeneration
        });
      },

      isReadCurrent(token) {
        return Boolean(token) &&
          token.authEpoch === authEpoch &&
          token.userId === userId &&
          token.generation === readGeneration;
      },

      clear() {
        authEpoch += 1;
        readGeneration += 1;
        userId = null;
      }
    });
  }

  return Object.freeze({
    TEST_APP_ID,
    FAVORITES_KEY,
    NOTES_KEY,
    OBSERVED_KEYS,
    SELECTED_COLUMNS,
    createReadOnlyObserver,
    createViewBoundary,
    parseObservedValue,
    summarizeRows,
    validateSessionUser
  });
});
