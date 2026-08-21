#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FOUNDATION_8_INDEX_BLOB = "a591a41afc633f1058a94eeec7e8c2e01cedc6da";
const decoder = new TextDecoder("utf-8", { fatal: true });
const successes = [];
const failures = [];

function rooted(relativePath) {
  const fullPath = resolve(ROOT, relativePath);
  assert.ok(
    fullPath === ROOT || fullPath.startsWith(ROOT + sep),
    "Path escapes repository root: " + relativePath
  );
  return fullPath;
}

function readUtf8(relativePath) {
  return decoder.decode(readFileSync(rooted(relativePath)));
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function stringConstant(source, name) {
  const pattern = new RegExp(
    "\\bconst\\s+" + escapeRegExp(name) + "\\s*=\\s*([\"'])(.*?)\\1\\s*;"
  );
  const match = source.match(pattern);
  assert.ok(match, "Missing string constant " + name);
  return match[2];
}

function numberConstant(source, name) {
  const pattern = new RegExp(
    "\\bconst\\s+" + escapeRegExp(name) + "\\s*=\\s*(\\d+)\\s*;"
  );
  const match = source.match(pattern);
  assert.ok(match, "Missing numeric constant " + name);
  return Number(match[1]);
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, "Missing marker: " + startMarker);
  assert.ok(end > start, "Missing marker after " + startMarker + ": " + endMarker);
  return source.slice(start, end);
}

function coreAssetPath(asset) {
  assert.match(asset, /^\.\/(?:[^?#\\]*)$/, "Unsafe core asset path: " + asset);
  const relativePath = asset.slice(2);
  assert.ok(!relativePath.split("/").includes(".."), "Unsafe core asset path: " + asset);
  return relativePath || "index.html";
}

function normalizedCoreContent(relativePath, content = readFileSync(rooted(relativePath))) {
  if (/\.(?:html|js|json|webmanifest|txt|text)$/i.test(relativePath)) {
    return Buffer.from(decoder.decode(content).replace(/\r\n?/g, "\n"), "utf8");
  }
  return content;
}

function assetDigest(asset) {
  const content = normalizedCoreContent(coreAssetPath(asset));
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

function coreDigest(coreFiles) {
  const hash = createHash("sha256");
  for (const asset of coreFiles) {
    const relativePath = coreAssetPath(asset);
    const content = normalizedCoreContent(relativePath);
    hash.update(asset);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return "sha256:" + hash.digest("hex");
}

function gitBlobSha(content) {
  const header = Buffer.from("blob " + content.length + "\0", "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

async function check(name, callback) {
  try {
    const detail = await callback();
    successes.push(detail ? name + " — " + detail : name);
  } catch (error) {
    failures.push(name + ": " + (error && error.message ? error.message : String(error)));
  }
}

const indexHtml = readUtf8("index.html");
const serviceWorker = readUtf8("sw.js");
const personalSync = readUtf8("v8/clair-sync.js");
const foundation = readUtf8("v8/clair-foundation.js");
const manifest = JSON.parse(readUtf8("manifest.webmanifest"));
const version = JSON.parse(readUtf8("v8/version.json"));
const refreshMarker = readUtf8("refresh.text");

const scriptMatches = [
  ...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)
];
const inlineScripts = scriptMatches
  .filter(([, attributes, body]) => !/\bsrc\s*=/.test(attributes) && body.trim())
  .map(([, , body]) => body);

const coreMatch = serviceWorker.match(/const CORE_FILES\s*=\s*(\[[\s\S]*?\]);/);
assert.ok(coreMatch, "Missing CORE_FILES declaration");
const coreFiles = JSON.parse(coreMatch[1]);
const digestMatch = serviceWorker.match(
  /const CORE_DIGESTS\s*=\s*Object\.freeze\((\{[\s\S]*?\})\);/
);
assert.ok(digestMatch, "Missing CORE_DIGESTS declaration");
const coreDigests = JSON.parse(digestMatch[1]);

await check("Required repository files", () => {
  const required = [
    "index.html",
    "sw.js",
    "manifest.webmanifest",
    "icon-192.png",
    "icon-512.png",
    "v8/clair-sync.js",
    "v8/clair-foundation.js",
    "v8/version.json"
  ];
  for (const relativePath of required) {
    assert.ok(existsSync(rooted(relativePath)), "Missing " + relativePath);
  }
  return required.length + " files";
});

await check("UTF-8 and merge-conflict safety", () => {
  const textFiles = [
    "index.html",
    "sw.js",
    "manifest.webmanifest",
    "refresh.text",
    "deploy-trigger.txt",
    "v8/clair-sync.js",
    "v8/clair-foundation.js",
    "v8/version.json"
  ];
  for (const relativePath of textFiles) {
    const text = readUtf8(relativePath);
    assert.doesNotMatch(
      text,
      /^(?:<<<<<<<|=======|>>>>>>>)(?: .*)?$/m,
      "Merge-conflict marker in " + relativePath
    );
  }
  return textFiles.length + " text files";
});

await check("JavaScript syntax", () => {
  new vm.Script(serviceWorker, { filename: "sw.js" });
  new vm.Script(personalSync, { filename: "v8/clair-sync.js" });
  new vm.Script(foundation, { filename: "v8/clair-foundation.js" });
  assert.ok(inlineScripts.length > 0, "No inline application script found");
  inlineScripts.forEach((source, index) => {
    new vm.Script(source, { filename: "index.html:inline-" + (index + 1) + ".js" });
  });
  return inlineScripts.length + 3 + " scripts";
});

await check("Release metadata consistency", () => {
  const appId = stringConstant(serviceWorker, "APP_ID");
  const release = stringConstant(serviceWorker, "RELEASE");
  const schema = numberConstant(serviceWorker, "DATA_SCHEMA");
  const syncRelease = personalSync.match(/clairRelease\s*\|\|\s*(["'])(.*?)\1/);
  const syncSchema = personalSync.match(/clairSchema\s*\|\|\s*(\d+)/);
  const foundationRelease = foundation.match(/clairRelease\s*\|\|\s*(["'])(.*?)\1/);
  const foundationSchema = foundation.match(/clairSchema\s*\|\|\s*(\d+)/);
  const productVersion = stringConstant(indexHtml, "CR_APP_VERSION");
  const productSchema = numberConstant(indexHtml, "CR_DATA_SCHEMA_VERSION");
  const markerVersion = refreshMarker.match(/Clair Repas V(\d+(?:\.\d+){1,2})/i);

  assert.ok(syncRelease, "Missing personal Sync release fallback");
  assert.ok(syncSchema, "Missing personal Sync schema fallback");
  assert.ok(foundationRelease, "Missing Foundation release fallback");
  assert.ok(foundationSchema, "Missing Foundation schema fallback");
  assert.ok(markerVersion, "Missing product version in refresh.text");
  assert.equal(version.app, appId);
  assert.equal(version.foundationVersion, release);
  assert.equal(syncRelease[2], release);
  assert.equal(foundationRelease[2], release);
  assert.equal(version.dataSchema, schema);
  assert.equal(Number(syncSchema[1]), schema);
  assert.equal(Number(foundationSchema[1]), schema);
  assert.equal(productSchema, schema);
  assert.equal(version.productVersion, productVersion);
  assert.equal(markerVersion[1], productVersion);
  assert.match(version.publishedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((serviceWorker.match(/data-clair-core="\$\{CORE_REVISION\}"/g) || []).length, 2);
  assert.match(personalSync, /protocol:\s*'clair-personal-sync\/v1'/);
  assert.match(foundation, /coreRevision:\s*CORE_REVISION/);
  assert.match(
    serviceWorker,
    /data\.release === RELEASE && data\.coreRevision === CORE_REVISION/
  );
  return release + " / product " + productVersion;
});

await check("Foundation.8 application shell identity", () => {
  const canonicalIndex = normalizedCoreContent("index.html");
  assert.equal(
    gitBlobSha(canonicalIndex),
    FOUNDATION_8_INDEX_BLOB,
    "index.html must remain the exact Foundation.8 application shell"
  );
  assert.doesNotMatch(indexHtml, /data-clair-v8-(?:sync|foundation)/);
  return "index.html blob " + FOUNDATION_8_INDEX_BLOB.slice(0, 12);
});

await check("PWA manifest and icons", () => {
  assert.equal(manifest.name, "Clair Repas");
  assert.equal(manifest.short_name, "Clair Repas");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.match(indexHtml, /<link\s+rel=["']manifest["']\s+href=["']\.\/manifest\.webmanifest["']/i);

  const themeMatch = indexHtml.match(
    /<meta\s+name=["']theme-color["']\s+content=["']([^"']+)["']/i
  );
  assert.ok(themeMatch, "Missing HTML theme-color");
  assert.equal(themeMatch[1].toLowerCase(), String(manifest.theme_color).toLowerCase());
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "Missing PWA icons");

  const dimensions = new Set();
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    const iconPath = coreAssetPath(icon.src);
    const bytes = readFileSync(rooted(iconPath));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const actual = width + "x" + height;
    assert.ok(String(icon.sizes).split(/\s+/).includes(actual), iconPath + " is " + actual);
    dimensions.add(actual);
  }
  assert.ok(dimensions.has("192x192"), "Missing 192x192 icon");
  assert.ok(dimensions.has("512x512"), "Missing 512x512 icon");
  return [...dimensions].sort().join(", ");
});

await check("Precache completeness and immutable revision", () => {
  assert.ok(Array.isArray(coreFiles) && coreFiles.length > 0, "CORE_FILES must be non-empty");
  assert.equal(new Set(coreFiles).size, coreFiles.length, "Duplicate CORE_FILES entries");
  for (const expected of [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./icon-192.png",
    "./icon-512.png",
    "./v8/clair-sync.js",
    "./v8/clair-foundation.js",
    "./v8/version.json"
  ]) {
    assert.ok(coreFiles.includes(expected), "CORE_FILES omits " + expected);
  }
  for (const asset of coreFiles) {
    assert.ok(existsSync(rooted(coreAssetPath(asset))), "Missing core asset " + asset);
    assert.equal(coreDigests[asset], assetDigest(asset), "Digest mismatch for " + asset);
  }
  assert.deepEqual(Object.keys(coreDigests).sort(), [...coreFiles].sort());
  assert.equal(
    normalizedCoreContent("sample.txt", Buffer.from("a\r\nb\rc\n", "utf8")).toString("utf8"),
    "a\nb\nc\n"
  );

  const revision = stringConstant(serviceWorker, "CORE_REVISION");
  assert.match(revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(revision, coreDigest(coreFiles));
  assert.match(
    serviceWorker,
    /const CURRENT_CACHE\s*=\s*[^;]*CORE_REVISION/,
    "Cache identity must include CORE_REVISION"
  );
  assert.match(
    serviceWorker,
    /const ROLLBACK_CORE_FILES\s*=\s*CORE_FILES\.filter\(path => path !== "\.\/v8\/clair-sync\.js"\)/,
    "Foundation.8 fallback must not require clair-sync.js"
  );
  assert.match(
    serviceWorker,
    /html\.includes\("data-clair-v8-sync"\) \? CORE_FILES : ROLLBACK_CORE_FILES/,
    "Post-Sync fallbacks must retain clair-sync.js"
  );
  return coreFiles.length + " URLs, " + revision.slice(0, 19);
});

await check("Service-worker registration and full-cache validation", async () => {
  const handlers = new Map();
  const fakeSelf = {
    registration: { scope: "https://example.test/app/" },
    location: { origin: "https://example.test" },
    addEventListener(type, handler) {
      handlers.set(type, handler);
    }
  };
  vm.runInNewContext(
    serviceWorker,
    {
      self: fakeSelf,
      URL,
      Headers,
      Response,
      Request,
      Set,
      Date,
      console,
      crypto: webcrypto,
      TextDecoder,
      TextEncoder
    },
    { filename: "sw.js:registration-smoke", timeout: 1000 }
  );
  assert.deepEqual([...handlers.keys()].sort(), ["activate", "fetch", "install", "message"]);

  let cacheNames = ["legacy"];
  let missingAsset = null;
  const cacheContext = {
    self: fakeSelf,
    URL,
    Headers,
    Response,
    Request,
    Set,
    Date,
    console,
    crypto: webcrypto,
    TextDecoder,
    TextEncoder,
    caches: {
      async keys() {
        return cacheNames;
      },
      async open(cacheName) {
        return {
          async match(request) {
            const url = String(request);
            if (missingAsset && url.includes(missingAsset)) return null;
            if (url.endsWith("/index.html") || url.endsWith("/app/")) {
              const bootstrap = cacheName === "legacy"
                ? "<script data-clair-v8-foundation></script>"
                : "<script data-clair-v8-sync></script><script data-clair-v8-foundation></script>";
              return new Response("<head>" + bootstrap + "</head>");
            }
            return new Response("asset");
          }
        };
      }
    }
  };
  vm.runInNewContext(
    serviceWorker +
      "\n;globalThis.__cacheHasCore = cacheHasCore;" +
      "\n;globalThis.__currentCache = CURRENT_CACHE;" +
      "\n;globalThis.__validateCoreDigest = validateCoreDigest;",
    cacheContext,
    { filename: "sw.js:cache-smoke", timeout: 1000 }
  );
  cacheNames = [cacheContext.__currentCache, "legacy", "future"];
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), true);
  assert.equal(await cacheContext.__cacheHasCore("legacy"), true);
  assert.equal(await cacheContext.__cacheHasCore("future"), true);
  missingAsset = "clair-sync.js";
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), false);
  assert.equal(
    await cacheContext.__cacheHasCore("legacy"),
    true,
    "Foundation.8 fallback must remain valid without clair-sync.js"
  );
  assert.equal(
    await cacheContext.__cacheHasCore("future"),
    false,
    "Post-Sync fallback must require clair-sync.js"
  );
  missingAsset = "manifest.webmanifest";
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), false);
  assert.equal(await cacheContext.__cacheHasCore("legacy"), false);
  assert.equal(await cacheContext.__cacheHasCore("future"), false);

  const manifestResponse = new Response(readFileSync(rooted("manifest.webmanifest")));
  await cacheContext.__validateCoreDigest("./manifest.webmanifest", manifestResponse);
  await assert.rejects(
    () =>
      cacheContext.__validateCoreDigest(
        "./manifest.webmanifest",
        new Response(
          Buffer.concat([
            readFileSync(rooted("manifest.webmanifest")),
            Buffer.from(" ", "utf8")
          ])
        )
      ),
    /digest mismatch/
  );
  const fetchRequiredSource = between(
    serviceWorker,
    "function isTextCorePath(path) {",
    "\nasync function buildCandidateCache"
  );
  const fetchContext = {
    self: fakeSelf,
    URL,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    crypto: webcrypto,
    CORE_DIGESTS: coreDigests,
    fetch: async () =>
      new Response(
        Buffer.concat([
          readFileSync(rooted("manifest.webmanifest")),
          Buffer.from(" ", "utf8")
        ]),
        { status: 200 }
      )
  };
  vm.runInNewContext(
    fetchRequiredSource + "\n;globalThis.__fetchRequired = fetchRequired;",
    fetchContext,
    { filename: "sw.js:fetch-required-smoke", timeout: 1000 }
  );
  await assert.rejects(
    () => fetchContext.__fetchRequired("./manifest.webmanifest"),
    /digest mismatch/
  );

  const injectionSource = between(
    serviceWorker,
    "function syncTag() {",
    "\nasync function validateVersionManifest"
  );
  const injectionContext = {
    APP_ID: stringConstant(serviceWorker, "APP_ID"),
    RELEASE: stringConstant(serviceWorker, "RELEASE"),
    DATA_SCHEMA: numberConstant(serviceWorker, "DATA_SCHEMA"),
    CORE_REVISION: stringConstant(serviceWorker, "CORE_REVISION"),
    Headers,
    Response
  };
  vm.runInNewContext(
    injectionSource + "\n;globalThis.__injectRuntime = injectRuntime;",
    injectionContext,
    { filename: "sw.js:runtime-injection-smoke", timeout: 1000 }
  );
  const injectedResponse = await injectionContext.__injectRuntime(
    new Response("<!doctype html><html><head><title>App</title></head><body></body></html>")
  );
  const injectedHtml = await injectedResponse.text();
  const syncPosition = injectedHtml.indexOf("data-clair-v8-sync");
  const foundationPosition = injectedHtml.indexOf("data-clair-v8-foundation");
  assert.ok(syncPosition >= 0 && foundationPosition > syncPosition);
  assert.equal((injectedHtml.match(/data-clair-v8-sync/g) || []).length, 1);
  assert.equal((injectedHtml.match(/data-clair-v8-foundation/g) || []).length, 1);
  assert.equal((injectedHtml.match(/data-clair-app="clair-repas"/g) || []).length, 2);
  await assert.rejects(
    () =>
      injectionContext.__injectRuntime(
        new Response("<head><script data-clair-v8-foundation></script></head>")
      ),
    /incomplete runtime bootstrap/
  );

  const markCandidateSource = between(
    serviceWorker,
    "async function markCandidateActive() {",
    "\nasync function rollbackIfNeeded"
  );
  assert.match(markCandidateSource, /bootAttempted:\s*false/);
  assert.match(markCandidateSource, /bootStartedAt:\s*0/);

  const startAttemptSource = between(
    serviceWorker,
    "async function startBootAttemptIfNeeded(state) {",
    "\nasync function startBootAttemptSafely"
  );
  const attemptContext = {
    CURRENT_CACHE: "candidate",
    Date,
    writeState: async (state) => state
  };
  vm.runInNewContext(
    startAttemptSource +
      "\n;globalThis.__startBootAttemptIfNeeded = startBootAttemptIfNeeded;",
    attemptContext,
    { filename: "sw.js:boot-attempt-smoke", timeout: 1000 }
  );
  const untouched = { probation: false, activeCache: "candidate", bootStartedAt: 0 };
  assert.equal(await attemptContext.__startBootAttemptIfNeeded(untouched), untouched);
  const attempted = await attemptContext.__startBootAttemptIfNeeded({
    probation: true,
    activeCache: "candidate",
    bootAttempted: false,
    bootStartedAt: 0
  });
  assert.equal(attempted.bootAttempted, true);
  assert.ok(Number.isFinite(attempted.bootStartedAt) && attempted.bootStartedAt > 0);
  const safeAttemptSource = between(
    serviceWorker,
    "async function startBootAttemptSafely(state) {",
    "\nasync function serveFromCache"
  );
  const failedMetaContext = {
    CURRENT_CACHE: "candidate",
    Date,
    writeState: async () => {
      throw new Error("meta-cache unavailable");
    }
  };
  vm.runInNewContext(
    startAttemptSource +
      safeAttemptSource +
      "\n;globalThis.__startBootAttemptSafely = startBootAttemptSafely;",
    failedMetaContext,
    { filename: "sw.js:meta-cache-failure-smoke", timeout: 1000 }
  );
  const candidateState = {
    probation: true,
    activeCache: "candidate",
    previousCache: "previous",
    bootStartedAt: 0
  };
  const afterMetaFailure = await failedMetaContext.__startBootAttemptSafely(candidateState);
  assert.equal(afterMetaFailure, candidateState);
  assert.equal(afterMetaFailure.activeCache, "candidate");
  const mainNavigationSource = between(
    serviceWorker,
    "if (isMainNavigation(url, request)) {",
    "\n  if (request.mode === \"navigate\")"
  );
  assert.match(mainNavigationSource, /startBootAttemptSafely\(state\)/);
  assert.doesNotMatch(serviceWorker, /CLAIR_V8_BOOT_START/);

  const buildCandidateSource = between(
    serviceWorker,
    "async function buildCandidateCache() {",
    "\nasync function choosePreviousCache"
  );
  assert.ok(
    buildCandidateSource.indexOf("state.failedCache === CURRENT_CACHE") <
      buildCandidateSource.indexOf("cacheHasCore(CURRENT_CACHE)"),
    "Failed-cache quarantine must run before candidate reuse"
  );
  const quarantineContext = {
    CURRENT_CACHE: "candidate",
    readState: async () => ({ failedCache: "candidate" })
  };
  vm.runInNewContext(
    buildCandidateSource + "\n;globalThis.__buildCandidateCache = buildCandidateCache;",
    quarantineContext,
    { filename: "sw.js:failed-cache-smoke", timeout: 1000 }
  );
  await assert.rejects(
    () => quarantineContext.__buildCandidateCache(),
    /quarantined after a failed boot/
  );

  return "4 handlers; digest, watchdog and quarantine paths";
});

await check("Literal DOM references", () => {
  const declared = new Set(
    [...indexHtml.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2])
  );
  const references = [
    ...indexHtml.matchAll(/\$\(\s*(["'])(.*?)\1\s*\)/g)
  ].map((match) => match[2]);
  const missing = [...new Set(references.filter((id) => !declared.has(id)))];
  assert.deepEqual(missing, []);
  return declared.size + " IDs / " + references.length + " references";
});

await check("Direct personal sync isolation", async () => {
  assert.doesNotMatch(foundation, /\blocalStorage\b/);
  assert.doesNotMatch(foundation, /personalKeyPolicies|function readPersonalData/);
  assert.match(personalSync, /\blocalStorage\b/);
  assert.match(foundation, /const personalSync = resolvePersonalSync\(\)/);
  const readySource = between(
    foundation,
    "function clairRepasReady() {",
    "\n  const appConfig ="
  );
  const readyContext = {
    window: { __CLAIR_REPAS_HEALTH: { ok: false } },
    document: { readyState: "complete" }
  };
  vm.runInNewContext(
    readySource + "\n;globalThis.__clairRepasReady = clairRepasReady;",
    readyContext,
    { filename: "v8/clair-foundation.js:health-smoke", timeout: 1000 }
  );
  assert.equal(readyContext.__clairRepasReady(), false);
  readyContext.window.__CLAIR_REPAS_HEALTH = { ok: true };
  assert.equal(readyContext.__clairRepasReady(), true);
  readyContext.document.readyState = "loading";
  assert.equal(readyContext.__clairRepasReady(), false);

  const values = new Map([
    ["crA", "old-a"],
    ["crB", "old-b"],
    ["unrelated", "keep"]
  ]);
  let operation = 0;
  let failAt = 2;
  let readFailuresRemaining = 0;
  const localStorage = {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      if (readFailuresRemaining > 0 && /^cr/.test(key)) {
        readFailuresRemaining -= 1;
        throw new Error("injected read failure");
      }
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      operation += 1;
      if (operation === failAt) throw new Error("injected write failure");
      values.set(key, String(value));
    },
    removeItem(key) {
      operation += 1;
      if (operation === failAt) throw new Error("injected remove failure");
      values.delete(key);
    }
  };
  const context = {
    window: {},
    document: {
      currentScript: {
        dataset: {
          clairApp: "clair-repas",
          clairRelease: stringConstant(serviceWorker, "RELEASE"),
          clairSchema: String(numberConstant(serviceWorker, "DATA_SCHEMA")),
          clairCore: stringConstant(serviceWorker, "CORE_REVISION")
        }
      }
    },
    location: { href: "https://example.test/app/index.html", pathname: "/app/" },
    URL,
    localStorage,
  };
  vm.runInNewContext(
    personalSync,
    context,
    { filename: "v8/clair-sync.js:storage-smoke", timeout: 1000 }
  );
  const syncApi = context.window.ClairSync;
  assert.ok(syncApi, "ClairSync API was not published");
  assert.equal(syncApi.protocol, "clair-personal-sync/v1");
  assert.deepEqual(Object.fromEntries(Object.entries(syncApi.capture().values)), {
    crA: "old-a",
    crB: "old-b"
  });

  const resolverSource = between(
    foundation,
    "function resolvePersonalSync() {",
    "\n  const personalSync ="
  );
  const resolverContext = {
    window: { ClairSync: syncApi },
    APP_ID: syncApi.app,
    RELEASE: syncApi.release,
    CORE_REVISION: syncApi.coreRevision,
    DATA_SCHEMA: syncApi.dataSchema,
    SCOPE_PATH: syncApi.scopePath,
    SCOPE_ID: syncApi.scopeId
  };
  vm.runInNewContext(
    resolverSource + "\n;globalThis.__resolvePersonalSync = resolvePersonalSync;",
    resolverContext,
    { filename: "v8/clair-foundation.js:sync-contract-smoke", timeout: 1000 }
  );
  assert.equal(resolverContext.__resolvePersonalSync(), syncApi);
  resolverContext.window.ClairSync = { ...syncApi, coreRevision: "sha256:tampered" };
  assert.equal(resolverContext.__resolvePersonalSync(), null);

  assert.equal(syncApi.restore({ crA: "new-a", crC: "new-c" }), false);
  assert.deepEqual(Object.fromEntries(values), {
    crA: "old-a",
    crB: "old-b",
    unrelated: "keep"
  });

  operation = 0;
  failAt = Number.POSITIVE_INFINITY;
  assert.equal(syncApi.restore({ crA: "new-a", crC: "new-c" }), true);
  assert.deepEqual(Object.fromEntries(values), {
    crA: "new-a",
    crC: "new-c",
    unrelated: "keep"
  });
  const beforeRejectedRestore = Object.fromEntries(values);
  assert.equal(syncApi.restore(new Map([["crA", "map-value"]])), false);
  assert.equal(syncApi.restore({ crA: 42 }), false);
  assert.deepEqual(Object.fromEntries(values), beforeRejectedRestore);

  readFailuresRemaining = 1;
  const failedCapture = syncApi.capture();
  assert.equal(failedCapture.ok, false);
  assert.equal(Object.keys(failedCapture.values).length, 0);

  const failBootSource = between(
    foundation,
    "async function failBoot(reason, detail = '') {",
    "\n  window.addEventListener('error'"
  );
  let restoreCalls = 0;
  let snapshotCalls = 0;
  let postedFailure = null;
  const failBootContext = {
    prebootCapture: { ok: false },
    prebootData: {},
    restorePersonalData: () => {
      restoreCalls += 1;
      return true;
    },
    putSnapshot: async () => {
      snapshotCalls += 1;
    },
    post: (_type, payload) => {
      postedFailure = payload;
    }
  };
  vm.runInNewContext(
    "let bootResolved = false; let fatalError = null;\n" +
      failBootSource +
      "\n;globalThis.__failBoot = failBoot;",
    failBootContext,
    { filename: "v8/clair-foundation.js:capture-failure-smoke", timeout: 1000 }
  );
  await failBootContext.__failBoot("runtime-error", "test");
  assert.equal(restoreCalls, 0);
  assert.equal(snapshotCalls, 0);
  assert.equal(postedFailure.personalDataCaptured, false);

  const quotaValues = new Map([
    ["crA", "a".repeat(4000)],
    ["crB", "b".repeat(1000)]
  ]);
  const quotaLimit = 6000;
  const quotaStorage = {
    get length() {
      return quotaValues.size;
    },
    key(index) {
      return [...quotaValues.keys()][index] ?? null;
    },
    getItem(key) {
      return quotaValues.has(key) ? quotaValues.get(key) : null;
    },
    setItem(key, value) {
      const next = new Map(quotaValues);
      next.set(key, String(value));
      const size = [...next.values()].reduce((sum, item) => sum + item.length, 0);
      if (size > quotaLimit) throw new Error("quota exceeded");
      quotaValues.set(key, String(value));
    },
    removeItem(key) {
      quotaValues.delete(key);
    }
  };
  const quotaContext = {
    window: {},
    document: context.document,
    location: context.location,
    URL,
    localStorage: quotaStorage,
  };
  vm.runInNewContext(
    personalSync,
    quotaContext,
    { filename: "v8/clair-sync.js:quota-smoke", timeout: 1000 }
  );
  assert.equal(
    quotaContext.window.ClairSync.restore({
      crA: "a".repeat(1000),
      crC: "c".repeat(4000),
      crD: "d".repeat(1000)
    }),
    false
  );
  assert.deepEqual(Object.fromEntries(quotaValues), {
    crA: "a".repeat(4000),
    crB: "b".repeat(1000)
  });
  return "storage isolated; transient and quota failures restore the before-image";
});

await check("Compatible newest snapshot selection", () => {
  const hashSource = between(foundation, "function fnv1a(text) {", "function appScopePath() {");
  const snapshotSource = between(
    foundation,
    "function compatibleSnapshot(record) {",
    "function post(type, extra = {}) {"
  );
  const context = {
    APP_ID: "clair-repas",
    DATA_SCHEMA: 2,
    SCOPE_PATH: "/app/",
    SCOPE_ID: "scope-id",
    validPersonalData(values) {
      return (
        Object.prototype.toString.call(values) === "[object Object]" &&
        Object.entries(values).every(
          ([key, value]) => /^cr/.test(key) && typeof value === "string"
        )
      );
    }
  };
  vm.runInNewContext(
    hashSource +
      snapshotSource +
      "\n;globalThis.__fnv1a = fnv1a;" +
      "\n;globalThis.__latestCompatibleSnapshot = latestCompatibleSnapshot;",
    context,
    { filename: "v8/clair-foundation.js:snapshot-smoke", timeout: 1000 }
  );

  const makeSnapshot = (capturedAt, overrides = {}) => {
    const values = overrides.values || { crA: capturedAt };
    return {
      app: "clair-repas",
      dataSchema: 2,
      scopePath: "/app/",
      scopeId: "scope-id",
      capturedAt,
      values,
      fingerprint: "fnv1a:" + context.__fnv1a(JSON.stringify(values)),
      ...overrides
    };
  };
  const oldHealthy = makeSnapshot("2026-08-20T10:00:00.000Z");
  const newPreboot = makeSnapshot("2026-08-21T10:00:00.000Z");
  const incompatible = makeSnapshot("2026-08-22T10:00:00.000Z", { dataSchema: 1 });
  assert.equal(
    context.__latestCompatibleSnapshot([oldHealthy, incompatible, newPreboot]),
    newPreboot
  );
  assert.equal(
    context.__latestCompatibleSnapshot([
      { ...newPreboot, fingerprint: "fnv1a:tampered" },
      oldHealthy
    ]),
    oldHealthy
  );
  const cyclic = makeSnapshot("2026-08-22T11:00:00.000Z");
  cyclic.values.self = cyclic.values;
  const withBigInt = {
    ...makeSnapshot("2026-08-22T12:00:00.000Z"),
    values: { crA: 1n }
  };
  const withMap = makeSnapshot("2026-08-22T13:00:00.000Z", {
    values: new Map([["crA", "map-value"]])
  });
  const withNonString = makeSnapshot("2026-08-22T14:00:00.000Z", {
    values: { crA: 42 }
  });
  assert.equal(
    context.__latestCompatibleSnapshot([
      cyclic,
      withBigInt,
      withMap,
      withNonString,
      newPreboot
    ]),
    newPreboot
  );
  return "newest valid snapshot wins; malformed records skipped";
});

await check("Recipe-library integrity", () => {
  const code = inlineScripts[0];
  const domMarker = "$('libraryCount').textContent=";
  const end = code.indexOf(domMarker);
  const helperStart = code.indexOf("function recipeText(");
  const helperEnd = code.indexOf("function inferFamily(");
  assert.ok(end > 0, "Recipe validation DOM marker missing");
  assert.ok(helperStart > 0 && helperEnd > helperStart, "Recipe helper markers missing");
  const sandbox = { window: {} };
  const probe =
    code.slice(0, end) +
    "\n" +
    code.slice(helperStart, helperEnd) +
    "\n;globalThis.__report = v73RecipeDiagnostics();";
  vm.runInNewContext(probe, sandbox, {
    filename: "index.html:recipe-data",
    timeout: 10000
  });
  const report = sandbox.__report;
  assert.ok(report.count > 0, "No recipes");
  assert.equal(report.count, report.indexCount);
  assert.equal(report.duplicates.length, 0);
  assert.equal(report.invalid.length, 0);
  return report.count + " unique valid recipes";
});

if (failures.length) {
  console.error("\nStatic PWA validation failed:");
  failures.forEach((failure) => console.error("  - " + failure));
  console.error("\n" + successes.length + " checks passed, " + failures.length + " failed.");
  process.exitCode = 1;
} else {
  successes.forEach((success) => console.log("✓ " + success));
  console.log("\n" + successes.length + " validation groups passed.");
}
