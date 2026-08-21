(() => {
  'use strict';

  const script = document.currentScript;
  const LOCAL_APP_ID = script?.dataset?.clairApp || 'clair';
  const RELEASE = script?.dataset?.clairRelease || '8.0.0-foundation.9';
  const DATA_SCHEMA = Number(script?.dataset?.clairSchema || 2);
  const CORE_REVISION = script?.dataset?.clairCore || '';

  const CLOUD_PROTOCOL = 'clair-cloud-sync/v1';
  const META_PROTOCOL = 'clair-cloud-sync-meta/v1';
  const CLOUD_APP_ID = 'clair-repas-v8-test';
  const STORAGE_PROTOCOL = 'clair-test-storage/v1';
  const INTEGRATION = 'clair-v8-foundation.9';
  // Start a fresh technical history for the isolated personal namespace. The
  // previous metadata may describe production-origin cr... values and must not
  // generate deletions or uploads in the test bucket.
  const META_STORAGE_KEY = 'clair.v8.sync.meta.' + CLOUD_APP_ID + '.test-storage-v1';
  const DEVICE_KEY_STORAGE = 'clair.device.key.v1';
  const SUPABASE_URL = 'https://ryyewskgfgysfubesdsj.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_T9Dmg9VKTdMFdCuLVxD54w_7GeH3Q6S';
  const SUPABASE_JS_PATH = './v8/vendor/supabase-js-2.111.0.js';
  const LOCAL_SCAN_MS = 4000;
  const PERIODIC_SYNC_MS = 60000;
  const BOOT_WAIT_MS = 20000;

  const MISSING = Object.freeze({ missing: true });

  function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function isPlainObject(value) {
    return Boolean(
      value &&
      Object.prototype.toString.call(value) === '[object Object]'
    );
  }

  function stableJson(value) {
    if (Array.isArray(value)) {
      return '[' + value.map(stableJson).join(',') + ']';
    }
    if (isPlainObject(value)) {
      return '{' + Object.keys(value).sort().map((key) =>
        JSON.stringify(key) + ':' + stableJson(value[key])
      ).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function sameJson(left, right) {
    if (left === MISSING || right === MISSING) return left === right;
    return stableJson(left) === stableJson(right);
  }

  function cloneJson(value) {
    if (value === MISSING) return MISSING;
    if (Array.isArray(value)) return value.map(cloneJson);
    if (isPlainObject(value)) {
      const next = {};
      for (const key of Object.keys(value)) next[key] = cloneJson(value[key]);
      return next;
    }
    return value;
  }

  function mergeArrays(localValue, remoteValue, preferLocal) {
    const ordered = preferLocal
      ? [...localValue, ...remoteValue]
      : [...remoteValue, ...localValue];
    const seen = new Set();
    const result = [];
    for (const item of ordered) {
      const identity = stableJson(item);
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push(cloneJson(item));
    }
    return result;
  }

  function mergeJsonNode(
    baseValue,
    localValue,
    remoteValue,
    preferLocal,
    conflicts = [],
    path = []
  ) {
    if (sameJson(localValue, remoteValue)) return cloneJson(localValue);
    if (sameJson(localValue, baseValue)) return cloneJson(remoteValue);
    if (sameJson(remoteValue, baseValue)) return cloneJson(localValue);

    if (localValue === MISSING) {
      if (remoteValue === MISSING) return MISSING;
      if (baseValue === MISSING) return cloneJson(remoteValue);
      return sameJson(remoteValue, baseValue) ? MISSING : cloneJson(remoteValue);
    }

    if (remoteValue === MISSING) {
      if (baseValue === MISSING) return cloneJson(localValue);
      return sameJson(localValue, baseValue) ? MISSING : cloneJson(localValue);
    }

    if (Array.isArray(localValue) && Array.isArray(remoteValue)) {
      return mergeArrays(localValue, remoteValue, preferLocal);
    }

    if (isPlainObject(localValue) && isPlainObject(remoteValue)) {
      const result = {};
      const keys = new Set([
        ...Object.keys(isPlainObject(baseValue) ? baseValue : {}),
        ...Object.keys(localValue),
        ...Object.keys(remoteValue)
      ]);
      for (const key of [...keys].sort()) {
        const baseChild =
          isPlainObject(baseValue) && own(baseValue, key)
            ? baseValue[key]
            : MISSING;
        const localChild = own(localValue, key) ? localValue[key] : MISSING;
        const remoteChild = own(remoteValue, key) ? remoteValue[key] : MISSING;
        const merged = mergeJsonNode(
          baseChild,
          localChild,
          remoteChild,
          preferLocal,
          conflicts,
          [...path, key]
        );
        if (merged !== MISSING) result[key] = merged;
      }
      return result;
    }

    conflicts.push({
      path: [...path],
      local: cloneJson(localValue),
      remote: cloneJson(remoteValue),
      resolved: preferLocal ? 'local' : 'remote'
    });
    return cloneJson(preferLocal ? localValue : remoteValue);
  }

  function parseJsonContainer(raw) {
    if (typeof raw !== 'string') return null;
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) || isPlainObject(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function mergePersonalStrings(baseRaw, localRaw, remoteRaw, preferLocal) {
    const localValue = parseJsonContainer(localRaw);
    const remoteValue = parseJsonContainer(remoteRaw);
    const bothArrays = Array.isArray(localValue) && Array.isArray(remoteValue);
    const bothObjects =
      isPlainObject(localValue) && isPlainObject(remoteValue);
    if (!bothArrays && !bothObjects) {
      return {
        mergeable: false,
        value: preferLocal ? localRaw : remoteRaw,
        conflicts: []
      };
    }

    const parsedBase = parseJsonContainer(baseRaw);
    const compatibleBase =
      (bothArrays && Array.isArray(parsedBase)) ||
      (bothObjects && isPlainObject(parsedBase))
        ? parsedBase
        : MISSING;
    const conflicts = [];
    const merged = mergeJsonNode(
      compatibleBase,
      localValue,
      remoteValue,
      preferLocal,
      conflicts
    );
    return {
      mergeable: true,
      value: JSON.stringify(merged),
      conflicts
    };
  }

  async function fingerprint(value, cryptoApi = crypto) {
    const bytes = new TextEncoder().encode(String(value));
    if (cryptoApi?.subtle?.digest) {
      const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
      return 'sha256:' + Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    }

    let hash = 0x811c9dc5;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
    return 'fnv1a:' + (hash >>> 0).toString(16).padStart(8, '0');
  }

  function freshMetaRoot() {
    return {
      protocol: META_PROTOCOL,
      appId: CLOUD_APP_ID,
      accounts: {}
    };
  }

  function readMetaRoot(storage) {
    try {
      const parsed = JSON.parse(storage.getItem(META_STORAGE_KEY) || 'null');
      if (
        parsed &&
        parsed.protocol === META_PROTOCOL &&
        parsed.appId === CLOUD_APP_ID &&
        isPlainObject(parsed.accounts)
      ) return parsed;
    } catch (_) {}
    return freshMetaRoot();
  }

  function accountMeta(root, userId) {
    const current = root.accounts[userId];
    if (
      current &&
      current.userId === userId &&
      isPlainObject(current.keys)
    ) {
      if (!isPlainObject(current.conflicts)) current.conflicts = {};
      return current;
    }
    const next = { userId, keys: {}, conflicts: {}, lastSyncAt: null };
    root.accounts[userId] = next;
    return next;
  }

  function writeMetaRoot(storage, root) {
    try {
      storage.setItem(META_STORAGE_KEY, JSON.stringify(root));
      return true;
    } catch (_) {
      return false;
    }
  }

  function randomDeviceKey(cryptoApi = crypto) {
    if (typeof cryptoApi?.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2) +
      '-' +
      Math.random().toString(36).slice(2)
    );
  }

  function deviceKey(storage, cryptoApi = crypto) {
    try {
      const existing = storage.getItem(DEVICE_KEY_STORAGE);
      if (typeof existing === 'string' && existing.length >= 8) return existing;
      const created = randomDeviceKey(cryptoApi);
      storage.setItem(DEVICE_KEY_STORAGE, created);
      return created;
    } catch (_) {
      return randomDeviceKey(cryptoApi);
    }
  }

  function platformLabel(navigatorApi = navigator) {
    const userAgent = String(navigatorApi?.userAgent || '');
    if (/iPhone/i.test(userAgent)) return 'iPhone';
    if (/iPad/i.test(userAgent)) return 'iPad';
    if (/Android/i.test(userAgent)) return 'Android';
    if (/Windows/i.test(userAgent)) return 'Windows';
    if (/Macintosh|Mac OS X/i.test(userAgent)) return 'Mac';
    if (/Linux/i.test(userAgent)) return 'Linux';
    return 'Navigateur';
  }

  function browserLabel(navigatorApi = navigator) {
    const userAgent = String(navigatorApi?.userAgent || '');
    if (/Edg\//.test(userAgent)) return 'Edge';
    if (/CriOS|Chrome\//.test(userAgent) && !/Edg\//.test(userAgent)) {
      return 'Chrome';
    }
    if (/FxiOS|Firefox\//.test(userAgent)) return 'Firefox';
    if (
      /Safari\//.test(userAgent) &&
      !/Chrome\//.test(userAgent) &&
      !/CriOS/.test(userAgent)
    ) return 'Safari';
    return 'Web';
  }

  function deviceLabel(navigatorApi = navigator) {
    return platformLabel(navigatorApi) + ' • ' + browserLabel(navigatorApi);
  }

  function isPersonalKey(sync, key) {
    if (typeof key !== 'string' || !key) return false;
    try {
      return sync.valid({ [key]: '' }) === true;
    } catch (_) {
      return false;
    }
  }

  function normalizeRevision(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  }

  function rowTime(row) {
    const value = row?.deleted_at || row?.updated_at;
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
  }

  function localTime(entry) {
    const time = Date.parse(entry?.localChangedAt || '');
    return Number.isFinite(time) ? time : 0;
  }

  function liveRemoteValue(row) {
    if (!row || row.deleted_at) return { present: false, value: null };
    const value = row.payload?.value;
    if (typeof value !== 'string') {
      throw new Error('invalid-remote-payload:' + String(row.data_key || 'unknown'));
    }
    return { present: true, value };
  }

  class SyncConflictError extends Error {
    constructor() {
      super('remote-revision-conflict');
      this.name = 'SyncConflictError';
    }
  }

  function createSupabaseTransport(client) {
    const selectedColumns =
      'id,user_id,app_id,data_key,payload,schema_version,revision,' +
      'last_device_id,updated_at,deleted_at';

    function assertTestAppId(appId) {
      if (appId !== CLOUD_APP_ID) throw new Error('forbidden-app-id');
    }

    return {
      async getAuthenticatedUser() {
        const sessionResult = await client.auth.getSession();
        if (sessionResult.error || !sessionResult.data?.session?.user) return null;
        const userResult = await client.auth.getUser();
        if (userResult.error || !userResult.data?.user) return null;
        if (userResult.data.user.id !== sessionResult.data.session.user.id) {
          return null;
        }
        return userResult.data.user;
      },

      async registerDevice(record) {
        const result = await client
          .from('clair_devices')
          .upsert(record, { onConflict: 'user_id,device_key' })
          .select('id,user_id,device_key,label,platform,last_seen_at')
          .single();
        if (result.error) throw result.error;
        return result.data;
      },

      async listData(query) {
        assertTestAppId(query.app_id);
        const result = await client
          .from('clair_data')
          .select(selectedColumns)
          .eq('user_id', query.user_id)
          .eq('app_id', CLOUD_APP_ID);
        if (result.error) throw result.error;
        return result.data || [];
      },

      async getData(query) {
        assertTestAppId(query.app_id);
        const result = await client
          .from('clair_data')
          .select(selectedColumns)
          .eq('user_id', query.user_id)
          .eq('app_id', CLOUD_APP_ID)
          .eq('data_key', query.data_key)
          .maybeSingle();
        if (result.error) throw result.error;
        return result.data || null;
      },

      async writeData(record, expectedRow) {
        assertTestAppId(record.app_id);
        if (expectedRow) {
          // Le trigger BEFORE UPDATE `clair_data_bump_revision` porte la
          // révision serveur à old.revision + 1. Le filtre ci-dessous est le
          // compare-and-swap qui empêche une écriture sur une base périmée.
          const changes = {
            payload: record.payload,
            schema_version: record.schema_version,
            last_device_id: record.last_device_id,
            updated_at: record.updated_at,
            deleted_at: record.deleted_at
          };
          const result = await client
            .from('clair_data')
            .update(changes)
            .eq('user_id', record.user_id)
            .eq('app_id', CLOUD_APP_ID)
            .eq('data_key', record.data_key)
            .eq('revision', expectedRow.revision)
            .select(selectedColumns)
            .maybeSingle();
          if (result.error) throw result.error;
          if (!result.data) throw new SyncConflictError();
          return result.data;
        }

        const result = await client
          .from('clair_data')
          .insert({ ...record, revision: 1 })
          .select(selectedColumns)
          .single();
        if (result.error?.code === '23505') throw new SyncConflictError();
        if (result.error) throw result.error;
        return result.data;
      },

      subscribeAuth(callback) {
        const subscription = client.auth.onAuthStateChange((_event, session) => {
          callback(Boolean(session?.user));
        });
        return () => subscription?.data?.subscription?.unsubscribe?.();
      }
    };
  }

  function loadSupabaseLibrary(hostWindow = window, hostDocument = document) {
    const pinnedSelector = 'script[data-clair-supabase-js="2.111.0"]';
    const pinnedScript = hostDocument.querySelector?.(pinnedSelector);
    if (
      pinnedScript?.dataset?.clairSupabaseReady === 'true' &&
      typeof hostWindow.supabase?.createClient === 'function'
    ) {
      return Promise.resolve(hostWindow.supabase);
    }

    return new Promise((resolve, reject) => {
      let existing = pinnedScript;
      if (existing?.dataset?.clairSupabaseFailed === 'true') {
        existing.remove?.();
        existing = null;
      }
      const libraryScript = existing || hostDocument.createElement('script');
      let settled = false;
      let timeoutId = null;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (error) {
          libraryScript.dataset.clairSupabaseFailed = 'true';
          reject(error);
          return;
        }
        if (typeof hostWindow.supabase?.createClient !== 'function') {
          libraryScript.dataset.clairSupabaseFailed = 'true';
          reject(new Error('supabase-library-unavailable'));
          return;
        }
        libraryScript.dataset.clairSupabaseReady = 'true';
        resolve(hostWindow.supabase);
      };

      libraryScript.addEventListener('load', () => finish(), { once: true });
      libraryScript.addEventListener(
        'error',
        () => finish(new Error('supabase-library-load-failed')),
        { once: true }
      );

      if (!existing) {
        libraryScript.src = SUPABASE_JS_PATH;
        libraryScript.async = true;
        libraryScript.dataset.clairSupabaseJs = '2.111.0';
        hostDocument.head.appendChild(libraryScript);
      }

      timeoutId = setTimeout(
        () => finish(new Error('supabase-library-timeout')),
        15000
      );
    });
  }

  function createRuntime(options = {}) {
    const hostWindow = options.window || window;
    const hostDocument = options.document || document;
    const navigatorApi = options.navigator || navigator;
    const storage = options.storage || localStorage;
    const cryptoApi = options.crypto || crypto;
    const sync = options.sync || hostWindow.ClairSync;
    const personalStorage = options.personalStorage || hostWindow.ClairStorage;
    const now = options.now || (() => Date.now());
    const scheduleTimeout = options.setTimeout || setTimeout;
    const cancelTimeout = options.clearTimeout || clearTimeout;
    const scheduleInterval = options.setInterval || setInterval;
    const cancelInterval = options.clearInterval || clearInterval;
    const healthy =
      options.isHealthy ||
      (() => {
        try {
          const status = hostWindow.ClairV8?.getStatus?.();
          return Boolean(status?.bootResolved && !status?.fatalError);
        } catch (_) {
          return false;
        }
      });

    const state = {
      phase: 'idle',
      reason: null,
      authenticated: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      metaPersisted: true,
      started: false
    };

    let stopped = false;
    let inFlight = null;
    let pendingTimer = null;
    let scanInterval = null;
    let periodicInterval = null;
    let lastObservedSignature = null;
    let lastObservedValues = null;
    const localChangeTimes = new Map();
    let transportPromise = null;
    let unsubscribeAuth = null;
    let authSubscriptionAttached = false;

    function isoNow() {
      return new Date(now()).toISOString();
    }

    function setState(next) {
      Object.assign(state, next);
    }

    function snapshotSignature(values) {
      return stableJson(
        Object.fromEntries(
          Object.keys(values).sort().map((key) => [key, values[key]])
        )
      );
    }

    function captureLocal() {
      if (!sync || typeof sync.capture !== 'function') {
        throw new Error('clair-sync-unavailable');
      }
      if (
        !personalStorage ||
        personalStorage.ready !== true ||
        personalStorage.protocol !== STORAGE_PROTOCOL ||
        personalStorage.appId !== CLOUD_APP_ID
      ) {
        throw new Error('clair-test-storage-unavailable');
      }
      if (
        sync.protocol !== 'clair-personal-sync/v1' ||
        sync.app !== LOCAL_APP_ID ||
        sync.release !== RELEASE ||
        Number(sync.dataSchema) !== DATA_SCHEMA ||
        sync.coreRevision !== CORE_REVISION ||
        sync.storageProtocol !== STORAGE_PROTOCOL ||
        sync.storageAppId !== CLOUD_APP_ID
      ) {
        throw new Error('clair-sync-runtime-mismatch');
      }
      const capture = sync.capture();
      if (!capture?.ok || !sync.valid(capture.values)) {
        throw new Error('personal-data-read-failed');
      }
      return capture.values;
    }

    function persistMeta(root) {
      const persisted = writeMetaRoot(storage, root);
      state.metaPersisted = persisted;
      if (!persisted) throw new Error('sync-meta-persistence-failed');
    }

    async function resolveTransport() {
      if (options.transport) return options.transport;
      if (transportPromise) return transportPromise;
      transportPromise = (async () => {
        const namespace = await loadSupabaseLibrary(hostWindow, hostDocument);
        const client = namespace.createClient(
          SUPABASE_URL,
          SUPABASE_PUBLISHABLE_KEY,
          {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: false
            }
          }
        );
        return createSupabaseTransport(client);
      })().catch((error) => {
        transportPromise = null;
        throw error;
      });
      return transportPromise;
    }

    function ensureAuthSubscription(transport) {
      if (authSubscriptionAttached) return;
      authSubscriptionAttached = true;
      unsubscribeAuth = transport.subscribeAuth?.((signedIn) => {
        if (signedIn) scheduleSync('auth-session', 100);
        else {
          setState({
            phase: 'local-only',
            reason: 'no-session',
            authenticated: false
          });
        }
      }) || null;
    }

    function samePersonalValue(left, right, key) {
      const leftPresent = own(left, key);
      const rightPresent = own(right, key);
      return (
        leftPresent === rightPresent &&
        (!leftPresent || left[key] === right[key])
      );
    }

    function noteConcurrentChanges(baseline, current, concurrentKeys) {
      const keys = new Set([
        ...Object.keys(baseline),
        ...Object.keys(current)
      ]);
      for (const key of keys) {
        if (samePersonalValue(baseline, current, key)) continue;
        concurrentKeys.add(key);
        if (!localChangeTimes.has(key)) localChangeTimes.set(key, isoNow());
      }
    }

    async function applyLocalState(
      localValues,
      key,
      present,
      value,
      mutationJournal,
      concurrentKeys
    ) {
      const latest = { ...captureLocal() };
      noteConcurrentChanges(localValues, latest, concurrentKeys);
      if (!samePersonalValue(localValues, latest, key)) {
        throw new Error('local-key-changed-during-sync:' + key);
      }

      const target = { ...latest };
      if (present) target[key] = value;
      else delete target[key];
      if (!sync.valid(target)) throw new Error('invalid-local-restore');
      if (sync.restore(target) !== true) throw new Error('local-restore-failed');
      const journalEntry = mutationJournal.get(key) || {
        beforePresent: own(latest, key),
        beforeValue: own(latest, key) ? latest[key] : null
      };
      journalEntry.afterPresent = present;
      journalEntry.afterValue = present ? value : null;
      mutationJournal.set(key, journalEntry);
      const verified = sync.capture();
      if (
        !verified?.ok ||
        !sync.valid(verified.values) ||
        snapshotSignature(verified.values) !== snapshotSignature(target)
      ) throw new Error('local-restore-verification-failed');
      return target;
    }

    function rollbackLocalMutations(mutationJournal) {
      if (!mutationJournal.size) return true;
      let current;
      try {
        current = { ...captureLocal() };
      } catch (_) {
        return false;
      }
      const target = { ...current };
      let changed = false;
      for (const [key, entry] of [...mutationJournal.entries()].reverse()) {
        if (!own(entry, 'afterPresent')) continue;
        const after = entry.afterPresent
          ? { [key]: entry.afterValue }
          : {};
        if (!samePersonalValue(target, after, key)) continue;
        if (entry.beforePresent) target[key] = entry.beforeValue;
        else delete target[key];
        changed = true;
      }
      if (!changed) return true;
      if (!sync.valid(target) || sync.restore(target) !== true) return false;
      const verified = sync.capture();
      return Boolean(
        verified?.ok &&
        sync.valid(verified.values) &&
        snapshotSignature(verified.values) === snapshotSignature(target)
      );
    }

    async function finalEntry(localValues, key, row, syncedAt) {
      const present = own(localValues, key);
      return {
        basePresent: present,
        baseValue: present ? localValues[key] : null,
        localFingerprint: present
          ? await fingerprint(localValues[key], cryptoApi)
          : null,
        remoteRevision: row ? normalizeRevision(row.revision) : null,
        remoteUpdatedAt: row?.updated_at || row?.deleted_at || null,
        lastSyncedAt: syncedAt,
        localChangedAt: null
      };
    }

    function rememberJsonConflict(
      account,
      key,
      merged,
      localValue,
      remoteValue,
      resolvedValue,
      syncedAt
    ) {
      if (!merged.mergeable || !merged.conflicts?.length) return;
      const history = Array.isArray(account.conflicts[key])
        ? account.conflicts[key]
        : [];
      history.push({
        at: syncedAt,
        kind: 'json-three-way',
        localValue,
        remoteValue,
        resolvedValue,
        details: merged.conflicts
      });
      account.conflicts[key] = history.slice(-3);
    }

    async function uploadState(
      transport,
      user,
      device,
      key,
      present,
      value,
      expectedRow
    ) {
      const syncedAt = isoNow();
      return transport.writeData(
        {
          user_id: user.id,
          app_id: CLOUD_APP_ID,
          data_key: key,
          payload: {
            value: present ? value : null,
            source_device: device.label,
            synced_at: syncedAt,
            integration: INTEGRATION
          },
          schema_version: DATA_SCHEMA,
          last_device_id: device.id,
          updated_at: syncedAt,
          deleted_at: present ? null : syncedAt
        },
        expectedRow
      );
    }

    async function reconcileOnce(context) {
      let {
        key,
        row,
        localValues,
        account,
        metaRoot,
        transport,
        user,
        device,
        mutationJournal,
        concurrentKeys
      } = context;
      const entry = isPlainObject(account.keys[key]) ? account.keys[key] : null;
      let localPresent = own(localValues, key);
      let localValue = localPresent ? localValues[key] : null;
      const remoteState = liveRemoteValue(row);
      const remotePresent = remoteState.present;
      const remoteValue = remoteState.value;
      const currentFingerprint = localPresent
        ? await fingerprint(localValue, cryptoApi)
        : null;
      const syncedAt = isoNow();

      if (row && Number(row.schema_version) !== DATA_SCHEMA) {
        throw new Error('remote-schema-mismatch:' + key);
      }

      if (!entry) {
        if (localPresent) {
          let valueToUpload = localValue;
          if (remotePresent && remoteValue !== localValue) {
            const merged = mergePersonalStrings(
              null,
              localValue,
              remoteValue,
              true
            );
            valueToUpload = merged.value;
            rememberJsonConflict(
              account,
              key,
              merged,
              localValue,
              remoteValue,
              valueToUpload,
              syncedAt
            );
            if (valueToUpload !== localValue) {
              localValues = await applyLocalState(
                localValues,
                key,
                true,
                valueToUpload,
                mutationJournal,
                concurrentKeys
              );
              localValue = valueToUpload;
            }
          }
          if (!remotePresent || remoteValue !== valueToUpload) {
            row = await uploadState(
              transport,
              user,
              device,
              key,
              true,
              valueToUpload,
              row
            );
          }
        } else if (remotePresent) {
          localValues = await applyLocalState(
            localValues,
            key,
            true,
            remoteValue,
            mutationJournal,
            concurrentKeys
          );
          localPresent = true;
          localValue = remoteValue;
        }

        account.keys[key] = await finalEntry(
          localValues,
          key,
          row,
          syncedAt
        );
        return { localValues, row };
      }

      const localChanged =
        localPresent !== Boolean(entry.basePresent) ||
        (localPresent && currentFingerprint !== entry.localFingerprint);
      const remoteChanged =
        normalizeRevision(row?.revision) !==
        normalizeRevision(entry.remoteRevision);

      if (localChanged && !entry.localChangedAt) {
        entry.localChangedAt = localChangeTimes.get(key) || syncedAt;
        account.keys[key] = entry;
        persistMeta(metaRoot);
      }

      if (!localChanged && !remoteChanged) {
        account.keys[key] = await finalEntry(
          localValues,
          key,
          row,
          syncedAt
        );
        return { localValues, row };
      }

      if (localChanged && !remoteChanged) {
        row = await uploadState(
          transport,
          user,
          device,
          key,
          localPresent,
          localValue,
          row
        );
        account.keys[key] = await finalEntry(
          localValues,
          key,
          row,
          syncedAt
        );
        return { localValues, row };
      }

      if (!localChanged && remoteChanged) {
        if (!row) {
          if (localPresent) {
            row = await uploadState(
              transport,
              user,
              device,
              key,
              true,
              localValue,
              null
            );
          }
        } else {
          localValues = await applyLocalState(
            localValues,
            key,
            remotePresent,
            remoteValue,
            mutationJournal,
            concurrentKeys
          );
        }
        account.keys[key] = await finalEntry(
          localValues,
          key,
          row,
          syncedAt
        );
        return { localValues, row };
      }

      if (!row) {
        if (localPresent) {
          row = await uploadState(
            transport,
            user,
            device,
            key,
            true,
            localValue,
            null
          );
        }
        account.keys[key] = await finalEntry(
          localValues,
          key,
          row,
          syncedAt
        );
        return { localValues, row };
      }

      const localChangedAt = localTime(entry);
      const remoteChangedAt = rowTime(row);
      const preferLocal =
        localChangedAt === 0 || localChangedAt >= remoteChangedAt;

      if (localPresent && remotePresent) {
        if (localValue !== remoteValue) {
          const merged = mergePersonalStrings(
            entry.basePresent ? entry.baseValue : null,
            localValue,
            remoteValue,
            preferLocal
          );
          const resolvedValue = merged.value;
          rememberJsonConflict(
            account,
            key,
            merged,
            localValue,
            remoteValue,
            resolvedValue,
            syncedAt
          );
          if (resolvedValue !== localValue) {
            localValues = await applyLocalState(
              localValues,
              key,
              true,
              resolvedValue,
              mutationJournal,
              concurrentKeys
            );
          }
          if (resolvedValue !== remoteValue) {
            row = await uploadState(
              transport,
              user,
              device,
              key,
              true,
              resolvedValue,
              row
            );
          }
        }
      } else if (!localPresent && remotePresent) {
        const localDeletionWins =
          localChangedAt > 0 && localChangedAt >= remoteChangedAt;
        if (localDeletionWins) {
          row = await uploadState(
            transport,
            user,
            device,
            key,
            false,
            null,
            row
          );
        } else {
          localValues = await applyLocalState(
            localValues,
            key,
            true,
            remoteValue,
            mutationJournal,
            concurrentKeys
          );
        }
      } else if (localPresent && !remotePresent) {
        const localModificationWins =
          localChangedAt === 0 || localChangedAt >= remoteChangedAt;
        if (localModificationWins) {
          row = await uploadState(
            transport,
            user,
            device,
            key,
            true,
            localValue,
            row
          );
        } else {
          localValues = await applyLocalState(
            localValues,
            key,
            false,
            null,
            mutationJournal,
            concurrentKeys
          );
        }
      }

      account.keys[key] = await finalEntry(
        localValues,
        key,
        row,
        syncedAt
      );
      return { localValues, row };
    }

    async function reconcileKey(context) {
      let row = context.row;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await reconcileOnce({ ...context, row });
        } catch (error) {
          if (!(error instanceof SyncConflictError)) throw error;
          row = await context.transport.getData({
            user_id: context.user.id,
            app_id: CLOUD_APP_ID,
            data_key: context.key
          });
        }
      }
      throw new Error('remote-conflict-retry-exhausted');
    }

    async function performSync(reason) {
      state.lastAttemptAt = isoNow();
      if (stopped || !healthy()) {
        setState({ phase: 'waiting-for-foundation', reason });
        return { synced: false, reason: 'foundation-not-healthy' };
      }
      if (navigatorApi?.onLine === false) {
        setState({ phase: 'local-only', reason: 'offline', lastError: null });
        return { synced: false, reason: 'offline' };
      }

      const localCapture = captureLocal();
      let localValues = { ...localCapture };
      const mutationJournal = new Map();
      const concurrentKeys = new Set();
      const processedKeys = new Set();
      let metaBefore = null;
      let metaExistedBefore = false;
      try {
        metaBefore = storage.getItem(META_STORAGE_KEY);
        metaExistedBefore = metaBefore !== null;
      } catch (_) {}

      try {
        const transport = await resolveTransport();
        ensureAuthSubscription(transport);
        const user = await transport.getAuthenticatedUser();
        if (!user?.id) {
          setState({
            phase: 'local-only',
            reason: 'no-session',
            authenticated: false,
            lastError: null
          });
          return { synced: false, reason: 'no-session' };
        }

        setState({
          phase: 'syncing',
          reason,
          authenticated: true,
          lastError: null
        });

        const keyValue = deviceKey(storage, cryptoApi);
        const label = deviceLabel(navigatorApi);
        const device = await transport.registerDevice({
          user_id: user.id,
          device_key: keyValue,
          label,
          platform: platformLabel(navigatorApi),
          app_version: RELEASE,
          last_seen_at: isoNow(),
          updated_at: isoNow()
        });
        if (!device?.id) throw new Error('device-registration-failed');
        device.label = device.label || label;

        const remoteRows = await transport.listData({
          user_id: user.id,
          app_id: CLOUD_APP_ID
        });
        const remoteMap = new Map();
        for (const row of Array.isArray(remoteRows) ? remoteRows : []) {
          if (
            row?.app_id === CLOUD_APP_ID &&
            isPersonalKey(sync, row.data_key)
          ) remoteMap.set(row.data_key, row);
        }

        const metaRoot = readMetaRoot(storage);
        const account = accountMeta(metaRoot, user.id);
        const keys = new Set([
          ...Object.keys(localValues),
          ...remoteMap.keys(),
          ...Object.keys(account.keys)
        ]);

        for (const key of [...keys].sort()) {
          if (!isPersonalKey(sync, key)) continue;
          const result = await reconcileKey({
            key,
            row: remoteMap.get(key) || null,
            localValues,
            account,
            metaRoot,
            transport,
            user,
            device,
            mutationJournal,
            concurrentKeys
          });
          localValues = result.localValues;
          if (result.row) remoteMap.set(key, result.row);
          else remoteMap.delete(key);
          processedKeys.add(key);
          persistMeta(metaRoot);
        }

        const finalLocalValues = { ...captureLocal() };
        noteConcurrentChanges(localValues, finalLocalValues, concurrentKeys);
        localValues = finalLocalValues;
        account.lastSyncAt = isoNow();
        persistMeta(metaRoot);
        for (const key of processedKeys) {
          if (!concurrentKeys.has(key)) localChangeTimes.delete(key);
        }
        lastObservedSignature = snapshotSignature(localValues);
        lastObservedValues = { ...localValues };
        setState({
          phase: 'synced',
          reason,
          authenticated: true,
          lastSuccessAt: account.lastSyncAt,
          lastError: null
        });
        if (concurrentKeys.size) {
          scheduleSync('concurrent-local-change', 250);
        }
        return { synced: true, reason, keyCount: keys.size };
      } catch (error) {
        const rollbackSucceeded = rollbackLocalMutations(mutationJournal);
        try {
          if (metaExistedBefore) storage.setItem(META_STORAGE_KEY, metaBefore);
          else storage.removeItem(META_STORAGE_KEY);
        } catch (_) {}
        if (concurrentKeys.size) {
          scheduleSync('concurrent-local-change', 250);
        }
        if (!rollbackSucceeded) {
          throw new Error(
            'local-rollback-failed-after-sync-error:' +
              String(error?.message || error || 'unknown')
          );
        }
        throw error;
      }
    }

    function syncNow(reason = 'manual') {
      if (inFlight) return inFlight;
      inFlight = performSync(reason)
        .catch((error) => {
          setState({
            phase: 'local-only',
            reason,
            lastError: String(error?.message || error || 'sync-failed')
          });
          return { synced: false, reason: 'error', error: state.lastError };
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    }

    function scheduleSync(reason, delay = 250) {
      if (stopped) return;
      if (pendingTimer !== null) cancelTimeout(pendingTimer);
      pendingTimer = scheduleTimeout(() => {
        pendingTimer = null;
        void syncNow(reason);
      }, Math.max(0, delay));
    }

    function markDirty(key, reason = 'local-change', delay = 500) {
      if (!isPersonalKey(sync, key)) return false;
      localChangeTimes.set(key, isoNow());
      scheduleSync(reason, delay);
      return true;
    }

    function scanLocal(initial = false) {
      try {
        const values = captureLocal();
        const signature = snapshotSignature(values);
        if (!initial && lastObservedValues !== null) {
          const keys = new Set([
            ...Object.keys(lastObservedValues),
            ...Object.keys(values)
          ]);
          for (const key of keys) {
            if (lastObservedValues[key] !== values[key]) {
              localChangeTimes.set(key, isoNow());
            }
          }
          if (signature !== lastObservedSignature) {
            scheduleSync('local-change', 500);
          }
        }
        lastObservedSignature = signature;
        lastObservedValues = { ...values };
      } catch (_) {}
    }

    function attachTriggers() {
      const onOnline = () => {
        scanLocal(false);
        scheduleSync('online', 150);
      };
      const onStorage = (event) => {
        if (!event?.key) {
          scheduleSync('storage', 300);
          return;
        }
        const logical = personalStorage.logicalKey?.(event.key) ?? null;
        if (logical && isPersonalKey(sync, logical)) {
          markDirty(logical, 'storage', 300);
        }
      };
      const onVisibility = () => {
        if (!hostDocument.hidden) {
          scanLocal(false);
          scheduleSync('foreground', 150);
        }
      };

      hostWindow.addEventListener?.('online', onOnline);
      hostWindow.addEventListener?.('storage', onStorage);
      hostDocument.addEventListener?.('visibilitychange', onVisibility);
      scanInterval = scheduleInterval(() => scanLocal(false), LOCAL_SCAN_MS);
      periodicInterval = scheduleInterval(() => {
        if (!hostDocument.hidden) {
          scanLocal(false);
          scheduleSync('periodic', 0);
        }
      }, PERIODIC_SYNC_MS);

      return () => {
        hostWindow.removeEventListener?.('online', onOnline);
        hostWindow.removeEventListener?.('storage', onStorage);
        hostDocument.removeEventListener?.('visibilitychange', onVisibility);
      };
    }

    let detachTriggers = null;

    async function waitForHealthyFoundation() {
      const startedAt = now();
      while (!stopped && now() - startedAt < BOOT_WAIT_MS) {
        if (healthy()) return true;
        try {
          const status = hostWindow.ClairV8?.getStatus?.();
          if (status?.fatalError) return false;
        } catch (_) {}
        await new Promise((resolve) => scheduleTimeout(resolve, 180));
      }
      return false;
    }

    async function start() {
      if (state.started) return;
      state.started = true;
      const ready = await waitForHealthyFoundation();
      if (!ready || stopped) {
        setState({ phase: 'local-only', reason: 'foundation-unavailable' });
        return;
      }
      scanLocal(true);
      detachTriggers = attachTriggers();
      void resolveTransport()
        .then(ensureAuthSubscription)
        .catch(() => {
          // Les déclencheurs restent actifs et retenteront sans bloquer l'app.
        });
      scheduleSync('startup', 0);
    }

    function stop() {
      stopped = true;
      if (pendingTimer !== null) cancelTimeout(pendingTimer);
      if (scanInterval !== null) cancelInterval(scanInterval);
      if (periodicInterval !== null) cancelInterval(periodicInterval);
      detachTriggers?.();
      unsubscribeAuth?.();
      setState({ phase: 'stopped', reason: 'stopped' });
    }

    return Object.freeze({
      protocol: CLOUD_PROTOCOL,
      appId: CLOUD_APP_ID,
      supabaseVersion: '2.111.0',
      syncNow,
      markDirty,
      start,
      stop,
      getStatus() {
        return { ...state };
      }
    });
  }

  const testMode = script?.dataset?.clairCloudTest === 'true';
  if (testMode) {
    window.ClairCloudSyncTest = Object.freeze({
      createRuntime,
      createSupabaseTransport,
      loadSupabaseLibrary,
      mergePersonalStrings,
      fingerprint,
      constants: Object.freeze({
        CLOUD_APP_ID,
        STORAGE_PROTOCOL,
        META_STORAGE_KEY,
        DEVICE_KEY_STORAGE,
        INTEGRATION,
        SUPABASE_JS_PATH
      })
    });
    return;
  }

  const runtime = createRuntime();
  window.ClairCloudSync = runtime;
  void runtime.start();
})();
