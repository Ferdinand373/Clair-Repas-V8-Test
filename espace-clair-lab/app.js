(() => {
  "use strict";

  const SUPABASE_URL = "https://ryyewskgfgysfubesdsj.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_T9Dmg9VKTdMFdCuLVxD54w_7GeH3Q6S";
  const TEST_ROOT_URL = "https://ferdinand373.github.io/Clair-Repas-V8-Test/";
  const Core = window.ClairEspaceLabCore;
  const byId = (id) => document.getElementById(id);

  if (!Core || typeof window.supabase?.createClient !== "function") {
    byId("loadingText").textContent = "Le Lab n’a pas pu charger son accès sécurisé.";
    return;
  }

  const client = window.supabase.createClient(
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
  const observer = Core.createReadOnlyObserver(client);
  const viewBoundary = Core.createViewBoundary();
  const ui = {
    loading: byId("loading"),
    loadingText: byId("loadingText"),
    signedOut: byId("signedOut"),
    dashboard: byId("dashboard"),
    authForm: byId("authForm"),
    authEmail: byId("authEmail"),
    authPassword: byId("authPassword"),
    authButton: byId("authButton"),
    authMessage: byId("authMessage"),
    identityEmail: byId("identityEmail"),
    identityId: byId("identityId"),
    dataState: byId("dataState"),
    favoritesCount: byId("favoritesCount"),
    favoritesState: byId("favoritesState"),
    notesCount: byId("notesCount"),
    notesState: byId("notesState"),
    lastSync: byId("lastSync"),
    sourceDevice: byId("sourceDevice"),
    readMessage: byId("readMessage"),
    refreshButton: byId("refreshButton"),
    openTestLink: byId("openTestLink")
  };
  let currentUser = null;
  ui.openTestLink.href = TEST_ROOT_URL;

  function setMessage(element, text, kind = "info") {
    element.textContent = text || "";
    element.dataset.kind = text ? kind : "";
    element.hidden = !text;
  }

  function setBusy(button, busy, busyLabel) {
    if (busy) {
      if (!button.disabled) button.dataset.label = button.textContent;
      button.textContent = busyLabel;
    } else {
      button.textContent = button.dataset.label || button.textContent;
    }
    button.disabled = busy;
  }

  function formatDate(value) {
    if (!value) return "Aucune synchronisation observée";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Date momentanément illisible";
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function renderObservedValue(result, countElement, stateElement, label) {
    if (result.state === "unreadable") {
      countElement.textContent = "—";
      stateElement.textContent = "Donnée momentanément illisible";
      stateElement.dataset.state = "warning";
      return;
    }

    countElement.textContent = String(result.count);
    stateElement.textContent = result.state === "ready"
      ? `${label} observé${result.count > 1 ? "s" : ""}`
      : "Aucune donnée observée";
    stateElement.dataset.state = result.state;
  }

  function renderSummary(summary) {
    ui.dataState.textContent = summary.hasData
      ? "Données TEST disponibles"
      : "Aucune donnée TEST disponible";
    ui.dataState.dataset.state = summary.hasData ? "ready" : "empty";
    renderObservedValue(summary.favorites, ui.favoritesCount, ui.favoritesState, "favori");
    renderObservedValue(summary.notes, ui.notesCount, ui.notesState, "note utile");
    ui.lastSync.textContent = formatDate(summary.lastSyncAt);
    ui.sourceDevice.textContent = summary.sourceDevice || "Source non renseignée";
  }

  function resetObservedUi() {
    ui.dataState.textContent = "Lecture des données TEST…";
    ui.dataState.dataset.state = "loading";
    ui.favoritesCount.textContent = "—";
    ui.favoritesState.textContent = "Lecture en cours…";
    ui.favoritesState.dataset.state = "loading";
    ui.notesCount.textContent = "—";
    ui.notesState.textContent = "Lecture en cours…";
    ui.notesState.dataset.state = "loading";
    ui.lastSync.textContent = "—";
    ui.sourceDevice.textContent = "Source non renseignée";
    setMessage(ui.readMessage, "");
    setBusy(ui.refreshButton, false);
  }

  function showSignedOut(message = "") {
    viewBoundary.clear();
    currentUser = null;
    observer.clearValidatedUser();
    resetObservedUi();
    ui.dashboard.hidden = true;
    ui.signedOut.hidden = false;
    ui.loading.hidden = true;
    setMessage(ui.authMessage, message, message ? "error" : "");
  }

  function showDashboard(user) {
    currentUser = user;
    resetObservedUi();
    ui.identityEmail.textContent = user.email || "Adresse non renseignée";
    ui.identityId.textContent = user.id;
    ui.signedOut.hidden = true;
    ui.dashboard.hidden = false;
    ui.loading.hidden = true;
    setMessage(ui.authMessage, "");
  }

  async function refreshObservedData() {
    const token = viewBoundary.beginRead();
    if (!currentUser || !token || currentUser.id !== token.userId) return;
    setBusy(ui.refreshButton, true, "Lecture…");
    setMessage(ui.readMessage, "");
    try {
      const result = await observer.read();
      if (
        result.state !== "ready" ||
        result.userId !== token.userId ||
        !viewBoundary.isReadCurrent(token)
      ) return;
      renderSummary(Core.summarizeRows(result.rows));
    } catch (error) {
      console.error("Lecture Lab indisponible", error);
      if (!viewBoundary.isReadCurrent(token)) return;
      setMessage(
        ui.readMessage,
        "Les données TEST sont momentanément indisponibles. Aucune correction n’a été tentée.",
        "error"
      );
    } finally {
      if (viewBoundary.isReadCurrent(token)) setBusy(ui.refreshButton, false);
    }
  }

  async function applySession(session) {
    const epoch = viewBoundary.beginAuth();
    observer.clearValidatedUser();
    if (!session?.user) {
      showSignedOut();
      return;
    }

    ui.loading.hidden = false;
    ui.loadingText.textContent = "Validation de la session commune…";
    try {
      const user = await observer.validateSession(session);
      if (!viewBoundary.isAuthCurrent(epoch)) return;
      if (!user) {
        showSignedOut("La session n’a pas pu être validée. Reconnectez-vous.");
        return;
      }
      if (!viewBoundary.acceptAuth(epoch, user.id)) return;
      showDashboard(user);
      await refreshObservedData();
    } catch (error) {
      console.error("Session Lab indisponible", error);
      if (epoch === authEpoch) {
        showSignedOut("La session est momentanément indisponible.");
      }
    }
  }

  function friendlyAuthError(error) {
    const message = String(error?.message || error || "Connexion impossible");
    if (/invalid login credentials/i.test(message)) {
      return "Adresse e-mail ou mot de passe incorrect.";
    }
    if (/email not confirmed/i.test(message)) {
      return "Confirmez d’abord votre adresse e-mail.";
    }
    if (/failed to fetch/i.test(message)) {
      return "Le serveur d’authentification est momentanément indisponible.";
    }
    return "Connexion impossible pour le moment.";
  }

  ui.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(ui.authMessage, "");
    setBusy(ui.authButton, true, "Connexion…");
    try {
      const result = await client.auth.signInWithPassword({
        email: ui.authEmail.value.trim(),
        password: ui.authPassword.value
      });
      ui.authPassword.value = "";
      if (result.error) throw result.error;
      await applySession(result.data?.session || null);
    } catch (error) {
      setMessage(ui.authMessage, friendlyAuthError(error), "error");
    } finally {
      setBusy(ui.authButton, false);
    }
  });

  ui.refreshButton.addEventListener("click", refreshObservedData);

  async function registerLabServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js", {
        scope: "./",
        updateViaCache: "none"
      });
    } catch (error) {
      console.error("Frontière hors ligne du Lab indisponible", error);
    }
  }

  client.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => applySession(session), 0);
  });

  registerLabServiceWorker();

  (async () => {
    try {
      const result = await client.auth.getSession();
      if (result.error) throw result.error;
      await applySession(result.data?.session || null);
    } catch (error) {
      console.error("Initialisation Lab indisponible", error);
      showSignedOut("Impossible de vérifier la session pour le moment.");
    }
  })();
})();
