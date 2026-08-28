(() => {
  'use strict';

  const script = document.currentScript;
  const TEST_APP_ID = 'clair-repas-v8-test';
  const PROTOCOL = 'clair-test-storage/v1';
  const NAMESPACE = 'clair.v8.test.personal';
  const PREFIX = `${NAMESPACE}.`;
  const MANIFEST_KEY = `${NAMESPACE}.keys.v1`;
  const PERSONAL_KEY = /^cr[A-Za-z0-9_.-]+$/;
  const configuredApp = script?.dataset?.clairStorageApp || TEST_APP_ID;

  if (configuredApp !== TEST_APP_ID) {
    throw new Error('clair-test-storage-app-mismatch');
  }

  // Capture the browser storage once. The adapter never replaces or patches it:
  // Supabase Auth and technical metadata stay native.
  const nativeStorage = window.localStorage;

  function normalizedKey(key) {
    return String(key);
  }

  function isPersonalKey(key) {
    return PERSONAL_KEY.test(normalizedKey(key));
  }

  function physicalKey(key) {
    const logical = normalizedKey(key);
    return isPersonalKey(logical) ? PREFIX + logical : logical;
  }

  function logicalKey(key) {
    const physical = normalizedKey(key);
    if (physical.startsWith(PREFIX)) {
      const logical = physical.slice(PREFIX.length);
      return isPersonalKey(logical) ? logical : null;
    }
    // Raw cr... keys belong to production and are deliberately invisible.
    if (isPersonalKey(physical)) return null;
    return physical;
  }

  function manifestKeys() {
    const raw = nativeStorage.getItem(MANIFEST_KEY);
    if (raw === null) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      throw new Error('clair-test-storage-manifest-invalid');
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some(key => typeof key !== 'string' || !isPersonalKey(key))
    ) throw new Error('clair-test-storage-manifest-invalid');
    return [...new Set(parsed)];
  }

  function writeManifest(keys) {
    const normalized = [...new Set(keys)].sort();
    if (normalized.length) {
      nativeStorage.setItem(MANIFEST_KEY, JSON.stringify(normalized));
    } else {
      nativeStorage.removeItem(MANIFEST_KEY);
    }
  }

  const api = {
    protocol: PROTOCOL,
    appId: TEST_APP_ID,
    namespace: NAMESPACE,
    ready: true,
    isPersonalKey,
    logicalKey,
    get length() {
      return manifestKeys().length;
    },
    key(index) {
      const position = Number(index);
      if (!Number.isInteger(position) || position < 0) return null;
      return manifestKeys()[position] ?? null;
    },
    getItem(key) {
      const logical = normalizedKey(key);
      if (!isPersonalKey(logical)) return nativeStorage.getItem(logical);

      const value = nativeStorage.getItem(physicalKey(logical));
      if (value === null) return null;

      // Repair a value left behind if the browser stopped between the physical
      // write and its manifest update. Unmanifested values must not disappear
      // from snapshots or manual backups.
      const keys = manifestKeys();
      if (!keys.includes(logical)) writeManifest([...keys, logical]);
      return value;
    },
    setItem(key, value) {
      const logical = normalizedKey(key);
      if (!isPersonalKey(logical)) {
        nativeStorage.setItem(logical, String(value));
        return;
      }

      const physical = physicalKey(logical);
      const previous = nativeStorage.getItem(physical);
      const keys = manifestKeys();
      nativeStorage.setItem(physical, String(value));
      if (keys.includes(logical)) return;
      try {
        writeManifest([...keys, logical]);
      } catch (error) {
        try {
          if (previous === null) nativeStorage.removeItem(physical);
          else nativeStorage.setItem(physical, previous);
        } catch (_) {}
        throw error;
      }
    },
    removeItem(key) {
      const logical = normalizedKey(key);
      if (!isPersonalKey(logical)) {
        nativeStorage.removeItem(logical);
        return;
      }

      const physical = physicalKey(logical);
      const previous = nativeStorage.getItem(physical);
      const keys = manifestKeys();
      nativeStorage.removeItem(physical);
      if (!keys.includes(logical)) return;
      try {
        writeManifest(keys.filter(candidate => candidate !== logical));
      } catch (error) {
        try {
          if (previous !== null) nativeStorage.setItem(physical, previous);
        } catch (_) {}
        throw error;
      }
    },
    clear() {
      // A safe clear only removes the test's personal namespace. It must never
      // erase production cr... keys, Supabase Auth, the device key or metadata.
      for (const key of manifestKeys()) api.removeItem(key);
    }
  };

  window.ClairStorage = Object.freeze(api);
})();
