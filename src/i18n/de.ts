// German texts for the timeline, mails and admin pages.

import { escapeMarkdown, formatDate, shorten } from "./format.js";
import type { FailureStage, Messages } from "./index.js";

const MAX_DETAIL = 400;
const INTL = "de-DE";

const FAILURE_REASONS: Readonly<Record<FailureStage, string>> = {
  load: "Rezept nicht lesbar",
  prepare: "Aufbereitung fehlgeschlagen",
  categories: "Kategorien nicht verfügbar",
  convert: "Umwandlung fehlgeschlagen",
  validate: "Prüfung nicht bestanden",
  ingredients: "Zutaten-Zuordnung fehlgeschlagen",
  upload: "Hochladen fehlgeschlagen",
  unexpected: "Unerwarteter Fehler",
};

export const de: Messages = {
  language: "de",
  intlLocale: INTL,
  timeline: {
    createdSubject: (status) =>
      status === "draft"
        ? "Monsieur Cuisine: Entwurf erstellt"
        : "Monsieur Cuisine: Rezept privat gespeichert",
    created(text) {
      const status =
        text.status === "draft"
          ? "Entwurf, am Gerät erst nach „Nur auf meinem Gerät speichern“ im Editor sichtbar"
          : text.statusFailed
            ? "Entwurf; das private Speichern ist fehlgeschlagen, bitte im Editor „Nur auf meinem Gerät speichern“ wählen"
            : "Privat gespeichert, nur auf deinem Gerät sichtbar";
      const lines = [
        `Das Rezept liegt in deinem Monsieur-Cuisine-Konto: [Im Editor öffnen](${text.url})`,
        "",
        `- Portionen: ${text.servings}`,
        `- Status: ${status}`,
        `- Umgewandelt mit: ${escapeMarkdown(text.provider)}, ${escapeMarkdown(text.model)}`,
      ];
      if (text.imageSkipped) lines.push("- Bild: nicht übernommen, bitte im Editor ergänzen");
      if (text.reviewHints.length > 0) {
        lines.push(
          "",
          "**Bitte prüfen:**",
          ...text.reviewHints.map((hint) => `- ${escapeMarkdown(hint)}`),
        );
      }
      lines.push(
        "",
        "Die Schritte hat ein Sprachmodell erstellt. Prüfe Mengen, Garzeiten und Temperaturen im Editor, bevor du mit dem Rezept kochst.",
      );
      return lines.join("\n");
    },
    unchangedSubject: "Monsieur Cuisine: unverändert",
    unchanged(text) {
      const link = text.status === "draft" ? "Entwurf öffnen" : "Rezept öffnen";
      return `Unverändert, bereits gesendet am ${formatDate(text.sentAt, INTL)}: [${link}](${text.url})`;
    },
    failedSubject(stage) {
      return `Monsieur Cuisine: Fehler – ${FAILURE_REASONS[stage]}`;
    },
    failed(text) {
      return [
        `${FAILURE_REASONS[text.stage]}: ${escapeMarkdown(shorten(text.detail, MAX_DETAIL))}`,
        "",
        "Details stehen auf der Admin-Seite der Bridge. Dort lässt sich der Auftrag erneut starten.",
      ].join("\n");
    },
    sessionSubject: "Monsieur Cuisine: Sitzung abgelaufen",
    session() {
      return "Die Bridge ist gerade nicht bei Monsieur Cuisine angemeldet. Der Auftrag wartet und läuft automatisch weiter, sobald auf der Admin-Seite eine neue Sitzung hinterlegt ist.";
    },
    failureReasons: FAILURE_REASONS,
  },
  email: {
    subjectPrefix: "Monsieur-Cuisine-Bridge",
    session: {
      expired: {
        subject: "Sitzung abgelaufen",
        lead: "Die Monsieur-Cuisine-Sitzung der Bridge ist abgelaufen.",
      },
      invalid: {
        subject: "Sitzung ungültig",
        lead: "Monsieur Cuisine lehnt das gespeicherte Sitzungs-Cookie ab, oder es ist keines hinterlegt.",
      },
    },
    sessionWaiting:
      "Neue Aufträge aus Mealie warten, bis eine gültige Sitzung hinterlegt ist, und laufen dann automatisch weiter.",
    sessionNextSteps: [
      "So geht es weiter:",
      "1. Auf www.monsieur-cuisine.com anmelden.",
      "2. Das Cookie aus den Entwicklerwerkzeugen des Browsers kopieren (siehe README, Abschnitt „Monsieur Cuisine session“).",
      "3. Auf der Admin-Seite der Bridge (/admin) einfügen und speichern.",
    ],
    lastChecked: (when) => `Zuletzt geprüft: ${when}`,
    never: "noch nie",
    lastMessage: (message) => `Letzte Meldung: ${message}`,
    jobFailedSubject: (title) => `„${title}“ nicht gesendet`,
    jobFailedLead: (title) =>
      `Das Rezept „${title}“ konnte nicht an Monsieur Cuisine gesendet werden.`,
    error: (message) => `Fehler: ${message}`,
    job: (id) => `Auftrag: ${id}`,
    attempts: (count) => `Versuche: ${count}`,
    recipeInMealie: (url) => `Rezept in Mealie: ${url}`,
    jobRetry: "Auf der Admin-Seite der Bridge (/admin/jobs) lässt sich der Auftrag erneut starten.",
    healthSubject: "Sitzungsprüfung fehlgeschlagen",
    healthLead:
      "Die regelmäßige Prüfung der Monsieur-Cuisine-Sitzung ist fehlgeschlagen. Die Sitzung selbst wurde dabei nicht abgelehnt; meist ist die Website kurz nicht erreichbar.",
    healthOutro:
      "Die Bridge prüft weiter. Bleibt der Fehler bestehen, hilft ein Blick in die Logs.",
  },
  admin: {
    htmlLang: "de",
    nav: { dashboard: "Übersicht", jobs: "Aufträge", dryRun: "Probelauf" },
    authBanner: "Die Admin-Seiten haben kein Passwort. Setze ADMIN_USER und ADMIN_PASSWORD.",
    notices: {
      "session-saved":
        "Sitzung gespeichert. Aufträge, die darauf gewartet haben, stehen wieder in der Warteschlange.",
      "session-checked": "Sitzung geprüft.",
      "job-queued": "Der Auftrag steht wieder in der Warteschlange.",
      "job-forced":
        "Der Auftrag steht wieder in der Warteschlange und wird gesendet, auch wenn sich das Rezept nicht geändert hat.",
      "job-cancelled": "Auftrag abgebrochen.",
    },
    plain: {
      unknownHost: "Unbekannter Hostname. Trage ihn in ADMIN_HOSTS ein oder nutze die IP-Adresse.",
      authRequired: "Anmeldung erforderlich",
      crossOrigin: "Anfrage von einer fremden Seite abgelehnt",
    },
    titles: {
      dashboard: "Übersicht",
      jobs: "Aufträge",
      job: "Auftrag",
      notFound: "Nicht gefunden",
      notPossible: "Nicht möglich",
      formExpired: "Formular abgelaufen",
      dryRun: "Probelauf",
    },
    errors: {
      formExpired:
        "Das Formular ist abgelaufen (die Bridge wurde neu gestartet, oder die Seite stammt von woanders). Lade die Seite neu und versuche es noch einmal.",
      cookieEmpty: "Das Cookie-Feld ist leer.",
      cookieRejected: (reason) =>
        `${reason}. Das Cookie wurde nicht gespeichert. Melde dich neu an und kopiere ein frisches.`,
      cookieUnchecked: (reason) =>
        `Das Cookie ließ sich nicht prüfen und wurde deshalb nicht gespeichert: ${reason}`,
      noSuchJob: "Diesen Auftrag gibt es nicht.",
      recipeNotLoaded: (reason) => `Das Rezept ließ sich nicht laden: ${reason}`,
      conversionLinkExpired:
        "Der Link zur Umwandlung ist abgelaufen (die Bridge wurde neu gestartet, oder der Link stammt von woanders). Nutze den Knopf unten.",
      conversionFailed: (reason) => `Die Umwandlung ist fehlgeschlagen: ${reason}`,
    },
    links: {
      backToDashboard: "Zurück zur Übersicht",
      backToJobs: "Zurück zu den Aufträgen",
      allJobs: "Alle Aufträge",
    },
    jobStatus: {
      queued: "wartet",
      running: "läuft",
      done: "fertig",
      skipped: "übersprungen",
      failed: "fehlgeschlagen",
      session_expired: "Sitzung abgelaufen",
      cancelled: "abgebrochen",
    },
    sessionState: {
      valid: "gültig",
      invalid: "ungültig",
      expired: "abgelaufen",
      unknown: "unbekannt",
    },
    jobsTable: {
      empty: "Noch keine Aufträge.",
      created: "Erstellt",
      recipe: "Rezept",
      scale: "Faktor",
      status: "Status",
      attempts: "Versuche",
      result: "Ergebnis",
      recipeLink: (id, status) => `${status === "draft" ? "Entwurf" : "Rezept"} ${id}`,
    },
    dashboard: {
      session: "Monsieur-Cuisine-Sitzung",
      state: "Zustand",
      lastCheck: "Letzte Prüfung",
      cookieAge: "Alter des Cookies",
      noCookie: "kein Cookie",
      hours: (count) => `${count} h`,
      lastError: "Letzter Fehler",
      newRecipes: "Neue Rezepte",
      privatePublish: "nur auf dem Gerät gespeichert",
      draftOnly: "bleiben Entwürfe und erscheinen nicht am Gerät",
      checkNow: "Jetzt prüfen",
      cookieLabel:
        "Füge den Request-Header `Cookie` eines angemeldeten Tabs von www.monsieur-cuisine.com ein (Entwicklerwerkzeuge, Netzwerk, eine beliebige Anfrage an `proxy-api`). Die Bridge prüft ihn an deinem Konto, bevor sie ihn verschlüsselt speichert.",
      saveSession: "Sitzung speichern",
      queue: "Warteschlange",
      worker: "Worker:",
      unknown: "unbekannt",
      paused: "pausiert, bis die Sitzung funktioniert",
      running: "läuft",
      stopped: "gestoppt",
      lastWorkerError: (time) => `Letzter Fehler des Workers (${time}):`,
      recentJobs: "Letzte Aufträge",
      dryRun: "Probelauf",
    },
    jobList: {
      status: "Status",
      all: "alle",
      recipe: "Rezept",
      searchPlaceholder: "Titel, Slug oder ID",
      filter: "Filtern",
      newer: "Neuere",
      older: "Ältere",
    },
    jobDetail: {
      status: "Status",
      job: "Auftrag",
      mealieRecipe: "Mealie-Rezept",
      monsieurCuisine: "Monsieur Cuisine",
      openRecipe: (id, status) =>
        `${status === "draft" ? "Entwurf" : "Rezept"} ${id} im Editor öffnen`,
      scale: "Faktor",
      servings: (count) => ` (${count} Portionen)`,
      attempts: "Versuche",
      forced: " · erzwungen",
      created: "Erstellt",
      started: "Gestartet",
      finished: "Beendet",
      model: "Modell",
      usage: "Verbrauch",
      tokens: (input, cached, output) =>
        `${input} Eingabe-Tokens${cached ? ` (${cached} aus dem Cache)` : ""}, ${output} Ausgabe-Tokens`,
      ingredientIds: "Zutaten-IDs",
      resolutionOff: (unresolved) => `Zuordnung ausgeschaltet (${unresolved} ohne ID)`,
      resolution: (catalog, relaxed, cache, search, unresolved) =>
        `${catalog} aus dem Katalog${relaxed > 0 ? ` (${relaxed} ohne Zusätze im Namen)` : ""}, ${cache} aus dem Cache, ${search} aus der Suche, ${unresolved} ohne ID`,
      withoutId: "Ohne ID",
      error: "Fehler",
      runningLocked: "Laufende Aufträge lassen sich nicht ändern.",
      retry: "Erneut versuchen",
      forceRebuild: "Neu senden erzwingen",
      cancel: "Abbrechen",
      events: "Protokoll",
      time: "Zeit",
      level: "Stufe",
      message: "Meldung",
    },
    dryRun: {
      recipe: "Rezept",
      recipePlaceholder: "ID oder Slug",
      scale: "Faktor",
      preview: "Vorschau",
      servings: "Portionen",
      sourceHash: "Quell-Hash",
      alreadySent: "Schon gesendet",
      sentAt: (time) => `ja, ${time}:`,
      wouldSkip: "(ein Auftrag würde übersprungen, außer er wird erzwungen)",
      no: "nein",
      convert: "Umwandeln ohne Hochladen",
      costsMoney: "Ruft das Sprachmodell auf; das kostet Geld.",
      ingredients: "Zutaten",
      section: "Abschnitt",
      amount: "Menge",
      unit: "Einheit",
      food: "Lebensmittel",
      note: "Hinweis",
      source: "Quelle",
      original: "Original",
      optional: "(optional)",
      converterInput: "Eingabe des Konverters (Markdown)",
      conversion: "Umwandlung",
      model: "Modell",
      attempts: (count) => `${count} ${count === 1 ? "Versuch" : "Versuche"}`,
      usage: "Verbrauch",
      tokens: (input, output) => `${input} Eingabe-, ${output} Ausgabe-Tokens`,
      title: "Titel",
      times: "Zeiten",
      timesValue: (preparation, ready) =>
        `${preparation} min Vorbereitung, ${ready} min bis fertig`,
      categories: "Kategorien",
      none: "keine",
      droppedIds: (ids) => `· unbekannte IDs entfernt: ${ids}`,
      validation: "Prüfung",
      passed: "bestanden",
      errors: (count) => `${count} Fehler`,
      field: "Feld",
      problem: "Problem",
      reviewHints: "Prüfhinweise",
      noHints: "Keine.",
      warnings: "Hinweise des Konverters",
      steps: "Schritte",
      kind: "Art",
      settings: "Einstellungen",
      text: "Text",
      ingredientGroups: "Zutatengruppen",
    },
  },
};
