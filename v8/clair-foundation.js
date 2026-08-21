(() => {
  'use strict';

  const script = document.currentScript;
  const APP_ID = script?.dataset?.clairApp || 'clair';
  const RELEASE = script?.dataset?.clairRelease || '8.0.0-foundation.9';
  const DATA_SCHEMA = Number(script?.dataset?.clairSchema || 2);
  const CORE_REVISION = script?.dataset?.clairCore || '';
  const DB_VERSION = 1;
  const STORE = 'snapshots';
  const BOOT_TIMEOUT_MS = 15000;
  const READY_STABLE_MS = 900;

  function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function appScopePath() {
    try {
      const url = new URL('.', location.href);
      return url.pathname;
    } catch (_) {
      return location.pathname || '/';
    }
  }

  const SCOPE_PATH = appScopePath();
  const SCOPE_ID = fnv1a(SCOPE_PATH);
  const DB_NAME = `clair-v8-personal-${APP_ID}-${SCOPE_ID}`;

  function clairRepasReady() {
    const health = window.__CLAIR_REPAS_HEALTH;
    return document.readyState === 'complete' && Boolean(health && health.ok === true);
  }

  const appConfig = {
    'clair-repas': {
      ready: clairRepasReady,
      personalKey: (key) => /^cr[A-Za-z0-9_.-]+$/.test(key) && key !== 'crHealthProbeV73'
    },
    'clair-courses': {
      ready: () => Boolean(document.querySelector('#list-title, #aisles-root, .action-bar')),
      personalKey: (key) => {
        if (!key.startsWith('clairCourses.')) return false;
        // Les anciens wrappers/shells sont du code applicatif, pas des données personnelles.
        if (/\.shell\./i.test(key) || /\.wrapper\./i.test(key)) return false;
        return true;
      }
    }
  };

  const config = appConfig[APP_ID] || {
    ready: () => document.readyState !== 'loading',
    personalKey: () => false
  };

  let bootResolved = false;
  let fatalError = null;
  const prebootCapture = capturePersonalData();
  const prebootData = prebootCapture.values;

  function collectPersonalData() {
    return capturePersonalData().values;
  }

  function capturePersonalData() {
    try {
      return { ok: true, values: readPersonalData() };
    } catch (_) {
      return { ok: false, values: {} };
    }
  }

  function readPersonalData() {
    const values = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !config.personalKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) values[key] = value;
    }
    return values;
  }

  function validPersonalData(values) {
    if (Object.prototype.toString.call(values) !== '[object Object]') return false;
    return Object.entries(values).every(
      ([key, value]) => config.personalKey(key) && typeof value === 'string'
    );
  }

  function replacePersonalData(values) {
    const current = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && config.personalKey(key)) current.push(key);
    }

    // Écrire d'abord limite les pertes si le quota est atteint. Les clés qui
    // n'existent plus dans la photo ne sont supprimées qu'après les écritures.
    for (const [key, value] of Object.entries(values)) {
      if (config.personalKey(key)) localStorage.setItem(key, String(value));
    }

    for (const key of current) {
      if (!(key in values)) localStorage.removeItem(key);
    }
  }

  function restorePersonalDataBeforeImage(before) {
    let current;
    try {
      current = readPersonalData();
    } catch (_) {
      return false;
    }

    let recovered = true;
    // Libérer d'abord les clés créées par la tentative. Les valeurs originales
    // tenaient ensemble avant l'opération ; les réécritures qui libèrent le
    // plus d'espace sont ensuite appliquées avant celles qui en reprennent.
    for (const key of Object.keys(current)) {
      if (key in before) continue;
      try {
        localStorage.removeItem(key);
      } catch (_) {
        recovered = false;
      }
    }

    const originals = Object.entries(before).map(([key, value]) => ({
      key,
      value,
      delta: String(value).length - String(current[key] ?? '').length
    })).sort((a, b) => a.delta - b.delta);

    for (const { key, value } of originals) {
      try {
        localStorage.setItem(key, value);
      } catch (_) {
        recovered = false;
      }
    }

    try {
      const restored = readPersonalData();
      const expectedKeys = Object.keys(before).sort();
      const restoredKeys = Object.keys(restored).sort();
      if (
        expectedKeys.length !== restoredKeys.length ||
        expectedKeys.some((key, index) => key !== restoredKeys[index] || before[key] !== restored[key])
      ) recovered = false;
    } catch (_) {
      recovered = false;
    }
    return recovered;
  }

  function restorePersonalData(values) {
    if (!validPersonalData(values)) return false;

    let before;
    try {
      before = readPersonalData();
    } catch (_) {
      return false;
    }

    try {
      replacePersonalData(values);
      return true;
    } catch (_) {
      // localStorage n'est pas transactionnel. Une restauration compensatoire
      // remet la photo initiale si une écriture ou suppression échoue à mi-chemin.
      restorePersonalDataBeforeImage(before);
      return false;
    }
  }

  function makeRecord(kind, values) {
    const payload = {
      app: APP_ID,
      kind,
      release: RELEASE,
      dataSchema: DATA_SCHEMA,
      scopePath: SCOPE_PATH,
      scopeId: SCOPE_ID,
      capturedAt: new Date().toISOString(),
      values
    };
    payload.fingerprint = `fnv1a:${fnv1a(JSON.stringify(values))}`;
    return payload;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('indexeddb-unavailable'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb-open-failed'));
    });
  }

  async function putSnapshot(kind, values) {
    if (values === undefined) {
      const capture = capturePersonalData();
      if (!capture.ok) return null;
      values = capture.values;
    }
    if (!validPersonalData(values)) return null;
    const record = makeRecord(kind, values);
    record.id = `${APP_ID}:${kind}`;

    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('snapshot-write-failed'));
      });
      db.close();
      return record;
    } catch (_) {
      return record;
    }
  }

  async function getSnapshot(kind) {
    try {
      const db = await openDb();
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(`${APP_ID}:${kind}`);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('snapshot-read-failed'));
      });
      db.close();
      return record;
    } catch (_) {
      return null;
    }
  }

  function compatibleSnapshot(record) {
    try {
      if (!record || typeof record !== 'object') return false;
      if (record.app !== APP_ID || Number(record.dataSchema) !== DATA_SCHEMA) return false;
      if (record.scopePath !== SCOPE_PATH || record.scopeId !== SCOPE_ID) return false;
      if (!validPersonalData(record.values)) return false;
      const capturedAt = Date.parse(record.capturedAt);
      if (!Number.isFinite(capturedAt)) return false;
      return record.fingerprint === `fnv1a:${fnv1a(JSON.stringify(record.values))}`;
    } catch (_) {
      return false;
    }
  }

  function latestCompatibleSnapshot(records) {
    return (Array.isArray(records) ? records : [])
      .filter(compatibleSnapshot)
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0] || null;
  }

  function post(type, extra = {}) {
    try {
      navigator.serviceWorker?.controller?.postMessage({
        type,
        app: APP_ID,
        release: RELEASE,
        coreRevision: CORE_REVISION,
        dataSchema: DATA_SCHEMA,
        scopeId: SCOPE_ID,
        ...extra
      });
    } catch (_) {}
  }

  function sameOriginFilename(filename) {
    if (!filename) return false;
    try {
      return new URL(filename, location.href).origin === location.origin;
    } catch (_) {
      return false;
    }
  }

  function isFatalErrorEvent(event) {
    if (!event) return false;
    if (event.error instanceof SyntaxError || event.error instanceof ReferenceError) return true;
    return Boolean(event.error instanceof Error && sameOriginFilename(event.filename));
  }

  async function failBoot(reason, detail = '') {
    if (bootResolved) return;
    bootResolved = true;

    // La photo des données est prise avant le démarrage de l'application.
    // En cas d'échec, on la restaure avant le retour au code précédent.
    const personalDataRestored = prebootCapture.ok
      ? restorePersonalData(prebootData)
      : false;
    fatalError = {
      reason,
      detail,
      personalDataCaptured: prebootCapture.ok,
      personalDataRestored,
      at: new Date().toISOString()
    };
    if (prebootCapture.ok) await putSnapshot('recovered', prebootData);
    post('CLAIR_V8_BOOT_FAIL', {
      reason,
      detail,
      personalDataCaptured: prebootCapture.ok,
      personalDataRestored
    });
  }

  window.addEventListener('error', (event) => {
    if (bootResolved || !isFatalErrorEvent(event)) return;
    failBoot('runtime-error', String(event.message || event.error?.message || 'Erreur JavaScript'));
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    if (bootResolved) return;
    const reason = event?.reason;
    if (!(reason instanceof Error) || reason.name === 'AbortError') return;
    failBoot('unhandled-rejection', String(reason.message || reason.name || 'Promesse rejetée'));
  });

  // Capture immédiate : elle ne dépend pas de la suite du code applicatif.
  if (prebootCapture.ok) putSnapshot('preboot', prebootData);

  async function confirmHealthyBoot() {
    const started = Date.now();

    while (!bootResolved && Date.now() - started < BOOT_TIMEOUT_MS) {
      let ready = false;
      try {
        ready = config.ready();
      } catch (_) {}

      if (ready) {
        await new Promise(resolve => setTimeout(resolve, READY_STABLE_MS));
        if (bootResolved) return;

        const healthyCapture = capturePersonalData();
        if (!healthyCapture.ok) {
          await failBoot('storage-read-failed', 'Lecture des données personnelles impossible');
          return;
        }

        bootResolved = true;
        const healthy = healthyCapture.values;
        await putSnapshot('healthy', healthy);
        post('CLAIR_V8_BOOT_OK', {
          fingerprint: makeRecord('healthy', healthy).fingerprint
        });
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 180));
    }

    if (!bootResolved) {
      await failBoot('boot-timeout', `Interface non prête après ${BOOT_TIMEOUT_MS} ms`);
    }
  }

  confirmHealthyBoot();

  window.ClairV8 = Object.freeze({
    app: APP_ID,
    release: RELEASE,
    coreRevision: CORE_REVISION,
    dataSchema: DATA_SCHEMA,
    scopePath: SCOPE_PATH,
    scopeId: SCOPE_ID,
    listPersonalKeys() {
      return Object.keys(collectPersonalData()).sort();
    },
    snapshot(kind = 'manual') {
      return putSnapshot(kind);
    },
    async restoreLatest() {
      const records = await Promise.all([
        getSnapshot('healthy'),
        getSnapshot('preboot'),
        getSnapshot('recovered')
      ]);
      const latest = latestCompatibleSnapshot(records);
      return Boolean(latest && restorePersonalData(latest.values));
    },
    exportPersonalData() {
      const capture = capturePersonalData();
      if (!capture.ok) throw new Error('personal-data-read-failed');
      return JSON.stringify(makeRecord('export', capture.values), null, 2);
    },
    getStatus() {
      return {
        app: APP_ID,
        release: RELEASE,
        dataSchema: DATA_SCHEMA,
        scopePath: SCOPE_PATH,
        scopeId: SCOPE_ID,
        bootResolved,
        fatalError
      };
    }
  });
})();
