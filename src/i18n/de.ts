// German texts for the timeline, mails and admin pages.

import { escapeMarkdown, formatDate, formatNumber, shorten } from "./format.js";
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
    failureReasons: FAILURE_REASONS,
  },
  jobEvents: {
    converting: "Konvertierung gestartet",
    stillConverting: (seconds) => `Konvertierung läuft noch, ${seconds} s`,
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
      `Die automatische Anmeldung mit dem hinterlegten Lidl-Konto versucht es ab ${time} wieder; so lange wartet sie nach früheren Versuchen. Schneller geht es mit „Anmeldung jetzt testen“ in den Einstellungen, dem Anmelde-Helfer oder dem Cookie-Formular.`,
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
    header: {
      mcSession: "MC-Sitzung",
      signedIn: (user) => `angemeldet als ${user}`,
      noPassword: "ohne Passwort",
    },
    authBanner: "Die Admin-Seiten haben kein Passwort. Setze ADMIN_USER und ADMIN_PASSWORD.",
    skipToContent: "Zum Inhalt springen",
    login: {
      title: "Anmelden",
      intro: "Melde dich mit ADMIN_USER und ADMIN_PASSWORD an. Die Anmeldung gilt 12 Stunden.",
      user: "Benutzer",
      password: "Passwort",
      submit: "Anmelden",
      wrongCredentials: "Benutzer oder Passwort stimmen nicht.",
      tooMany: (minutes) =>
        `Zu viele fehlgeschlagene Anmeldungen von dieser Adresse. Versuche es in ${minutes} ${minutes === 1 ? "Minute" : "Minuten"} wieder.`,
    },
    autoRefresh: "Die Seite lädt alle 5 Sekunden neu, solange ein Auftrag wartet oder läuft.",
    notices: {
      "session-saved":
        "Sitzung gespeichert. Aufträge, die darauf gewartet haben, stehen wieder in der Warteschlange.",
      "session-checked": "Sitzung geprüft.",
      "job-queued": "Der Auftrag steht wieder in der Warteschlange.",
      "job-forced":
        "Der Auftrag steht wieder in der Warteschlange und wird gesendet, auch wenn sich das Rezept nicht geändert hat.",
      "job-cancelled": "Auftrag abgebrochen.",
      "logged-out": "Abgemeldet.",
      "credentials-saved": "Lidl-Konto verschlüsselt gespeichert.",
      "credentials-deleted": "Lidl-Konto gelöscht.",
      "login-started": "Anmeldung gestartet. Die Seite lädt neu, bis sie fertig ist.",
      "login-running": "Es läuft schon eine Anmeldung.",
      "login-no-credentials": "Bitte zuerst das Lidl-Konto hinterlegen.",
      "login-cooldown":
        "Ein manueller Test läuft höchstens alle 3 Minuten. Bitte gleich noch einmal versuchen.",
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
      noSuchJob: "Diesen Auftrag gibt es nicht. Vielleicht ist der Link falsch.",
      recipeNotLoaded: (reason) => `Das Rezept ließ sich nicht laden: ${reason}`,
      conversionLinkExpired:
        "Der Link zur Umwandlung ist abgelaufen (die Bridge wurde neu gestartet, oder der Link stammt von woanders). Nutze den Knopf unten.",
      conversionFailed: (reason) => `Die Umwandlung ist fehlgeschlagen: ${reason}`,
      credentialsInvalid: (field) =>
        field === "email"
          ? "Das Konto wurde nicht gespeichert: Die E-Mail-Adresse ist ungültig."
          : "Das Konto wurde nicht gespeichert: Das Passwort fehlt.",
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
    jobStatusHelp: {
      queued:
        "Wartet auf den Worker. Er beginnt in wenigen Sekunden, außer ein anderer Auftrag läuft.",
      running: "Die Bridge wandelt das Rezept gerade um oder lädt es hoch.",
      done: "Das Rezept liegt in deinem Monsieur-Cuisine-Konto.",
      skipped:
        "Dasselbe Rezept mit demselben Faktor wurde schon gesendet und hat sich nicht geändert. Es wurde nichts hochgeladen.",
      failed:
        "Mit einem Fehler beendet. Die Seite des Auftrags nennt ihn, dort lässt er sich neu starten.",
      session_expired:
        "Wartet auf eine gültige Monsieur-Cuisine-Sitzung und läuft von selbst weiter, sobald sie wieder funktioniert.",
      cancelled: "Von Hand abgebrochen. Er läuft nicht mehr.",
    },
    sessionState: {
      valid: "gültig",
      invalid: "ungültig",
      expired: "abgelaufen",
      unknown: "unbekannt",
    },
    jobsTable: {
      empty: "Noch keine Aufträge.",
      emptyHint:
        "Öffne in Mealie ein Rezept und wähle im Drei-Punkte-Menü die Rezeptaktion der Bridge. Der Auftrag erscheint dann hier. Wie du die Aktion anlegst, steht in der Übersicht.",
      created: "Erstellt",
      recipe: "Rezept",
      scale: "Faktor",
      status: "Status",
      duration: "Dauer",
      cost: "Kosten",
      result: "Ergebnis",
      recipeLink: (id, status) => `${status === "draft" ? "Entwurf" : "Rezept"} ${id}`,
    },
    setup: {
      title: "Erste Schritte",
      lead: "Fünf Schritte von der frischen Installation bis zum ersten Rezept am Gerät. Die Markierungen zeigen, was die Bridge gerade sieht.",
      stepState: { done: "erledigt", open: "offen", failed: "Problem", unknown: "unbekannt" },
      mealie: {
        title: "Mealie mit dem API-Token erreichbar",
        ok: (url) => `Mealie unter \`${url}\` antwortet und nimmt das API-Token an.`,
        failed: (url) => `Mealie unter \`${url}\` hat die Anfrage nicht angenommen.`,
        unchecked: (url) => `Nicht geprüft. Mealie-Adresse: \`${url}\`.`,
        fix: "Prüfe `MEALIE_URL` (wie die Bridge Mealie erreicht, zum Beispiel `http://mealie:9000` im gemeinsamen Docker-Netz) und `MEALIE_API_TOKEN` in der `.env` und starte die Bridge neu.",
        timeout: (seconds) => `keine Antwort innerhalb von ${seconds} s`,
      },
      session: {
        title: "Monsieur-Cuisine-Sitzung",
        valid: "Gültig. Die Bridge kann Rezepte hochladen.",
        validUntil: (time, expired) =>
          expired
            ? `Bei der letzten Prüfung gültig, aber die Anmeldung dahinter endete am ${time}.`
            : `Gültig. Die Anmeldung endet am ${time}; vorher erneuert die Bridge sie oder sagt dir Bescheid.`,
        notValid: (state) =>
          `Zustand: ${state}. Ohne gültige Sitzung lässt sich nichts hochladen; Aufträge warten, bis sie funktioniert.`,
        fix: "Sitzung in den Einstellungen erneuern",
      },
      autoLogin: {
        title: "Automatische Anmeldung (empfohlen)",
        configured: (email) =>
          `Eingerichtet mit ${email}. Läuft die Sitzung ab, meldet sich die Bridge selbst wieder an.`,
        notConfigured:
          "Nicht eingerichtet. Ohne sie erneuerst du die Sitzung etwa alle zwei Wochen von Hand.",
        fix: "Lidl-Konto in den Einstellungen hinterlegen",
        unavailable: "In dieser Installation nicht verfügbar.",
      },
      action: {
        title: "Rezeptaktion in Mealie",
        seen: (jobs) =>
          `Mealie hat die Bridge schon aufgerufen: bisher ${jobs} ${jobs === 1 ? "Auftrag" : "Aufträge"}.`,
        notSeen: "Mealie hat die Bridge noch nicht aufgerufen.",
        where:
          "Öffne in Mealie die Einstellungen, dort Datenverwaltung und die Rezeptaktionen (englisch: Settings › Data Management › Recipe Actions), und lege eine Aktion an. Titel: zum Beispiel `An Monsieur Cuisine senden`. Typ: `post`. URL:",
        reveal: "URL mit Token anzeigen",
        dockerLabel:
          "Mealie und Bridge im selben Docker-Netz (der Compose-Dienst heißt mc-bridge):",
        pageLabel:
          "Oder die Adresse, unter der du diese Seite geöffnet hast, falls Mealie die Bridge dort erreicht:",
        secret:
          "Das Token ist der einzige Schutz des Webhooks. Gib die URL nicht weiter; zum Ändern setzt du ein neues WEBHOOK_TOKEN und passt die Aktion an.",
        noToken: "Das Webhook-Token ist dieser Seite nicht bekannt.",
        network:
          'Mealie ab 3.26 sendet nur an Hosts auf seiner Erlaubnisliste: Trage `HTTP_ALLOW_LIST: "mc-bridge"` in Mealies Umgebung ein. Jeder Haushalt, der den Knopf haben will, braucht eine eigene Aktion.',
      },
      firstJob: {
        title: "Erstes Rezept gesendet",
        done: (count) =>
          `${count} ${count === 1 ? "Rezept" : "Rezepte"} gesendet. Am Gerät findest du sie unter „Meine Rezepte“.`,
        notYet:
          "Öffne in Mealie ein Rezept, stelle die Portionen ein, wähle die Aktion im Drei-Punkte-Menü und verfolge den Auftrag unter Aufträge. Eine Umwandlung dauert eine bis einige Minuten.",
      },
    },
    dashboard: {
      lead: "Der Zustand der Bridge auf einen Blick: was eingerichtet ist, was wartet und was zuletzt schiefging.",
      state: "Zustand",
      lastCheck: "Letzte Prüfung",
      cookieAge: "Alter des Cookies",
      noCookie: "kein Cookie",
      age: (hours, from) => {
        const value =
          hours < 48 ? `${formatNumber(hours, INTL)} h` : `${formatNumber(hours / 24, INTL)} Tage`;
        return `${value} ${from === "login" ? "seit der Anmeldung" : "seit dem Speichern in der Bridge"}`;
      },
      cookieExpires: "Anmeldung läuft ab",
      expiresAt: (time, expired) => `am ${time}${expired ? " (abgelaufen)" : ""}`,
      lastError: "Letzter Fehler",
      checkNow: "Jetzt prüfen",
      cookieLabel:
        "Füge den Request-Header `Cookie` eines angemeldeten Tabs von www.monsieur-cuisine.com ein (Entwicklerwerkzeuge, Netzwerk, eine beliebige Anfrage an `proxy-api`). Die Bridge prüft ihn an deinem Konto, bevor sie ihn verschlüsselt speichert.",
      saveSession: "Sitzung speichern",
      queue: "Warteschlange",
      queueLead:
        "Aufträge je Status. Der Worker bearbeitet einen Auftrag nach dem anderen und pausiert, solange die Sitzung nicht funktioniert.",
      worker: "Worker:",
      unknown: "unbekannt",
      paused: "pausiert, bis die Sitzung funktioniert",
      running: "läuft",
      stopped: "gestoppt",
      workerError: (time) => `Fehler des Workers am ${time}`,
      jobError: (time) => `Fehlgeschlagener Auftrag am ${time}`,
      noErrors: "Bisher keine Fehler.",
      recentJobs: "Letzte 10 Aufträge",
    },
    jobList: {
      lead: "Jedes Rezept, das Mealie an die Bridge geschickt hat, das neueste zuerst. Ein Klick auf den Auftrag zeigt den Verlauf, die Punkte vor dem Kochen und die Knöpfe zum Wiederholen.",
      status: "Status",
      all: "alle",
      recipe: "Rezept",
      searchPlaceholder: "Titel, Slug oder ID",
      filter: "Filtern",
      reset: "Alle Aufträge zeigen",
      noMatch: "Kein Auftrag passt zu diesem Filter.",
      noMore: "Keine älteren Aufträge.",
      newer: "Neuere",
      older: "Ältere",
      legend: "Was die Status bedeuten",
    },
    jobDetail: {
      lead: "Ein Rezept aus Mealie auf dem Weg zum Gerät: was passiert ist, was du prüfen solltest und was du damit tun kannst.",
      facts: "Details",
      job: "Auftrag",
      mealieRecipe: "Mealie-Rezept",
      monsieurCuisine: "Monsieur Cuisine",
      openRecipe: (id, status) =>
        `${status === "draft" ? "Entwurf" : "Rezept"} ${id} im Editor öffnen`,
      openInMealie: "in Mealie öffnen",
      scale: "Faktor",
      servingSize: (amount, unit) => ` (${amount} ${unit ?? "Portionen"})`,
      attempts: "Versuche",
      forced: " · erzwungen",
      created: "Erstellt",
      started: "Gestartet",
      finished: "Beendet",
      duration: "Dauer",
      model: "Modell",
      usage: "Verbrauch",
      tokens: (input, cached, output) =>
        `${input} Eingabe-Tokens${cached ? ` (${cached} aus dem Cache)` : ""}, ${output} Ausgabe-Tokens`,
      ingredientIds: "Zutaten-IDs",
      resolutionOff: (unresolved) => `Zuordnung ausgeschaltet (${unresolved} ohne ID)`,
      resolution: (catalog, relaxed, cache, search, unresolved) =>
        `${catalog} aus dem Katalog${relaxed > 0 ? ` (${relaxed} ohne Zusätze im Namen)` : ""}, ${cache} aus dem Cache, ${search} aus der Suche, ${unresolved} ohne ID`,
      checkTitle: "Vor dem Kochen prüfen",
      checkLead:
        "Die Schritte hat ein Sprachmodell geschrieben. Öffne das Rezept im Editor und prüfe Mengen, Zeiten, Temperaturen und Stufen, bevor du damit kochst.",
      noHints: "Der Konverter hat nichts Bestimmtes markiert.",
      reviewHints: "Prüfhinweise",
      warnings: "Hinweise des Konverters",
      error: "Fehler",
      actions: "Aktionen",
      runningLocked: "Laufende Aufträge lassen sich nicht ändern. Warte, bis er fertig ist.",
      retry: "Erneut versuchen",
      retryHelp:
        "Stellt den Auftrag wieder in die Warteschlange. Hat sich das Rezept nicht geändert, nutzt er die gespeicherte Umwandlung und überspringt das Hochladen, wenn diese Fassung schon gesendet ist.",
      forceRebuild: "Neu senden erzwingen",
      forceRebuildHelp:
        "Wandelt das Rezept neu um und lädt es hoch, auch wenn es sich nicht geändert hat. Kostet einen Aufruf des Sprachmodells und legt ein weiteres Rezept in deinem Konto an.",
      cancel: "Abbrechen",
      cancelHelp: "Nimmt den Auftrag aus der Warteschlange. Es wird nichts hochgeladen.",
      events: "Verlauf",
      noEvents: "Noch keine Einträge.",
      ingredients: "Zutaten und Monsieur-Cuisine-IDs",
      ingredientsLead:
        "Die Monsieur-Cuisine-App braucht für ihre Einkaufsliste eine Zutaten-ID. Zutaten ohne ID stehen trotzdem im Rezept, nur nicht auf der Liste.",
      ingredientsOff:
        "Die Zuordnung ist ausgeschaltet (MC_RESOLVE_INGREDIENTS=off): Alle Zutaten gingen ohne ID hinaus.",
      resolved: (count) => `Mit ID (${count})`,
      withoutId: (count) => `Ohne ID (${count})`,
      noneResolved: "Keine.",
      noneUnresolved: "Keine. Jede Zutat hat eine ID bekommen.",
    },
    settings: {
      title: "Einstellungen",
      lead: "Wie die Bridge bei Monsieur Cuisine angemeldet bleibt, und mit welcher Konfiguration sie läuft.",
      session: {
        title: "Monsieur-Cuisine-Sitzung",
        lead: "Monsieur Cuisine hat keine öffentliche Schnittstelle zum Schreiben von Rezepten. Die Bridge nutzt die Schnittstelle des Rezepteditors mit dem Cookie einer angemeldeten Browsersitzung. Sie speichert dieses Cookie verschlüsselt mit `SETTINGS_KEY`. Eine Anmeldung gilt 14 Tage; danach läuft das Cookie ab und muss erneuert werden.",
        checkHelp:
          "Fragt Monsieur Cuisine, ob das gespeicherte Cookie noch funktioniert. Die Bridge tut das von selbst alle `SESSION_CHECK_MINUTES` Minuten.",
        renewTitle: "Drei Wege, die Sitzung zu erneuern",
        renewWays: [
          "Automatische Anmeldung (unten): Einmal das Lidl-Konto hinterlegen, dann meldet sich die Bridge selbst an, wenn die Sitzung abläuft.",
          "Anmelde-Helfer auf einem Rechner mit Browser: `npm run mc:login -- --bridge http://<Adresse der Bridge>:3000` öffnet die Anmeldeseite und schickt die Sitzung an die Bridge.",
          "Cookie von Hand einfügen: Auf www.monsieur-cuisine.com anmelden, den Request-Header `Cookie` aus den Entwicklerwerkzeugen des Browsers kopieren und unten einfügen.",
        ],
        cookieLabel: "Cookie-Header",
      },
      account: "Lidl-Konto für die automatische Anmeldung",
      intro:
        "Mit E-Mail-Adresse und Passwort deines Lidl-Kontos für monsieur-cuisine.com meldet sich die Bridge selbst in einem Browser ohne Fenster an, sobald die Sitzung abgelaufen ist.",
      facts: [
        "Wann: nur wenn sich die Sitzung als abgelaufen oder abgelehnt herausstellt, bei der regelmäßigen Prüfung oder während eines Auftrags. Eine funktionierende Sitzung bleibt unberührt.",
        "Wie oft: höchstens einmal pro Stunde und dreimal in 24 Stunden. Nach einem Fehlschlag wartet sie 1 Stunde, nach zwei in Folge 4 Stunden, nach drei 24 Stunden.",
        "Speicherort: E-Mail und Passwort liegen in `bridge.db`, verschlüsselt mit `SETTINGS_KEY`. Das Passwort wird nie angezeigt, geloggt oder an den Browser zurückgeschickt.",
        "Grenzen: Ein Captcha oder ein zweiter Faktor hält die Anmeldung auf. Dann kommt die Sitzungs-Mail, und du erneuerst die Sitzung auf einem anderen Weg.",
        "Bei einem Fehlschlag hebt die Bridge ein Bildschirmfoto der Anmeldeseite auf (die letzten fünf), unten verlinkt, damit du siehst, was im Weg war.",
        "Löschen: mit dem Knopf unten. Dabei verschwinden auch die Bildschirmfotos und das Browserprofil.",
      ],
      unavailable: "Die automatische Anmeldung ist in dieser Installation nicht verfügbar.",
      accountState: "Konto",
      storeAccount: "Konto hinterlegen",
      changeAccount: "Konto ändern",
      email: "E-Mail-Adresse",
      emailHelp:
        "Die Adresse, mit der du dich auf www.monsieur-cuisine.com anmeldest (Lidl-Konto).",
      password: "Passwort",
      passwordHelp:
        "Wird verschlüsselt mit `SETTINGS_KEY` gespeichert. Lass das Feld leer, um das gespeicherte Passwort zu behalten.",
      passwordStored: "gespeichert; leer lassen, um es zu behalten",
      save: "Konto speichern",
      testNow: "Anmeldung jetzt testen",
      testHelp:
        "Meldet sich sofort einmal an, egal wie es der Sitzung geht, und speichert die neue Sitzung, wenn es klappt. Höchstens alle 3 Minuten; zählt nicht zu den Grenzen pro Stunde und Tag.",
      remove: "Konto löschen",
      removeHelp:
        "Löscht E-Mail, Passwort, Bildschirmfotos und das Browserprofil. Die aktuelle Sitzung bleibt, bis sie abläuft.",
      notConfigured: "Kein Konto hinterlegt.",
      configuredAs: (email) => `Hinterlegtes Konto: ${email}`,
      browser: "Browser",
      browserReady: "Chromium ohne Fenster verfügbar",
      browserMissing: (reason) => `nicht verfügbar: ${reason}`,
      lastAttempt: "Letzter Anmeldeversuch",
      never: "noch keiner",
      attempt: (time, ok, manual) =>
        `${time}: ${ok ? "erfolgreich" : "fehlgeschlagen"}${manual ? " (manueller Test)" : ""}`,
      failure: {
        browser_unavailable: "Der Browser ist nicht verfügbar.",
        no_login_form:
          "Es kam kein Anmeldeformular: Die Seite hat sich geändert, oder ein Captcha oder eine Zustimmungsseite kam dazwischen.",
        wrong_password: "Die Seite meldet ein falsches Passwort. Prüfe das hinterlegte Konto.",
        verification_required:
          "Die Seite verlangt ein Captcha oder einen Bestätigungscode. Melde dich einmal von Hand mit dem Anmelde-Helfer an.",
        not_logged_in:
          "Das Formular wurde abgeschickt, aber es kam keine Sitzung: falsches Passwort, Captcha oder zweiter Faktor.",
        verify_failed: "Die Anmeldung lief durch, aber Monsieur Cuisine lehnt die neue Sitzung ab.",
        error: "Der Browser ist ausgefallen.",
      },
      consentDismissed: "Unterwegs wurde ein Zustimmungsdialog abgelehnt.",
      screenshot: "Bildschirmfoto der Seite",
      nextAttempt: "Nächster automatischer Versuch frühestens",
      running: "Eine Anmeldung läuft.",
      manualCooldown: (time) => `Nächster manueller Test ab ${time}`,
      locale: {
        title: "Sprache und Rezeptstatus",
        lead: "Kommen aus der Umgebung; zum Ändern die .env anpassen und die Bridge neu starten.",
        unverified: "nicht am Gerät geprüft",
        mcLocale:
          "Sprache der Rezepte, die die Bridge schreibt, und die passenden Monsieur-Cuisine-Einstellungen (Kategorien, Schwierigkeit, Editor-Adresse).",
        uiLanguage: "Sprache dieser Seiten, der Einträge in der Mealie-Zeitleiste und der Mails.",
        recipeStatus: {
          "private-publish":
            "Neue Rezepte werden privat auf deinem Gerät gespeichert: Sie erscheinen an der Maschine, und niemand sonst sieht sie.",
          draft:
            "Neue Rezepte bleiben Entwürfe im Web-Editor und erscheinen nicht an der Maschine. Gedacht zur Fehlersuche.",
        },
      },
      config: {
        title: "Aktive Konfiguration",
        lead: "Was die Bridge beim Start aus ihrer Umgebung (`.env` oder Compose-Datei) gelesen hat. Nur zum Lesen: Werte dort ändern und die Bridge neu starten. Bei Geheimnissen steht nur, ob sie gesetzt sind. Die Beschreibungen stammen aus der Konfigurationsreferenz im README und sind englisch.",
        unavailable: "Die Konfiguration ist auf dieser Seite nicht verfügbar.",
        name: "Variable",
        value: "Aktueller Wert",
        description: "Bedeutung",
        hidden: "gesetzt (verborgen)",
        unset: "nicht gesetzt",
        isDefault: "Vorgabe",
        defaultLabel: "Vorgabe:",
        required: "Pflicht",
        valuesLabel: "Werte:",
      },
    },
    dryRun: {
      lead: "Probiere ein Mealie-Rezept aus, ohne etwas an Monsieur Cuisine zu senden. Die Vorschau zeigt, was der Konverter bekäme. Mit Umwandlung zeigt sie auch, was er daraus macht; das ruft das Sprachmodell auf und kostet Geld, hochgeladen wird trotzdem nichts.",
      formTitle: "Rezept",
      recipe: "Rezept",
      recipePlaceholder: "ID oder Slug",
      recipeHelp:
        "Der Slug ist der letzte Teil der Rezept-URL in Mealie, zum Beispiel `kuerbissuppe` in `/g/home/r/kuerbissuppe`.",
      scale: "Faktor",
      scaleHelp:
        "Vervielfacht die Portionen wie der Faktor in Mealie. 1 lässt das Rezept, wie es ist.",
      preview: "Vorschau",
      alsoConvert: "Gleich umwandeln",
      alsoConvertHelp:
        "Ruft das Sprachmodell auf, was Geld kostet, und zeigt die Schritte, die hochgeladen würden. Hochgeladen wird nichts.",
      servings: "Ergibt",
      servingsEstimated:
        "Vorgabe, im Rezept nicht angegeben; das Modell schätzt und meldet es als Prüfhinweis",
      sourceHash: "Quell-Hash",
      alreadySent: "Schon gesendet",
      sentAt: (time) => `ja, ${time}:`,
      wouldSkip: "(ein Auftrag würde übersprungen, außer er wird erzwungen)",
      no: "nein",
      convert: "Umwandeln ohne Hochladen",
      costsMoney: "Ruft das Sprachmodell auf; das kostet Geld.",
      ingredients: "Zutaten",
      ingredientsLead:
        "So hat die Bridge die Zutaten aus Mealie gelesen, schon umgerechnet. Zeilen mit „unparsed“ gehen als freier Text an das Modell.",
      noIngredients: "Das Rezept hat keine Zutaten.",
      section: "Abschnitt",
      amount: "Menge",
      unit: "Einheit",
      food: "Lebensmittel",
      note: "Hinweis",
      source: "Quelle",
      original: "Original",
      optional: "(optional)",
      converterInput: "Eingabe des Konverters (Markdown)",
      converterInputLead: "Das Rezept so, wie das Sprachmodell es bekommt.",
      conversion: "Umwandlung",
      conversionLead:
        "Was das Modell gemacht hat, nach der Prüfung gegen die Gerätegrenzen und Kochregeln.",
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
      noHints: "Der Konverter hat nichts Bestimmtes markiert.",
      warnings: "Hinweise des Konverters",
      steps: "Schritte",
      kind: "Art",
      settings: "Einstellungen",
      text: "Text",
      ingredientGroups: "Zutatengruppen",
    },
  },
};
