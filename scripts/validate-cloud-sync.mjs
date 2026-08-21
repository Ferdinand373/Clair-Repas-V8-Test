#!/usr/bin/env node

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(ROOT, "v8/clair-cloud-sync.js"), "utf8");
const RELEASE = "8.0.0-foundation.9";
const DATA_SCHEMA = 2;
const CORE_REVISION = "sha256:test-core-revision";
const TEST_APP_ID = "clair-repas-v8-test";
const STORAGE_PROTOCOL = "clair-test-storage/v1";
const PERSONAL_PREFIX = "clair.v8.test.personal.";
const successes = [];
const failures = [];

async function check(name, callback) {
  try {
    await callback();
    successes.push(name);
  } catch (error) {
    failures.push(name + ": " + (error?.stack || error));
  }
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
    this.hidden = false;
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
}

class FakeStorage {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

class FakeSync {
  constructor(values = {}) {
    this.values = { ...values };
    this.restoreCalls = [];
    this.failRestore = false;
    this.failRestoreAt = null;
    this.protocol = "clair-personal-sync/v1";
    this.app = "clair-repas";
    this.release = RELEASE;
    this.dataSchema = DATA_SCHEMA;
    this.coreRevision = CORE_REVISION;
    this.storageProtocol = STORAGE_PROTOCOL;
    this.storageAppId = TEST_APP_ID;
  }

  capture() {
    return { ok: true, values: { ...this.values } };
  }

  valid(values) {
    return (
      Object.prototype.toString.call(values) === "[object Object]" &&
      Object.entries(values).every(
        ([key, value]) =>
          /^cr[A-Za-z0-9_.-]+$/.test(key) &&
          key !== "crHealthProbeV73" &&
          typeof value === "string"
      )
    );
  }

  restore(values) {
    this.restoreCalls.push({ ...values });
    if (
      this.failRestore ||
      this.restoreCalls.length === this.failRestoreAt ||
      !this.valid(values)
    ) return false;
    this.values = { ...values };
    return true;
  }
}

class FakePersonalStorage {
  constructor() {
    this.ready = true;
    this.protocol = STORAGE_PROTOCOL;
    this.appId = TEST_APP_ID;
    this.namespace = "clair.v8.test.personal";
  }

  logicalKey(key) {
    key = String(key);
    if (key.startsWith(PERSONAL_PREFIX)) {
      const logical = key.slice(PERSONAL_PREFIX.length);
      return /^cr[A-Za-z0-9_.-]+$/.test(logical) ? logical : null;
    }
    if (/^cr[A-Za-z0-9_.-]+$/.test(key)) return null;
    return key;
  }
}

class MemoryTransport {
  constructor({ user = { id: "user-test" }, rows = [] } = {}) {
    this.user = user;
    this.rows = new Map(rows.map((row) => [row.data_key, structuredClone(row)]));
    this.authCalls = 0;
    this.registerCalls = [];
    this.listCalls = [];
    this.getCalls = [];
    this.writeCalls = [];
    this.failAt = null;
    this.onList = null;
  }

  maybeFail(operation) {
    if (this.failAt === operation) throw new Error("network-" + operation);
  }

  async getAuthenticatedUser() {
    this.authCalls += 1;
    this.maybeFail("auth");
    return this.user;
  }

  async registerDevice(record) {
    this.maybeFail("device");
    this.registerCalls.push(structuredClone(record));
    return { id: "device-row-test", ...structuredClone(record) };
  }

  async listData(query) {
    this.maybeFail("list");
    this.listCalls.push(structuredClone(query));
    if (this.onList) await this.onList();
    return [...this.rows.values()]
      .filter(
        (row) => row.user_id === query.user_id && row.app_id === query.app_id
      )
      .map((row) => structuredClone(row));
  }

  async getData(query) {
    this.maybeFail("get");
    this.getCalls.push(structuredClone(query));
    const row = this.rows.get(query.data_key);
    return row && row.user_id === query.user_id && row.app_id === query.app_id
      ? structuredClone(row)
      : null;
  }

  async writeData(record, expectedRow) {
    this.maybeFail("write");
    this.writeCalls.push({
      record: structuredClone(record),
      expectedRevision: expectedRow?.revision ?? null
    });
    const current = this.rows.get(record.data_key) || null;
    if (expectedRow) {
      if (!current || String(current.revision) !== String(expectedRow.revision)) {
        throw new Error("unexpected-test-revision-conflict");
      }
    } else if (current) {
      throw new Error("unexpected-test-insert-conflict");
    }
    const next = {
      id: current?.id || "row-" + record.data_key,
      created_at: current?.created_at || record.updated_at,
      ...structuredClone(record),
      revision: current ? Number(current.revision) + 1 : 1
    };
    this.rows.set(record.data_key, next);
    return structuredClone(next);
  }

  subscribeAuth() {
    return () => {};
  }

  putRemote(key, value, options = {}) {
    const current = this.rows.get(key);
    const updatedAt = options.updatedAt || "2026-08-21T12:00:00.000Z";
    const deletedAt = options.deletedAt || null;
    this.rows.set(key, {
      id: current?.id || "row-" + key,
      user_id: this.user?.id || "user-test",
      app_id: TEST_APP_ID,
      data_key: key,
      payload: {
        value: deletedAt ? null : value,
        source_device: "Autre appareil",
        synced_at: updatedAt,
        integration: "clair-v8-foundation.9"
      },
      schema_version: DATA_SCHEMA,
      revision: options.revision ?? (current ? Number(current.revision) + 1 : 1),
      last_device_id: "remote-device",
      created_at: current?.created_at || updatedAt,
      updated_at: updatedAt,
      deleted_at: deletedAt
    });
  }
}

const scriptElement = {
  dataset: {
    clairApp: "clair-repas",
    clairRelease: RELEASE,
    clairSchema: String(DATA_SCHEMA),
    clairCore: CORE_REVISION,
    clairCloudTest: "true"
  }
};
const moduleWindow = {};
vm.runInNewContext(
  source,
  {
    window: moduleWindow,
    document: { currentScript: scriptElement },
    navigator: { onLine: true, userAgent: "Test Browser", platform: "Test" },
    localStorage: new FakeStorage(),
    crypto: webcrypto,
    TextEncoder,
    Date,
    Math,
    Map,
    Set,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  },
  { filename: "v8/clair-cloud-sync.js:test-mode", timeout: 2000 }
);
const api = moduleWindow.ClairCloudSyncTest;
assert.ok(api, "Cloud Sync test API was not exposed");

function makeHarness({
  values = {},
  transport = new MemoryTransport(),
  storage,
  personalStorage = new FakePersonalStorage(),
  sync = new FakeSync(values)
} = {}) {
  const technicalStorage = storage || new FakeStorage();
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget();
  let currentTime = Date.parse("2026-08-21T10:00:00.000Z");
  const runtime = api.createRuntime({
    window: windowTarget,
    document: documentTarget,
    navigator: {
      onLine: true,
      userAgent: "Mozilla/5.0 (Windows) Chrome/140.0",
      platform: "Win32"
    },
    storage: technicalStorage,
    personalStorage,
    crypto: webcrypto,
    sync,
    transport,
    isHealthy: () => true,
    now: () => currentTime
  });
  return {
    runtime,
    sync,
    storage: technicalStorage,
    personalStorage,
    transport,
    windowTarget,
    documentTarget,
    advance(milliseconds = 1000) {
      currentTime += milliseconds;
      return new Date(currentTime).toISOString();
    },
    future(milliseconds) {
      return new Date(currentTime + milliseconds).toISOString();
    }
  };
}

function assertOnlyTestApp(transport) {
  const ids = [
    ...transport.listCalls.map((call) => call.app_id),
    ...transport.getCalls.map((call) => call.app_id),
    ...transport.writeCalls.map((call) => call.record.app_id)
  ];
  assert.ok(ids.length > 0, "Expected at least one clair_data operation");
  assert.ok(ids.every((appId) => appId === TEST_APP_ID));
  assert.ok(ids.every((appId) => appId !== "clair-repas"));
}

await check("Pinned SDK loader replaces a loaded-but-unavailable script", async () => {
  const scripts = [];
  let appendCount = 0;
  class FakeScript {
    constructor() {
      this.dataset = {};
      this.listeners = new Map();
      this.removed = false;
    }

    addEventListener(type, callback) {
      this.listeners.set(type, callback);
    }

    emit(type) {
      this.listeners.get(type)?.();
    }

    remove() {
      this.removed = true;
      const index = scripts.indexOf(this);
      if (index >= 0) scripts.splice(index, 1);
    }
  }
  const document = {
    querySelector(selector) {
      assert.equal(selector, 'script[data-clair-supabase-js="2.111.0"]');
      return scripts.find(
        (script) => script.dataset.clairSupabaseJs === "2.111.0"
      ) || null;
    },
    createElement(tag) {
      assert.equal(tag, "script");
      return new FakeScript();
    },
    head: {
      appendChild(script) {
        appendCount += 1;
        scripts.push(script);
      }
    }
  };
  const hostWindow = {};
  const first = api.loadSupabaseLibrary(hostWindow, document);
  const firstScript = scripts[0];
  firstScript.emit("load");
  await assert.rejects(first, /supabase-library-unavailable/);
  assert.equal(firstScript.dataset.clairSupabaseFailed, "true");

  const second = api.loadSupabaseLibrary(hostWindow, document);
  const secondScript = scripts[0];
  assert.notEqual(secondScript, firstScript);
  assert.equal(firstScript.removed, true);
  assert.equal(appendCount, 2);
  hostWindow.supabase = { createClient() {} };
  secondScript.emit("load");
  assert.equal(await second, hostWindow.supabase);
  assert.equal(secondScript.dataset.clairSupabaseReady, "true");
});

await check("Supabase adapter reuses auth and hard-locks clair_data to the test app", async () => {
  let getUserCalls = 0;
  let fromCalls = 0;
  const signedOutClient = {
    auth: {
      async getSession() {
        return { data: { session: null }, error: null };
      },
      async getUser() {
        getUserCalls += 1;
        return { data: { user: null }, error: null };
      }
    },
    from() {
      fromCalls += 1;
      throw new Error("anonymous-table-access");
    }
  };
  const signedOut = api.createSupabaseTransport(signedOutClient);
  assert.equal(await signedOut.getAuthenticatedUser(), null);
  assert.equal(getUserCalls, 0);
  assert.equal(fromCalls, 0);

  const operations = [];
  const user = { id: "user-test" };
  function createBuilder(table) {
    const operation = {
      table,
      action: null,
      filters: [],
      record: null,
      columns: null
    };
    operations.push(operation);
    const builder = {
      select(columns) {
        operation.action ||= "select";
        operation.columns = columns;
        return builder;
      },
      upsert(record) {
        operation.action = "upsert";
        operation.record = structuredClone(record);
        return builder;
      },
      insert(record) {
        operation.action = "insert";
        operation.record = structuredClone(record);
        return builder;
      },
      update(record) {
        operation.action = "update";
        operation.record = structuredClone(record);
        return builder;
      },
      eq(key, value) {
        operation.filters.push([key, value]);
        return builder;
      },
      single() {
        return Promise.resolve(result());
      },
      maybeSingle() {
        return Promise.resolve(result());
      },
      then(resolve, reject) {
        return Promise.resolve(result()).then(resolve, reject);
      }
    };
    function result() {
      if (table === "clair_devices") {
        return { data: { id: "device-db", ...operation.record }, error: null };
      }
      if (operation.action === "insert") {
        return {
          data: { id: "row-db", revision: 1, ...operation.record },
          error: null
        };
      }
      if (operation.action === "update") {
        const expected = operation.filters.find(([key]) => key === "revision")?.[1];
        return {
          data: {
            id: "row-db",
            revision: Number(expected) + 1,
            ...operation.record
          },
          error: null
        };
      }
      return { data: operation.action === "select" ? [] : null, error: null };
    }
    return builder;
  }
  const signedInClient = {
    auth: {
      async getSession() {
        return { data: { session: { user } }, error: null };
      },
      async getUser() {
        return { data: { user }, error: null };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      }
    },
    from(table) {
      return createBuilder(table);
    }
  };
  const signedIn = api.createSupabaseTransport(signedInClient);
  assert.equal((await signedIn.getAuthenticatedUser()).id, user.id);
  await signedIn.registerDevice({ user_id: user.id, device_key: "device-key" });
  await signedIn.listData({ user_id: user.id, app_id: TEST_APP_ID });
  await signedIn.getData({
    user_id: user.id,
    app_id: TEST_APP_ID,
    data_key: "crAdapter"
  });
  await signedIn.writeData(
    {
      user_id: user.id,
      app_id: TEST_APP_ID,
      data_key: "crAdapter",
      payload: { value: "x" },
      schema_version: DATA_SCHEMA,
      last_device_id: "device-db",
      updated_at: "2026-08-21T10:00:00.000Z",
      deleted_at: null
    },
    null
  );
  await signedIn.writeData(
    {
      user_id: user.id,
      app_id: TEST_APP_ID,
      data_key: "crAdapter",
      payload: { value: "updated" },
      schema_version: DATA_SCHEMA,
      last_device_id: "device-db",
      updated_at: "2026-08-21T10:01:00.000Z",
      deleted_at: null
    },
    { revision: 7 }
  );
  const beforeForbidden = operations.length;
  await assert.rejects(
    () => signedIn.listData({ user_id: user.id, app_id: "clair-repas" }),
    /forbidden-app-id/
  );
  await assert.rejects(
    () =>
      signedIn.writeData(
        { user_id: user.id, app_id: "clair-repas", data_key: "crForbidden" },
        null
      ),
    /forbidden-app-id/
  );
  assert.equal(operations.length, beforeForbidden);
  const dataOperations = operations.filter((operation) => operation.table === "clair_data");
  assert.ok(dataOperations.length >= 4);
  for (const operation of dataOperations) {
    const appFilter = operation.filters.find(([key]) => key === "app_id");
    if (operation.action === "insert") {
      assert.equal(operation.record.app_id, TEST_APP_ID);
    } else {
      assert.deepEqual(appFilter, ["app_id", TEST_APP_ID]);
    }
  }
  const update = dataOperations.find((operation) => operation.action === "update");
  assert.ok(update);
  assert.deepEqual(
    update.filters.find(([key]) => key === "revision"),
    ["revision", 7]
  );
  assert.equal(Object.hasOwn(update.record, "revision"), false);
});

await check("Cloud transport requires the isolated personal-storage contract", async () => {
  const transport = new MemoryTransport();
  const missing = makeHarness({
    values: { crLocal: "safe" },
    transport,
    personalStorage: null
  });
  const missingResult = await missing.runtime.syncNow("missing-storage-adapter");
  assert.equal(missingResult.synced, false);
  assert.match(missingResult.error, /clair-test-storage-unavailable/);
  assert.deepEqual(missing.sync.values, { crLocal: "safe" });
  assert.equal(transport.authCalls, 0);
  assert.equal(transport.registerCalls.length, 0);
  assert.equal(transport.listCalls.length, 0);
  assert.equal(transport.writeCalls.length, 0);

  const wrongProtocol = new FakePersonalStorage();
  wrongProtocol.protocol = "clair-test-storage/legacy";
  const mismatched = makeHarness({
    values: { crLocal: "safe" },
    transport: new MemoryTransport(),
    personalStorage: wrongProtocol
  });
  const mismatchedResult = await mismatched.runtime.syncNow("wrong-storage-adapter");
  assert.equal(mismatchedResult.synced, false);
  assert.match(mismatchedResult.error, /clair-test-storage-unavailable/);
  assert.deepEqual(mismatched.sync.values, { crLocal: "safe" });

  const wrongSync = new FakeSync({ crLocal: "safe" });
  wrongSync.storageAppId = "clair-repas";
  const wrongSyncTransport = new MemoryTransport();
  const syncMismatch = makeHarness({
    transport: wrongSyncTransport,
    sync: wrongSync
  });
  const syncMismatchResult = await syncMismatch.runtime.syncNow("wrong-sync-storage");
  assert.equal(syncMismatchResult.synced, false);
  assert.match(syncMismatchResult.error, /clair-sync-runtime-mismatch/);
  assert.equal(wrongSyncTransport.authCalls, 0);
  assert.equal(wrongSyncTransport.writeCalls.length, 0);
});

await check("No session stays local and performs no anonymous write", async () => {
  const transport = new MemoryTransport({ user: null });
  const harness = makeHarness({ values: { crLocal: "safe" }, transport });
  const result = await harness.runtime.syncNow("test-no-session");
  assert.equal(result.reason, "no-session");
  assert.deepEqual(harness.sync.values, { crLocal: "safe" });
  assert.equal(transport.registerCalls.length, 0);
  assert.equal(transport.listCalls.length, 0);
  assert.equal(transport.writeCalls.length, 0);
});

await check("Local upload uses the raw value and test app_id", async () => {
  const harness = makeHarness({ values: { crPrefs: '{"mode":"local"}' } });
  const result = await harness.runtime.syncNow("test-upload");
  assert.equal(result.synced, true, JSON.stringify(result));
  const row = harness.transport.rows.get("crPrefs");
  assert.equal(row.payload.value, '{"mode":"local"}');
  assert.equal(row.payload.integration, "clair-v8-foundation.9");
  assert.equal(row.payload.source_device, "Windows • Chrome");
  assert.equal(row.deleted_at, null);
  assert.equal(harness.transport.registerCalls.length, 1);
  assertOnlyTestApp(harness.transport);
});

await check("Remote-only data downloads without format conversion", async () => {
  const transport = new MemoryTransport();
  transport.putRemote("crRemote", '["a","b"]');
  const harness = makeHarness({ transport });
  const result = await harness.runtime.syncNow("test-download");
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.equal(harness.sync.values.crRemote, '["a","b"]');
  assert.equal(harness.sync.restoreCalls.length, 1);
  assertOnlyTestApp(transport);
});

await check("A local edit during network I/O is never overwritten", async () => {
  const harness = makeHarness({
    values: { crA: "base-a", crB: "base-b" }
  });
  await harness.runtime.syncNow("seed-concurrency");
  harness.transport.putRemote("crA", "remote-a", {
    updatedAt: harness.advance(1000)
  });
  harness.transport.onList = async () => {
    harness.transport.onList = null;
    harness.sync.values.crB = "user-edit-during-network-await";
  };
  const result = await harness.runtime.syncNow("concurrent-local-edit");
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.equal(harness.sync.values.crA, "remote-a");
  assert.equal(
    harness.sync.values.crB,
    "user-edit-during-network-await"
  );
  assert.equal(
    harness.transport.rows.get("crB").payload.value,
    "user-edit-during-network-await"
  );
});

await check("Deletion sends a tombstone and recreation clears it", async () => {
  const harness = makeHarness({ values: { crDraft: "first" } });
  await harness.runtime.syncNow("seed");
  delete harness.sync.values.crDraft;
  harness.advance(2000);
  await harness.runtime.syncNow("delete");
  const tombstone = harness.transport.rows.get("crDraft");
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.payload.value, null);
  harness.sync.values.crDraft = "reborn";
  harness.advance(2000);
  await harness.runtime.syncNow("recreate");
  const recreated = harness.transport.rows.get("crDraft");
  assert.equal(recreated.deleted_at, null);
  assert.equal(recreated.payload.value, "reborn");
  assert.ok(Number(recreated.revision) > Number(tombstone.revision));
  assertOnlyTestApp(harness.transport);
});

await check("First connection never lets old cloud data erase local data", async () => {
  const transport = new MemoryTransport();
  transport.putRemote("crImportant", null, {
    deletedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z"
  });
  transport.putRemote("crScalar", "old-cloud", {
    updatedAt: "2025-01-01T00:00:00.000Z"
  });
  const harness = makeHarness({
    values: { crImportant: "local-safe", crScalar: "local-new" },
    transport
  });
  await harness.runtime.syncNow("first-connection");
  assert.deepEqual(harness.sync.values, {
    crImportant: "local-safe",
    crScalar: "local-new"
  });
  assert.equal(transport.rows.get("crImportant").deleted_at, null);
  assert.equal(transport.rows.get("crImportant").payload.value, "local-safe");
  assert.equal(transport.rows.get("crScalar").payload.value, "local-new");
});

await check("Concurrent JSON objects and arrays merge non-destructively", async () => {
  const harness = makeHarness({
    values: {
      crObject: '{"base":1}',
      crArray: '["base"]',
      crLeaf: '{"note":"base"}'
    }
  });
  await harness.runtime.syncNow("seed");
  harness.sync.values.crObject = '{"base":1,"local":2}';
  harness.sync.values.crArray = '["base","local"]';
  harness.sync.values.crLeaf = '{"note":"local"}';
  harness.advance(1000);
  harness.transport.putRemote("crObject", '{"base":1,"remote":3}', {
    updatedAt: harness.advance(1000)
  });
  harness.transport.putRemote("crArray", '["base","remote"]', {
    updatedAt: harness.advance(1000)
  });
  harness.transport.putRemote("crLeaf", '{"note":"remote"}', {
    updatedAt: harness.advance(1000)
  });
  await harness.runtime.syncNow("json-conflict");
  assert.deepEqual(JSON.parse(harness.sync.values.crObject), {
    base: 1,
    local: 2,
    remote: 3
  });
  assert.deepEqual(
    new Set(JSON.parse(harness.sync.values.crArray)),
    new Set(["base", "local", "remote"])
  );
  assert.equal(
    harness.transport.rows.get("crObject").payload.value,
    harness.sync.values.crObject
  );
  assert.equal(JSON.parse(harness.sync.values.crLeaf).note, "local");
  const meta = JSON.parse(
    harness.storage.getItem(api.constants.META_STORAGE_KEY)
  );
  const archived = meta.accounts["user-test"].conflicts.crLeaf.at(-1);
  assert.equal(archived.localValue, '{"note":"local"}');
  assert.equal(archived.remoteValue, '{"note":"remote"}');
  assert.deepEqual(archived.details[0].path, ["note"]);
});

await check("Newest scalar and newest delete win after a shared base", async () => {
  const harness = makeHarness({
    values: { crScalar: "base", crDeleteVsEdit: "base" }
  });
  await harness.runtime.syncNow("seed");
  harness.sync.values.crScalar = "local-edit";
  harness.sync.values.crDeleteVsEdit = "local-edit";
  harness.advance(1000);
  const remoteTime = harness.future(5000);
  harness.transport.putRemote("crScalar", "remote-newest", {
    updatedAt: remoteTime
  });
  harness.transport.putRemote("crDeleteVsEdit", null, {
    updatedAt: remoteTime,
    deletedAt: remoteTime
  });
  await harness.runtime.syncNow("scalar-conflict");
  assert.equal(harness.sync.values.crScalar, "remote-newest");
  assert.equal(Object.hasOwn(harness.sync.values, "crDeleteVsEdit"), false);
});

await check("Network and local restore failures preserve the local before-image", async () => {
  const offlineTransport = new MemoryTransport();
  offlineTransport.failAt = "list";
  const offline = makeHarness({
    values: { crKeep: "untouched" },
    transport: offlineTransport
  });
  const offlineResult = await offline.runtime.syncNow("network-error");
  assert.equal(offlineResult.reason, "error");
  assert.deepEqual(offline.sync.values, { crKeep: "untouched" });

  const remoteTransport = new MemoryTransport();
  remoteTransport.putRemote("crIncoming", "cloud-value");
  const failedRestore = makeHarness({
    values: { crKeep: "untouched" },
    transport: remoteTransport
  });
  failedRestore.sync.failRestore = true;
  const restoreResult = await failedRestore.runtime.syncNow("restore-error");
  assert.equal(restoreResult.reason, "error");
  assert.deepEqual(failedRestore.sync.values, { crKeep: "untouched" });

  const partialTransport = new MemoryTransport();
  partialTransport.putRemote("crA", "remote-a");
  partialTransport.putRemote("crB", "remote-b");
  const partial = makeHarness({
    values: { crKeep: "before-image" },
    transport: partialTransport
  });
  partial.sync.failRestoreAt = 2;
  const partialResult = await partial.runtime.syncNow("partial-restore-error");
  assert.equal(partialResult.reason, "error");
  assert.deepEqual(partial.sync.values, { crKeep: "before-image" });
  assert.ok(partial.sync.restoreCalls.length >= 3);
});

await check("Technical metadata remains outside personal and cloud data", async () => {
  const harness = makeHarness({ values: { crOnly: "personal" } });
  await harness.runtime.syncNow("metadata-isolation");
  const metaKey = api.constants.META_STORAGE_KEY;
  assert.equal(
    metaKey,
    "clair.v8.sync.meta.clair-repas-v8-test.test-storage-v1"
  );
  assert.equal(harness.sync.valid({ [metaKey]: "x" }), false);
  assert.ok(harness.storage.getItem(metaKey));
  assert.ok(harness.storage.getItem(api.constants.DEVICE_KEY_STORAGE));
  assert.equal(harness.transport.rows.has(metaKey), false);
  assert.ok([...harness.transport.rows.keys()].every((key) => key.startsWith("cr")));
  assert.ok(
    [...harness.transport.rows.keys()].every(
      (key) => !key.startsWith(PERSONAL_PREFIX)
    )
  );
  assertOnlyTestApp(harness.transport);
});

await check("Metadata quota failure is reported without losing local data", async () => {
  const storage = new FakeStorage();
  const baseSetItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === api.constants.META_STORAGE_KEY) {
      throw new Error("metadata-quota");
    }
    baseSetItem(key, value);
  };
  const harness = makeHarness({
    values: { crQuotaSafe: "local-before" },
    storage
  });
  const result = await harness.runtime.syncNow("metadata-quota");
  assert.equal(result.reason, "error");
  assert.match(result.error, /sync-meta-persistence-failed/);
  assert.deepEqual(harness.sync.values, { crQuotaSafe: "local-before" });
  assert.equal(harness.runtime.getStatus().metaPersisted, false);
});

await check("A transient metadata failure preserves the original edit time", async () => {
  const storage = new FakeStorage();
  const baseSetItem = storage.setItem.bind(storage);
  let metaWrites = 0;
  let failMetaAt = Number.POSITIVE_INFINITY;
  storage.setItem = (key, value) => {
    if (key === api.constants.META_STORAGE_KEY) {
      metaWrites += 1;
      if (metaWrites === failMetaAt) throw new Error("one-shot-meta-failure");
    }
    baseSetItem(key, value);
  };
  const harness = makeHarness({
    values: { crTimed: "base" },
    storage
  });
  await harness.runtime.syncNow("seed-timestamp");
  harness.advance(1000);
  harness.sync.values.crTimed = "older-local-edit";
  assert.equal(harness.runtime.markDirty("crTimed"), true);
  harness.transport.putRemote("crTimed", "newer-remote-edit", {
    updatedAt: harness.future(1000)
  });
  metaWrites = 0;
  failMetaAt = 2;
  const failed = await harness.runtime.syncNow("one-shot-meta-failure");
  assert.equal(failed.reason, "error");
  assert.equal(harness.sync.values.crTimed, "older-local-edit");

  failMetaAt = Number.POSITIVE_INFINITY;
  harness.advance(10000);
  const retried = await harness.runtime.syncNow("retry-after-meta-failure");
  assert.equal(retried.synced, true, JSON.stringify(retried));
  assert.equal(harness.sync.values.crTimed, "newer-remote-edit");
  harness.runtime.stop();
});

await check("Startup, local, foreground, online and periodic triggers stay asynchronous", async () => {
  const sync = new FakeSync({ crTrigger: "one" });
  const transport = new MemoryTransport();
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget();
  const timers = new Map();
  const intervals = new Map();
  let nextTimer = 1;
  const runtime = api.createRuntime({
    window: windowTarget,
    document: documentTarget,
    navigator: { onLine: true, userAgent: "Windows Chrome", platform: "Win32" },
    storage: new FakeStorage(),
    personalStorage: new FakePersonalStorage(),
    crypto: webcrypto,
    sync,
    transport,
    isHealthy: () => true,
    now: () => Date.parse("2026-08-21T10:00:00.000Z"),
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(callback, delay) {
      const id = nextTimer++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    }
  });
  await runtime.start();
  assert.ok(windowTarget.listeners.get("online")?.size);
  assert.ok(windowTarget.listeners.get("storage")?.size);
  assert.ok(documentTarget.listeners.get("visibilitychange")?.size);
  assert.deepEqual(
    [...intervals.values()].map((entry) => entry.delay).sort((a, b) => a - b),
    [4000, 60000]
  );
  assert.ok([...timers.values()].some((entry) => entry.delay === 0));

  const timersBeforeRawProductionEvent = [...timers.entries()];
  windowTarget.dispatch("storage", { key: "crProductionOnly" });
  assert.deepEqual([...timers.entries()], timersBeforeRawProductionEvent);
  windowTarget.dispatch("storage", { key: "clair.device.key.v1" });
  assert.deepEqual([...timers.entries()], timersBeforeRawProductionEvent);
  windowTarget.dispatch("storage", { key: PERSONAL_PREFIX + "crTrigger" });
  assert.ok([...timers.values()].some((entry) => entry.delay === 300));

  windowTarget.dispatch("online");
  assert.ok([...timers.values()].some((entry) => entry.delay === 150));
  documentTarget.dispatch("visibilitychange");
  assert.ok([...timers.values()].some((entry) => entry.delay === 150));
  sync.values.crTrigger = "two";
  [...intervals.values()].find((entry) => entry.delay === 4000).callback();
  assert.ok([...timers.values()].some((entry) => entry.delay === 500));
  [...intervals.values()].find((entry) => entry.delay === 60000).callback();
  assert.ok([...timers.values()].some((entry) => entry.delay === 0));

  runtime.stop();
  assert.equal(intervals.size, 0);
  assert.equal(windowTarget.listeners.get("online")?.size || 0, 0);
  assert.equal(documentTarget.listeners.get("visibilitychange")?.size || 0, 0);
});

if (failures.length) {
  console.error("\nCloud Sync validation failed:");
  failures.forEach((failure) => console.error("  - " + failure));
  console.error("\n" + successes.length + " checks passed, " + failures.length + " failed.");
  process.exitCode = 1;
} else {
  successes.forEach((success) => console.log("✓ " + success));
  console.log("\n" + successes.length + " Cloud Sync validation groups passed.");
}
