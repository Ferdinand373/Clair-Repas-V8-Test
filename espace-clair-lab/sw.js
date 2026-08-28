"use strict";

const OFFLINE_DOCUMENT = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#eef3ef">
  <title>Espace Clair Lab hors connexion</title>
  <style>
    *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;color:#14211d;background:linear-gradient(145deg,#f9faf8,#e8f1eb);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(520px,100%);padding:34px;border:1px solid rgba(20,33,29,.08);border-radius:28px;background:rgba(255,255,255,.88);box-shadow:0 24px 64px rgba(28,45,38,.11)}.mark{font-size:30px}h1{margin:18px 0 10px;font-size:34px;letter-spacing:-.04em}p{margin:0;color:#68766f;line-height:1.55}a{display:inline-flex;margin-top:24px;color:#28543f;font-weight:750}
  </style>
</head>
<body><main class="card"><div class="mark">🌿</div><h1>Espace Clair Lab hors connexion</h1><p>Le Lab reste fermé plutôt que d’afficher une autre application. Reconnectez-vous puis actualisez pour observer les données TEST.</p><a href="./">Réessayer</a></main></body>
</html>`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  event.respondWith(
    fetch(request, { cache: "no-store" }).catch(() => new Response(
      OFFLINE_DOCUMENT,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        }
      }
    ))
  );
});
