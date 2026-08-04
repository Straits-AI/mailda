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
  accessExpiresAt, adopt, apiFetch, ensureFresh, isSignedIn, logout, onSessionChange, refresh, start,
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
  app.replaceChildren(...nodes);
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

let nodeState = { claimed: false, outboxPending: 0 };

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

  if (nodeState.claimed) {
    items.push(
      el("span", { class: "field" }, [
        el("span", { class: "key", text: "outbox" }),
        el("span", { class: "mono num", text: String(nodeState.outboxPending) }),
      ]),
    );
  }

  if (sessionText !== null) {
    items.push(el("span", { class: "field session mono", text: sessionText }));
  }
  if (isSignedIn()) {
    items.push(el("button", { class: "linkish", text: "sign out", onclick: () => logout() }));
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
    el("p", { class: "hint", text: "Shown once, during mailda deploy." }),
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
      panel("Sign in", null, [form]),
    ]),
  );
}

function renderEmpty() {
  show(
    el("div", { class: "stage", "data-reveal": "" }, [
      el("h1", { text: "Listening." }),
      el("p", {
        class: "lede",
        text:
          "This Node is claimed and routing is live. No messages have arrived yet — send one to " +
          "an address routed here and it will appear in this ledger.",
      }),
      el("p", { class: "hint", text: "An empty ledger. Not a filtered one: nothing has been hidden from you." }),
    ]),
  );
}

const bytes = (n) => `${Number(n).toLocaleString()} B`;

function received(iso) {
  const at = new Date(iso);
  const day = at.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time}`;
}

/** The ledger. Reads as a record of receipts, because that is what it is. */
function renderLedger(messages) {
  const head = el("tr", {}, [
    el("th", { text: "From" }),
    el("th", { text: "To" }),
    el("th", { text: "Received" }),
    el("th", { class: "num", text: "Size" }),
    el("th", { class: "num", text: "Evidence" }),
  ]);

  const rows = messages.flatMap((message) => {
    const detail = el("tr", { class: "detail", hidden: "hidden" }, [
      el("td", { colspan: "5" }, [
        el("dl", {}, [
          el("dt", { text: "receipt" }), el("dd", { class: "mono", text: message.id }),
          el("dt", { text: "accepted" }), el("dd", { class: "mono", text: message.accepted_at }),
          el("dt", { text: "stored" }),
          el("dd", { class: "mono", text: `${bytes(message.raw_bytes)} — framed, encrypted at rest` }),
        ]),
      ]),
    ]);

    const row = el("tr", { class: "entry", tabindex: "0", "data-reveal": "" }, [
      el("td", { text: message.envelope_from }),
      el("td", { class: "dim", text: message.envelope_to }),
      el("td", { class: "mono dim", text: received(message.accepted_at) }),
      el("td", { class: "num mono", text: bytes(message.raw_bytes) }),
      el("td", { class: "num" }, [
        el("a", {
          class: "mono",
          href: `/api/messages/${encodeURIComponent(message.id)}/raw`,
          text: ".eml",
        }),
      ]),
    ]);

    const toggle = () => { detail.hidden = !detail.hidden; row.classList.toggle("open", !detail.hidden); };
    row.addEventListener("click", (event) => {
      if (event.target.tagName !== "A") toggle();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); }
    });

    return [row, detail];
  });

  show(
    el("div", { class: "ledger-head", "data-reveal": "" }, [
      el("h1", { text: "Ledger" }),
      el("p", {
        class: "count mono",
        text: `${messages.length} message${messages.length === 1 ? "" : "s"}`,
      }),
    ]),
    // The ledger is dense and its columns cannot all shrink. Wrapped so *it* scrolls sideways on a
    // narrow viewport rather than the page body, which is the difference between a usable table and
    // a broken layout.
    el("div", { class: "scroller" }, [
      el("table", {}, [el("thead", {}, [head]), el("tbody", {}, rows)]),
    ]),
  );
}

/* ------------------------------------------------------------------ routing -------------- */

async function route() {
  const health = await fetch("/health").then((r) => r.json());
  nodeState = { claimed: health.claimed === true, outboxPending: health.outboxPending ?? 0 };
  renderStatus(sessionReadout());

  if (!nodeState.claimed) return renderClaim();
  if (!isSignedIn()) return renderSignIn();

  const response = await apiFetch("/api/messages");
  if (response.status === 401) {
    // We believed we held a session and we do not. Both halves of the screen have to agree about
    // that: stop the countdown, then say what happened. §5C's distinction is carried in the
    // message — an unreadable ledger is not an empty one.
    clearInterval(sessionTicker);
    renderStatus(null);
    return renderSignIn(
      "Nothing is shown because this session could not be renewed. That is not the same as an " +
        "empty mailbox — sign in again to see what is here.",
    );
  }
  if (!response.ok) {
    return show(notice(`This Node answered ${response.status}. The ledger could not be read.`, "bad"));
  }

  const { messages } = await response.json();
  return messages.length === 0 ? renderEmpty() : renderLedger(messages);
}

onSessionChange((event) => {
  if (event.type === "refreshed") {
    // Visible on purpose. A refresh that happens silently is indistinguishable from one that
    // never happened, and this readout is how an operator confirms the machinery works.
    renewingUntil = Date.now() + 1200;
    renderStatus("session · renewed");
  }
  if (event.type === "signed-out") {
    clearInterval(sessionTicker);
    renderStatus(null);
    renderSignIn(event.message ?? null);
  }
  if (event.type === "signed-in") startSessionTicker();
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
