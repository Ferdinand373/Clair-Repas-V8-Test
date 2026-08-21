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
const testStorage = readUtf8("v8/clair-test-storage.js");
const personalSync = readUtf8("v8/clair-sync.js");
const foundation = readUtf8("v8/clair-foundation.js");
const cloudSync = readUtf8("v8/clair-cloud-sync.js");
const supabaseVendor = readUtf8("v8/vendor/supabase-js-2.111.0.js");
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
    "v8/clair-test-storage.js",
    "v8/clair-sync.js",
    "v8/clair-cloud-sync.js",
    "v8/vendor/supabase-js-2.111.0.js",
    "v8/vendor/supabase-js-2.111.0.LICENSE",
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
    "v8/clair-test-storage.js",
    "v8/clair-sync.js",
    "v8/clair-cloud-sync.js",
    "v8/vendor/supabase-js-2.111.0.js",
    "v8/vendor/supabase-js-2.111.0.LICENSE",
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
  new vm.Script(testStorage, { filename: "v8/clair-test-storage.js" });
  new vm.Script(personalSync, { filename: "v8/clair-sync.js" });
  new vm.Script(foundation, { filename: "v8/clair-foundation.js" });
  new vm.Script(cloudSync, { filename: "v8/clair-cloud-sync.js" });
  new vm.Script(supabaseVendor, {
    filename: "v8/vendor/supabase-js-2.111.0.js"
  });
  assert.ok(inlineScripts.length > 0, "No inline application script found");
  inlineScripts.forEach((source, index) => {
    new vm.Script(source, { filename: "index.html:inline-" + (index + 1) + ".js" });
  });
  return inlineScripts.length + 6 + " scripts";
});

await check("Release metadata consistency", () => {
  const appId = stringConstant(serviceWorker, "APP_ID");
  const release = stringConstant(serviceWorker, "RELEASE");
  const schema = numberConstant(serviceWorker, "DATA_SCHEMA");
  const syncRelease = personalSync.match(/clairRelease\s*\|\|\s*(["'])(.*?)\1/);
  const syncSchema = personalSync.match(/clairSchema\s*\|\|\s*(\d+)/);
  const foundationRelease = foundation.match(/clairRelease\s*\|\|\s*(["'])(.*?)\1/);
  const foundationSchema = foundation.match(/clairSchema\s*\|\|\s*(\d+)/);
  const cloudRelease = cloudSync.match(/clairRelease\s*\|\|\s*(["'])(.*?)\1/);
  const cloudSchema = cloudSync.match(/clairSchema\s*\|\|\s*(\d+)/);
  const productVersion = stringConstant(indexHtml, "CR_APP_VERSION");
  const productSchema = numberConstant(indexHtml, "CR_DATA_SCHEMA_VERSION");
  const markerVersion = refreshMarker.match(/Clair Repas V(\d+(?:\.\d+){1,2})/i);

  assert.ok(syncRelease, "Missing personal Sync release fallback");
  assert.ok(syncSchema, "Missing personal Sync schema fallback");
  assert.ok(foundationRelease, "Missing Foundation release fallback");
  assert.ok(foundationSchema, "Missing Foundation schema fallback");
  assert.ok(cloudRelease, "Missing Cloud Sync release fallback");
  assert.ok(cloudSchema, "Missing Cloud Sync schema fallback");
  assert.ok(markerVersion, "Missing product version in refresh.text");
  assert.equal(version.app, appId);
  assert.equal(version.foundationVersion, release);
  assert.equal(syncRelease[2], release);
  assert.equal(foundationRelease[2], release);
  assert.equal(cloudRelease[2], release);
  assert.equal(version.dataSchema, schema);
  assert.equal(Number(syncSchema[1]), schema);
  assert.equal(Number(foundationSchema[1]), schema);
  assert.equal(Number(cloudSchema[1]), schema);
  assert.equal(productSchema, schema);
  assert.equal(version.productVersion, productVersion);
  assert.equal(markerVersion[1], productVersion);
  assert.match(version.publishedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((serviceWorker.match(/data-clair-core="\$\{CORE_REVISION\}"/g) || []).length, 4);
  assert.equal(stringConstant(serviceWorker, "TEST_STORAGE_APP_ID"), "clair-repas-v8-test");
  assert.equal(stringConstant(testStorage, "TEST_APP_ID"), "clair-repas-v8-test");
  assert.equal(stringConstant(testStorage, "PROTOCOL"), "clair-test-storage/v1");
  assert.equal(stringConstant(testStorage, "NAMESPACE"), "clair.v8.test.personal");
  assert.equal(stringConstant(personalSync, "STORAGE_PROTOCOL"), "clair-test-storage/v1");
  assert.equal(stringConstant(personalSync, "STORAGE_APP_ID"), "clair-repas-v8-test");
  assert.equal(stringConstant(foundation, "STORAGE_PROTOCOL"), "clair-test-storage/v1");
  assert.equal(stringConstant(foundation, "STORAGE_APP_ID"), "clair-repas-v8-test");
  assert.match(personalSync, /protocol:\s*'clair-personal-sync\/v1'/);
  assert.match(cloudSync, /const CLOUD_PROTOCOL = 'clair-cloud-sync\/v1'/);
  assert.equal(stringConstant(cloudSync, "CLOUD_APP_ID"), "clair-repas-v8-test");
  assert.equal(stringConstant(cloudSync, "INTEGRATION"), "clair-v8-foundation.9");
  assert.equal(
    stringConstant(cloudSync, "SUPABASE_JS_PATH"),
    "./v8/vendor/supabase-js-2.111.0.js"
  );
  assert.match(stringConstant(cloudSync, "SUPABASE_PUBLISHABLE_KEY"), /^sb_publishable_/);
  assert.doesNotMatch(cloudSync, /service_role|sb_secret_/i);
  assert.match(supabaseVendor, /realtime-js\/2\.111\.0/);
  assert.equal(
    assetDigest("./v8/vendor/supabase-js-2.111.0.js"),
    "sha256:7396012594aa6d23bb373ebc25d1080bf3672fa847c3713f756520b40fd13453",
    "Vendored Supabase bundle must remain the exact pinned 2.111.0 artifact"
  );
  assert.match(foundation, /coreRevision:\s*CORE_REVISION/);
  assert.match(
    serviceWorker,
    /data\.release === RELEASE && data\.coreRevision === CORE_REVISION/
  );
  return release + " / product " + productVersion;
});

await check("Foundation.8 application shell identity", () => {
  const normalizedIndex = indexHtml.replace(/\r\n?/g, "\n");
  const storageBootstrap =
    /<script src="\.\/v8\/clair-test-storage\.js" data-clair-v8-test-storage data-clair-storage-app="clair-repas-v8-test"><\/script>\n/;
  assert.equal((indexHtml.match(/data-clair-v8-test-storage/g) || []).length, 1);
  assert.equal((indexHtml.match(/window\.ClairStorage/g) || []).length, 58);
  assert.doesNotMatch(indexHtml.replaceAll("window.ClairStorage", ""), /\blocalStorage\b/);
  assert.ok(
    indexHtml.indexOf("data-clair-v8-test-storage") <
      indexHtml.indexOf("<script>"),
    "The isolated storage bootstrap must run before application JavaScript"
  );
  const canonicalIndex = Buffer.from(
    normalizedIndex
      .replace(storageBootstrap, "")
      .replaceAll("window.ClairStorage", "localStorage"),
    "utf8"
  );
  assert.equal(
    gitBlobSha(canonicalIndex),
    FOUNDATION_8_INDEX_BLOB,
    "Only the isolated storage routing may differ from the Foundation.8 shell"
  );
  assert.doesNotMatch(indexHtml, /data-clair-v8-(?:sync|foundation|cloud-sync)/);
  return "functional shell " + FOUNDATION_8_INDEX_BLOB.slice(0, 12) + "; 58 isolated accesses";
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
    "./v8/clair-test-storage.js",
    "./v8/clair-sync.js",
    "./v8/vendor/supabase-js-2.111.0.js",
    "./v8/clair-foundation.js",
    "./v8/clair-cloud-sync.js",
    "./v8/version.json"
  ]) {
    assert.ok(coreFiles.includes(expected), "CORE_FILES omits " + expected);
  }
  assert.ok(
    coreFiles.indexOf("./v8/clair-test-storage.js") <
      coreFiles.indexOf("./v8/clair-sync.js"),
    "The isolated storage module must precede personal sync"
  );
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
    /const FOUNDATION_CORE_FILES\s*=\s*LOCAL_SYNC_CORE_FILES\.filter/,
    "Foundation.8 fallback must retain its historical core set"
  );
  assert.match(
    serviceWorker,
    /if \(rootProfile === "cloud"\) return CORE_FILES/,
    "Cloud fallbacks must retain the complete cloud runtime"
  );
  assert.match(
    serviceWorker,
    /if \(rootProfile === "local"\) return LOCAL_SYNC_CORE_FILES/,
    "Local-Sync fallbacks must retain clair-sync.js"
  );
  assert.match(
    serviceWorker,
    /if \(\/\\blocalStorage\\b\/\.test\(html\)\) return null/,
    "Shells with raw localStorage access must never be rollback targets"
  );
  assert.match(
    serviceWorker,
    /if \(!rootProfile \|\| rootProfile !== indexProfile\) return null/,
    "Root and index shells must share the same isolated runtime profile"
  );
  assert.match(
    serviceWorker,
    /const guarded = await hardenFallbackCache\(candidate\)/,
    "An unsafe historical cache must be copied into an isolated fallback"
  );
  assert.match(
    serviceWorker,
    /await buildCandidateCache\(\);\s*await migrateLegacyFallback\(\);/,
    "The isolated runtime must exist before fallback hardening"
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

  let cacheNames = ["unsafe-foundation"];
  let missingAsset = null;
  let mismatchedRoot = false;
  const bootstraps = {
    "unsafe-foundation":
      "<script data-clair-v8-foundation></script>",
    "unsafe-cloud":
      "<script data-clair-v8-sync></script>" +
      "<script data-clair-v8-foundation></script>" +
      "<script data-clair-v8-cloud-sync></script>",
    "isolated-foundation":
      "<script data-clair-v8-test-storage></script>" +
      "<script data-clair-v8-foundation></script>",
    "isolated-local":
      "<script data-clair-v8-test-storage></script>" +
      "<script data-clair-v8-sync></script>" +
      "<script data-clair-v8-foundation></script>",
    "isolated-cloud":
      "<script data-clair-v8-test-storage></script>" +
      "<script data-clair-v8-sync></script>" +
      "<script data-clair-v8-foundation></script>" +
      "<script data-clair-v8-cloud-sync></script>"
  };
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
              if (
                mismatchedRoot &&
                cacheName === "isolated-cloud" &&
                url.endsWith("/app/")
              ) {
                return new Response(
                  "<head><script data-clair-v8-foundation></script>" +
                    "<script>localStorage.getItem('crUnsafe')</script></head>"
                );
              }
              const bootstrap = bootstraps[cacheName] || bootstraps["isolated-cloud"];
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
  cacheNames = [
    cacheContext.__currentCache,
    "unsafe-foundation",
    "unsafe-cloud",
    "isolated-foundation",
    "isolated-local",
    "isolated-cloud"
  ];
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), true);
  assert.equal(await cacheContext.__cacheHasCore("unsafe-foundation"), false);
  assert.equal(await cacheContext.__cacheHasCore("unsafe-cloud"), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-foundation"), true);
  assert.equal(await cacheContext.__cacheHasCore("isolated-local"), true);
  assert.equal(await cacheContext.__cacheHasCore("isolated-cloud"), true);
  mismatchedRoot = true;
  assert.equal(
    await cacheContext.__cacheHasCore("isolated-cloud"),
    false,
    "A raw root shell must invalidate an otherwise isolated index shell"
  );
  mismatchedRoot = false;
  missingAsset = "clair-test-storage.js";
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-foundation"), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-local"), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-cloud"), false);
  missingAsset = "clair-cloud-sync.js";
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-foundation"), true);
  assert.equal(await cacheContext.__cacheHasCore("isolated-local"), true);
  assert.equal(await cacheContext.__cacheHasCore("isolated-cloud"), false);
  missingAsset = "supabase-js-2.111.0.js";
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-foundation"), true);
  assert.equal(await cacheContext.__cacheHasCore("isolated-local"), true);
  assert.equal(await cacheContext.__cacheHasCore("isolated-cloud"), false);
  missingAsset = "clair-sync.js";
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), false);
  assert.equal(
    await cacheContext.__cacheHasCore("isolated-foundation"),
    true,
    "An isolation-aware Foundation fallback remains valid without clair-sync.js"
  );
  assert.equal(
    await cacheContext.__cacheHasCore("isolated-local"),
    false,
    "Post-Sync fallback must require clair-sync.js"
  );
  assert.equal(await cacheContext.__cacheHasCore("isolated-cloud"), false);
  missingAsset = "manifest.webmanifest";
  assert.equal(await cacheContext.__cacheHasCore(cacheContext.__currentCache), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-foundation"), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-local"), false);
  assert.equal(await cacheContext.__cacheHasCore("isolated-cloud"), false);
  missingAsset = null;

  const manifestResponse = new Response(readFileSync(rooted("manifest.webmanifest")));
  await cacheContext.__validateCoreDigest("./manifest.webmanifest", manifestResponse);
  await cacheContext.__validateCoreDigest(
    "./v8/clair-test-storage.js",
    new Response(readFileSync(rooted("v8/clair-test-storage.js")))
  );
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
    "function storageTag() {",
    "\nasync function validateVersionManifest"
  );
  const injectionContext = {
    APP_ID: stringConstant(serviceWorker, "APP_ID"),
    TEST_STORAGE_APP_ID: stringConstant(serviceWorker, "TEST_STORAGE_APP_ID"),
    RELEASE: stringConstant(serviceWorker, "RELEASE"),
    DATA_SCHEMA: numberConstant(serviceWorker, "DATA_SCHEMA"),
    CORE_REVISION: stringConstant(serviceWorker, "CORE_REVISION"),
    Headers,
    Response
  };
  vm.runInNewContext(
    injectionSource +
      "\n;globalThis.__injectRuntime = injectRuntime;" +
      "\n;globalThis.__isolationFallbackHtml = isolationFallbackHtml;",
    injectionContext,
    { filename: "sw.js:runtime-injection-smoke", timeout: 1000 }
  );
  const injectedResponse = await injectionContext.__injectRuntime(
    new Response("<!doctype html><html><head><title>App</title></head><body></body></html>")
  );
  const injectedHtml = await injectedResponse.text();
  const storagePosition = injectedHtml.indexOf("data-clair-v8-test-storage");
  const syncPosition = injectedHtml.indexOf("data-clair-v8-sync");
  const foundationPosition = injectedHtml.indexOf("data-clair-v8-foundation");
  const cloudPosition = injectedHtml.indexOf("data-clair-v8-cloud-sync");
  assert.ok(
    storagePosition >= 0 &&
      syncPosition > storagePosition &&
      foundationPosition > syncPosition &&
      cloudPosition > foundationPosition
  );
  assert.equal((injectedHtml.match(/data-clair-v8-test-storage/g) || []).length, 1);
  assert.equal((injectedHtml.match(/data-clair-v8-sync/g) || []).length, 1);
  assert.equal((injectedHtml.match(/data-clair-v8-foundation/g) || []).length, 1);
  assert.equal((injectedHtml.match(/data-clair-v8-cloud-sync/g) || []).length, 1);
  assert.equal((injectedHtml.match(/data-clair-app="clair-repas"/g) || []).length, 4);
  assert.equal(
    (injectedHtml.match(/data-clair-storage-app="clair-repas-v8-test"/g) || []).length,
    1
  );
  const routedLegacyResponse = await injectionContext.__injectRuntime(
    new Response(
      "<head></head><body><script>localStorage.getItem('crLegacy')</script></body>"
    )
  );
  const routedLegacyHtml = await routedLegacyResponse.text();
  assert.doesNotMatch(routedLegacyHtml, /\blocalStorage\b/);
  assert.match(routedLegacyHtml, /window\.ClairStorage\.getItem\('crLegacy'/);
  const upgradedResponse = await injectionContext.__injectRuntime(
    new Response(
      '<head><script src="./v8/clair-test-storage.js" ' +
        'data-clair-v8-test-storage data-clair-storage-app="clair-repas-v8-test"></script>' +
        '<title>App</title></head>'
    )
  );
  const upgradedHtml = await upgradedResponse.text();
  const upgradedPositions = [
    upgradedHtml.indexOf("data-clair-v8-test-storage"),
    upgradedHtml.indexOf("data-clair-v8-sync"),
    upgradedHtml.indexOf("data-clair-v8-foundation"),
    upgradedHtml.indexOf("data-clair-v8-cloud-sync")
  ];
  assert.ok(upgradedPositions.every((position) => position >= 0));
  assert.ok(upgradedPositions.every((position, index) => index === 0 || position > upgradedPositions[index - 1]));
  assert.equal((upgradedHtml.match(/data-clair-v8-test-storage/g) || []).length, 1);
  await assert.rejects(
    () =>
      injectionContext.__injectRuntime(
        new Response("<head><script data-clair-v8-foundation></script></head>")
      ),
    /incomplete runtime bootstrap/
  );
  await assert.rejects(
    () =>
      injectionContext.__injectRuntime(
        new Response(
          "<head><script data-clair-v8-cloud-sync></script>" +
            "<script data-clair-v8-foundation></script>" +
            "<script data-clair-v8-sync></script>" +
            "<script data-clair-v8-test-storage></script></head>"
        )
      ),
    /runtime bootstrap order/
  );
  const guardedFallbackHtml = injectionContext.__isolationFallbackHtml(
    "<html><head><script data-clair-v8-foundation></script></head>" +
      "<body><script>localStorage.setItem('crFavMeals','fallback');</script></body></html>"
  );
  const guardedPositions = [
    guardedFallbackHtml.indexOf("data-clair-v8-test-storage"),
    guardedFallbackHtml.indexOf("data-clair-v8-sync"),
    guardedFallbackHtml.indexOf("data-clair-v8-foundation")
  ];
  assert.ok(guardedPositions.every((position) => position >= 0));
  assert.ok(guardedPositions.every((position, index) => index === 0 || position > guardedPositions[index - 1]));
  assert.doesNotMatch(guardedFallbackHtml, /data-clair-v8-cloud-sync/);
  assert.doesNotMatch(guardedFallbackHtml, /\blocalStorage\b/);
  assert.match(guardedFallbackHtml, /window\.ClairStorage\.setItem\('crFavMeals'/);

  const rollbackSource = between(
    serviceWorker,
    "async function rollbackIfNeeded(state, reason = \"boot-failed\") {",
    "\nasync function currentServingState"
  );
  const rollbackContext = {
    CURRENT_CACHE: "candidate",
    cacheHasCore: async (cacheName) => cacheName === "isolated-fallback",
    choosePreviousCache: async () => "isolated-fallback",
    writeState: async (state) => state,
    Date
  };
  vm.runInNewContext(
    rollbackSource + "\n;globalThis.__rollbackIfNeeded = rollbackIfNeeded;",
    rollbackContext,
    { filename: "sw.js:isolated-rollback-smoke", timeout: 1000 }
  );
  const rolledBack = await rollbackContext.__rollbackIfNeeded(
    {
      activeCache: "candidate",
      previousCache: "unsafe-pre-isolation",
      lastHealthyCache: "isolated-fallback",
      probation: true
    },
    "test-rollback"
  );
  assert.equal(rolledBack.activeCache, "isolated-fallback");
  assert.equal(rolledBack.previousCache, "isolated-fallback");
  assert.equal(rolledBack.probation, false);

  const migrationSource = between(
    serviceWorker,
    "async function migrateLegacyFallback() {",
    "\nfunction storageTag()"
  );
  let migrationWrites = 0;
  const migrationContext = {
    CURRENT_CACHE: "candidate",
    LEGACY_APP_PREFIX: "legacy-",
    readState: async () => ({
      activeCache: "unsafe-known",
      lastHealthyCache: "unsafe-known",
      probation: false
    }),
    readLegacyState: async () => ({}),
    caches: { keys: async () => ["unsafe-known"] },
    isAppCache: (cacheName) => cacheName === "unsafe-known",
    cacheHasCore: async () => false,
    hardenFallbackCache: async () => {
      throw new Error("quota-during-fallback-hardening");
    },
    writeState: async (state) => {
      migrationWrites += 1;
      return state;
    },
    Date
  };
  vm.runInNewContext(
    migrationSource + "\n;globalThis.__migrateLegacyFallback = migrateLegacyFallback;",
    migrationContext,
    { filename: "sw.js:fallback-migration-failure-smoke", timeout: 1000 }
  );
  await assert.rejects(
    () => migrationContext.__migrateLegacyFallback(),
    /known fallback could not be isolated.*quota-during-fallback-hardening/
  );
  assert.equal(migrationWrites, 0);

  const serveSource = between(
    serviceWorker,
    "async function serveFromCache(cacheName, request) {",
    "\nfunction isMainNavigation"
  );
  const offlineContext = {
    cacheHasCore: async (cacheName) => cacheName === "isolated-fallback",
    appIndexUrl: () => "https://example.test/app/index.html",
    appRootUrl: () => "https://example.test/app/",
    caches: {
      async open() {
        return {
          async match(request) {
            if (String(request) === "https://example.test/app/index.html") {
              return new Response(guardedFallbackHtml);
            }
            return null;
          }
        };
      }
    }
  };
  vm.runInNewContext(
    serveSource + "\n;globalThis.__serveFromCache = serveFromCache;",
    offlineContext,
    { filename: "sw.js:offline-fallback-smoke", timeout: 1000 }
  );
  const offlineResponse = await offlineContext.__serveFromCache(
    "isolated-fallback",
    { mode: "navigate", toString: () => "https://example.test/app/offline" }
  );
  assert.match(await offlineResponse.text(), /data-clair-v8-test-storage/);
  assert.equal(
    await offlineContext.__serveFromCache(
      "unsafe-pre-isolation",
      { mode: "navigate", toString: () => "https://example.test/app/" }
    ),
    null
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
  assert.match(mainNavigationSource, /network\.ok \? injectRuntime\(network\) : network/);
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

  return "4 handlers; isolated fallback, digest, watchdog and quarantine paths";
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
  assert.doesNotMatch(personalSync, /\blocalStorage\b/);
  assert.equal((testStorage.match(/window\.localStorage/g) || []).length, 1);
  assert.doesNotMatch(testStorage, /sessionStorage|Storage\.prototype/);
  assert.doesNotMatch(testStorage, /nativeStorage\.(?:length|key)\b/);
  assert.match(testStorage, /const MANIFEST_KEY = `\$\{NAMESPACE\}\.keys\.v1`/);
  assert.match(testStorage, /const PERSONAL_KEY = \/\^cr\[A-Za-z0-9_\.\-\]\+\$\//);
  assert.match(testStorage, /const NAMESPACE = 'clair\.v8\.test\.personal'/);
  assert.match(cloudSync, /sync\.capture\(\)/);
  assert.match(cloudSync, /sync\.restore\(target\)/);
  assert.match(cloudSync, /sync\.valid\(\{ \[key\]: '' \}\)/);
  assert.match(cloudSync, /const storage = options\.storage \|\| localStorage/);
  assert.match(cloudSync, /const personalStorage = options\.personalStorage \|\| hostWindow\.ClairStorage/);
  assert.doesNotMatch(cloudSync, /personalKeyPolicies|function readPersonalData/);
  assert.doesNotMatch(cloudSync, /app_id:\s*['"]clair-repas['"]/);
  assert.match(foundation, /const personalSync = resolvePersonalSync\(\)/);
  assert.match(foundation, /fnv1a\(STORAGE_PROTOCOL\)/);
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

  const testAppId = "clair-repas-v8-test";
  const storageProtocol = "clair-test-storage/v1";
  const personalPrefix = "clair.v8.test.personal.";
  const rawPersonalKey = /^cr[A-Za-z0-9_.-]+$/;

  function makeNativeStorage(entries, quotaLimit = Number.POSITIVE_INFINITY) {
    const values = new Map(entries);
    const trace = {
      rawReads: [],
      rawWrites: [],
      rawRemoves: [],
      nativeLengthReads: 0,
      nativeKeyReads: 0,
      clearCalls: 0
    };
    const faults = {
      operation: 0,
      failAt: Number.POSITIVE_INFINITY,
      readFailuresRemaining: 0
    };
    const storage = {
      get length() {
        trace.nativeLengthReads += 1;
        return values.size;
      },
      key(index) {
        trace.nativeKeyReads += 1;
        return [...values.keys()][index] ?? null;
      },
      getItem(key) {
        key = String(key);
        if (rawPersonalKey.test(key)) trace.rawReads.push(key);
        if (key.startsWith(personalPrefix) && faults.readFailuresRemaining > 0) {
          faults.readFailuresRemaining -= 1;
          throw new Error("injected read failure");
        }
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        key = String(key);
        value = String(value);
        if (rawPersonalKey.test(key)) trace.rawWrites.push(key);
        if (key.startsWith(personalPrefix)) {
          faults.operation += 1;
          if (faults.operation === faults.failAt) {
            throw new Error("injected write failure");
          }
        }
        const next = new Map(values);
        next.set(key, value);
        const personalSize = [...next]
          .filter(([candidate]) => candidate.startsWith(personalPrefix))
          .reduce((sum, [, candidate]) => sum + candidate.length, 0);
        if (personalSize > quotaLimit) throw new Error("quota exceeded");
        values.set(key, value);
      },
      removeItem(key) {
        key = String(key);
        if (rawPersonalKey.test(key)) trace.rawRemoves.push(key);
        if (key.startsWith(personalPrefix)) {
          faults.operation += 1;
          if (faults.operation === faults.failAt) {
            throw new Error("injected remove failure");
          }
        }
        values.delete(key);
      },
      clear() {
        trace.clearCalls += 1;
        values.clear();
      }
    };
    return { storage, values, trace, faults };
  }

  const native = makeNativeStorage([
    ["crA", "PRODUCTION-A"],
    ["crFavMeals", '["production-favorite"]'],
    ["crProdOnly", "PRODUCTION-ONLY"],
    [personalPrefix + "crA", "test-a"],
    [personalPrefix + "crB", "test-b"],
    [personalPrefix + "keys.v1", '["crA","crB"]'],
    ["clair.device.key.v1", "shared-device"],
    ["sb-project-auth-token", "shared-auth-session"],
    ["clair.v8.sync.meta.clair-repas-v8-test", "technical-meta"],
    ["unrelated", "keep"]
  ]);
  const storageDocument = {
    currentScript: { dataset: { clairStorageApp: testAppId } }
  };
  const storageContext = {
    window: { localStorage: native.storage },
    document: storageDocument
  };
  vm.runInNewContext(testStorage, storageContext, {
    filename: "v8/clair-test-storage.js:isolation-smoke",
    timeout: 1000
  });
  const storageApi = storageContext.window.ClairStorage;
  assert.ok(storageApi?.ready, "ClairStorage API was not published");
  assert.equal(storageApi.protocol, storageProtocol);
  assert.equal(storageApi.appId, testAppId);
  assert.equal(storageApi.namespace, "clair.v8.test.personal");
  for (const key of ["crA", "cr0", "cr_a", "cr.a", "cr-a", "crHealthProbeV73"]) {
    assert.equal(storageApi.isPersonalKey(key), true, key);
  }
  for (const key of ["cr", "CrA", "cr/a", "cr:a", "cr a", "cré", "clair.device.key.v1"]) {
    assert.equal(storageApi.isPersonalKey(key), false, key);
  }
  assert.equal(storageApi.logicalKey("crA"), null);
  assert.equal(storageApi.logicalKey(personalPrefix + "crA"), "crA");
  assert.equal(storageApi.getItem("crA"), "test-a");
  assert.equal(storageApi.getItem("crProdOnly"), null);
  assert.equal(storageApi.getItem("clair.device.key.v1"), "shared-device");
  assert.equal(storageApi.getItem("sb-project-auth-token"), "shared-auth-session");
  storageApi.setItem("crFavMeals", '["test-favorite"]');
  assert.equal(
    native.values.get(personalPrefix + "crFavMeals"),
    '["test-favorite"]'
  );
  assert.equal(native.values.get("crFavMeals"), '["production-favorite"]');
  assert.equal(storageApi.getItem("crFavMeals"), '["test-favorite"]');
  const visible = Array.from({ length: storageApi.length }, (_, index) => storageApi.key(index));
  assert.ok(visible.includes("crA") && visible.includes("crB") && visible.includes("crFavMeals"));
  assert.ok(!visible.includes("crProdOnly") && !visible.includes(personalPrefix + "crA"));
  storageApi.setItem("technical-probe", "native");
  assert.equal(native.values.get("technical-probe"), "native");
  storageApi.removeItem("technical-probe");
  assert.equal(native.values.has("technical-probe"), false);

  const context = {
    window: { ClairStorage: storageApi },
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
    URL
  };
  vm.runInNewContext(
    personalSync,
    context,
    { filename: "v8/clair-sync.js:storage-smoke", timeout: 1000 }
  );
  const syncApi = context.window.ClairSync;
  assert.ok(syncApi, "ClairSync API was not published");
  assert.equal(syncApi.protocol, "clair-personal-sync/v1");
  assert.equal(syncApi.storageProtocol, storageProtocol);
  assert.equal(syncApi.storageAppId, testAppId);
  assert.deepEqual(Object.fromEntries(Object.entries(syncApi.capture().values)), {
    crA: "test-a",
    crB: "test-b",
    crFavMeals: '["test-favorite"]'
  });
  assert.deepEqual(native.trace.rawReads, []);

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
    STORAGE_PROTOCOL: syncApi.storageProtocol,
    STORAGE_APP_ID: syncApi.storageAppId,
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

  native.faults.operation = 0;
  native.faults.failAt = 2;
  assert.equal(syncApi.restore({ crA: "new-a", crC: "new-c" }), false);
  assert.deepEqual(Object.fromEntries(Object.entries(syncApi.capture().values)), {
    crA: "test-a",
    crB: "test-b",
    crFavMeals: '["test-favorite"]'
  });

  native.faults.operation = 0;
  native.faults.failAt = Number.POSITIVE_INFINITY;
  assert.equal(syncApi.restore({ crA: "new-a", crC: "new-c" }), true);
  assert.deepEqual(Object.fromEntries(Object.entries(syncApi.capture().values)), {
    crA: "new-a",
    crC: "new-c"
  });
  const beforeRejectedRestore = { ...syncApi.capture().values };
  assert.equal(syncApi.restore(new Map([["crA", "map-value"]])), false);
  assert.equal(syncApi.restore({ crA: 42 }), false);
  assert.deepEqual(Object.fromEntries(Object.entries(syncApi.capture().values)), beforeRejectedRestore);

  native.faults.readFailuresRemaining = 1;
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

  storageApi.setItem("crClear", "test-only");
  storageApi.clear();
  assert.ok([...native.values.keys()].every((key) => !key.startsWith(personalPrefix)));
  assert.equal(native.values.get("crA"), "PRODUCTION-A");
  assert.equal(native.values.get("crFavMeals"), '["production-favorite"]');
  assert.equal(native.values.get("crProdOnly"), "PRODUCTION-ONLY");
  assert.equal(native.values.get("clair.device.key.v1"), "shared-device");
  assert.equal(native.values.get("sb-project-auth-token"), "shared-auth-session");
  assert.equal(native.values.get("unrelated"), "keep");
  assert.equal(native.trace.clearCalls, 0);
  assert.equal(native.trace.nativeLengthReads, 0);
  assert.equal(native.trace.nativeKeyReads, 0);
  assert.deepEqual(native.trace.rawReads, []);
  assert.deepEqual(native.trace.rawWrites, []);
  assert.deepEqual(native.trace.rawRemoves, []);
  native.values.set(personalPrefix + "keys.v1", "not-json");
  assert.throws(() => storageApi.length, /clair-test-storage-manifest-invalid/);
  native.values.delete(personalPrefix + "keys.v1");

  const quotaNative = makeNativeStorage([
    ["crA", "PRODUCTION-QUOTA-SENTINEL"],
    [personalPrefix + "crA", "a".repeat(4000)],
    [personalPrefix + "crB", "b".repeat(1000)],
    [personalPrefix + "keys.v1", '["crA","crB"]']
  ]);
  const quotaLimited = makeNativeStorage(quotaNative.values, 6050);
  const quotaDocument = {
    currentScript: { dataset: { clairStorageApp: testAppId } }
  };
  const quotaContext = {
    window: { localStorage: quotaLimited.storage },
    document: quotaDocument,
    location: context.location,
    URL
  };
  vm.runInNewContext(testStorage, quotaContext, {
    filename: "v8/clair-test-storage.js:quota-smoke",
    timeout: 1000
  });
  quotaDocument.currentScript = context.document.currentScript;
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
  assert.deepEqual(Object.fromEntries(Object.entries(quotaContext.window.ClairSync.capture().values)), {
    crA: "a".repeat(4000),
    crB: "b".repeat(1000)
  });
  assert.equal(quotaLimited.values.get("crA"), "PRODUCTION-QUOTA-SENTINEL");
  assert.deepEqual(quotaLimited.trace.rawReads, []);
  assert.deepEqual(quotaLimited.trace.rawWrites, []);
  assert.deepEqual(quotaLimited.trace.rawRemoves, []);
  assert.equal(quotaLimited.trace.nativeLengthReads, 0);
  assert.equal(quotaLimited.trace.nativeKeyReads, 0);

  const rejectedContext = {
    window: { localStorage: native.storage },
    document: { currentScript: { dataset: { clairStorageApp: "clair-repas" } } }
  };
  assert.throws(
    () => vm.runInNewContext(testStorage, rejectedContext),
    /clair-test-storage-app-mismatch/
  );
  assert.equal(rejectedContext.window.ClairStorage, undefined);

  return "raw production cr values untouched; test namespace and rollback verified";
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
    STORAGE_PROTOCOL: "clair-test-storage/v1",
    STORAGE_APP_ID: "clair-repas-v8-test",
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
      storageProtocol: "clair-test-storage/v1",
      storageAppId: "clair-repas-v8-test",
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
  const preIsolation = makeSnapshot("2026-08-23T10:00:00.000Z");
  delete preIsolation.storageProtocol;
  delete preIsolation.storageAppId;
  assert.equal(
    context.__latestCompatibleSnapshot([
      oldHealthy,
      incompatible,
      preIsolation,
      newPreboot
    ]),
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
  return "newest isolated snapshot wins; legacy and malformed records skipped";
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
