"use strict";

/*
 * Clair V8 Fondation — mise à jour atomique et réversible.
 * Ce service worker ne lit, ne modifie et ne supprime aucune donnée personnelle.
 * Les données utilisateur restent dans localStorage/IndexedDB ; seules les ressources
 * applicatives sont gérées ici dans Cache Storage.
 */
const APP_ID = "clair-repas";
const RELEASE = "8.0.0-foundation.5";
const DATA_SCHEMA = 2;
const CACHE_PREFIX = "clair-repas-";
const CURRENT_CACHE = `${CACHE_PREFIX}app-${RELEASE}`;
const META_CACHE = `${CACHE_PREFIX}v8-meta`;
const META_URL = new URL("./__clair_v8_meta__", self.registration.scope).toString();
const CORE_FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./v8/clair-foundation.js", "./v8/version.json"];
const FOUNDATION_PATH = "./v8/clair-foundation.js";
const VERSION_PATH = "./v8/version.json";
const BOOT_GRACE_MS = 18000;

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
  await cache.put(META_URL, new Response(JSON.stringify(next), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  }));
  return next;
}

function foundationTag() {
  return `<script src="./v8/clair-foundation.js" data-clair-v8-foundation data-clair-app="${APP_ID}" data-clair-release="${RELEASE}" data-clair-schema="${DATA_SCHEMA}"></script>`;
}

async function injectFoundation(response) {
  const text = await response.text();
  if (text.includes("data-clair-v8-foundation")) {
    return new Response(text, responseInit(response));
  }
  const tag = foundationTag();
  const html = /<head(?:\s[^>]*)?>/i.test(text)
    ? text.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n${tag}`)
    : `${tag}\n${text}`;
  return new Response(html, responseInit(response));
}

function responseInit(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  return { status: response.status, statusText: response.statusText, headers };
}

async function fetchRequired(path) {
  const url = new URL(path, self.registration.scope).toString();
  const response = await fetch(new Request(url, { cache: "no-store", credentials: "same-origin" }));
  if (!response.ok) throw new Error(`V8 install: ${path} -> HTTP ${response.status}`);
  if (path === "./" || path === "./index.html") return injectFoundation(response);
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

async function choosePreviousCache(state = {}) {
  const names = await caches.keys();
  const available = names.filter(name => isAppCache(name) && name !== CURRENT_CACHE);
  for (const preferred of [state.activeCache, state.lastHealthyCache, state.previousCache]) {
    if (preferred && preferred !== CURRENT_CACHE && available.includes(preferred)) return preferred;
  }
  // Avant V8, le service worker stable ne conservait normalement qu'un seul cache.
  return available.length ? available[available.length - 1] : null;
}

async function cacheHasIndex(cacheName) {
  if (!cacheName) return false;
  try {
    const cache = await caches.open(cacheName);
    return Boolean(await cache.match(appIndexUrl()) || await cache.match(appRootUrl()));
  } catch (_) {
    return false;
  }
}

async function markCandidateActive() {
  const previousState = await readState();
  const previousCache = await choosePreviousCache(previousState);
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
  if (!state?.previousCache || !(await cacheHasIndex(state.previousCache))) return state;
  return writeState({
    ...state,
    activeCache: state.previousCache,
    failedCache: CURRENT_CACHE,
    probation: false,
    rollbackReason: reason,
    rolledBackAt: new Date().toISOString()
  });
}

async function currentServingState() {
  let state = await readState();
  if (!state.activeCache || !(await cacheHasIndex(state.activeCache))) {
    state = await writeState({ ...state, activeCache: CURRENT_CACHE, release: RELEASE, probation: true });
  }
  if (state.probation && state.bootStartedAt && Date.now() - Number(state.bootStartedAt) > BOOT_GRACE_MS) {
    state = await rollbackIfNeeded(state, "boot-watchdog-timeout");
  }
  return state;
}

async function serveFromCache(cacheName, request) {
  if (!cacheName) return null;
  const cache = await caches.open(cacheName);
  let response = await cache.match(request, { ignoreSearch: true });
  if (!response && request.mode === "navigate") {
    response = await cache.match(appIndexUrl()) || await cache.match(appRootUrl());
  }
  return response || null;
}

function isMainNavigation(url, request) {
  if (request.mode !== "navigate") return false;
  const scope = new URL(self.registration.scope);
  const base = scope.pathname.endsWith("/") ? scope.pathname : `${scope.pathname}/`;
  return url.pathname === base || url.pathname === `${base}index.html`;
}

async function cleanupCaches(state) {
  const keep = new Set([META_CACHE, CURRENT_CACHE, state?.activeCache, state?.previousCache, state?.lastHealthyCache].filter(Boolean));
  const names = await caches.keys();
  await Promise.all(names.filter(name => isAppCache(name) && !keep.has(name)).map(name => caches.delete(name)));
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    // Une mise à jour n'est installée que si TOUT le socle V8 a pu être téléchargé.
    await buildCandidateCache();
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // L'ancienne version reste intacte : elle devient le parachute de retour arrière.
    await markCandidateActive();
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (data.app && data.app !== APP_ID) return;

  if (data.type === "CLAIR_V8_BOOT_START" && data.release === RELEASE) {
    event.waitUntil((async () => {
      const state = await readState();
      if (state.activeCache !== CURRENT_CACHE) return;
      await writeState({ ...state, probation: true, bootStartedAt: Date.now(), prebootFingerprint: data.fingerprint || null });
    })());
    return;
  }

  if (data.type === "CLAIR_V8_BOOT_OK" && data.release === RELEASE) {
    event.waitUntil((async () => {
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
    })());
    return;
  }

  if (data.type === "CLAIR_V8_BOOT_FAIL" && data.release === RELEASE) {
    event.waitUntil((async () => {
      const state = await readState();
      const failed = await writeState({
        ...state,
        bootFailures: Number(state.bootFailures || 0) + 1,
        lastBootError: { reason: data.reason || "runtime-error", detail: data.detail || "", at: new Date().toISOString() }
      });
      const rolled = await rollbackIfNeeded(failed, data.reason || "runtime-error");
      try {
        const client = event.source?.id ? await self.clients.get(event.source.id) : null;
        if (client && "navigate" in client && rolled.activeCache !== CURRENT_CACHE) await client.navigate(client.url);
      } catch (_) {}
    })());
    return;
  }

  if (data.type === "CLAIR_V8_FORCE_ROLLBACK") {
    event.waitUntil((async () => {
      const state = await readState();
      await rollbackIfNeeded(state, "manual-rollback");
    })());
  }
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isMainNavigation(url, request)) {
    event.respondWith((async () => {
      const state = await currentServingState();
      const cached = await serveFromCache(state.activeCache, request);
      if (cached) return cached;
      // Ultime filet : si le cache actif est indisponible, on essaie le précédent.
      const previous = await serveFromCache(state.previousCache, request);
      if (previous) return previous;
      return fetch(request, { cache: "no-store" });
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try { return await fetch(request, { cache: "no-store" }); }
      catch (_) {
        const state = await readState();
        return (await serveFromCache(state.activeCache, request)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const state = await currentServingState();
    const cached = await serveFromCache(state.activeCache, request);
    if (cached) return cached;
    try { return await fetch(request); }
    catch (_) {
      const previous = await serveFromCache(state.previousCache, request);
      return previous || Response.error();
    }
  })());
});
