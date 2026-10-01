import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CLAIM_REFUSALS, JOIN_REFUSALS, LOGIN_REFUSALS, PASSKEY_REFUSALS, answer, app, boot, claimScreen, every, fillClaim, html,
  joinScreen, page, passkey, route, session, signInScreen, strip, until, withPasskeys,
} from "./preauth-driver.ts";

/**
 * The pre-authentication pages' words (ADR 46, layer 3): the claim, the recovery codes, sign-in with its passkey,
 * the invitation, the status strip, and every refusal each of them can show.
 *
 * ## The goldens
 *
 * `golden/preauth.*.en.html` were written from `src/client/app.client.js` on 2 October 2026, **before** the file
 * moved a word into the catalog, by this file as it then stood. So the English a viewer sees is held to what it
 * was, and a changed English word is a deliberate one, listed in `docs/i18n.md`. The five whose strip is drawn
 * after `/health` answers were rewritten the same day when zh-Hans left preview, for the language switch the strip
 * then gained, and for nothing else: no English word changed.
 *
 * It renders into `#app` on import and keeps module state, so it is imported once and every state is reached
 * through it as a browser reaches it (`preauth-driver.ts`).
 */

vi.mock("./session-stub.ts", async (original) => (await import("./preauth-driver.ts")).controlled(await original()));

let unreachable = "";
beforeAll(async () => {
  unreachable = await boot();
});

describe("the pre-authentication pages, in English, equal their goldens", () => {
  it("says so when this Node does not answer", async () => {
    await expect(unreachable).toMatchFileSnapshot("./golden/preauth.unreachable.en.html");
  });

  it("the claim", async () => {
    await claimScreen();
    await expect(page()).toMatchFileSnapshot("./golden/preauth.claim.en.html");
  });

  it("the claim, while it is claiming", async () => {
    await claimScreen();
    let settle: (response: Response) => void = () => undefined;
    answer("/api/claim", () => new Promise<Response>((resolve) => { settle = resolve; }));
    fillClaim();
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => (app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "the claim never started");
    await expect(html(app().querySelector("form")!)).toMatchFileSnapshot("./golden/preauth.claim-busy.en.html");
    settle(Response.json({}, { status: 502 }));
    await until(() => !(app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "the claim never ended");
  });

  it("the claim's refusals", async () => {
    await claimScreen();
    await expect(await every(CLAIM_REFUSALS, "/api/claim", fillClaim)).toMatchFileSnapshot("./golden/preauth.claim-refusals.en.html");
  });

  it("the recovery codes, with the session's readout in the strip", async () => {
    await claimScreen();
    answer("/api/claim", () => {
      session.signedIn = true;
      // Read at render, so the readout is 2:05 whenever it is drawn within half a second.
      session.expiresAt = Date.now() + 125_500;
      return Response.json({ claimed: true, recoveryCodes: ["aaaa-bbbb-cccc", "dddd-eeee-ffff"] });
    });
    fillClaim();
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => app().querySelector("ol.codes") !== null, "the codes never showed");
    await expect(page()).toMatchFileSnapshot("./golden/preauth.recovery.en.html");
  });

  /*
   * Found on screen in layer 3's verification (2 October 2026), older than the layer: the claim adopts the session,
   * whose "signed-in" event hands the page to the shell, so the codes (shown once, never again: #134, ADR 29) were
   * replaced by the app before anybody could copy them. The stub's adopt() is silent, so the event is sent here, as
   * the real one sends it.
   */
  it("keeps the recovery codes on screen when the session says signed in, until they are acknowledged", async () => {
    await claimScreen();
    answer("/api/claim", () => {
      session.signedIn = true;
      return Response.json({ claimed: true, recoveryCodes: ["aaaa-bbbb-cccc", "dddd-eeee-ffff"] });
    });
    fillClaim();
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => app().querySelector("ol.codes") !== null, "the codes never showed");
    session.listener!({ type: "signed-in" });
    await new Promise((done) => setTimeout(done, 200));
    expect(app().querySelector("ol.codes"), "the codes were taken off the screen").not.toBeNull();
  });

  it("the strip, when the session renews", async () => {
    session.signedIn = true;
    session.expiresAt = Date.now() + 125_500;
    session.listener!({ type: "refreshed" });
    const renewed = html(strip());
    // Within the next second and a bit, the readout says it is renewing; `route()` draws it once.
    answer("/health", () => Response.json({ claimed: false, outboxPending: 0 }));
    await route();
    const renewing = html(strip());
    await expect(`<!-- refreshed -->\n${renewed}<!-- within 1.2 s -->\n${renewing}`).toMatchFileSnapshot("./golden/preauth.strip.en.html");
  });

  it("sign-in", async () => {
    await signInScreen();
    await expect(page()).toMatchFileSnapshot("./golden/preauth.signin.en.html");
  });

  it("sign-in, while it is signing in", async () => {
    await signInScreen();
    let settle: (response: Response) => void = () => undefined;
    answer("/api/auth/login", () => new Promise<Response>((resolve) => { settle = resolve; }));
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => (app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "sign-in never started");
    await expect(html(app().querySelector("form")!)).toMatchFileSnapshot("./golden/preauth.signin-busy.en.html");
    settle(Response.json({}, { status: 502 }));
    await until(() => !(app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "sign-in never ended");
  });

  it("sign-in's refusals", async () => {
    await signInScreen();
    await expect(await every(LOGIN_REFUSALS, "/api/auth/login")).toMatchFileSnapshot("./golden/preauth.signin-refusals.en.html");
  });

  it("sign-in after the session ended, for each reason the session gives", async () => {
    let out = "";
    const ENDED: Record<string, { reason: string; message?: string }> = {
      no_refresh_token: { reason: "no_refresh_token", message: "Your session has ended. Please sign in again." },
      expired: { reason: "expired", message: "Your session has ended. Please sign in again." },
      unknown: { reason: "unknown", message: "Your session has ended. Please sign in again." },
      reuse_detected: { reason: "reuse_detected", message: "This session was signed out because its token was used twice. Sign in again." },
      // The page's own finding, which `session.client.js` sends with no `message`: the words are this interface's.
      refresh_did_not_help: { reason: "refresh_did_not_help" },
      session_ended: { reason: "session_ended" },
      signed_out: { reason: "signed_out" },
    };
    for (const [name, event] of Object.entries(ENDED)) {
      session.signedIn = false;
      session.listener!({ type: "signed-out", ...event });
      out += `<!-- ${name} -->\n${html(app().querySelector(".errors")!)}`;
    }
    await expect(out).toMatchFileSnapshot("./golden/preauth.signin-ended.en.html");
  });

  it("the passkey's outcomes", async () => {
    await signInScreen();
    let out = `<!-- no passkey support -->\n${await passkey()}`;

    withPasskeys();
    answer("/api/auth/passkeys/challenge", () => Response.json({}, { status: 500 }));
    out += `<!-- the challenge refused -->\n${await passkey()}`;
    answer("/api/auth/passkeys/challenge", () => { throw new TypeError("Failed to fetch"); });
    out += `<!-- no answer -->\n${await passkey()}`;

    answer("/api/auth/passkeys/challenge", () => Response.json({ publicKey: { challenge: "AQID", rpId: "localhost" } }));
    for (const [name, [status, body]] of Object.entries(PASSKEY_REFUSALS)) {
      answer("/api/auth/passkeys/verify", () => Response.json(body, { status }));
      out += `<!-- ${name} -->\n${await passkey()}`;
    }
    withPasskeys(true);
    out += `<!-- cancelled -->\n${await passkey()}`;
    await expect(out).toMatchFileSnapshot("./golden/preauth.passkey.en.html");
  });

  it("the passkey, while it waits", async () => {
    await signInScreen();
    withPasskeys();
    let settle: (response: Response) => void = () => undefined;
    answer("/api/auth/passkeys/challenge", () => new Promise<Response>((resolve) => { settle = resolve; }));
    const button = app().querySelector("form button[type=button]") as HTMLButtonElement;
    button.click();
    await until(() => button.disabled, "the passkey never started");
    await expect(html(app().querySelector("form")!)).toMatchFileSnapshot("./golden/preauth.passkey-busy.en.html");
    settle(Response.json({}, { status: 500 }));
    await until(() => !button.disabled, "the passkey never ended");
  });

  it("the invitation", async () => {
    await joinScreen();
    await expect(page()).toMatchFileSnapshot("./golden/preauth.join.en.html");
  });

  it("the invitation, while it is joining, and its refusals", async () => {
    await joinScreen();
    let settle: (response: Response) => void = () => undefined;
    answer("/api/invitations/redeem", () => new Promise<Response>((resolve) => { settle = resolve; }));
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => (app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "joining never started");
    await expect(html(app().querySelector("form")!)).toMatchFileSnapshot("./golden/preauth.join-busy.en.html");
    settle(Response.json({}, { status: 502 }));
    await until(() => !(app().querySelector("button[type=submit]") as HTMLButtonElement).disabled, "joining never ended");
    await expect(await every(JOIN_REFUSALS, "/api/invitations/redeem")).toMatchFileSnapshot("./golden/preauth.join-refusals.en.html");
  });

  it("the shell that could not be loaded", async () => {
    session.signedIn = true;
    session.expiresAt = Date.now() + 125_500;
    answer("/health", () => Response.json({ claimed: true, outboxPending: 0 }));
    await route();
    await until(() => app().querySelector(".notice") !== null, "the failed shell never said so");
    // The reason is the module loader's own, which differs between runtimes; the sentence around it is the subject.
    const notice = html(app()).replace(/\(.*\)\. This Node/s, "([the loader's reason]). This Node");
    document.body.classList.remove("shell");
    await expect(notice).toMatchFileSnapshot("./golden/preauth.shell-failed.en.html");
  });
});

describe("the pre-authentication chrome, in English", () => {
  it("draws the language switch for an English reader too, each language in its own name, English chosen", async () => {
    await signInScreen();
    const select = strip().querySelector("select")!;
    expect(select.getAttribute("aria-label")).toBe("Language");
    expect([...select.options].map((option) => [option.value, option.lang, option.textContent])).toEqual([
      ["en", "en", "English"], ["zh-Hans", "zh-Hans", "简体中文"],
    ]);
    expect(select.value).toBe("en");
  });

  it("shows the one mark, Mailda, with no second one beside it", () => {
    const wordmark = document.querySelector(".rack .wordmark")!;
    expect([...wordmark.querySelectorAll("span")].map((span) => span.textContent)).toEqual(["Mailda"]);
  });
});

