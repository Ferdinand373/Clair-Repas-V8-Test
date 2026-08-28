(() => {
  'use strict';

  const script = document.currentScript;
  const APP_ID = script?.dataset?.clairApp || 'clair';
  const RELEASE = script?.dataset?.clairRelease || '8.0.0-foundation.11';
  const DATA_SCHEMA = Number(script?.dataset?.clairSchema || 2);
  const CORE_REVISION = script?.dataset?.clairCore || '';
  const STORAGE_PROTOCOL = 'clair-test-storage/v1';
  const STORAGE_APP_ID = 'clair-repas-v8-test';
  const storage = window.ClairStorage;

  if (
    !storage ||
    storage.ready !== true ||
    storage.protocol !== STORAGE_PROTOCOL ||
    storage.appId !== STORAGE_APP_ID
  ) return;

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
      return new URL('.', location.href).pathname;
    } catch (_) {
      return location.pathname || '/';
    }
  }

  const SCOPE_PATH = appScopePath();
  const SCOPE_ID = fnv1a(SCOPE_PATH);

  const personalKeyPolicies = {
    'clair-repas': (key) =>
      /^cr[A-Za-z0-9_.-]+$/.test(key) && key !== 'crHealthProbeV73',
    'clair-courses': (key) => {
      if (!key.startsWith('clairCourses.')) return false;
      // Les anciens wrappers/shells sont du code applicatif, pas des données personnelles.
      return !/\.shell\./i.test(key) && !/\.wrapper\./i.test(key);
    }
  };

  const personalKey = personalKeyPolicies[APP_ID] || (() => false);

  function readPersonalData() {
    const values = {};
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !personalKey(key)) continue;
      const value = storage.getItem(key);
      if (value !== null) values[key] = value;
    }
    return values;
  }

  function capture() {
    try {
      return { ok: true, values: readPersonalData() };
    } catch (_) {
      return { ok: false, values: {} };
    }
  }

  function valid(values) {
    if (Object.prototype.toString.call(values) !== '[object Object]') return false;
    return Object.entries(values).every(
      ([key, value]) => personalKey(key) && typeof value === 'string'
    );
  }

  function currentPersonalKeys() {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && personalKey(key)) keys.push(key);
    }
    return keys;
  }

  function replace(values) {
    const current = currentPersonalKeys();

    // Les écritures précèdent les suppressions afin qu'un quota insuffisant
    // n'efface pas d'abord la photo personnelle encore saine.
    for (const [key, value] of Object.entries(values)) {
      storage.setItem(key, value);
    }

    for (const key of current) {
      if (!Object.prototype.hasOwnProperty.call(values, key)) {
        storage.removeItem(key);
      }
    }
  }

  function restoreBeforeImage(before) {
    let current;
    try {
      current = readPersonalData();
    } catch (_) {
      return false;
    }

    let recovered = true;

    // Libérer en premier les clés créées par la tentative. La photo d'origine
    // tenait déjà dans le quota avant l'opération.
    for (const key of Object.keys(current)) {
      if (Object.prototype.hasOwnProperty.call(before, key)) continue;
      try {
        storage.removeItem(key);
      } catch (_) {
        recovered = false;
      }
    }

    // Appliquer d'abord les réécritures qui libèrent le plus d'espace.
    const originals = Object.entries(before)
      .map(([key, value]) => ({
        key,
        value,
        delta: value.length - String(current[key] ?? '').length
      }))
      .sort((a, b) => a.delta - b.delta);

    for (const { key, value } of originals) {
      try {
        storage.setItem(key, value);
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
        expectedKeys.some(
          (key, index) =>
            key !== restoredKeys[index] || before[key] !== restored[key]
        )
      ) recovered = false;
    } catch (_) {
      recovered = false;
    }

    return recovered;
  }

  function restore(values) {
    if (!valid(values)) return false;

    let before;
    try {
      before = readPersonalData();
    } catch (_) {
      return false;
    }

    try {
      replace(values);
      return true;
    } catch (_) {
      // Le stockage navigateur n'est pas transactionnel : rétablir l'avant-image si une
      // écriture ou une suppression échoue au milieu de la synchronisation.
      restoreBeforeImage(before);
      return false;
    }
  }

  function listPersonalKeys() {
    const result = capture();
    if (!result.ok) throw new Error('personal-data-read-failed');
    return Object.keys(result.values).sort();
  }

  window.ClairSync = Object.freeze({
    protocol: 'clair-personal-sync/v1',
    app: APP_ID,
    release: RELEASE,
    coreRevision: CORE_REVISION,
    dataSchema: DATA_SCHEMA,
    storageProtocol: STORAGE_PROTOCOL,
    storageAppId: STORAGE_APP_ID,
    scopePath: SCOPE_PATH,
    scopeId: SCOPE_ID,
    capture,
    valid,
    restore,
    listPersonalKeys
  });
})();
