import { describe, expect, it } from "vitest";
import { errorMessage, scrubSecrets } from "../app-logger.js";
import { credentialsMatch, parseBasicAuth, redactUrl, safeEqual } from "./security.js";

describe("safeEqual", () => {
  it("compares values of any length", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("a", "a".repeat(100))).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("parseBasicAuth and credentialsMatch", () => {
  const header = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;

  it("parses user and password, keeping colons in the password", () => {
    expect(parseBasicAuth(header("admin:pa:ss"))).toEqual({ user: "admin", password: "pa:ss" });
    expect(parseBasicAuth(header("ädmin:pässword"))).toEqual({
      user: "ädmin",
      password: "pässword",
    });
  });

  it("returns null for anything else", () => {
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    expect(parseBasicAuth(header("no-colon"))).toBeNull();
    expect(parseBasicAuth("Basic !!!")).toBeNull();
  });

  it("needs both user and password to match", () => {
    const expected = { user: "admin", password: "secret" };
    expect(credentialsMatch({ user: "admin", password: "secret" }, expected)).toBe(true);
    expect(credentialsMatch({ user: "admin", password: "wrong" }, expected)).toBe(false);
    expect(credentialsMatch({ user: "other", password: "secret" }, expected)).toBe(false);
    expect(credentialsMatch(null, expected)).toBe(false);
  });
});

describe("redactUrl", () => {
  it("hides the hook token and form tokens", () => {
    expect(redactUrl("/hooks/mealie/abc?x=1")).toBe("/hooks/mealie/[redacted]?x=1");
    expect(redactUrl("/admin/dry-run?recipe=a&_csrf=secret&convert=1")).toBe(
      "/admin/dry-run?recipe=a&_csrf=[redacted]&convert=1",
    );
    expect(redactUrl("/admin")).toBe("/admin");
  });
});

describe("scrubSecrets and errorMessage", () => {
  it("masks credentials in free text", () => {
    expect(scrubSecrets("Cookie: a=1; b=2")).toBe("Cookie: [redacted]");
    expect(scrubSecrets("set wordpress_logged_in_ab12=xyz; PHPSESSID=q")).toBe(
      "set wordpress_logged_in_ab12=[redacted]; PHPSESSID=[redacted]",
    );
    expect(scrubSecrets("Authorization: Bearer eyJ.abc.def")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(scrubSecrets('{"api_key": "sk-123"}')).toBe('{"api_key": "[redacted]"}');
    expect(scrubSecrets("POST /hooks/mealie/abc failed")).toBe(
      "POST /hooks/mealie/[redacted] failed",
    );
    expect(scrubSecrets("nothing secret here")).toBe("nothing secret here");
    expect(scrubSecrets("connect smtps://mailer:s3cr3t@mail.example.com:465 failed")).toBe(
      "connect smtps://[redacted]@mail.example.com:465 failed",
    );
    expect(scrubSecrets("see https://mealie.example.com/g/home and http://u:@h/x")).toBe(
      "see https://mealie.example.com/g/home and http://[redacted]@h/x",
    );
  });

  it("drops Playwright call logs and the values of fill()", () => {
    const marker = "MARKER-PASSWORD-91";
    const playwright = [
      "locator.fill: Timeout 1500ms exceeded.",
      "Call log:",
      "  - waiting for locator('input[type=\"password\"]').first()",
      `    - fill("${marker}")`,
    ].join("\n");
    expect(scrubSecrets(playwright)).toBe("locator.fill: Timeout 1500ms exceeded.");
    expect(errorMessage(new Error(playwright))).not.toContain(marker);
    expect(scrubSecrets(`retrying fill("${marker}") and type('x\\'y')`)).toBe(
      'retrying fill("[redacted]") and type("[redacted]")',
    );
  });

  it("turns any error into one short line", () => {
    expect(errorMessage(new Error("a\n  b"))).toBe("a b");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(new Error("x".repeat(600)))).toHaveLength(503);
  });
});
