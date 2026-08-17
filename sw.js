"use strict";

/*
 * Clair V8 Fondation — FOUNDATION.7 TEST DE ROLLBACK AUTOMATIQUE
 *
 * But de ce fichier :
 * 1) installer une candidate foundation.7 complète ;
 * 2) conserver foundation.5 comme version saine précédente ;
 * 3) simuler automatiquement un échec de démarrage ;
 * 4) vérifier que le système revient seul sur foundation.5 ;
 * 5) ne lire, modifier ou supprimer aucune donnée personnelle.
 *
 * IMPORTANT : ce fichier est destiné uniquement au dépôt Clair-Repas-V8-Test.
 */

const APP_ID = "clair-repas";
const RELEASE = "8.0.0-foundation.7";
const DATA_SCHEMA = 2;

const CACHE_PREFIX = "clair-repas-";
const CURRENT_CACHE = `${CACHE_PREFIX}app-${RELEASE}`;
const META_CACHE = `${CACHE_PREFIX}v8-meta`;
const META_URL = new URL("./__clair_v8_meta__", self.registration.scope).toString();
const STATUS_URL = new URL("./__clair_v8_status__", self.registration.scope).toString();

const CORE_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./v8/clair-foundation.js",
  "./v8/version.json"
];

const BOOT_GRACE_MS = 18000;

// Test volontaire : foundation.7 doit échouer puis revenir automatiquement sur foundation.5.
const ROLLBACK_SELF_TEST = true;
const ROLLBACK_REASON = "rollback-self-test";

function appIndexUrl() {
  return new URL("./index.html", self.registration.scope).toString();
}

function appRootUrl() {
  return new URL("./", self.registration.scope).toString();
}

function isMetaCache(name) {
  return name === META_CACHE;
}

function isAppCache(name) {
  return name.startsWith(CACHE_PREFIX) && !isMetaCache(name);
}

async function readState() {
  try {
    const cache = await caches.open(META_CACHE);
    const response = await cache.match(META_URL);
    if (!response) return {};
    const state = await response.json();
    return state && typeof state === "object" ? state : {};
  } catch (_) {
    return {};
  }
}

async function writeState(state) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  const cache = await caches.open(META_CACHE);
  await cache.put(
    META_URL,
    new Response(JSON.stringify(next), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    })
  );
  return next;
}

function foundationTag() {
  return `<script src="./v8/clair-foundation.js" data-clair-v8-foundation data-clair-app="${APP_ID}" data-clair-release="${RELEASE}" data-clair-schema="${DATA_SCHEMA}"></script>`;
}

function rollbackSelfTestTag() {
  // Foundation.7 : le test est déclenché directement pendant l'activation
  // du service worker afin d'éviter tout problème de timing avec la page.
  return "";
}

function responseInit(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  return {
    status: response.status,
    statusText: response.statusText,
    headers
  };
}

async function injectFoundation(response) {
  const text = await response.text();
  const tags = `${foundationTag()}\n${rollbackSelfTestTag()}`;

  if (text.includes("data-clair-v8-foundation")) {
    if (!ROLLBACK_SELF_TEST || text.includes("data-clair-v8-rollback-self-test")) {
      return new Response(text, responseInit(response));
    }
    const htmlWithTest = /<\/head>/i.test(text)
      ? text.replace(/<\/head>/i, `${rollbackSelfTestTag()}\n</head>`)
      : `${rollbackSelfTestTag()}\n${text}`;
    return new Response(htmlWithTest, responseInit(response));
  }

  const html = /<head(?:\s[^>]*)?>/i.test(text)
    ? text.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n${tags}`)
    : `${tags}\n${text}`;

  return new Response(html, responseInit(response));
}

async function fetchRequired(path) {
  const url = new URL(path, self.registration.scope).toString();
  const response = await fetch(
    new Request(url, {
      cache: "no-store",
      credentials: "same-origin"
    })
  );

  if (!response.ok) {
    throw new Error(`V8 install: ${path} -> HTTP ${response.status}`);
  }

  if (path === "./" || path === "./index.html") {
    return injectFoundation(response);
  }

  return response;
}

async function buildCandidateCache() {
  await caches.delete(CURRENT_CACHE);
  const cache = await caches.open(CURRENT_CACHE);

  try {
    for (const path of CORE_FILES) {
      const response = await fetchRequired(path);
      const url = new URL(path, self.registration.scope).toString();
      await cache.put(url, response.clone());
    }
  } catch (error) {
    await caches.delete(CURRENT_CACHE);
    throw error;
  }
}

async function cacheExists(cacheName) {
  if (!cacheName) return false;
  const names = await caches.keys();
  return names.includes(cacheName);
}

async function cacheHasIndex(cacheName) {
  if (!cacheName) return false;

  try {
    if (!(await cacheExists(cacheName))) return false;
    const cache = await caches.open(cacheName);
    return Boolean(
      (await cache.match(appIndexUrl())) ||
      (await cache.match(appRootUrl()))
    );
  } catch (_) {
    return false;
  }
}

async function choosePreviousCache(state = {}) {
  const names = await caches.keys();
  const available = names.filter(
    name => isAppCache(name) && name !== CURRENT_CACHE
  );

  const preferredOrder = [
    state.lastHealthyCache,
    state.previousCache,
    state.probation ? null : state.activeCache
  ];

  for (const preferred of preferredOrder) {
    if (!preferred || preferred === CURRENT_CACHE) continue;
    if (!available.includes(preferred)) continue;
    if (await cacheHasIndex(preferred)) return preferred;
  }

  for (const candidate of available) {
    if (await cacheHasIndex(candidate)) return candidate;
  }

  return null;
}

async function markCandidateActive() {
  const previousState = await readState();
  const previousCache = await choosePreviousCache(previousState);

  if (!(await cacheHasIndex(CURRENT_CACHE))) {
    throw new Error("V8 activate: candidate cache invalid");
  }

  return writeState({
    app: APP_ID,
    release: RELEASE,
    dataSchema: DATA_SCHEMA,
    activeCache: CURRENT_CACHE,
    previousCache,
    lastHealthyCache: previousState.lastHealthyCache || previousCache || null,
    failedCache: null,
    probation: true,
    bootFailures: 0,
    bootStartedAt: 0,
    activatedAt: new Date().toISOString()
  });
}

async function rollbackIfNeeded(state, reason = "boot-failed") {
  let fallback = state?.previousCache || null;

  if (!fallback || !(await cacheHasIndex(fallback))) {
    fallback = await choosePreviousCache(state || {});
  }

  if (!fallback || !(await cacheHasIndex(fallback))) {
    return state;
  }

  return writeState({
    ...state,
    activeCache: fallback,
    previousCache: fallback,
    failedCache: CURRENT_CACHE,
    probation: false,
    rollbackReason: reason,
    rolledBackAt: new Date().toISOString()
  });
}

async function currentServingState() {
  let state = await readState();

  if (!state.activeCache || !(await cacheHasIndex(state.activeCache))) {
    state = await rollbackIfNeeded(state, "invalid-active-cache");
  }

  if (
    state.probation &&
    state.bootStartedAt &&
    Date.now() - Number(state.bootStartedAt) > BOOT_GRACE_MS
  ) {
    state = await rollbackIfNeeded(state, "boot-watchdog-timeout");
  }

  return state;
}

async function serveFromCache(cacheName, request) {
  if (!cacheName || !(await cacheExists(cacheName))) return null;

  const cache = await caches.open(cacheName);
  let response = await cache.match(request, { ignoreSearch: true });

  if (!response && request.mode === "navigate") {
    response =
      (await cache.match(appIndexUrl())) ||
      (await cache.match(appRootUrl()));
  }

  return response || null;
}

function isMainNavigation(url, request) {
  if (request.mode !== "navigate") return false;
  const scope = new URL(self.registration.scope);
  const base = scope.pathname.endsWith("/")
    ? scope.pathname
    : `${scope.pathname}/`;
  return url.pathname === base || url.pathname === `${base}index.html`;
}

async function cleanupCaches(state) {
  const keep = new Set(
    [
      META_CACHE,
      CURRENT_CACHE,
      state?.activeCache,
      state?.previousCache,
      state?.lastHealthyCache
    ].filter(Boolean)
  );

  const names = await caches.keys();
  await Promise.all(
    names
      .filter(name => isAppCache(name) && !keep.has(name))
      .map(name => caches.delete(name))
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function statusResponse() {
  const state = await readState();
  const cacheNames = await caches.keys();
  const activeHealthy = Boolean(
    state.activeCache &&
    state.activeCache !== CURRENT_CACHE &&
    (await cacheHasIndex(state.activeCache))
  );
  const rollbackPassed = Boolean(
    activeHealthy &&
    state.failedCache === CURRENT_CACHE &&
    state.rollbackReason === ROLLBACK_REASON &&
    state.probation === false
  );

  const title = rollbackPassed
    ? "TEST RÉUSSI — retour automatique validé"
    : "TEST EN COURS OU À VÉRIFIER";

  const details = {
    testRelease: RELEASE,
    result: rollbackPassed ? "PASS" : "PENDING",
    activeCache: state.activeCache || null,
    previousCache: state.previousCache || null,
    lastHealthyCache: state.lastHealthyCache || null,
    failedCache: state.failedCache || null,
    rollbackReason: state.rollbackReason || null,
    probation: state.probation,
    bootFailures: state.bootFailures,
    caches: cacheNames
  };

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clair V8 — statut rollback</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 32px; background: #f5f7f9; color: #173042; }
  .card { max-width: 760px; margin: 40px auto; background: white; border-radius: 18px; padding: 28px; box-shadow: 0 10px 35px rgba(0,0,0,.08); }
  h1 { font-size: 24px; margin: 0 0 18px; }
  .ok { font-weight: 700; font-size: 18px; }
  pre { white-space: pre-wrap; background: #eef3f6; padding: 18px; border-radius: 12px; overflow-wrap: anywhere; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p class="ok">${rollbackPassed ? "Foundation.7 a échoué volontairement et Clair Repas est revenu sur la dernière version saine." : "Le test n’a pas encore confirmé le retour automatique."}</p>
    <pre>${escapeHtml(JSON.stringify(details, null, 2))}</pre>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      await buildCandidateCache();
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      let state = await markCandidateActive();

      if (ROLLBACK_SELF_TEST) {
        state = await rollbackIfNeeded(state, ROLLBACK_REASON);
      }

      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", event => {
  const data = event.data || {};

  if (data.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (data.app && data.app !== APP_ID) return;

  if (data.type === "CLAIR_V8_BOOT_START" && data.release === RELEASE) {
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (state.activeCache !== CURRENT_CACHE) return;
        await writeState({
          ...state,
          probation: true,
          bootStartedAt: Date.now(),
          prebootFingerprint: data.fingerprint || null
        });
      })()
    );
    return;
  }

  if (data.type === "CLAIR_V8_BOOT_OK" && data.release === RELEASE) {
    event.waitUntil(
      (async () => {
        const state = await readState();
        if (state.activeCache !== CURRENT_CACHE) return;

        const healthy = await writeState({
          ...state,
          probation: false,
          bootFailures: 0,
          bootStartedAt: 0,
          lastHealthyCache: CURRENT_CACHE,
          healthyFingerprint: data.fingerprint || null,
          validatedAt: new Date().toISOString()
        });

        await cleanupCaches(healthy);
      })()
    );
    return;
  }

  if (data.type === "CLAIR_V8_BOOT_FAIL" && data.release === RELEASE) {
    event.waitUntil(
      (async () => {
        const state = await readState();

        const failed = await writeState({
          ...state,
          bootFailures: Number(state.bootFailures || 0) + 1,
          lastBootError: {
            reason: data.reason || "runtime-error",
            detail: data.detail || "",
            at: new Date().toISOString()
          }
        });

        const rolled = await rollbackIfNeeded(
          failed,
          data.reason || "runtime-error"
        );

        try {
          const client = event.source?.id
            ? await self.clients.get(event.source.id)
            : null;

          if (
            client &&
            "navigate" in client &&
            rolled.activeCache !== CURRENT_CACHE
          ) {
            await client.navigate(client.url);
          }
        } catch (_) {}
      })()
    );
    return;
  }

  if (data.type === "CLAIR_V8_FORCE_ROLLBACK") {
    event.waitUntil(
      (async () => {
        const state = await readState();
        await rollbackIfNeeded(state, "manual-rollback");
      })()
    );
  }
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.toString() === STATUS_URL) {
    event.respondWith(statusResponse());
    return;
  }

  if (isMainNavigation(url, request)) {
    event.respondWith(
      (async () => {
        const state = await currentServingState();

        const cached = await serveFromCache(state.activeCache, request);
        if (cached) return cached;

        const previous = await serveFromCache(state.previousCache, request);
        if (previous) return previous;

        return fetch(request, { cache: "no-store" });
      })()
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request, { cache: "no-store" });
        } catch (_) {
          const state = await readState();
          return (
            (await serveFromCache(state.activeCache, request)) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const state = await currentServingState();

      const cached = await serveFromCache(state.activeCache, request);
      if (cached) return cached;

      try {
        return await fetch(request);
      } catch (_) {
        const previous = await serveFromCache(state.previousCache, request);
        return previous || Response.error();
      }
    })()
  );
});
