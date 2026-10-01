import { beforeAll, describe, expect, it, vi } from "vitest";

import { current, install } from "/app/locale.js";
import { PSEUDO_TAG, english, notProse, pseudoTable, untranslated, type Allowance } from "./pseudo-locale.ts";
import {
  CLAIM_REFUSALS, JOIN_REFUSALS, LOGIN_REFUSALS, PASSKEY_REFUSALS, answer, app, boot, claimScreen, fillClaim, joinScreen,
  passkey, refused, route, session, signInScreen, until, withPasskeys,
} from "./preauth-driver.ts";

/**
 * T4 for the pages before sign-in (ADR 30, ADR 46): the claim, the recovery codes, sign-in with its passkey, the
 * invitation, the status strip, the session's endings and every refusal each can show, in the pseudo-locale
 * (`pseudo-locale.ts`), show no Latin word outside `lang="en"`, `<code>`, `<kbd>` and `<samp>`.
 *
 * The script is booted once under `?locale=zh-Hans` (it keeps module state), then the pseudo table is installed
 * over that locale's, which merges, so every page it draws afterwards takes its words from the pseudo table and
 * its `<span lang="en">` marks are the ones a translated locale gets. Drawn once at boot and so left in Chinese:
 * the title, the wordmark's lockup and the language switch; those are Han or marked, and read here as they are.
 *
 * Latin by design and allowed: the Node's messages and the browser's failure reasons (`<span lang="en">`), the
 * NOT_PROSE entries of the three framework-free scripts, and this page's host (a hostname in the strip). The
 * recovery codes are this test's own data and carry no letter.
 */

vi.mock("./session-stub.ts", async (original) => (await import("./preauth-driver.ts")).controlled(await original()));

const ALLOWANCE: Allowance = {
  notWords: notProse((file) => ["src/client/app.client.js", "src/client/session.client.js", "src/client/theme.client.js"].includes(file)),
  latin: [location.host],
};

/** Every hit on the page now, the strip and the screen, and the document's title. */
function scan(): string[] {
  const hits = untranslated(document.body, ALLOWANCE);
  if (english(document.title, ALLOWANCE)) hits.push(`<title>: ${JSON.stringify(document.title)}`);
  return hits;
}

/** The Node's words on the page inside `lang="en"`: the witness that a refusal was read and shown. */
const marked = (): number => document.body.querySelectorAll("#app [lang=en]").length;

/** The page the script draws on load, a Node that does not answer: drawn only then, so read in Chinese (below). */
let atBoot: string[] = [];

beforeAll(async () => {
  history.replaceState(null, "", "/?locale=zh-Hans");
  await boot();
  atBoot = scan();
  install(current(), pseudoTable());
  document.documentElement.lang = PSEUDO_TAG;
});

describe("the pages before sign-in, in the pseudo-locale, show no English outside lang=en, code, kbd and samp", () => {
  it("a Node that does not answer, read in Chinese, since only the script's first route() draws it", () => {
    expect(app().textContent, "the boot page was not the unreachable one").not.toBe("");
    expect(atBoot).toEqual([]);
  });

  it("the claim, while it claims, and each of its refusals", async () => {
    await claimScreen();
    const hits = new Set(scan());
    let settle: (response: Response) => void = () => undefined;
    answer("/api/claim", () => new Promise<Response>((resolve) => { settle = resolve; }));
    fillClaim();
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => (app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "the claim never started");
    for (const hit of scan()) hits.add(hit);
    settle(Response.json({}, { status: 502 }));
    await until(() => !(app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "the claim never ended");
    let shown = 0;
    for (const [status, body] of Object.values(CLAIM_REFUSALS)) {
      fillClaim();
      await refused("/api/claim", () => Response.json(body, { status }));
      shown += marked();
      for (const hit of scan()) hits.add(hit);
    }
    expect(shown, "no refusal showed the Node's words, so none was read").toBeGreaterThan(0);
    expect([...hits]).toEqual([]);
  });

  it("the recovery codes, and the strip while the session renews", async () => {
    await claimScreen();
    answer("/api/claim", () => {
      session.signedIn = true;
      session.expiresAt = Date.now() + 125_500;
      return Response.json({ claimed: true, recoveryCodes: ["1234-5678-9012", "3456-7890-1234"] });
    });
    fillClaim();
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => app().querySelector("ol.codes") !== null, "the codes never showed");
    const hits = new Set(scan());
    session.listener!({ type: "refreshed" });
    for (const hit of scan()) hits.add(hit);
    answer("/health", () => Response.json({ claimed: false, outboxPending: 0 }));
    await route();
    for (const hit of scan()) hits.add(hit);
    session.signedIn = false;
    expect([...hits]).toEqual([]);
  });

  it("sign-in, while it signs in, each refusal, and each way a session ends", async () => {
    await signInScreen();
    const hits = new Set(scan());
    let settle: (response: Response) => void = () => undefined;
    answer("/api/auth/login", () => new Promise<Response>((resolve) => { settle = resolve; }));
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => (app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "sign-in never started");
    for (const hit of scan()) hits.add(hit);
    settle(Response.json({}, { status: 502 }));
    await until(() => !(app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "sign-in never ended");
    for (const [status, body] of Object.values(LOGIN_REFUSALS)) {
      await refused("/api/auth/login", () => Response.json(body, { status }));
      for (const hit of scan()) hits.add(hit);
    }
    // The Node's reasons carry its message; the page's own (`refresh_did_not_help`, `session_ended`, `signed_out`) do not.
    const ended = "Your session has ended. Please sign in again.";
    const ENDED = [
      { reason: "no_refresh_token", message: ended }, { reason: "expired", message: ended }, { reason: "unknown", message: ended },
      { reason: "reuse_detected", message: "This session was signed out because its token was used twice. Sign in again." },
      { reason: "refresh_did_not_help" }, { reason: "session_ended" }, { reason: "signed_out" },
    ];
    for (const event of ENDED) {
      session.signedIn = false;
      session.listener!({ type: "signed-out", ...event });
      for (const hit of scan()) hits.add(hit);
    }
    expect([...hits]).toEqual([]);
  });

  it("the passkey: unsupported, refused before and after the ceremony, unanswered, cancelled", async () => {
    await signInScreen();
    await passkey();
    const hits = new Set(scan());
    withPasskeys();
    answer("/api/auth/passkeys/challenge", () => Response.json({}, { status: 500 }));
    await passkey();
    for (const hit of scan()) hits.add(hit);
    answer("/api/auth/passkeys/challenge", () => { throw new TypeError("Failed to fetch"); });
    await passkey();
    for (const hit of scan()) hits.add(hit);
    answer("/api/auth/passkeys/challenge", () => Response.json({ publicKey: { challenge: "AQID", rpId: "localhost" } }));
    for (const [status, body] of Object.values(PASSKEY_REFUSALS)) {
      answer("/api/auth/passkeys/verify", () => Response.json(body, { status }));
      await passkey();
      for (const hit of scan()) hits.add(hit);
    }
    withPasskeys(true);
    await passkey();
    for (const hit of scan()) hits.add(hit);
    expect([...hits]).toEqual([]);
  });

  it("the invitation, and each of its refusals", async () => {
    await joinScreen();
    const hits = new Set(scan());
    for (const [status, body] of Object.values(JOIN_REFUSALS)) {
      await refused("/api/invitations/redeem", () => Response.json(body, { status }));
      for (const hit of scan()) hits.add(hit);
    }
    expect([...hits]).toEqual([]);
  });

  it("the shell that could not be loaded", async () => {
    session.signedIn = true;
    session.expiresAt = Date.now() + 125_500;
    answer("/health", () => Response.json({ claimed: true, outboxPending: 0 }));
    await route();
    await until(() => app().querySelector(".notice") !== null, "the failed shell never said so");
    const hits = scan();
    document.body.classList.remove("shell");
    session.signedIn = false;
    expect(hits).toEqual([]);
  });
});
