/**
 * The Mailda Node interface.
 *
 * Design intent — **states named rather than implied.** This is a device the operator installed
 * into their own Cloudflare account. The product's own rule is that every number carries a
 * receipt, so the interface shows its work instead of rounding it off. That is also why the
 * session countdown is visible: the token lifecycle is real machinery, and machinery an operator
 * can watch is machinery they can trust. The look (dark first, one sans family, calm and dense)
 * is ADR 30 as amended on 26 September 2026; the "instrument panel" it replaced is history.
 *
 * Four states are kept genuinely distinct, because §5C requires it and because collapsing them
 * is how a mail client tells its first lie:
 *
 *   unclaimed   — no organization yet; the Node rejects mail rather than misfiling it
 *   signed out  — there may well be messages; we are not entitled to say
 *   empty       — claimed, listening, and nothing has arrived
 *   populated   — the ledger
 *
 * **No `innerHTML`.** Everything reaches the DOM as a node or a `textContent` assignment. In a
 * mail client the most dangerous strings — sender address, subject — are written by whoever sent
 * the message. Escaping on write is correct only while every future author remembers to do it;
 * constructing nodes makes injection impossible instead of merely handled.
 */

import {
  accessExpiresAt, adopt, apiFetch, ensureFresh, isSignedIn, onSessionChange, refresh, start,
} from "./session.js";
import { LOCALE_FLAG, bootLocale, current, loadApp, refusalHeadline, rich, switchable, t } from "./locale.js";
import { bootTheme } from "./theme.js";

// The viewer's theme, before this script renders anything: the claim, the sign-in and a locked-out doctor honour
// it, and so does the React shell loaded later. See `theme.client.js`.
// ponytail: a module script runs after parsing, so a viewer who chose Light may see this page dark for the
// moment before it runs; a render-blocking classic `<script src="/app/theme.js">` in `<head>` is the upgrade
// if anyone reports it, at the price of a request before every viewer's first paint.
bootTheme();
// The viewer's language, in the same place and for the same reason (`locale.ts`, ADR 46): `<html lang>`, the
// title and the wordmark are named in it before anything renders. It does not throw, even where storage is refused.
bootLocale();

const app = document.getElementById("app");
const statusStrip = document.getElementById("status");

/**
 * One element, built node by node. Typed for the untranslated-text scan (`test/node/support/untranslated.ts`),
 * which reads this file with the checker: a tag is one of the platform's, so its name is a token, not words.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any>} [props]
 * @param {Node | string | null | false | Array<Node | string | null | false>} [children]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function show(...nodes) {
  // Nulls filtered, same rule `el` already applies to children. `replaceChildren(null)` stringifies
  // to a literal "null" on the page — which is exactly what a conditional section renders as when it
  // is absent, so the two helpers have to agree.
  app.replaceChildren(...nodes.filter((node) => node !== null && node !== false && node !== undefined));
  // The staggered reveal is applied here rather than in CSS-per-element so any screen gets it
  // without remembering to opt in.
  [...app.querySelectorAll("[data-reveal]")].forEach((node, index) => {
    node.style.setProperty("--reveal-delay", `${index * 55}ms`);
  });
}

/** A notice: `said` is the catalog's text, the Node's marked words, or the two (`refusal()`). */
function notice(said, kind = "") {
  return el("p", { class: `notice ${kind}`.trim(), "data-reveal": "" }, said);
}

/**
 * The Node's own English, marked as English: the pre-authentication twin of the shell's `<NodeWords>`
 * (`src/client/app/words.tsx`). Its `message`s stay English and byte-stable for the agents that read them (ADR 46).
 */
function nodeWords(message) {
  return el("span", { lang: "en", text: message });
}

/**
 * A refusal the Node sent (`{ error, message }`), as a notice. A code the contract lists (`PREAUTH_ERRORS`) has a
 * headline in the viewer's language, and the Node's English follows it, marked; a code it does not list shows the
 * Node's English alone; a Node that said nothing gets `fallback`, this interface's own words.
 *
 * Where the Node's words begin with the headline they already say it, and are shown alone: so English, whose
 * headline for a fixed sentence is that sentence, never shows one sentence twice.
 */
function refusal(body, fallback) {
  const said = typeof body?.message === "string" && body.message !== "" ? body.message : null;
  const headline = refusalHeadline(body?.error);
  if (said === null) return notice(headline ?? fallback, "bad");
  if (headline === null || said.startsWith(headline)) return notice(nodeWords(said), "bad");
  return notice([headline, el("br"), nodeWords(said)], "bad");
}

/* ------------------------------------------------------------------ status strip ---------- */

let nodeState = { claimed: false, outboxPending: 0, mailboxId: null };

/**
 * The front panel. Live node state, and the session's own clock.
 *
 * Showing time-to-renewal is not decoration: an access token that silently expires is the exact
 * failure this client exists to prevent, so its countdown is on screen where a person can see it
 * happen. When it renews, the readout says so.
 */
function renderStatus(sessionText = null) {
  const dot = el("span", { class: nodeState.claimed ? "dot live" : "dot idle" });
  const items = [
    el("span", { class: "field" }, [dot, el("span", { text: t(nodeState.claimed ? "preauth.status.listening" : "preauth.status.unclaimed") })]),
    el("span", { class: "field mono", text: location.host }),
  ];

  // No navigation and no counts. This strip now belongs to the *pre-authentication* screens only — once
  // somebody is signed in the shell takes the page over and carries its own countdown (on its Settings
  // screen), and two readouts of one session on one page would eventually disagree about it.
  if (sessionText !== null) {
    items.push(el("span", { class: "field session mono", text: sessionText }));
  }
  if (languageSwitch !== null) items.push(languageSwitch);

  statusStrip.replaceChildren(...items);
}

/**
 * The language, chosen before sign-in (ADR 46). Settings is where a choice is kept, and it is behind sign-in, so a
 * reader on a browser that asks for another language could not reach it. This reloads the page with the review
 * flag (`?locale=`), which applies to that load and needs no storage, so it works where the browser refuses it.
 *
 * Built once, and put back into the strip each time it is redrawn, so a redraw never takes the control from under
 * somebody using it. Not drawn while there is one language to choose (`switchable()`).
 */
const languageSwitch = (() => {
  const choices = switchable();
  if (choices.length < 2) return null;
  const select = el("select", { "aria-label": t("preauth.language") },
    choices.map((choice) => el("option", { value: choice.tag, lang: choice.tag, text: choice.endonym })));
  select.value = current().locale;
  select.addEventListener("change", () => {
    const next = new URL(location.href);
    next.searchParams.set(LOCALE_FLAG, select.value);
    location.assign(next);
  });
  return el("span", { class: "field" }, [select]);
})();

let sessionTicker = null;
let renewingUntil = 0;

function sessionReadout() {
  if (!isSignedIn()) return null;
  if (Date.now() < renewingUntil) return t("preauth.session.renewing");
  const expiresAt = accessExpiresAt();
  if (expiresAt === null) return null;
  const remaining = Math.max(0, expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return t("preauth.session.renewsIn", { time: `${minutes}:${String(seconds).padStart(2, "0")}` });
}

function startSessionTicker() {
  clearInterval(sessionTicker);
  sessionTicker = setInterval(() => renderStatus(sessionReadout()), 1000);
  renderStatus(sessionReadout());
}

/* ------------------------------------------------------------------ screens --------------- */

function field(id, label, attrs = {}) {
  const input = el("input", { id, ...attrs });
  return { input, node: el("label", { class: "field-row", for: id }, [el("span", { text: label }), input]) };
}

function panel(title, subtitle, children) {
  return el("section", { class: "panel", "data-reveal": "" }, [
    el("h2", { text: title }),
    subtitle === null ? null : el("p", { class: "sub", text: subtitle }),
    ...children,
  ]);
}

/**
 * First run. The one-time bootstrap secret is consumed here, so this is also where the owner sets
 * a password — an install that ends with an account nobody can sign into again is not an install.
 */
function renderClaim() {
  const org = field("org", t("preauth.claim.org"), { value: "", required: "required", placeholder: t("preauth.claim.orgExample") });
  const email = field("email", t("preauth.claim.email"), { type: "email", required: "required", autocomplete: "username" });
  const password = field("password", t("preauth.password"), {
    type: "password", required: "required", minlength: "12", autocomplete: "new-password",
  });
  const secret = field("secret", t("preauth.claim.secret"), { required: "required", autocomplete: "off", class: "mono" });
  const errors = el("div", { class: "errors", role: "alert" });
  const submit = el("button", { class: "primary", type: "submit", text: t("preauth.claim.submit") });

  const form = el("form", { novalidate: "novalidate" }, [
    org.node, email.node,
    // The two identities people conflate: an owner who claimed as admin@ was surprised to reply as hello@.
    el("p", { class: "hint", text: t("preauth.claim.emailHint") }),
    password.node,
    el("p", { class: "hint", text: t("preauth.password.rule") }),
    secret.node,
    el("p", { class: "hint", text: t("preauth.claim.secretHint") }),
    submit, errors,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errors.replaceChildren();
    submit.disabled = true;
    submit.textContent = t("preauth.claim.busy");
    try {
      const response = await fetch("/api/claim", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organization: org.input.value, email: email.input.value,
          password: password.input.value, secret: secret.input.value,
        }),
      });
      if (response.ok) {
        /*
         * The response body is read, and that is the fix (#134).
         *
         * This used to be `adopt(); startSessionTicker(); return route();` — the body was never touched. The
         * claim returns ADR 29's ten recovery codes in plaintext, and the contract says it is *"the only
         * response in this contract that carries them: the Node keeps a hash to recognise one and an escrow
         * only the code itself opens, so nothing can produce them again."* So the interface received the one
         * artifact that decrypts an organization's mail and routed straight past it into the inbox.
         *
         * Measured, during #92's restore drill: a full catalog and every object restored into a different
         * Cloudflare account, the destination came up holding all ten code hashes and escrow blobs, and
         * refused — `signing_key: E_EVIDENCE_AUTH_FAILED` — because the vault needs a code and no code had
         * ever been obtainable. `doctor` had been saying so since the claim.
         */
        const claimed = await response.json().catch(() => ({}));
        // Held before the session is adopted: adopting says "signed-in", which hands the page to the shell, and the
        // shell took the codes off the screen before anybody could copy them (found on screen, 2 October 2026).
        holdingCodes = Array.isArray(claimed.recoveryCodes) && claimed.recoveryCodes.length > 0;
        adopt();
        startSessionTicker();
        if (holdingCodes) return renderRecoveryCodes(claimed.recoveryCodes);
        return route();
      }
      const body = await response.json().catch(() => ({}));
      // §5C: the server's actual reason, including the four-part explanation when it sends one.
      errors.replaceChildren(refusal(body, t("preauth.claim.failed")));
    } finally {
      submit.disabled = false;
      submit.textContent = t("preauth.claim.submit");
    }
  });

  show(
    el("div", { class: "split" }, [
      el("div", { class: "split-lede", "data-reveal": "" }, [
        el("h1", { text: t("preauth.claim.title") }),
        el("p", { text: t("preauth.claim.lede") }),
      ]),
      panel(t("preauth.claim.heading"), null, [form]),
    ]),
  );
}

/**
 * The ten recovery codes, shown once, with no way past them but acknowledgement (#134).
 *
 * ## Why this is a screen of its own rather than a banner
 *
 * They cannot be produced again — the Node stores a hash to recognise a code and an escrow that only the
 * code's plaintext opens. An interface that shows them beside something else to do is an interface that will
 * be navigated away from, and the cost of that is the whole organization's mail.
 *
 * So there is one thing on the screen and one way forward, and the button says what it is asserting rather
 * than "OK": a person clicking *"I have saved these"* has been told what they are claiming.
 *
 * ## Why the session is adopted before this, not after
 *
 * The server has already set the cookies — the claim succeeded. Adopting first means the session ticker runs
 * while somebody copies ten strings into a password manager, so a slow, careful reader does not come back to
 * an expired session. Nothing here needs the session; it is the *next* screen that would.
 */
/** While the codes are on screen, a "signed-in" does not hand the page to the shell; the acknowledgement does. */
let holdingCodes = false;

export function renderRecoveryCodes(codes) {
  const acknowledged = el("button", {
    class: "primary", type: "button", text: t("preauth.codes.saved"),
  });
  acknowledged.addEventListener("click", () => { holdingCodes = false; void route(); });

  show(
    el("div", { class: "split" }, [
      el("div", { class: "split-lede", "data-reveal": "" }, [
        el("h1", { text: t("preauth.codes.title") }),
        el("p", { text: t("preauth.codes.lede") }),
        el("p", { text: t("preauth.codes.keep") }),
      ]),
      panel(t("preauth.codes.heading"), t("preauth.codes.once"), [
        el("ol", { class: "codes" }, codes.map((code) => el("li", { class: "mono", text: code }))),
        el("p", { class: "hint", text: t("preauth.codes.next") }),
        acknowledged,
      ]),
    ]),
  );
}

/**
 * Base64url, both ways.
 *
 * WebAuthn's JSON form carries every binary field as base64url, and `navigator.credentials` wants
 * `ArrayBuffer`s — so the conversion happens at the boundary, twice, and nowhere else. Written here rather
 * than pulled from a package because this file is the **pre-authentication** surface (ADR 30): it is what an
 * operator meets when the Node is broken, and it loads no bundle by design.
 */
function fromB64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function toB64url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What the routes accept: a `PublicKeyCredential` with its binary fields as base64url. */
function serialiseCredential(credential) {
  const response = credential.response;
  const out = {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: { clientDataJSON: toB64url(response.clientDataJSON) },
  };
  if (response.attestationObject !== undefined) {
    out.response.attestationObject = toB64url(response.attestationObject);
    out.response.transports = response.getTransports?.() ?? [];
  } else {
    out.response.authenticatorData = toB64url(response.authenticatorData);
    out.response.signature = toB64url(response.signature);
    out.response.userHandle = response.userHandle === null ? null : toB64url(response.userHandle);
  }
  return out;
}

/**
 * Signing in with a passkey (#84, ADR 29).
 *
 * **Nothing is typed.** The request names no account — the credential the authenticator returns is what
 * identifies it — which is what keeps this from answering *"does this address have a passkey"* to anybody
 * who asks. That is the same property `login` protects by making an unknown address and a wrong password
 * indistinguishable, and it would be lost by asking for an email first.
 *
 * Returns a notice on failure and never throws: this is the screen an operator reaches when the Node is
 * already misbehaving, and a thrown error here is a blank page.
 */
async function signInWithPasskey() {
  if (typeof PublicKeyCredential === "undefined") {
    return notice(t("preauth.passkey.unsupported"), "bad");
  }
  let options;
  try {
    const challenged = await fetch("/api/auth/passkeys/challenge", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "authenticate" }),
    });
    if (!challenged.ok) return notice(t("preauth.passkey.notStarted"), "bad");
    options = (await challenged.json()).publicKey;
  } catch {
    return notice(t("preauth.passkey.silent"), "bad");
  }

  let credential;
  try {
    credential = await navigator.credentials.get({
      publicKey: { ...options, challenge: fromB64url(options.challenge) },
    });
  } catch {
    // Includes the user simply cancelling the prompt, which is not an error worth alarming about.
    return null;
  }
  if (credential === null) return null;

  const verified = await fetch("/api/auth/passkeys/verify", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: serialiseCredential(credential) }),
  });
  if (verified.ok) return "signed-in";
  const body = await verified.json().catch(() => ({}));
  return refusal(body, t("preauth.passkey.failed"));
}

/** Sign-in, with `ended` (a notice: why the last session ended) in its errors region, or nothing there. */
function renderSignIn(ended = null) {
  const email = field("email", t("preauth.signin.email"), { type: "email", required: "required", autocomplete: "username" });
  const password = field("password", t("preauth.password"), { type: "password", required: "required", autocomplete: "current-password" });
  const errors = el("div", { class: "errors", role: "alert" });
  const submit = el("button", { class: "primary", type: "submit", text: t("preauth.signin.submit") });

  /*
   * The passkey button comes **first**, because ADR 29 makes passkeys the mechanism this product builds and
   * the password the fallback — and an interface that puts the fallback at the top teaches the opposite of
   * what the decision says. It is a button rather than an automatic prompt: a page that summons an
   * authenticator dialog on load is one people learn to dismiss without reading.
   */
  const passkey = el("button", { class: "primary", type: "button", text: t("preauth.signin.passkey") });
  const fallback = el("p", { class: "dim", text: t("preauth.signin.or") });
  const form = el("form", { novalidate: "novalidate" }, [
    passkey, fallback, email.node, password.node, submit, errors,
  ]);
  if (ended !== null) errors.replaceChildren(ended);

  passkey.addEventListener("click", async () => {
    errors.replaceChildren();
    passkey.disabled = true;
    passkey.textContent = t("preauth.passkey.waiting");
    try {
      const outcome = await signInWithPasskey();
      if (outcome === "signed-in") {
        adopt();
        startSessionTicker();
        return route();
      }
      // `null` is a cancelled prompt: the person changed their mind, which is not a failure to report.
      if (outcome !== null) errors.replaceChildren(outcome);
    } finally {
      passkey.disabled = false;
      passkey.textContent = t("preauth.signin.passkey");
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errors.replaceChildren();
    submit.disabled = true;
    submit.textContent = t("preauth.signin.busy");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.input.value, password: password.input.value }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        adopt();
        startSessionTicker();
        return route();
      }
      errors.replaceChildren(refusal(body, t("preauth.signin.failed")));
    } finally {
      submit.disabled = false;
      submit.textContent = t("preauth.signin.submit");
    }
  });

  show(
    el("div", { class: "split" }, [
      el("div", { class: "split-lede", "data-reveal": "" }, [
        el("h1", { text: t("preauth.signin.title") }),
        el("p", { text: t("preauth.signin.lede") }),
      ]),
      panel(t("preauth.signin.heading"), null, [
        form,
        /*
         * The way in for somebody who was invited (#83).
         *
         * A link rather than a URL carrying the secret. An invitation is a bearer credential for membership,
         * and a `?invite=…` link would put it in browser history, in a referrer, and in whatever logs sit
         * between — which is why the claim secret is typed into a field rather than clicked, and this follows
         * it. The administrator says "go to the Node and paste this", the same sentence they already use.
         */
        el("p", { class: "hint" }, [
          (() => {
            const link = el("button", { class: "linkish", type: "button", text: t("preauth.signin.invited") });
            link.addEventListener("click", () => renderJoin());
            return link;
          })(),
        ]),
      ]),
    ]),
  );
}

/**
 * Redeeming an invitation: paste the secret, choose a password, and you are in.
 *
 * Framework-free, beside sign-in and the claim, for ADR 30's reason and one more of its own: this is the
 * screen a person meets **before they have an account**, so it cannot be behind the bundle the shell loads
 * after sign-in.
 *
 * The password field is `new-password`, so a manager offers to generate one rather than filling the
 * colleague's existing credential for a different site — which is what `current-password` would invite here.
 */
function renderJoin() {
  const secret = field("invitation", t("preauth.join.secret"), {
    required: "required", autocomplete: "off", class: "mono",
  });
  const password = field("join-password", t("preauth.join.password"), {
    type: "password", required: "required", autocomplete: "new-password",
  });
  const errors = el("div", { class: "errors", role: "alert" });
  const submit = el("button", { class: "primary", type: "submit", text: t("preauth.join.submit") });

  const form = el("form", { novalidate: "novalidate" }, [
    secret.node, password.node,
    el("p", { class: "hint", text: t("preauth.password.rule") }),
    submit, errors,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errors.replaceChildren();
    submit.disabled = true;
    submit.textContent = t("preauth.join.busy");
    try {
      const response = await fetch("/api/invitations/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: secret.input.value, password: password.input.value }),
      });
      if (response.ok) {
        // Signed in on the way through, the same as the claim: somebody who just chose a password should not
        // be asked for it again immediately.
        adopt();
        startSessionTicker();
        return route();
      }
      const body = await response.json().catch(() => ({}));
      // The Node's own words, beside a headline that says no more than they do. Its refusal is deliberately the
      // same for a wrong, spent or expired secret, and softening it here would either invent a reason or lose the
      // one sentence that says what to do.
      errors.replaceChildren(refusal(body, t("preauth.join.failed")));
    } finally {
      submit.disabled = false;
      submit.textContent = t("preauth.join.submit");
    }
  });

  show(
    el("div", { class: "split" }, [
      el("div", { class: "split-lede", "data-reveal": "" }, [
        el("h1", { text: t("preauth.join.title") }),
        el("p", { text: t("preauth.join.lede") }),
      ]),
      panel(t("preauth.join.heading"), null, [
        form,
        el("p", { class: "hint" }, [
          (() => {
            const back = el("button", { class: "linkish", type: "button", text: t("preauth.join.member") });
            back.addEventListener("click", () => renderSignIn());
            return back;
          })(),
        ]),
      ]),
    ]),
  );
}

/**
 * The authenticated screens are gone from this file, and that is the point of ADR 30.
 *
 * They lived here: the ledger, the reading pane, the composer, the outbox, the audit trail and the log —
 * about six hundred lines of DOM construction. They are now React, in `src/client/app/`, because the
 * composer is where client state first outlives a request and because this file cannot be tested: it
 * touches `document` at module scope, so nothing could import it, and the outbox's honesty rules sat in
 * the one file with no coverage. That cost something real — a send whose every recipient bounced rendered
 * as green `handed over` — and the fix was to move the rule somewhere a test could reach it.
 *
 * What stays is what has to work when nothing else does: the first-run claim, sign-in, and the session
 * machinery underneath both. #23 was exactly that case — a dropped binding made sign-in return 500 and
 * left the diagnostic the only reachable surface — which is why these screens load no bundle and never
 * will.
 */

async function route() {
  const health = await fetch("/health").then((r) => r.json());
  nodeState = {
    claimed: health.claimed === true,
    outboxPending: health.outboxPending ?? 0,
    mailboxId: nodeState.mailboxId,
  };
  renderStatus(sessionReadout());

  if (!nodeState.claimed) return renderClaim();
  if (!isSignedIn()) return renderSignIn();

  // Signed in: the authenticated application is React (ADR 30), and it is fetched only now. An operator
  // looking at a broken Node never waits on it — that is the whole reason the split exists.
  return handOverToShell();
}

/**
 * Hands the page to the React application.
 *
 * Dynamic `import()` rather than a second `<script>` tag, so the bundle is requested at the moment
 * somebody is actually signed in. The pre-authentication screens — sign-in, first-run claim, and the
 * `doctor` an operator reaches when nothing else works — must render before any of it loads.
 *
 * Layer 1's top status strip does not survive the handover: the shell has its own status bar along the
 * bottom and its own session countdown on Settings, and two readouts of the same session on one page would
 * eventually disagree.
 */
let shell = null;

async function handOverToShell() {
  clearInterval(sessionTicker);
  statusStrip.replaceChildren();
  // Retires Layer 1's chrome. Clearing the strip's contents was not enough: the rack and its wordmark
  // stayed, so the page carried two wordmarks and the shell sat inside `main`'s 74rem measure.
  document.body.classList.add("shell");
  try {
    if (shell === null) {
      // The shell downloads while its words do and runs after them, so a module-scope `t()` in it is safe. Here
      // and nowhere else (critic M6): a preload anywhere the pre-authentication screens reach would fetch the
      // bundle before sign-in, the split ADR 30 exists for, and `test/shell-split.test.ts` parses for it.
      document.head.append(el("link", { rel: "modulepreload", href: "/app/shell.js" }));
      await loadApp();
    }
    shell ??= await import("/app/shell.js");
  } catch (error) {
    // A shell that cannot load must say so rather than leave an empty page. The pre-authentication
    // surface is still here and still works, which is why this is recoverable at all.
    return show(notice(rich("preauth.shell.failed", { reason: reason(error) }), "bad"));
  }
  app.replaceChildren();
  return shell.mount(app);
}

/** Kept for the framework-free ledger below, which now serves only as the signed-out fallback. */
onSessionChange((event) => {
  if (event.type === "refreshed") {
    // Visible on purpose. A refresh that happens silently is indistinguishable from one that
    // never happened, and this readout is how an operator confirms the machinery works.
    //
    // Suppressed once the shell owns the page, which is not a detail: without the guard this repopulated
    // the top strip on every refresh, so the page carried two session readouts on different clocks. The
    // comment above `handOverToShell` predicted that and the code did it anyway — caught by reading the
    // rendered tree.
    if (shell !== null) return;
    renewingUntil = Date.now() + 1200;
    renderStatus(t("preauth.session.renewed"));
  }
  if (event.type === "signed-out") {
    clearInterval(sessionTicker);
    renderStatus(null);
    // Unmounted first. A React root left alive over the sign-in form keeps issuing requests that now
    // 401, and would eventually render itself back on top of it.
    shell?.unmount();
    document.body.classList.remove("shell");
    renderSignIn(ended(event));
  }
  if (event.type === "signed-in" && !holdingCodes) {
    // No ticker: the shell's Settings screen carries the countdown from here on.
    void handOverToShell();
  }
});

/**
 * The session machinery, exposed for inspection.
 *
 * This grants a hostile script nothing it did not already have: the cookies are HttpOnly, so the
 * only thing reachable here is issuing same-origin requests, which any injected script can do with
 * `fetch` regardless. What it buys is the ability for an operator — or a test — to watch the token
 * lifecycle from a console instead of inferring it: `await mailda.refresh()`,
 * `mailda.accessExpiresAt()`, `await mailda.apiFetch("/api/messages")`.
 *
 * A lifecycle nobody can observe is a lifecycle nobody can debug, and this one is load-bearing
 * enough to be worth watching.
 */
window.mailda = { refresh, ensureFresh, apiFetch, accessExpiresAt, isSignedIn, route };

/**
 * Why the last session ended, for sign-in to say, or null. A renewal that did not help is this interface's own
 * finding (`session.client.js`), so it has words of its own; anything else is the Node's refusal.
 */
function ended(event) {
  if (event.reason === "refresh_did_not_help") return notice(t("preauth.session.notRenewed"), "bad");
  return event.message === undefined ? null : refusal({ error: event.reason, message: event.message }, null);
}

/**
 * The browser's own reason for a failure (a module that would not load, a `fetch` that failed), for a sentence to
 * carry. It is the platform's English, not this interface's words, so it is marked as English, as the Node's are.
 */
function reason(error) {
  return nodeWords(String(error?.message ?? error));
}

start();
if (isSignedIn()) startSessionTicker();
route().catch((error) => show(notice(rich("preauth.unreachable", { reason: reason(error) }), "bad")));
