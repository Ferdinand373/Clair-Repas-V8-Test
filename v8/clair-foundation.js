(() => {
  'use strict';

  const script = document.currentScript;
  const APP_ID = script?.dataset?.clairApp || 'clair';
  const RELEASE = script?.dataset?.clairRelease || '8.0.0-foundation.1';
  const DATA_SCHEMA = Number(script?.dataset?.clairSchema || 1);
  const DB_NAME = 'clair-v8-personal';
  const DB_VERSION = 1;
  const STORE = 'snapshots';
  const BOOT_TIMEOUT_MS = 15000;
  const READY_STABLE_MS = 900;

  const appConfig = {
    'clair-repas': {
      ready: () => document.readyState === 'complete',
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
  const prebootData = collectPersonalData();
  const prebootRecord = makeRecord('preboot', prebootData);

  function collectPersonalData() {
    const values = {};
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !config.personalKey(key)) continue;
        const value = localStorage.getItem(key);
        if (value !== null) values[key] = value;
      }
    } catch (_) {}
    return values;
  }

  function restorePersonalData(values) {
    if (!values || typeof values !== 'object') return false;
    try {
      const current = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && config.personalKey(key)) current.push(key);
      }
      for (const key of current) {
        if (!(key in values)) localStorage.removeItem(key);
      }
      for (const [key, value] of Object.entries(values)) {
        if (config.personalKey(key)) localStorage.setItem(key, String(value));
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function makeRecord(kind, values) {
    const payload = {
      app: APP_ID,
      kind,
      release: RELEASE,
      dataSchema: DATA_SCHEMA,
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
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb-open-failed'));
    });
  }

  async function putSnapshot(kind, values = collectPersonalData()) {
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

  function post(type, extra = {}) {
    try {
      navigator.serviceWorker?.controller?.postMessage({
        type,
        app: APP_ID,
        release: RELEASE,
        dataSchema: DATA_SCHEMA,
        ...extra
      });
    } catch (_) {}
  }

  function sameOriginFilename(filename) {
    if (!filename) return false;
    try { return new URL(filename, location.href).origin === location.origin; } catch (_) { return false; }
  }

  function isFatalErrorEvent(event) {
    if (!event) return false;
    if (event.error instanceof SyntaxError || event.error instanceof ReferenceError) return true;
    return Boolean(event.error instanceof Error && sameOriginFilename(event.filename));
  }

  async function failBoot(reason, detail = '') {
    if (bootResolved) return;
    bootResolved = true;
    fatalError = { reason, detail, at: new Date().toISOString() };
    // La photo des données a été prise avant l'exécution de l'application.
    // En cas d'échec de démarrage, on la restaure avant de revenir au code précédent.
    restorePersonalData(prebootData);
    await putSnapshot('recovered', prebootData);
    post('CLAIR_V8_BOOT_FAIL', { reason, detail });
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
  putSnapshot('preboot', prebootData);
  post('CLAIR_V8_BOOT_START', { fingerprint: prebootRecord.fingerprint });

  async function confirmHealthyBoot() {
    const started = Date.now();
    while (!bootResolved && Date.now() - started < BOOT_TIMEOUT_MS) {
      let ready = false;
      try { ready = config.ready(); } catch (_) {}
      if (ready) {
        await new Promise(resolve => setTimeout(resolve, READY_STABLE_MS));
        if (bootResolved) return;
        bootResolved = true;
        const healthy = collectPersonalData();
        await putSnapshot('healthy', healthy);
        post('CLAIR_V8_BOOT_OK', { fingerprint: makeRecord('healthy', healthy).fingerprint });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    if (!bootResolved) await failBoot('boot-timeout', `Interface non prête après ${BOOT_TIMEOUT_MS} ms`);
  }
  confirmHealthyBoot();

  window.ClairV8 = Object.freeze({
    app: APP_ID,
    release: RELEASE,
    dataSchema: DATA_SCHEMA,
    listPersonalKeys() { return Object.keys(collectPersonalData()).sort(); },
    snapshot(kind = 'manual') { return putSnapshot(kind); },
    async restoreLatest() {
      const record = await getSnapshot('healthy') || await getSnapshot('preboot');
      return Boolean(record?.values && restorePersonalData(record.values));
    },
    exportPersonalData() {
      return JSON.stringify(makeRecord('export', collectPersonalData()), null, 2);
    },
    getStatus() {
      return { app: APP_ID, release: RELEASE, dataSchema: DATA_SCHEMA, bootResolved, fatalError };
    }
  });
})();
