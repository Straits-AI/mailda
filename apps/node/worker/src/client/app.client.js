/**
 * The Mailda Node interface.
 *
 * Design intent — **instrument panel, not dashboard.** This is a device the operator installed
 * into their own Cloudflare account, and it should read like a precision instrument's front
 * panel: exact figures in monospace, hairline rules, states named rather than implied. The
 * product's own rule is that every number carries a receipt, so the interface shows its work
 * instead of rounding it off. That is also why the session countdown is visible: the token
 * lifecycle is real machinery, and machinery an operator can watch is machinery they can trust.
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

const app = document.getElementById("app");
const statusStrip = document.getElementById("status");

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

function notice(text, kind = "") {
  return el("p", { class: `notice ${kind}`.trim(), text, "data-reveal": "" });
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
    el("span", { class: "field" }, [dot, el("span", { text: nodeState.claimed ? "listening" : "unclaimed" })]),
    el("span", { class: "field mono", text: location.host }),
  ];

  // No navigation and no counts. This strip now belongs to the *pre-authentication* screens only — once
  // somebody is signed in the shell takes the page over and carries its own instrument bar, and two
  // readouts of one session on one page would eventually disagree about it.
  if (sessionText !== null) {
    items.push(el("span", { class: "field session mono", text: sessionText }));
  }

  statusStrip.replaceChildren(...items);
}

let sessionTicker = null;
let renewingUntil = 0;

function sessionReadout() {
  if (!isSignedIn()) return null;
  if (Date.now() < renewingUntil) return "session · renewing";
  const expiresAt = accessExpiresAt();
  if (expiresAt === null) return null;
  const remaining = Math.max(0, expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `session · renews in ${minutes}:${String(seconds).padStart(2, "0")}`;
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
  const org = field("org", "Organization", { value: "", required: "required", placeholder: "Acme Logistics" });
  const email = field("email", "Owner email", { type: "email", required: "required", autocomplete: "username" });
  const password = field("password", "Password", {
    type: "password", required: "required", minlength: "12", autocomplete: "new-password",
  });
  const secret = field("secret", "Bootstrap secret", { required: "required", autocomplete: "off", class: "mono" });
  const errors = el("div", { class: "errors", role: "alert" });
  const submit = el("button", { class: "primary", type: "submit", text: "Claim this Node" });

  const form = el("form", { novalidate: "novalidate" }, [
    org.node, email.node, password.node,
    el("p", { class: "hint", text: "At least 12 characters. No character-class rules — length is what resists guessing." }),
    secret.node,
    el("p", { class: "hint", text: "Shown once, by `mailda claim-secret`." }),
    submit, errors,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errors.replaceChildren();
    submit.disabled = true;
    submit.textContent = "Claiming…";
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
        adopt();
        startSessionTicker();
        return route();
      }
      const body = await response.json().catch(() => ({}));
      // §5C: the server's actual reason, including the four-part explanation when it sends one.
      errors.replaceChildren(notice(body.message ?? "Claim failed.", "bad"));
    } finally {
      submit.disabled = false;
      submit.textContent = "Claim this Node";
    }
  });

  show(
    el("div", { class: "split" }, [
      el("div", { class: "split-lede", "data-reveal": "" }, [
        el("h1", { text: "This Node is yours to claim." }),
        el("p", {
          text:
            "It is running in your Cloudflare account, holding your data, under your keys. " +
            "Nothing has been claimed yet, so it rejects incoming mail rather than filing it " +
            "somewhere it cannot attribute.",
        }),
      ]),
      panel("First run", null, [form]),
    ]),
  );
}

function renderSignIn(message = null) {
  const email = field("email", "Email", { type: "email", required: "required", autocomplete: "username" });
  const password = field("password", "Password", { type: "password", required: "required", autocomplete: "current-password" });
  const errors = el("div", { class: "errors", role: "alert" });
  const submit = el("button", { class: "primary", type: "submit", text: "Sign in" });

  const form = el("form", { novalidate: "novalidate" }, [email.node, password.node, submit, errors]);
  if (message !== null) errors.replaceChildren(notice(message, "bad"));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errors.replaceChildren();
    submit.disabled = true;
    submit.textContent = "Signing in…";
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
      errors.replaceChildren(notice(body.message ?? "Sign-in failed.", "bad"));
    } finally {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });

  show(
    el("div", { class: "split" }, [
      el("div", { class: "split-lede", "data-reveal": "" }, [
        el("h1", { text: "Shared inboxes that know who replied." }),
        el("p", {
          text:
            "Every message that arrives here is kept byte for byte, encrypted at rest, and " +
            "readable only by people you have granted access. Access is re-checked on every " +
            "request — not carried in a token.",
        }),
      ]),
      panel("Sign in", null, [
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
            const link = el("button", { class: "linkish", type: "button", text: "I have an invitation" });
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
  const secret = field("invitation", "Invitation secret", {
    required: "required", autocomplete: "off", class: "mono",
  });
  const password = field("join-password", "Choose a password", {
    type: "password", required: "required", autocomplete: "new-password",
  });
  const errors = el("div", { class: "errors", role: "alert" });
  const submit = el("button", { class: "primary", type: "submit", text: "Join" });

  const form = el("form", { novalidate: "novalidate" }, [
    secret.node, password.node,
    el("p", { class: "hint", text: "At least 12 characters. No character-class rules — length is what resists guessing." }),
    submit, errors,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errors.replaceChildren();
    submit.disabled = true;
    submit.textContent = "Joining…";
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
      // The Node's own words. Its refusal is deliberately the same for a wrong, spent or expired secret, and
      // softening it here would either invent a reason or lose the one sentence that says what to do.
      errors.replaceChildren(notice(body.message ?? "That invitation could not be used.", "bad"));
    } finally {
      submit.disabled = false;
      submit.textContent = "Join";
    }
  });

  show(
    el("div", { class: "split" }, [
      el("div", { class: "split-lede", "data-reveal": "" }, [
        el("h1", { text: "You have been invited." }),
        el("p", {
          text:
            "Paste the secret you were given and choose a password. Nobody else ever sees it — not even " +
            "the administrator who invited you. You will arrive holding nothing until they grant you " +
            "access to a mailbox.",
        }),
      ]),
      panel("Join", null, [
        form,
        el("p", { class: "hint" }, [
          (() => {
            const back = el("button", { class: "linkish", type: "button", text: "I already have an account" });
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
 * Layer 1's top status strip does not survive the handover: the shell has its own instrument bar along
 * the bottom, and two readouts of the same session on one page would eventually disagree.
 */
let shell = null;

async function handOverToShell() {
  clearInterval(sessionTicker);
  statusStrip.replaceChildren();
  // Retires Layer 1's chrome. Clearing the strip's contents was not enough: the rack and its wordmark
  // stayed, so the page carried two wordmarks and the shell sat inside `main`'s 74rem measure.
  document.body.classList.add("shell");
  try {
    shell ??= await import("/app/shell.js");
  } catch (error) {
    // A shell that cannot load must say so rather than leave an empty page. The pre-authentication
    // surface is still here and still works, which is why this is recoverable at all.
    return show(notice(
      `The application could not be loaded (${error.message}). This Node is running — /api/doctor and ` +
      `the original of every message are still reachable.`,
      "bad",
    ));
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
    renderStatus("session · renewed");
  }
  if (event.type === "signed-out") {
    clearInterval(sessionTicker);
    renderStatus(null);
    // Unmounted first. A React root left alive over the sign-in form keeps issuing requests that now
    // 401, and would eventually render itself back on top of it.
    shell?.unmount();
    document.body.classList.remove("shell");
    renderSignIn(event.message ?? null);
  }
  if (event.type === "signed-in") {
    // No ticker: the shell's instrument bar carries the countdown from here on.
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

start();
if (isSignedIn()) startSessionTicker();
route().catch((error) => show(notice(`Could not reach this Node: ${error.message}`, "bad")));
