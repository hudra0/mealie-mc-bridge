// German texts for the timeline, mails and admin pages.

import { escapeMarkdown, formatDate, formatNumber, formatUsd, shorten } from "./format.js";
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
        `- Ergibt: ${text.servings} ${escapeMarkdown(text.servingUnit)}`,
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
    limitSubject: "Monsieur Cuisine: nicht gesendet, Tageslimit erreicht",
    limit(text) {
      return text.kind === "jobs"
        ? `Die Bridge nimmt höchstens ${formatNumber(text.limit, INTL)} Rezepte in 24 Stunden an, und so viele sind eingegangen. Bitte später erneut versuchen; der Betreiber kann JOB_DAILY_LIMIT erhöhen.`
        : `Die Kosten des Sprachmodells der letzten 24 Stunden haben das Limit von ${formatNumber(text.limit, INTL)} USD erreicht. Bitte später erneut versuchen; der Betreiber kann JOB_DAILY_COST_LIMIT_USD erhöhen.`;
    },
    failureReasons: FAILURE_REASONS,
  },
  jobEvents: {
    queued: ({ scale, force }) =>
      `In die Warteschlange gestellt, Faktor ${formatNumber(scale, INTL)}${force ? ", erzwungen" : ""}`,
    requeued: ({ force }) =>
      force
        ? "Erneut in die Warteschlange gestellt, erzwungen"
        : "Erneut in die Warteschlange gestellt",
    cancelled: () => "Abgebrochen",
    paused: () => "Wartet auf eine gültige Monsieur-Cuisine-Sitzung",
    resumed: () => "Sitzung erneuert, wieder in der Warteschlange",
    recovered_done: () =>
      "Durch einen Neustart unterbrochen, nachdem das Rezept angelegt war; der Eintrag in Mealie ist vielleicht unvollständig",
    recovered_failed: () =>
      "Unterbrochen, während das Rezept angelegt wurde. Es kann auf monsieur-cuisine.com existieren: Prüfe deine Entwürfe, bevor du den Auftrag wiederholst.",
    recovered_queued: () => "Durch einen Neustart unterbrochen, wieder in der Warteschlange",
    attempt_started: ({ attempt }) => `Versuch ${attempt} gestartet`,
    recipe_loaded: ({ name }) => `Rezept „${name}“ aus Mealie geladen`,
    prepared: ({ ingredients, unparsed, servings, estimated, scale }) =>
      `${ingredients} Zutaten aufbereitet (${unparsed} nicht erkannt) für ${servings}${estimated ? " (im Rezept nicht angegeben; das Modell darf schätzen)" : ""}, Faktor ${formatNumber(scale, INTL)}`,
    forced_unchanged: () =>
      "Erzwungen: wird erneut gesendet, obwohl sich das Rezept nicht geändert hat",
    skip_exists: ({ since, recipeId }) =>
      `Unverändert seit ${formatDate(since, INTL)}; Rezept ${recipeId} gibt es noch bei Monsieur Cuisine, übersprungen`,
    skip_gone: ({ since, recipeId }) =>
      `Unverändert seit ${formatDate(since, INTL)}, aber Rezept ${recipeId} gibt es bei Monsieur Cuisine nicht mehr; wird neu umgewandelt`,
    skip_unchecked: ({ since, recipeId }) =>
      `Unverändert seit ${formatDate(since, INTL)}; Rezept ${recipeId} ließ sich bei Monsieur Cuisine nicht prüfen, übersprungen`,
    image_loaded: ({ kb }) => `Bild geladen (${kb} KB)`,
    image_none: () => "Das Rezept hat kein Bild",
    image_load_failed: () => "Bild nicht geladen, es geht ohne weiter",
    categories: ({ count, matched }) =>
      `${count} Kategorien verfügbar; passend: ${matched.length > 0 ? matched.join(", ") : "keine"}`,
    conversion_reused: ({ provider, model }) =>
      `Umwandlung aus einem früheren Versuch wiederverwendet (${provider}/${model}); kein neuer Modellaufruf`,
    converting: () => "Umwandlung gestartet",
    still_converting: ({ seconds }) => `Umwandlung läuft noch, ${seconds} s`,
    converted: ({ provider, model, attempts, inputTokens, outputTokens, costUsd }) =>
      `Umgewandelt mit ${provider}/${model} in ${attempts} ${attempts === 1 ? "Versuch" : "Versuchen"} (${formatNumber(inputTokens, INTL)} Eingabe-, ${formatNumber(outputTokens, INTL)} Ausgabe-Tokens${costUsd === null ? "" : `, ${formatUsd(costUsd, INTL)}`})`,
    converter_warning: ({ text }) => `Konverter: ${text}`,
    categories_dropped: ({ ids }) => `Unbekannte Kategorie-IDs entfernt: ${ids.join(", ")}`,
    servings_estimated: ({ servings }) => `Das Modell hat die Portionen geschätzt: ${servings}`,
    servings_changed: ({ requested, converted }) =>
      `Das Modell hat ${converted} statt ${requested} gesetzt`,
    validation_passed: () => "Prüfung bestanden",
    ingredients_resolved: ({ catalog, relaxed, cache, search, unresolved }) =>
      `Zutaten-IDs: ${catalog} aus dem Katalog${relaxed > 0 ? ` (${relaxed} ohne Zusätze)` : ""}, ${cache} aus dem Cache, ${search} aus der Suche, ${unresolved} ohne ID`,
    ingredients_off: ({ unresolved }) =>
      `Zutaten-IDs nicht zugeordnet (MC_RESOLVE_INGREDIENTS=off): ${unresolved} ohne ID`,
    image_skipped: () => "Bild übersprungen",
    image_uploaded: () => "Bild hochgeladen",
    draft_created: ({ recipeId }) => `Rezept ${recipeId} bei Monsieur Cuisine angelegt`,
    status_private: () => "Nur auf dem Gerät gespeichert",
    status_failed: () =>
      "Statuswechsel fehlgeschlagen; das Rezept bleibt ein Entwurf und erscheint nicht am Gerät",
    tag_unavailable: ({ tag }) => `Schlagwort „${tag}“ nicht verfügbar`,
    writeback_done: ({ tagged }) =>
      tagged ? "Mealie-Rezept verschlagwortet und Link gespeichert" : "Link in Mealie gespeichert",
    writeback_forbidden: () =>
      "Mealie hat die Änderung abgelehnt (403): Der Benutzer der Bridge braucht Schreibrechte auf das Rezept",
    writeback_failed: () => "Mealie-Rezept ließ sich nicht aktualisieren",
    timeline_posted: () => "Eintrag in der Mealie-Zeitleiste angelegt",
    timeline_failed: () => "Eintrag in der Mealie-Zeitleiste fehlgeschlagen",
    done: () => "Fertig",
    interrupted: () =>
      "Beim Herunterfahren unterbrochen; der Auftrag läuft nach dem Neustart weiter",
    session_unusable: ({ kind }) =>
      `Monsieur-Cuisine-Sitzung nicht nutzbar (${kind}); wartet auf eine neue`,
    temporary_failure: ({ stage }) => `Vorübergehender Fehler: ${FAILURE_REASONS[stage]}`,
    failed: ({ stage }) => FAILURE_REASONS[stage],
    crashed: () => "Abgestürzt",
    retry_scheduled: ({ retry, max, seconds }) =>
      `Wiederholung ${retry} von ${max} in ${seconds} s`,
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
      "So geht es weiter, eine der drei Möglichkeiten:",
      "1. Auf der Admin-Seite unter Einstellungen (/admin/settings) das Lidl-Konto hinterlegen; die Bridge meldet sich dann selbst an.",
      "2. Am Rechner den Anmelde-Helfer starten: npm run mc:login -- --bridge <Adresse der Bridge> (siehe README, Abschnitt „Monsieur Cuisine session“).",
      "3. Auf www.monsieur-cuisine.com anmelden, das Cookie aus den Entwicklerwerkzeugen kopieren und auf der Admin-Seite unter Einstellungen (/admin/settings) einfügen.",
    ],
    autoLoginWaiting: (time) =>
      `Die automatische Anmeldung mit dem hinterlegten Lidl-Konto versucht es ab ${time} wieder; so lange wartet sie nach früheren Versuchen. Schneller geht es mit „Anmeldung testen“ in den Einstellungen, dem Anmelde-Helfer oder dem Cookie-Formular.`,
    autoLoginFailed: (reason) =>
      `Die automatische Anmeldung mit dem hinterlegten Lidl-Konto hat nicht geklappt (${reason}). Bitte einmal von Hand anmelden: mit dem Anmelde-Helfer oder per Cookie.`,
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
    testSubject: "Testmail",
    testText:
      "Dies ist eine Testmail von der Einstellungsseite. Mails zu einer abgelaufenen Sitzung und zu fehlgeschlagenen Aufträgen gehen an diese Adresse.",
  },
  admin: {
    htmlLang: "de",
    nav: {
      dashboard: "Übersicht",
      jobs: "Aufträge",
      dryRun: "Probelauf",
      settings: "Einstellungen",
      logout: "Abmelden",
      label: "Hauptnavigation",
    },
    shell: {
      tagline: "Mealie zu Monsieur Cuisine",
      openMenu: "Menü öffnen",
      closeMenu: "Menü schließen",
      mcSession: "MC-Sitzung",
      theme: "Darstellung",
      themes: { system: "System", light: "Hell", dark: "Dunkel" },
      signedIn: (user) => `Angemeldet als ${user}`,
      noPassword: "Ohne Passwort",
      dismiss: "Schließen",
      cancel: "Abbrechen",
      confirm: "Bestätigen",
    },
    authBanner: "Die Admin-Seiten haben kein Passwort. Setze ADMIN_USER und ADMIN_PASSWORD.",
    skipToContent: "Zum Inhalt springen",
    copy: { copy: "Kopieren", copied: "Kopiert", reveal: "Anzeigen" },
    login: {
      title: "Anmelden",
      subtitle: "Admin-Seiten der Bridge",
      user: "Benutzer",
      password: "Passwort",
      submit: "Anmelden",
      hint: "ADMIN_USER und ADMIN_PASSWORD aus der Umgebung der Bridge. Die Anmeldung gilt 12 Stunden.",
      wrongCredentials: "Benutzer oder Passwort stimmen nicht.",
      tooMany: (minutes) =>
        `Zu viele fehlgeschlagene Anmeldungen von dieser Adresse. Versuche es in ${minutes} ${minutes === 1 ? "Minute" : "Minuten"} wieder.`,
    },
    autoRefresh: "Aktualisiert sich alle 5 Sekunden, solange der Auftrag läuft.",
    mealieTimeout: (seconds) => `keine Antwort innerhalb von ${seconds} s`,
    notices: {
      "session-saved": "Sitzung gespeichert. Wartende Aufträge stehen wieder in der Warteschlange.",
      "session-checked": "Sitzung geprüft.",
      "job-queued": "Der Auftrag steht wieder in der Warteschlange.",
      "job-forced":
        "Der Auftrag steht wieder in der Warteschlange und wird gesendet, auch wenn sich das Rezept nicht geändert hat.",
      "job-cancelled": "Auftrag abgebrochen.",
      "logged-out": "Abgemeldet.",
      "credentials-saved": "Lidl-Konto verschlüsselt gespeichert.",
      "credentials-deleted": "Lidl-Konto gelöscht.",
      "login-started": "Anmeldung gestartet. Die Seite aktualisiert sich, bis sie fertig ist.",
      "login-running": "Es läuft schon eine Anmeldung.",
      "login-no-credentials": "Bitte zuerst das Lidl-Konto hinterlegen.",
      "login-cooldown":
        "Ein manueller Test läuft höchstens alle 3 Minuten. Bitte gleich noch einmal versuchen.",
      "test-mail-sent": "Testmail gesendet. Sieh im Postfach nach.",
      "test-mail-cooldown": "Eine Testmail geht höchstens einmal pro Minute hinaus.",
      "mail-saved": "Mail-Einstellungen verschlüsselt gespeichert. Sie gelten ab sofort.",
      "mail-deleted": "Mail-Einstellungen gelöscht. Es gehen keine Mails mehr hinaus.",
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
      dryRun: "Probelauf",
      notFound: "Nicht gefunden",
      notPossible: "Nicht möglich",
      formExpired: "Formular abgelaufen",
      error: "Etwas ist schiefgegangen",
      badRequest: "Anfrage abgelehnt",
    },
    errors: {
      formExpired:
        "Das Formular ist abgelaufen: Die Bridge wurde neu gestartet, oder die Seite stammt von woanders. Lade die Seite neu und versuche es noch einmal.",
      cookieEmpty: "Das Cookie-Feld ist leer.",
      cookieRejected: (reason) =>
        `${reason}. Das Cookie wurde nicht gespeichert. Melde dich neu an und kopiere ein frisches.`,
      cookieUnchecked: (reason) =>
        `Das Cookie ließ sich nicht prüfen und wurde deshalb nicht gespeichert: ${reason}`,
      noSuchJob: "Diesen Auftrag gibt es nicht. Vielleicht ist der Link falsch.",
      noSuchPage: "Unter dieser Adresse gibt es keine Seite.",
      noSuchScreenshot: "Dieses Bildschirmfoto gibt es nicht mehr.",
      recipeNotLoaded: (reason) => `Das Rezept ließ sich nicht laden: ${reason}`,
      conversionFailed: (reason) => `Die Umwandlung ist fehlgeschlagen: ${reason}`,
      credentialsInvalid: (field) =>
        field === "email"
          ? "Das Konto wurde nicht gespeichert: Die E-Mail-Adresse ist ungültig."
          : "Das Konto wurde nicht gespeichert: Das Passwort fehlt.",
      testMailFailed: (reason) => `Die Testmail ging nicht hinaus: ${reason}`,
      mailUnavailable:
        "Mails sind nicht eingerichtet: Trage auf dieser Seite einen Mailserver ein oder setze SMTP_URL und NOTIFY_EMAIL.",
      mailFromEnv:
        "Die Mail-Einstellungen kommen aus der Umgebung (SMTP_URL) und lassen sich hier nicht ändern.",
      mailInvalid: "Die Mail-Einstellungen wurden nicht gespeichert. Prüfe die markierten Felder.",
      server: "Die Bridge konnte diese Anfrage nicht bearbeiten. Details stehen im Log.",
      badRequest: "Die Bridge konnte diese Anfrage nicht lesen.",
    },
    links: {
      backToDashboard: "Zurück zur Übersicht",
      backToJobs: "Zurück zu den Aufträgen",
      backToJob: "Zurück zum Auftrag",
      backToSettings: "Zurück zu den Einstellungen",
    },
    jobStatus: {
      queued: "Wartet",
      running: "Läuft",
      done: "Fertig",
      skipped: "Übersprungen",
      failed: "Fehlgeschlagen",
      session_expired: "Wartet auf Sitzung",
      cancelled: "Abgebrochen",
    },
    sessionState: {
      valid: "Gültig",
      invalid: "Ungültig",
      expired: "Abgelaufen",
      unknown: "Unbekannt",
    },
    events: { details: "Technische Details", code: "Code" },
    failures: {
      stages: {
        load: "Rezept aus Mealie nicht lesbar",
        prepare: "Rezept ließ sich nicht aufbereiten",
        categories: "Kategorien von Monsieur Cuisine nicht verfügbar",
        convert: "Das Sprachmodell konnte das Rezept nicht umwandeln",
        validate: "Die Umwandlung hat die Gerätegrenzen verletzt",
        ingredients: "Zutaten-Zuordnung fehlgeschlagen",
        upload: "Hochladen zu Monsieur Cuisine fehlgeschlagen",
        unexpected: "Unerwarteter Fehler",
      },
      session: "Monsieur-Cuisine-Sitzung abgelaufen",
      limits: "Die Umwandlung hat die Gerätegrenzen verletzt",
      mealieUnreachable: "Mealie nicht erreichbar",
      mealieRefused: "Mealie hat die Anfrage abgelehnt",
      converterMissing: "Kein Sprachmodell eingerichtet",
      modelRefused: "Das Sprachmodell hat das Rezept abgelehnt",
      interrupted: "Beim Anlegen des Rezepts unterbrochen",
      generic: "Fehlgeschlagen",
      details: "Technische Details",
    },
    dashboard: {
      subtitle: "Verbindungen, die letzten 30 Tage und die neuesten Aufträge.",
      workerPaused: "Warteschlange pausiert, bis die Sitzung funktioniert",
      workerStopped: "Worker gestoppt",
      health: {
        connected: "Verbunden",
        asUser: (user) => `als ${user}`,
        error: "Fehler",
        unchecked: "Nicht geprüft",
        sessionValid: "Sitzung gültig",
        until: "läuft ab",
        checked: (known) => (known ? "geprüft" : "noch nicht geprüft"),
        renew: "In den Einstellungen erneuern",
        autoLogin: "Automatische Anmeldung",
        unavailable: "Nicht verfügbar",
        off: "Aus",
        setUp: "Lidl-Konto hinterlegen",
        lastFailed: "Letzter Versuch fehlgeschlagen",
        active: "Aktiv",
        ai: "Sprachmodell",
      },
      kpi: {
        sent: "Rezepte gesendet (30 Tage)",
        sentHint: (total, skipped) =>
          `${total} ${total === 1 ? "Auftrag" : "Aufträge"}, ${skipped} übersprungen`,
        successRate: "Erfolgsquote",
        noFinished: "Noch keine abgeschlossenen Aufträge",
        failed: (count) => `${count} fehlgeschlagen`,
        duration: "Ø Dauer",
        durationHint: "pro gesendetem Rezept",
        cost: "Kosten (30 Tage)",
        costToday: (today, limit) => `Heute ${today} von ${limit}`,
        costTodayNoLimit: (today) => `Heute ${today}, ohne Limit`,
        costMeter: "Anteil am täglichen Kostenlimit",
      },
      setup: {
        title: "Einrichtung abschließen",
        progress: (done, total) => `${done} von ${total} erledigt`,
        dismiss: "Ausblenden",
        fix: "Einrichten",
        done: "erledigt",
        open: "offen",
        mealie: "Mealie erreichbar",
        session: "Monsieur-Cuisine-Sitzung gültig",
        autoLogin: "Automatische Anmeldung eingerichtet",
        action: "Rezeptaktion in Mealie",
        firstRecipe: "Erstes Rezept gesendet",
        firstRecipeHint:
          "Öffne in Mealie ein Rezept und wähle im Drei-Punkte-Menü die Aktion der Bridge.",
      },
      workerError: "Letzter Fehler des Workers",
      jobError: "Letzter fehlgeschlagener Auftrag",
      openJob: "Auftrag öffnen",
      recentJobs: "Neueste Aufträge",
      allJobs: "Alle Aufträge",
    },
    jobs: {
      subtitle: "Jedes Rezept, das Mealie an die Bridge geschickt hat, das neueste zuerst.",
      scale: (value) => `Faktor ${value}`,
      servings: (amount, unit) => `${amount} ${unit ?? "Portionen"}`,
      recipeLink: (id, status) => `${status === "draft" ? "Entwurf" : "Rezept"} ${id}`,
      image: "Bild",
      recipe: "Rezept",
      status: "Status",
      created: "Erstellt",
      duration: "Dauer",
      cost: "Kosten",
      actions: "Aktionen",
      open: "Öffnen",
      openEditor: "Im MC-Editor öffnen",
      retry: "Erneut versuchen",
      forceRebuild: "Neu senden erzwingen",
      forceConfirm:
        "Wandelt das Rezept neu um und lädt es hoch, auch wenn es sich nicht geändert hat. Das kostet einen Modellaufruf und legt ein weiteres Rezept in deinem Konto an.",
      cancel: "Auftrag abbrechen",
      cancelConfirm: "Der Auftrag verlässt die Warteschlange. Es wird nichts hochgeladen.",
      filterLabel: "Nach Status filtern",
      filters: {
        all: "Alle",
        active: "Aktiv",
        done: "Fertig",
        skipped: "Übersprungen",
        failed: "Fehlgeschlagen",
        cancelled: "Abgebrochen",
      },
      search: "Aufträge durchsuchen",
      searchPlaceholder: "Titel, Slug oder ID",
      empty: "Noch keine Aufträge",
      emptyHint: "Öffne in Mealie ein Rezept und wähle im Drei-Punkte-Menü die Aktion der Bridge.",
      noMatch: "Kein Auftrag passt zu diesem Filter.",
      noMore: "Keine älteren Aufträge.",
      reset: "Alle Aufträge zeigen",
      range: (from, to) => `${from} bis ${to}`,
      newer: "Neuere",
      older: "Ältere",
    },
    jobDetail: {
      tabsLabel: "Bereiche des Auftrags",
      tabs: { overview: "Übersicht", steps: "Schritte", ingredients: "Zutaten", events: "Verlauf" },
      openEditor: (status) =>
        status === "draft" ? "Entwurf im MC-Editor öffnen" : "Im MC-Editor öffnen",
      openInMealie: "In Mealie öffnen",
      facts: "Details",
      conversion: "Umwandlung",
      status: "Status",
      servings: "Portionen",
      scale: "Faktor",
      model: "Modell",
      tokens: "Tokens",
      tokenCounts: (input, cached, output) =>
        `${input} Eingabe${cached ? ` (${cached} aus dem Cache)` : ""}, ${output} Ausgabe`,
      cost: "Kosten",
      duration: "Dauer",
      attempts: "Versuche",
      forced: "erzwungen",
      created: "Erstellt",
      finished: "Beendet",
      ingredientIds: "Zutaten-IDs",
      resolutionOff: (unresolved) => `Zuordnung aus, ${unresolved} ohne ID`,
      resolution: (catalog, relaxed, cache, search, unresolved) =>
        `${catalog} aus dem Katalog${relaxed > 0 ? ` (${relaxed} ohne Zusätze im Namen)` : ""}, ${cache} aus dem Cache, ${search} aus der Suche, ${unresolved} ohne ID`,
      jobId: "Auftrags-ID",
      error: "Fehler",
      checkTitle: "Vor dem Kochen prüfen",
      checkLead:
        "Die Schritte hat ein Sprachmodell geschrieben. Prüfe Mengen, Zeiten, Temperaturen und Stufen im Editor, bevor du kochst.",
      reviewHints: "Prüfhinweise",
      noHints: "Der Konverter hat nichts Bestimmtes markiert.",
      warnings: "Hinweise des Konverters",
      noSteps:
        "Für diesen Auftrag ist kein umgewandeltes Rezept gespeichert. Es wird gespeichert, sobald die Prüfung bestanden ist.",
      noEvents: "Noch keine Einträge.",
      noIngredients: "Für diesen Auftrag sind keine umgewandelten Zutaten gespeichert.",
      ingredientsTitle: "Zutaten",
      ingredientsOff:
        "Zuordnung aus (MC_RESOLVE_INGREDIENTS=off), alle Zutaten gingen ohne ID hinaus",
      ingredientCounts: (withId, without) => `${withId} mit Katalog-ID, ${without} ohne`,
      ingredientsHint:
        "Die Monsieur-Cuisine-App setzt nur Zutaten mit ID auf die Einkaufsliste. Im Rezept stehen alle.",
      ingredient: "Zutat",
      amount: "Menge",
      catalogId: "Katalog-ID",
      withId: "Mit ID",
      withoutId: "Ohne ID",
    },
    steps: {
      modes: {
        customized: "Manuelles Kochen",
        roasting: "Anbraten",
        steaming: "Dampfgaren",
        kneading_solid_dough: "Fester Teig",
        kneading_soft_dough: "Weicher Teig",
        kneading_liquid_dough: "Flüssiger Teig",
        puree: "Pürieren",
        smoothie: "Smoothie",
        turbo: "Turbo",
        scale: "Waage",
        slow_cooking: "Slow Cook",
        sous_vide: "Sous-vide",
        fermentation: "Fermentieren",
        rice_cooking: "Reis kochen",
        cooking_eggs: "Eier kochen",
        precleaning: "Vorspülen",
        food_processor: "Food Processor",
      },
      temperature: "Temperatur",
      time: "Zeit",
      speed: (value) => `Stufe ${value}`,
      speedTitle: "Stufe",
      forward: "Rechtslauf",
      reverse: "Linkslauf",
      rotation: "Drehrichtung",
      whisk: "Rühraufsatz",
      accessory: "Aufsatz",
      weight: "Gewicht",
      eggSize: { small: "Größe S", medium: "Größe M", large: "Größe L" },
      eggSizeTitle: "Eigröße",
      eggTexture: { soft: "Weich", waxy_soft: "Wachsweich", hard: "Hart" },
      eggTextureTitle: "Konsistenz",
      cleaning: { short: "Kurz", long: "Lang" },
      servings: (amount, unit) => `${amount} ${unit}`,
      preparation: (minutes) => `${minutes} min Vorbereitung`,
      ready: (minutes) => `fertig in ${minutes} min`,
      ingredients: "Zutaten",
      optional: "optional",
      none: "Keine Schritte zum Anzeigen.",
    },
    dryRun: {
      subtitle: "Ein Rezept umwandeln, ohne etwas an Monsieur Cuisine zu senden.",
      formTitle: "Rezept",
      recipe: "Rezept",
      recipeHint: "Tippe einen Teil des Namens oder füge Slug oder ID ein.",
      recipePlaceholder: "Kürbissuppe",
      scale: "Faktor",
      scaleHint: "Wie der Faktor in Mealie, 0,25 bis 10.",
      convertNow: "Gleich umwandeln",
      convertNowHint: "Ruft das Sprachmodell auf, das kostet Geld. Hochgeladen wird nichts.",
      preview: "Vorschau",
      working: "Läuft…",
      sourceTitle: "Quelle",
      servings: "Ergibt",
      estimated: "Geschätzt",
      estimatedHelp:
        "Das Rezept nennt keine Portionen. Die Bridge nimmt eine Vorgabe an, das Modell schätzt und meldet es als Prüfhinweis.",
      sourceHash: "Quell-Hash",
      alreadySent: "Schon gesendet",
      wouldSkip: "Ein Auftrag würde übersprungen, außer er wird erzwungen.",
      notSent: "Nein",
      convert: "Umwandeln ohne Hochladen",
      loadFailed: "Rezept nicht geladen",
      matches: "Passende Rezepte",
      emptyTitle: "Wähle ein Rezept",
      empty:
        "Die Vorschau zeigt, was der Konverter bekommt, und nach der Umwandlung die Schritte so, wie die Maschine sie zeigt.",
      tabsLabel: "Ergebnis des Probelaufs",
      tabs: {
        preview: "Vorschau",
        input: "Markdown-Eingabe",
        ingredients: "Zutaten",
        checks: "Prüfhinweise",
      },
      notConverted: "Noch nicht umgewandelt",
      notConvertedHint:
        "Die Umwandlung ruft das Sprachmodell auf und kostet Geld. Hochgeladen wird nichts.",
      conversionFailed: "Umwandlung fehlgeschlagen",
      noIngredients: "Das Rezept hat keine Zutaten.",
      amount: "Menge",
      food: "Lebensmittel",
      note: "Hinweis",
      source: "Gelesen als",
      optional: "(optional)",
      unparsed: "freier Text",
      passed: "Prüfung bestanden",
      errors: (count) => `${count} Fehler`,
      reviewHints: "Prüfhinweise",
      warnings: "Hinweise des Konverters",
      conversion: "Umwandlung",
      model: "Modell",
      attempts: "Versuche",
      tokens: "Tokens",
      tokenCounts: (input, output) => `${input} Eingabe, ${output} Ausgabe`,
      cost: "Kosten",
      categories: "Kategorien",
      droppedIds: (ids) => `Unbekannte IDs entfernt: ${ids}`,
    },
    settings: {
      title: "Einstellungen",
      subtitle: "Sitzung, Konten und die Konfiguration, mit der die Bridge läuft.",
      tabsLabel: "Bereiche der Einstellungen",
      tabs: {
        mc: "Monsieur Cuisine",
        lidl: "Lidl-Konto",
        mealie: "Mealie",
        ai: "Sprachmodell",
        notify: "Benachrichtigungen",
        system: "System",
      },
      mc: {
        title: "Sitzung",
        checkNow: "Jetzt prüfen",
        checkHint: "Die Bridge prüft auch von selbst, alle SESSION_CHECK_MINUTES Minuten.",
        state: "Zustand",
        expires: "Anmeldung läuft ab",
        lastCheck: "Letzte Prüfung",
        age: "Alter",
        noCookie: "Kein Cookie hinterlegt",
        ageValue: (hours, from) => {
          const value =
            hours < 48
              ? `${formatNumber(hours, INTL)} h`
              : `${formatNumber(hours / 24, INTL)} Tage`;
          return `${value} ${from === "login" ? "seit der Anmeldung" : "seit dem Speichern in der Bridge"}`;
        },
        lastError: "Letzter Fehler",
        renewTitle: "Sitzung erneuern",
        ways: {
          auto: "Automatische Anmeldung",
          autoHint:
            "Einmal das Lidl-Konto hinterlegen; die Bridge meldet sich an, sobald die Sitzung abläuft.",
          autoLink: "Einrichten",
          helper: "Anmelde-Helfer",
          helperHint:
            "Läuft auf einem Rechner mit Browser und schickt die neue Sitzung an die Bridge.",
          cookie: "Cookie manuell setzen",
        },
        cookieLabel: "Cookie-Header",
        cookieHint:
          "Der Request-Header Cookie eines angemeldeten Tabs von www.monsieur-cuisine.com (Entwicklerwerkzeuge, eine beliebige Anfrage an proxy-api). Die Bridge prüft ihn an deinem Konto, bevor sie ihn verschlüsselt speichert.",
        saveCookie: "Prüfen und speichern",
      },
      lidl: {
        title: "Lidl-Konto",
        unavailable: "Die automatische Anmeldung ist in dieser Installation nicht verfügbar.",
        account: "Konto",
        notConfigured: "Kein Konto hinterlegt",
        browser: "Browser",
        browserReady: "Chromium ohne Fenster verfügbar",
        browserMissing: (reason) => `Nicht verfügbar: ${reason}`,
        state: "Zustand",
        running: "Anmeldung läuft",
        nextAttempt: "Nächster automatischer Versuch",
        nextTest: "Nächster manueller Test",
        testNow: "Anmeldung testen",
        howItWorks: "So funktioniert die automatische Anmeldung",
        facts: [
          "Wann: nur wenn sich die Sitzung als abgelaufen oder abgelehnt herausstellt, bei der regelmäßigen Prüfung oder während eines Auftrags. Eine funktionierende Sitzung bleibt unberührt.",
          "Wie oft: höchstens einmal pro Stunde und dreimal in 24 Stunden. Nach einem Fehlschlag wartet sie 1 Stunde, nach zwei in Folge 4 Stunden, nach drei 24 Stunden.",
          "Speicherort: E-Mail und Passwort liegen in bridge.db, verschlüsselt mit SETTINGS_KEY. Das Passwort wird nie angezeigt, geloggt oder an den Browser zurückgeschickt.",
          "Grenzen: Ein Captcha oder ein zweiter Faktor hält die Anmeldung auf. Dann kommt die Sitzungs-Mail, und du erneuerst die Sitzung auf einem anderen Weg.",
          "Lidl drosselt wiederholte Anmeldungen. Meldet die Seite, dass ihre Kapazität überschritten ist, wartet die Bridge mindestens eine Stunde, auch beim manuellen Test.",
          "Bei einem Fehlschlag hebt die Bridge ein Bildschirmfoto der Anmeldeseite auf (die letzten fünf), damit du siehst, was im Weg war.",
          "Löschen: unten. Dabei verschwinden auch die Bildschirmfotos.",
        ],
        storeAccount: "Konto hinterlegen",
        changeAccount: "Konto ändern",
        email: "E-Mail-Adresse",
        emailHint: "Die Adresse, mit der du dich auf www.monsieur-cuisine.com anmeldest.",
        password: "Passwort",
        passwordHint:
          "Wird verschlüsselt gespeichert. Leer lassen, um das gespeicherte zu behalten.",
        passwordStored: "gespeichert; leer lassen, um es zu behalten",
        save: "Konto speichern",
        dangerZone: "Konto löschen",
        remove: "Konto löschen",
        removeHint:
          "Entfernt E-Mail, Passwort und Bildschirmfotos. Die aktuelle Sitzung bleibt, bis sie abläuft.",
        removeConfirm:
          "Die Bridge vergisst das Lidl-Konto und kann sich nicht mehr selbst anmelden. Die aktuelle Sitzung bleibt, bis sie abläuft.",
        lastAttempt: "Letzter Versuch",
        succeeded: "Erfolgreich",
        failed: "Fehlgeschlagen",
        manual: "Manueller Test",
        screenshot: "Bildschirmfoto",
        failure: {
          browser_unavailable: "Der Browser ist nicht verfügbar.",
          no_login_form:
            "Es kam kein Anmeldeformular: Die Seite hat sich geändert, oder ein Captcha oder eine Zustimmungsseite kam dazwischen.",
          unknown_account:
            "Die Seite kennt die hinterlegte E-Mail-Adresse nicht. Prüfe das hinterlegte Konto.",
          wrong_password: "Die Seite meldet ein falsches Passwort. Prüfe das hinterlegte Konto.",
          rate_limited:
            "Lidl hat die Anmeldung vorübergehend gedrosselt. Warte mindestens eine Stunde, bevor du erneut testest: Jeder Versuch in der Zwischenzeit kann die Sperre verlängern. Am hinterlegten Konto liegt es nicht.",
          verification_required:
            "Die Seite verlangt ein Captcha oder einen Bestätigungscode. Melde dich einmal von Hand mit dem Anmelde-Helfer an.",
          not_logged_in:
            "Das Formular wurde abgeschickt, aber es kam keine Sitzung: falsches Passwort, Captcha oder zweiter Faktor.",
          unexpected_page:
            "Ein Anmeldeformular erschien auf einer Seite, die nicht die Lidl-Anmeldung ist; dort wurde nichts eingetragen.",
          verify_failed:
            "Die Anmeldung lief durch, aber Monsieur Cuisine lehnt die neue Sitzung ab.",
          error: "Der Browser ist ausgefallen.",
        },
        progressTitle: "Erreichte Schritte",
        steps: {
          page_reached: "Anmeldeseite erreicht",
          consent_dismissed: "Zustimmungsdialog abgelehnt",
          email_entered: "E-Mail-Adresse eingetragen",
          continue_clicked: "Weiter geklickt",
          password_page: "Passwortseite erreicht",
          password_entered: "Passwort eingetragen",
          redirect_reached: "Weiterleitung zu Monsieur Cuisine erreicht",
          terms_confirmed: "Nutzungsbedingungen bestätigt",
          device_chosen: "Gerät gewählt",
          cookies_received: "Sitzungscookies erhalten",
        },
        consentSteps: (count) => `Zustimmungsdialog abgelehnt (${count}×)`,
        consentDismissed: "Unterwegs wurde ein Zustimmungsdialog abgelehnt.",
        termsAccepted: "Nutzungsbedingungen wurden in deinem Namen bestätigt.",
        deviceChosen: "Als Gerät wurde MC Smart gewählt.",
        browserUsed: (name, mode) =>
          `Browser: ${name ?? "unbekannt"}, ${
            {
              new: "ohne Fenster (neuer Modus)",
              shell: "Headless-Shell",
              window: "sichtbares Fenster",
            }[mode]
          }`,
      },
      mealie: {
        title: "Verbindung",
        url: "Adresse",
        state: "Zustand",
        connected: "Verbunden",
        failed: "Keine Verbindung",
        unchecked: "Nicht geprüft",
        user: "API-Benutzer",
        error: "Fehler",
        lastCheck: "Letzte Prüfung",
        fix: "Prüfe MEALIE_URL und MEALIE_API_TOKEN in der .env und starte die Bridge neu.",
        actionTitle: "Rezeptaktion",
        actionSubtitle: "In Mealie: Einstellungen, Datenverwaltung, Rezeptaktionen; Typ post.",
        dockerUrl: "Im selben Docker-Netz",
        pageUrl: "Unter der Adresse dieser Seite",
        reveal: "URL mit Token anzeigen",
        allowList:
          'Mealie ab 3.26 sendet nur an Hosts auf seiner Erlaubnisliste: Trage HTTP_ALLOW_LIST: "mc-bridge" in Mealies Umgebung ein.',
        secret:
          "Das Token ist der einzige Schutz des Webhooks. Gib die URL nicht weiter; zum Ändern setzt du ein neues WEBHOOK_TOKEN und passt die Aktion an.",
        noToken: "Das Webhook-Token ist dieser Seite nicht bekannt.",
      },
      ai: {
        title: "Modell",
        provider: "Anbieter",
        providers: { openai: "OpenAI", anthropic: "Anthropic" },
        model: "Modell",
        effort: "Denkaufwand",
        corrections: "Korrekturrunden",
        readOnly:
          "Steht in der .env (LLM_PROVIDER und die Modelleinstellungen); nach einer Änderung die Bridge neu starten.",
        limits: "Limits und Verbrauch",
        jobsToday: "Aufträge, letzte 24 Stunden",
        costToday: "Kosten, letzte 24 Stunden",
        monthJobs: "Aufträge diesen Monat",
        monthCost: "Kosten diesen Monat",
        monthTokens: "Tokens diesen Monat",
        tokens: (input, output) => `${input} Eingabe, ${output} Ausgabe`,
        limitsHint:
          "JOB_DAILY_LIMIT und JOB_DAILY_COST_LIMIT_USD. Die Kosten sind Schätzungen aus der Preistabelle.",
      },
      notify: {
        title: "E-Mail",
        state: "Zustand",
        on: "An",
        off: "Aus",
        fromEnv: "aus der Umgebung",
        fromPage: "auf dieser Seite gespeichert",
        server: "Server",
        security: "Verschlüsselung",
        securityNames: { starttls: "STARTTLS", tls: "SSL/TLS", none: "Keine" },
        insecureAllowed: "unverschlüsselt erlaubt",
        recipient: "Empfänger",
        sender: "Absender",
        events: "Benachrichtigungen",
        eventNames: {
          session: "Sitzung abgelaufen oder ungültig",
          job: "Auftrag endgültig fehlgeschlagen",
          health: "Sitzungsprüfung scheitert",
        },
        noEvents: "Keine",
        test: "Testmail senden",
        sending: "Wird gesendet…",
        what: "Mails gehen hinaus, wenn die Sitzung abläuft, ein Auftrag endgültig fehlschlägt oder die Sitzungsprüfung immer wieder scheitert.",
        setUp:
          "Trage hier einen Mailserver ein oder setze SMTP_URL und NOTIFY_EMAIL in der Umgebung, um Mails zu abgelaufenen Sitzungen und fehlgeschlagenen Aufträgen zu bekommen.",
        unreadable:
          "Die gespeicherten Mail-Einstellungen lassen sich nicht lesen; vermutlich hat sich SETTINGS_KEY geändert. Bis du sie neu speicherst, gehen keine Mails hinaus.",
        unavailable: "Mail-Einstellungen sind in dieser Installation nicht verfügbar.",
        formTitle: "Mailserver",
        envHint:
          "Um die Werte hier zu bearbeiten, entferne SMTP_URL aus der Umgebung und starte die Bridge neu.",
        host: "Server",
        hostHint: "Host-Name oder IP-Adresse, zum Beispiel mail.example.com.",
        port: "Port",
        securityHint:
          "STARTTLS meist auf Port 587, SSL/TLS meist auf Port 465. Ohne Verschlüsselung gehen Passwort und Mails im Klartext durchs Netz.",
        allowInsecure: "Unverschlüsselt erlauben",
        allowInsecureHint:
          "Nur für einen Mailserver auf demselben Rechner oder in einem vertrauenswürdigen Netz. Mit STARTTLS sendet die Bridge dann auch, wenn der Server es nicht anbietet.",
        username: "Benutzername",
        usernameHint: "Leer lassen, wenn der Server keine Anmeldung verlangt.",
        password: "Passwort",
        passwordHint:
          "Wird verschlüsselt gespeichert und nie angezeigt. Nach einem Wechsel von Server oder Benutzername neu eingeben.",
        passwordStored: "gespeichert; leer lassen, um es zu behalten",
        from: "Absender",
        fromHint: "Leer lassen für den ersten Empfänger. Mit Namen: Bridge <bridge@example.com>.",
        to: "Empfänger",
        toHint: "Eine oder mehrere Adressen, durch Kommas getrennt, höchstens 10.",
        save: "Speichern",
        dangerZone: "Mail-Einstellungen löschen",
        remove: "Mail-Einstellungen löschen",
        removeHint:
          "Entfernt Server, Zugangsdaten und Empfänger. Danach gehen keine Mails mehr hinaus.",
        removeConfirm:
          "Die Bridge vergisst Mailserver, Zugangsdaten und Empfänger und sendet keine Mails mehr.",
        errors: {
          host_required: "Bitte einen Server angeben.",
          host_invalid: "Nur Host-Name oder IP-Adresse, ohne smtp:// und ohne Port.",
          port_invalid: "Ein Port von 1 bis 65535.",
          security_invalid: "Bitte STARTTLS, SSL/TLS oder Keine wählen.",
          security_insecure: "Ohne Verschlüsselung nur mit „Unverschlüsselt erlauben“.",
          username_invalid: "Höchstens 254 Zeichen, ohne Steuerzeichen.",
          password_required: "Bitte das Passwort eingeben.",
          password_reenter:
            "Server oder Benutzername sind neu: Bitte das Passwort noch einmal eingeben.",
          password_invalid: "Höchstens 1024 Zeichen.",
          from_invalid: "Eine E-Mail-Adresse, gern mit Namen: Bridge <bridge@example.com>.",
          to_required: "Bitte mindestens einen Empfänger angeben.",
          to_invalid: "Mindestens eine Adresse ist ungültig.",
          to_too_many: "Höchstens 10 Empfänger.",
        },
      },
      system: {
        title: "System",
        readme: "README",
        version: "Version",
        uptime: "Laufzeit",
        dataDir: "Datenverzeichnis",
        mcLocale: "Rezeptsprache",
        unverified: "nicht am Gerät geprüft",
        uiLanguage: "Sprache der Seiten",
        recipeStatus: "Rezeptstatus",
        recipeStatusHint: {
          "private-publish": "Privat auf deinem Gerät gespeichert; erscheint an der Maschine.",
          draft: "Bleibt ein Entwurf im Web-Editor; erscheint nicht an der Maschine.",
        },
        envHint: "Kommt aus der Umgebung; zum Ändern die .env anpassen und die Bridge neu starten.",
        advanced: "Erweitert: aktive Konfiguration",
        configHint:
          "Was die Bridge beim Start aus ihrer Umgebung gelesen hat. Bei Geheimnissen steht nur, ob sie gesetzt sind. Die Beschreibungen sind englisch.",
        name: "Variable",
        value: "Wert",
        description: "Bedeutung",
        hidden: "gesetzt (verborgen)",
        unset: "nicht gesetzt",
        isDefault: "Vorgabe",
        defaultLabel: "Vorgabe:",
        required: "Pflicht",
        valuesLabel: "Werte:",
      },
    },
  },
};
