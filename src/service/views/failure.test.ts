import { describe, expect, it } from "vitest";
import { CATALOGS } from "../../i18n/index.js";
import { INTERRUPTED_CREATE } from "../../store/jobs.js";
import { failureDetails, failureSummary } from "./failure.js";

const de = CATALOGS.de.admin;

describe("failure summaries", () => {
  it("name the kind of error in the language of the pages", () => {
    const cases: Array<[string, string]> = [
      [
        "The converted recipe failed validation: servingSize.steps[4].temperature 130 is above the limit",
        "Die Umwandlung hat die Gerätegrenzen verletzt",
      ],
      [
        "The recipe still has 2 errors after 4 attempts: servingSize.steps[1]: too long",
        "Die Umwandlung hat die Gerätegrenzen verletzt",
      ],
      ["converter not configured", "Kein Sprachmodell eingerichtet"],
      [
        "LLM_PROVIDER is openai, but OPENAI_API_KEY is not set. Put the key into OPENAI_API_KEY.",
        "Kein Sprachmodell eingerichtet",
      ],
      ["The openai model refused the request: unsafe", "Das Sprachmodell hat das Rezept abgelehnt"],
      [`timeout. ${INTERRUPTED_CREATE}`, "Beim Anlegen des Rezepts unterbrochen"],
      [
        "Mealie GET /api/recipes/x failed: no response from Mealie (fetch failed)",
        "Mealie nicht erreichbar",
      ],
      [
        "Mealie GET /api/recipes/x failed with 401: the API token is missing, invalid or revoked",
        "Mealie hat die Anfrage abgelehnt",
      ],
    ];
    for (const [error, summary] of cases) {
      expect(failureSummary(error, {}, de), error).toBe(summary);
    }
  });

  it("take the stage of the failure event, then a generic word", () => {
    expect(failureSummary("HTTP 503", { stage: "upload" }, de)).toBe(
      "Hochladen zu Monsieur Cuisine fehlgeschlagen",
    );
    expect(failureSummary("HTTP 503", { stage: "bogus" }, de)).toBe("Fehlgeschlagen");
    expect(failureSummary(null, {}, de)).toBe("Fehlgeschlagen");
    expect(failureSummary("anything", { status: "session_expired" }, de)).toBe(
      "Monsieur-Cuisine-Sitzung abgelaufen",
    );
    expect(failureSummary(null, { stage: "convert" }, CATALOGS.en.admin)).toBe(
      "The language model could not convert the recipe",
    );
  });

  it("keep the raw text, escaped, in a collapsed element", () => {
    const html = failureDetails("<b>boom</b>", de).html;
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Technische Details");
    expect(html).toContain("&lt;b&gt;boom&lt;/b&gt;");
  });
});
