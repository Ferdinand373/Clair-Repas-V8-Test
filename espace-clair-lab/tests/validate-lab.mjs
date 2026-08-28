import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FOUNDATION_REFERENCE = "a0ce0d477fea164ba27a25cadc02c6c5a98d504f";
const LAB_PREFIX = "espace-clair-lab/";
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const runtimeFiles = fs.readdirSync(path.join(root, "espace-clair-lab"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:html|css|js)$/.test(entry.name))
  .map((entry) => `espace-clair-lab/${entry.name}`)
  .sort();
assert.deepEqual(runtimeFiles, [
  "espace-clair-lab/app.js",
  "espace-clair-lab/core.js",
  "espace-clair-lab/index.html",
  "espace-clair-lab/styles.css",
  "espace-clair-lab/sw.js"
]);
const runtimeSource = runtimeFiles.map(read).join("\n");
const html = read("espace-clair-lab/index.html");
const app = read("espace-clair-lab/app.js");
const coreSource = read("espace-clair-lab/core.js");
const labServiceWorker = read("espace-clair-lab/sw.js");
const applicationSource = runtimeFiles
  .filter((file) => file !== "espace-clair-lab/sw.js")
  .map(read)
  .join("\n");
const foundationCloud = read("v8/clair-cloud-sync.js");
const require = createRequire(import.meta.url);
const Core = require(path.join(root, "espace-clair-lab/core.js"));
let passed = 0;

async function check(name, callback) {
  try {
    await callback();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function stringConstant(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*["']([^"']+)["']`));
  assert.ok(match, `Missing string constant ${name}`);
  return match[1];
}

function git(...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function zeroPaths(value) {
  return value.split("\0").filter(Boolean);
}

function tree(ref) {
  const entries = zeroPaths(git("ls-tree", "-r", "-z", ref));
  return new Map(entries.map((entry) => {
    const tab = entry.indexOf("\t");
    const metadata = entry.slice(0, tab).split(" ");
    return [entry.slice(tab + 1), metadata[2]];
  }));
}

await check("Foundation.11 is an unchanged ancestor and only Lab files differ", () => {
  git("merge-base", "--is-ancestor", FOUNDATION_REFERENCE, "HEAD");
  const changed = zeroPaths(git("diff", "--name-only", "-z", FOUNDATION_REFERENCE, "--"));
  const untracked = zeroPaths(git("ls-files", "--others", "--exclude-standard", "-z"));
  assert.ok(changed.every((file) => file.startsWith(LAB_PREFIX)), changed.join(", "));
  assert.ok(untracked.every((file) => file.startsWith(LAB_PREFIX)), untracked.join(", "));

  const referenceTree = tree(FOUNDATION_REFERENCE);
  const headTree = tree("HEAD");
  for (const [file, blob] of referenceTree) {
    assert.equal(headTree.get(file), blob, `Foundation blob changed: ${file}`);
  }
  for (const file of headTree.keys()) {
    if (!referenceTree.has(file)) assert.ok(file.startsWith(LAB_PREFIX), file);
  }

  const version = JSON.parse(read("v8/version.json"));
  assert.equal(version.foundationVersion, "8.0.0-foundation.11");
  assert.equal(version.productVersion, "7.5");
});

await check("Lab runtime contains no legacy bridge or browser-storage access", () => {
  assert.doesNotMatch(runtimeSource, /syncClairRepasPersonal|mergePersonal|writeLocalJson|readLocalJson/);
  assert.doesNotMatch(runtimeSource, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(runtimeSource, /\.\s*(?:getItem|setItem|removeItem)\s*\(/);
  assert.doesNotMatch(runtimeSource, /addEventListener\s*\(\s*["']storage["']/);
  assert.doesNotMatch(
    runtimeSource,
    /\b(?:accessToken|refreshToken)\b|access[_-]token|refresh[_-]token/i
  );
  assert.doesNotMatch(runtimeSource, /clair\.v8\.test\.personal\./);
  assert.doesNotMatch(runtimeSource, /\b(?:setSession|signOut|signUp|updateUser|registerDevice)\b/);
  assert.doesNotMatch(
    applicationSource,
    /\bfetch\s*\(|XMLHttpRequest|sendBeacon|\.functions\b|\.storage\b|\.channel\s*\(|\.schema\s*\(/
  );
});

await check("Lab database surface is SELECT-only", () => {
  assert.equal((runtimeSource.match(/\.from\s*\(\s*["']clair_data["']\s*\)/g) || []).length, 1);
  assert.equal((runtimeSource.match(/\.select\s*\(/g) || []).length, 1);
  assert.doesNotMatch(runtimeSource, /\.(?:insert|upsert|update|delete|rpc)\s*\(/);
  assert.doesNotMatch(runtimeSource, /\b(?:POST|PUT|PATCH|DELETE)\b/);
  const scripts = [...html.matchAll(/<script\s+src=["']([^"']+)["']><\/script>/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [
    "../v8/vendor/supabase-js-2.111.0.js",
    "./core.js",
    "./app.js"
  ]);
  assert.match(app, /serviceWorker\.register\s*\(\s*["']\.\/sw\.js["']/);
  assert.match(app, /scope:\s*["']\.\/["']/);
});

await check("Child service worker is network-only and never falls back to Clair Repas", async () => {
  assert.doesNotMatch(labServiceWorker, /\bcaches?\s*\.|cache\.put|importScripts|clair_data|supabase/i);
  assert.doesNotMatch(labServiceWorker, /\.\.\/|\/index\.html|clair-cloud-sync/);
  assert.match(labServiceWorker, /request\.mode\s*!==\s*["']navigate["']/);
  assert.match(labServiceWorker, /Espace Clair Lab hors connexion/);

  const handlers = new Map();
  const context = {
    Response,
    fetch: async () => { throw new Error("offline"); },
    self: {
      addEventListener(type, handler) { handlers.set(type, handler); },
      skipWaiting() {},
      clients: { claim: async () => {} }
    }
  };
  vm.createContext(context);
  new vm.Script(labServiceWorker, { filename: "espace-clair-lab/sw.js" }).runInContext(context);
  assert.deepEqual([...handlers.keys()].sort(), ["activate", "fetch", "install"]);

  let responsePromise = null;
  handlers.get("fetch")({
    request: { method: "GET", mode: "navigate" },
    respondWith(value) { responsePromise = value; }
  });
  const response = await responsePromise;
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /Espace Clair Lab hors connexion/);
  assert.doesNotMatch(body, /clair-cloud-sync|Clair Repas V7\.5/);
});

await check("Every personal read is constrained to the authenticated user and TEST app", () => {
  assert.equal(Core.TEST_APP_ID, "clair-repas-v8-test");
  assert.match(coreSource, /\.eq\s*\(\s*["']user_id["']\s*,\s*user\.id\s*\)/);
  assert.match(coreSource, /\.eq\s*\(\s*["']app_id["']\s*,\s*TEST_APP_ID\s*\)/);
  assert.match(coreSource, /\.in\s*\(\s*["']data_key["']\s*,\s*OBSERVED_KEYS\s*\)/);
  assert.match(coreSource, /\.is\s*\(\s*["']deleted_at["']\s*,\s*null\s*\)/);
  assert.doesNotMatch(runtimeSource, /["']clair-repas["']/);
});

await check("Lab and Foundation have compatible official persisted-session configuration", () => {
  assert.equal(stringConstant(app, "SUPABASE_URL"), stringConstant(foundationCloud, "SUPABASE_URL"));
  assert.equal(
    stringConstant(app, "SUPABASE_PUBLISHABLE_KEY"),
    stringConstant(foundationCloud, "SUPABASE_PUBLISHABLE_KEY")
  );
  assert.match(app, /persistSession:\s*true/);
  assert.match(app, /autoRefreshToken:\s*true/);
  assert.match(app, /detectSessionInUrl:\s*false/);
  assert.doesNotMatch(app, /storageKey\s*:/);
  assert.match(html, /\.\.\/v8\/vendor\/supabase-js-2\.111\.0\.js/);
});

await check("Clair Repas TEST root link is exact", () => {
  const exact = "https://ferdinand373.github.io/Clair-Repas-V8-Test/";
  assert.equal(stringConstant(app, "TEST_ROOT_URL"), exact);
  assert.match(html, new RegExp(`href=["']${exact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
  assert.match(html, />Ouvrir Clair Repas<\/a>/);
});

await check("Signed-out observer performs no personal query", async () => {
  let calls = 0;
  const client = {
    auth: {
      async getUser() {
        throw new Error("getUser-must-not-run");
      }
    },
    from() {
      calls += 1;
      throw new Error("forbidden-query");
    }
  };
  const observer = Core.createReadOnlyObserver(client);
  assert.equal(await observer.validateSession(null), null);
  const result = await observer.read();
  assert.equal(result.state, "signed-out");
  assert.equal(calls, 0);
  assert.match(html, /Connexion nécessaire/);
});

await check("Authenticated observer emits one fully constrained SELECT chain", async () => {
  const calls = [];
  const rows = [{
    user_id: "user-lab-test",
    app_id: Core.TEST_APP_ID,
    data_key: Core.FAVORITES_KEY,
    payload: { value: "[]" },
    updated_at: "2026-08-28T12:00:00.000Z",
    deleted_at: null
  }];
  const query = {
    select(columns) { calls.push(["select", columns]); return this; },
    eq(column, value) { calls.push(["eq", column, value]); return this; },
    in(column, value) { calls.push(["in", column, [...value]]); return this; },
    is(column, value) { calls.push(["is", column, value]); return Promise.resolve({ data: rows, error: null }); }
  };
  const client = {
    auth: {
      async getUser() {
        return { data: { user: { id: "user-lab-test" } }, error: null };
      }
    },
    from(table) { calls.push(["from", table]); return query; }
  };
  const observer = Core.createReadOnlyObserver(client);
  const validated = await observer.validateSession({ user: { id: "user-lab-test" } });
  assert.equal(validated.id, "user-lab-test");
  const result = await observer.read();
  assert.equal(result.state, "ready");
  assert.equal(result.userId, "user-lab-test");
  assert.deepEqual(calls, [
    ["from", "clair_data"],
    ["select", Core.SELECTED_COLUMNS],
    ["eq", "user_id", "user-lab-test"],
    ["eq", "app_id", Core.TEST_APP_ID],
    ["in", "data_key", [...Core.OBSERVED_KEYS]],
    ["is", "deleted_at", null]
  ]);
});

await check("Rows outside the verified user, TEST app or key boundary are rejected", async () => {
  let responseRows = [];
  const query = {
    select() { return this; },
    eq() { return this; },
    in() { return this; },
    is() { return Promise.resolve({ data: responseRows, error: null }); }
  };
  const observer = Core.createReadOnlyObserver({
    auth: {
      async getUser() {
        return { data: { user: { id: "user-lab-test" } }, error: null };
      }
    },
    from() { return query; }
  });
  await observer.validateSession({ user: { id: "user-lab-test" } });
  const base = {
    user_id: "user-lab-test",
    app_id: Core.TEST_APP_ID,
    data_key: Core.FAVORITES_KEY,
    payload: { value: "[]" },
    updated_at: "2026-08-28T12:00:00.000Z",
    deleted_at: null
  };
  responseRows = [{ ...base, user_id: "different-user" }];
  await assert.rejects(observer.read(), /forbidden-row-boundary/);
  responseRows = [{ ...base, app_id: "forbidden-app" }];
  await assert.rejects(observer.read(), /forbidden-row-boundary/);
  responseRows = [{ ...base, data_key: "forbidden-key" }];
  await assert.rejects(observer.read(), /forbidden-row-boundary/);
  responseRows = [base];
  assert.equal((await observer.read()).state, "ready");
});

await check("Session identity must match the server-validated user", async () => {
  let getUserCalls = 0;
  const client = {
    auth: {
      async getUser() {
        getUserCalls += 1;
        return { data: { user: { id: "same-user", email: "test@example.invalid" } }, error: null };
      }
    }
  };
  const valid = await Core.validateSessionUser(client, { user: { id: "same-user" } });
  assert.equal(valid.id, "same-user");
  const mismatch = await Core.validateSessionUser(client, { user: { id: "other-user" } });
  assert.equal(mismatch, null);
  const signedOut = await Core.validateSessionUser(client, null);
  assert.equal(signedOut, null);
  assert.equal(getUserCalls, 2);
});

await check("Unverified or mismatched sessions cannot reach clair_data", async () => {
  let fromCalls = 0;
  let verifiedUser = null;
  let getUserError = null;
  const client = {
    auth: {
      async getUser() {
        return { data: { user: verifiedUser }, error: getUserError };
      }
    },
    from() {
      fromCalls += 1;
      throw new Error("unexpected-query");
    }
  };
  const observer = Core.createReadOnlyObserver(client);

  assert.equal(await observer.validateSession(null), null);
  assert.equal((await observer.read()).state, "signed-out");
  getUserError = new Error("auth-unavailable");
  assert.equal(await observer.validateSession({ user: { id: "user-test" } }), null);
  assert.equal((await observer.read()).state, "signed-out");
  getUserError = null;
  verifiedUser = { id: "other-user" };
  assert.equal(await observer.validateSession({ user: { id: "user-test" } }), null);
  assert.equal((await observer.read()).state, "signed-out");
  assert.equal(fromCalls, 0);
});

await check("A delayed account A read can never render after account B", async () => {
  const boundary = Core.createViewBoundary();
  const rendered = [];
  const epochA = boundary.beginAuth();
  assert.equal(boundary.acceptAuth(epochA, "user-a"), true);
  const readA = boundary.beginRead();

  let resolveA;
  const delayedA = new Promise((resolve) => { resolveA = resolve; });
  const renderA = delayedA.then((value) => {
    if (boundary.isReadCurrent(readA)) rendered.push(value);
  });

  const epochB = boundary.beginAuth();
  assert.equal(boundary.acceptAuth(epochB, "user-b"), true);
  const readB = boundary.beginRead();
  assert.equal(boundary.isReadCurrent(readA), false);
  assert.equal(boundary.isReadCurrent(readB), true);

  resolveA("private-summary-a");
  await renderA;
  assert.deepEqual(rendered, []);
  assert.doesNotMatch(app, /setValidatedUser/);
  assert.match(app, /result\.userId\s*!==\s*token\.userId/);
  assert.match(app, /viewBoundary\.isReadCurrent\s*\(token\)/);
});

await check("Payload strings are counted without exposing personal content", () => {
  const favoriteSecret = "favorite-secret-id";
  const noteSecret = "private note content";
  const rows = [
    {
      user_id: "user-lab-test",
      app_id: Core.TEST_APP_ID,
      data_key: Core.FAVORITES_KEY,
      payload: { value: JSON.stringify([favoriteSecret, "second-secret"]) },
      updated_at: "2026-08-28T12:00:00.000Z",
      deleted_at: null
    },
    {
      user_id: "user-lab-test",
      app_id: Core.TEST_APP_ID,
      data_key: Core.NOTES_KEY,
      payload: { value: JSON.stringify({ recipe: noteSecret, empty: "" }), source_device: "Edge TEST" },
      updated_at: "2026-08-28T12:01:00.000Z",
      deleted_at: null
    }
  ];
  const summary = Core.summarizeRows(rows);
  assert.equal(summary.favorites.count, 2);
  assert.equal(summary.notes.count, 1);
  assert.equal(summary.lastSyncAt, "2026-08-28T12:01:00.000Z");
  assert.equal(summary.sourceDevice, "Edge TEST");
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, new RegExp(favoriteSecret));
  assert.doesNotMatch(serialized, new RegExp(noteSecret));
});

await check("Malformed payloads remain unreadable and are never corrected", async () => {
  let mutationCalls = 0;
  const rows = [Core.FAVORITES_KEY, Core.NOTES_KEY].map((dataKey) => ({
    user_id: "user-lab-test",
    app_id: Core.TEST_APP_ID,
    data_key: dataKey,
    payload: { value: "not-json" },
    updated_at: "2026-08-28T12:00:00.000Z",
    deleted_at: null
  }));
  const query = {
    select() { return this; },
    eq() { return this; },
    in() { return this; },
    is() { return Promise.resolve({ data: rows, error: null }); }
  };
  for (const method of ["insert", "upsert", "update", "delete", "rpc"]) {
    query[method] = () => {
      mutationCalls += 1;
      throw new Error(`forbidden-mutation:${method}`);
    };
  }
  const observer = Core.createReadOnlyObserver({
    auth: {
      async getUser() {
        return { data: { user: { id: "user-lab-test" } }, error: null };
      }
    },
    from() { return query; }
  });
  await observer.validateSession({ user: { id: "user-lab-test" } });
  const result = await observer.read();
  const summary = Core.summarizeRows(result.rows);
  assert.equal(summary.favorites.state, "unreadable");
  assert.equal(summary.favorites.count, null);
  assert.equal(summary.notes.state, "unreadable");
  assert.match(app, /Donnée momentanément illisible/);
  assert.equal(mutationCalls, 0);
});

console.log(`\n${passed} Espace Clair Lab invariant groups passed.`);
