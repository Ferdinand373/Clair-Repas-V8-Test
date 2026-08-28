(() => {
  'use strict';

  const script = document.currentScript;
  const APP_ID = script?.dataset?.clairApp || 'clair';
  const RELEASE = script?.dataset?.clairRelease || '8.0.0-foundation.10';
  const DATA_SCHEMA = Number(script?.dataset?.clairSchema || 2);
  const CORE_REVISION = script?.dataset?.clairCore || '';
  const STORAGE_PROTOCOL = 'clair-test-storage/v1';
  const STORAGE_APP_ID = 'clair-repas-v8-test';
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
  // A new database namespace prevents snapshots captured before storage
  // isolation from importing production-origin cr... values into the test app.
  const DB_NAME = `clair-v8-personal-${APP_ID}-${SCOPE_ID}-${fnv1a(STORAGE_PROTOCOL)}`;

  function resolvePersonalSync() {
    const candidate = window.ClairSync;
    if (!candidate || candidate.protocol !== 'clair-personal-sync/v1') return null;
    if (
      candidate.app !== APP_ID ||
      candidate.release !== RELEASE ||
      candidate.coreRevision !== CORE_REVISION ||
      Number(candidate.dataSchema) !== DATA_SCHEMA ||
      candidate.storageProtocol !== STORAGE_PROTOCOL ||
      candidate.storageAppId !== STORAGE_APP_ID ||
      candidate.scopePath !== SCOPE_PATH ||
      candidate.scopeId !== SCOPE_ID
    ) return null;
    if (
      typeof candidate.capture !== 'function' ||
      typeof candidate.valid !== 'function' ||
      typeof candidate.restore !== 'function' ||
      typeof candidate.listPersonalKeys !== 'function'
    ) return null;
    return candidate;
  }

  const personalSync = resolvePersonalSync();

  function clairRepasReady() {
    const health = window.__CLAIR_REPAS_HEALTH;
    return document.readyState === 'complete' && Boolean(health && health.ok === true);
  }

  const appConfig = {
    'clair-repas': {
      ready: clairRepasReady
    },
    'clair-courses': {
      ready: () => Boolean(document.querySelector('#list-title, #aisles-root, .action-bar'))
    }
  };

  const config = appConfig[APP_ID] || {
    ready: () => document.readyState !== 'loading'
  };

  let bootResolved = false;
  let fatalError = null;
  const prebootCapture = capturePersonalData();
  const prebootData = prebootCapture.values;

  function capturePersonalData() {
    if (!personalSync) return { ok: false, values: {} };
    try {
      const capture = personalSync.capture();
      if (!capture || capture.ok !== true || !personalSync.valid(capture.values)) {
        return { ok: false, values: {} };
      }
      return { ok: true, values: capture.values };
    } catch (_) {
      return { ok: false, values: {} };
    }
  }

  function validPersonalData(values) {
    if (!personalSync) return false;
    try {
      return personalSync.valid(values);
    } catch (_) {
      return false;
    }
  }

  function restorePersonalData(values) {
    if (!personalSync || !validPersonalData(values)) return false;
    try {
      return personalSync.restore(values) === true;
    } catch (_) {
      return false;
    }
  }

  function makeRecord(kind, values) {
    const payload = {
      app: APP_ID,
      kind,
      release: RELEASE,
      dataSchema: DATA_SCHEMA,
      storageProtocol: STORAGE_PROTOCOL,
      storageAppId: STORAGE_APP_ID,
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

    let db = null;
    try {
      db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('snapshot-write-failed'));
        tx.onabort = () => reject(tx.error || new Error('snapshot-write-aborted'));
      });
      return record;
    } catch (_) {
      return null;
    } finally {
      try { db?.close(); } catch (_) {}
    }
  }

  async function getSnapshot(kind) {
    let db = null;
    try {
      db = await openDb();
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(`${APP_ID}:${kind}`);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('snapshot-read-failed'));
      });
      return record;
    } catch (_) {
      return null;
    } finally {
      try { db?.close(); } catch (_) {}
    }
  }

  function compatibleSnapshot(record) {
    try {
      if (!record || typeof record !== 'object') return false;
      if (record.app !== APP_ID || Number(record.dataSchema) !== DATA_SCHEMA) return false;
      if (
        record.storageProtocol !== STORAGE_PROTOCOL ||
        record.storageAppId !== STORAGE_APP_ID
      ) return false;
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
        storageProtocol: STORAGE_PROTOCOL,
        storageAppId: STORAGE_APP_ID,
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
    if (!personalSync) {
      await failBoot('personal-sync-unavailable', 'Module de synchronisation personnelle indisponible');
      return;
    }

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

        const healthy = healthyCapture.values;
        const snapshot = await putSnapshot('healthy', healthy);
        if (bootResolved) return;
        if (!snapshot) {
          await failBoot(
            'snapshot-write-failed',
            'Sauvegarde de sécurité des données personnelles impossible'
          );
          return;
        }

        bootResolved = true;
        post('CLAIR_V8_BOOT_OK', {
          fingerprint: snapshot.fingerprint
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
    storageProtocol: STORAGE_PROTOCOL,
    storageAppId: STORAGE_APP_ID,
    scopePath: SCOPE_PATH,
    scopeId: SCOPE_ID,
    listPersonalKeys() {
      if (!personalSync) throw new Error('personal-sync-unavailable');
      return personalSync.listPersonalKeys();
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
        storageProtocol: STORAGE_PROTOCOL,
        storageAppId: STORAGE_APP_ID,
        scopePath: SCOPE_PATH,
        scopeId: SCOPE_ID,
        personalSyncReady: Boolean(personalSync),
        bootResolved,
        fatalError
      };
    }
  });
})();
