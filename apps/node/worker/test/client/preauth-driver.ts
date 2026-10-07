/**
 * Drives `src/client/app.client.js`, the pages before sign-in, as a browser does: `/health` answered, a form
 * submitted, a button clicked. Shared by `preauth-words.test.ts` (English, against its goldens), `preauth-zh.test.ts`
 * (Simplified Chinese) and any check that renders these pages under another table.
 *
 * The session is the suite's stub (`session-stub.ts`) with three things made controllable (`controlled()`):
 * whether somebody is signed in, when their token expires, and the listener `app.client.js` registers, so a test
 * can say the session ended.
 */

/** What a test controls of the session: whether somebody is signed in, when their token expires, and the listener. */
export const session = {
  signedIn: false,
  expiresAt: null as number | null,
  listener: null as ((event: { type: string; reason?: string; message?: string }) => void) | null,
};

/**
 * The suite's session stub with `session` in charge of those three. A test file says, before anything imports
 * `app.client.js`:
 *
 * ```ts
 * vi.mock("./session-stub.ts", async (original) => (await import("./preauth-driver.ts")).controlled(await original()));
 * ```
 */
export function controlled<T extends object>(stub: T): T {
  return {
    ...stub,
    isSignedIn: () => session.signedIn,
    accessExpiresAt: () => session.expiresAt,
    onSessionChange: (listener: NonNullable<typeof session.listener>) => { session.listener = listener; },
  };
}

type Answer = (init: RequestInit | undefined) => Promise<Response> | Response;
const answers = new Map<string, Answer>();
/** Answers `path` from now on. `/health` must always be answered: every `route()` reads it. */
export function answer(path: string, body: Answer): void {
  answers.set(path, body);
}

/** Polls a condition rather than sleeping for a guessed interval. Throws with `why` if it never holds. */
export async function until(holds: () => boolean, why: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (holds()) return;
    await new Promise((settle) => setTimeout(settle, 5));
  }
  throw new Error(why);
}

export const app = (): HTMLElement => document.getElementById("app") as HTMLElement;
export const strip = (): HTMLElement => document.getElementById("status") as HTMLElement;

export function html(element: Element): string {
  return element.innerHTML.replaceAll("><", ">\n<") + "\n";
}

/** The page as a reader meets it: the status strip, then the screen. */
export function page(): string {
  return `<!-- #status -->\n${html(strip())}<!-- #app -->\n${html(app())}`;
}

/**
 * Puts the page's shell in the document, answers `fetch` from `answer()`, and imports the script, whose own first
 * `route()` meets a Node that does not answer. Returns that page. Call once per file, in `beforeAll`: the script
 * keeps module state and captures `#app` when it loads. A `?locale=` set on the address before this boots that
 * language, as it does in a browser.
 */
export async function boot(): Promise<string> {
  document.body.innerHTML = '<header class="rack"><div class="rack-inner"><p class="wordmark"><span>Mailda</span></p>'
    + '<div id="status"></div></div></header><main id="app"></main>';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const answered = answers.get(path);
    if (answered === undefined) throw new Error(`nothing answers ${path} in this test`);
    return await answered(init);
  }) as typeof fetch;
  // The first `route()` is the module's own, and the only one with a `catch`: a Node that does not answer.
  answer("/health", () => { throw new TypeError("Failed to fetch"); });
  await import("../../src/client/app.client.js");
  await until(() => app().textContent !== "", "the module's own route() never rendered");
  return page();
}

export const route = (): Promise<unknown> => (window as unknown as { mailda: { route: () => Promise<unknown> } }).mailda.route();

export async function claimScreen(): Promise<void> {
  session.signedIn = false;
  answer("/health", () => Response.json({ claimed: false, outboxPending: 0 }));
  await route();
  await until(() => app().querySelector("#secret") !== null, "the claim screen never rendered");
}

export async function signInScreen(): Promise<void> {
  session.signedIn = false;
  answer("/health", () => Response.json({ claimed: true, outboxPending: 0 }));
  await route();
  await until(() => app().querySelector("#password") !== null && app().querySelector("#secret") === null, "sign-in never rendered");
}

export async function joinScreen(): Promise<void> {
  await signInScreen();
  // Sign-in's one link-styled button, whatever language it is in.
  (app().querySelector("button.linkish") as HTMLButtonElement).click();
  await until(() => app().querySelector("#invitation") !== null, "the invitation screen never rendered");
}

/** Submits the form on screen, answering `path` with `response`, and returns what its errors region then holds. */
export async function refused(path: string, response: () => Response): Promise<string> {
  answer(path, response);
  const form = app().querySelector("form") as HTMLFormElement;
  const errors = form.querySelector(".errors") as HTMLElement;
  errors.replaceChildren();
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await until(() => errors.childElementCount > 0, `nothing was said after ${path} refused`);
  // The button comes back after the `finally`, which runs after the notice: wait for it too.
  await until(() => !(form.querySelector("button[type=submit]") as HTMLButtonElement).disabled, "the button never came back");
  return html(errors);
}

/** A refusal for every shape the Node sends, by the code it carries. */
export const CROSS_SITE = {
  error: "E_CROSS_SITE_REQUEST",
  message: "E_CROSS_SITE_REQUEST  a POST arrived from https://evil.example, and this Node is https://node.example\n  why      an Origin that is not this Node's is another site acting as the person signed in here.\n  fix      state-changing requests must come from this Node's own interface",
};
export const INTERNAL = {
  error: "internal", message: "This Node failed to handle the request. Its operator can find this in the log.", requestId: "req_01TEST",
};
export const UNKNOWN = { error: "E_SOMETHING_NEW", message: "A refusal this interface has no words for." };

export const CLAIM_REFUSALS: Record<string, [number, object]> = {
  already_claimed: [409, { error: "already_claimed", message: "This Node has already been claimed. Sign in instead, or restore from backup to start over." }],
  bad_secret: [403, { error: "bad_secret", message: "That claim secret does not match. It was shown once by `mailda claim-secret`, and only its hash is stored — seed again if it is lost." }],
  not_installed: [503, { error: "not_installed", message: "This Node has no claim secret recorded. Run `mailda deploy` to complete installation." }],
  weak_password: [422, { error: "weak_password", message: "E_PASSWORD_TOO_SHORT  minimum=12, got 5\n  why      length is the only property that reliably resists offline guessing\n  fix      use a longer passphrase; there are no character-class requirements" }],
  cross_site: [403, CROSS_SITE],
  internal: [500, INTERNAL],
  unknown: [409, UNKNOWN],
  silent: [502, {}],
};

export const LOGIN_REFUSALS: Record<string, [number, object]> = {
  invalid_credentials: [401, { error: "invalid_credentials", message: "That email and password do not match." }],
  locked_out: [429, { error: "locked_out", message: "Too many failed sign-in attempts. Try again in 5 minutes." }],
  not_claimed: [503, { error: "not_claimed", message: "This Node has not been claimed yet." }],
  cross_site: [403, CROSS_SITE],
  internal: [500, INTERNAL],
  unknown: [409, UNKNOWN],
  silent: [502, {}],
};

export const JOIN_REFUSALS: Record<string, [number, object]> = {
  E_INVITATION_UNUSABLE: [404, { error: "E_INVITATION_UNUSABLE", message: "E_INVITATION_UNUSABLE  that invitation cannot be used\n  why      it does not exist, it has already been redeemed, or it has expired. Which one is deliberately not said: distinguishing them would let somebody guess at secrets and would confirm who was invited\n  fix      ask the administrator who invited you to send a new one — minting a fresh invitation withdraws the old link" }],
  E_WEAK_PASSWORD: [422, { error: "E_WEAK_PASSWORD", message: "E_WEAK_PASSWORD  that password is not usable\n  why      E_PASSWORD_TOO_SHORT  minimum=12, got 5\n  why      length is the only property that reliably resists offline guessing\n  fix      use a longer passphrase; there are no character-class requirements\n  fix      choose a longer passphrase; there are no character-class requirements" }],
  cross_site: [403, CROSS_SITE],
  internal: [500, INTERNAL],
  unknown: [409, UNKNOWN],
  silent: [502, {}],
};

export const PASSKEY_REFUSALS: Record<string, [number, object]> = {
  E_PASSKEY_REJECTED: [422, { error: "E_PASSKEY_REJECTED", message: "E_PASSKEY_REJECTED  that passkey did not verify\n  why      an unknown credential, a wrong origin, a stale challenge and a bad signature are one answer here on purpose: telling an anonymous caller which it was hands them half of it (§5C). The Node's own log records the detail: unknown credential\n  fix      try again, or sign in with your password and register this device" }],
  E_CHALLENGE_UNUSABLE: [422, { error: "E_CHALLENGE_UNUSABLE", message: "E_CHALLENGE_UNUSABLE  that challenge was not issued by this Node for this ceremony, or it has expired\n  why      a challenge is the anti-replay device of the whole exchange: it is minted here, spent once, and deleted. Its lifetime is auth.passkey_challenge_ttl_seconds=300\n  fix      start again — the interface asks for a fresh challenge each time" }],
  E_CHALLENGE_ALREADY_SPENT: [409, { error: "E_CHALLENGE_ALREADY_SPENT", message: "E_CHALLENGE_ALREADY_SPENT  that challenge was spent by another request\n  why      a challenge is single-use, and two ceremonies redeeming one would be a replay\n  fix      start again" }],
  cross_site: [403, CROSS_SITE],
  internal: [500, INTERNAL],
  unknown: [409, UNKNOWN],
  silent: [502, {}],
};

/** Every case of a table, each under its name, in one golden. */
export async function every(table: Record<string, [number, object]>, path: string, fill?: () => void): Promise<string> {
  let out = "";
  for (const [name, [status, body]] of Object.entries(table)) {
    fill?.();
    out += `<!-- ${name} -->\n${await refused(path, () => Response.json(body, { status }))}`;
  }
  return out;
}

export function fillClaim(): void {
  (app().querySelector("#org") as HTMLInputElement).value = "Acme";
  (app().querySelector("#email") as HTMLInputElement).value = "owner@example.test";
  (app().querySelector("#password") as HTMLInputElement).value = "a long enough password";
  (app().querySelector("#secret") as HTMLInputElement).value = "secret";
}

/** Clicks the passkey button and returns what the errors region holds once the button is back. */
export async function passkey(): Promise<string> {
  const button = [...app().querySelectorAll("button")].find((one) => one.type === "button" && !one.classList.contains("linkish"))!;
  const errors = app().querySelector(".errors") as HTMLElement;
  errors.replaceChildren();
  button.click();
  await until(() => !button.disabled, "the passkey button never came back");
  return html(errors);
}

/** A browser with passkeys, whose authenticator answers with one credential (or throws, if `cancel`). */
export function withPasskeys(cancel = false): void {
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      get: async () => {
        if (cancel) throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
        return {
          id: "cred", rawId: new Uint8Array([1]).buffer, type: "public-key", getClientExtensionResults: () => ({}),
          response: {
            clientDataJSON: new Uint8Array([2]).buffer, authenticatorData: new Uint8Array([3]).buffer,
            signature: new Uint8Array([4]).buffer, userHandle: null,
          },
        };
      },
    },
  });
}

