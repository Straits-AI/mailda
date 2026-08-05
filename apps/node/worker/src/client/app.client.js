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
    items.push(
      el("button", { class: "linkish", text: "inbox", onclick: () => route() }),
      el("button", { class: "linkish", text: "outbox", onclick: () => renderOutbox() }),
      el("button", { class: "linkish", text: "audit", onclick: () => renderAudit() }),
      el("button", { class: "linkish", text: "log", onclick: () => renderLogs() }),
      el("button", { class: "linkish", text: "sign out", onclick: () => logout() }),
    );
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
    // Declared before `detail`, which references it. Putting it next to `row` left it in the temporal
    // dead zone and threw at render — the kind of error no server-side test can catch, because none of
    // them execute this file.
    const bodyHost = el("div", { class: "body-host" });

    const detail = el("tr", { class: "detail", hidden: "hidden" }, [
      el("td", { colspan: "5" }, [
        el("dl", {}, [
          el("dt", { text: "receipt" }), el("dd", { class: "mono", text: message.id }),
          el("dt", { text: "envelope from" }), el("dd", { class: "mono", text: message.envelope_from }),
          el("dt", { text: "accepted" }), el("dd", { class: "mono", text: message.accepted_at }),
          el("dt", { text: "stored" }),
          el("dd", { class: "mono", text: `${bytes(message.raw_bytes)} — framed, encrypted at rest` }),
        ]),
        el("div", { class: "row-actions" }, [
          el("button", {
            class: "linkish",
            text: "reply",
            onclick: () =>
              composer({
                mailboxId: nodeState.mailboxId,
                inReplyToMessageId: message.message_id ?? undefined,
                to: message.envelope_from,
                subject: /^re:/i.test(message.subject ?? "") ? message.subject : `Re: ${message.subject ?? ""}`,
                body: `\n\nOn ${new Date(message.accepted_at).toLocaleString()}, ${message.envelope_from} wrote:\n> …`,
              }),
          }),
        ]),
        bodyHost,
      ]),
    ]);

    // The header `From`, not the envelope sender.
    //
    // For anything Cloudflare sent, the envelope sender is the return path
    // (`bounces@cf-bounce.<domain>`), which is not who wrote the message — a column labelled "From"
    // showing that is a quiet lie of exactly the kind §5C exists to stop. #27 parses the real header
    // into `messages.from_addr`; the envelope is still shown, in the detail, where it is labelled as
    // what it is.
    const row = el("tr", { class: "entry", tabindex: "0", "data-reveal": "" }, [
      el("td", { text: message.from_addr ?? message.envelope_from }),
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

    const toggle = () => {
      detail.hidden = !detail.hidden;
      row.classList.toggle("open", !detail.hidden);
      // Fetched on first open rather than for every row: a body costs a decrypt and a sanitise pass.
      if (!detail.hidden && bodyHost.childElementCount === 0) openBody(message.id, bodyHost);
    };
    row.addEventListener("click", (event) => {
      if (event.target.tagName !== "A" && event.target.tagName !== "BUTTON") toggle();
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

/* ------------------------------------------------------------------ reading a body -------- */

/**
 * The body panel.
 *
 * **The iframe is the trust boundary, not the sanitiser** (ADR 37). `sandbox` with neither
 * `allow-scripts` nor `allow-same-origin` gives the body an opaque origin and executes nothing, so
 * whatever the server-side sanitiser misses still cannot run. Sanitising reduces what the browser's
 * parser is handed and withholds remote content; it is not a claim the output is inert.
 *
 * `srcdoc` rather than a `src` URL, so the HTML never becomes a fetchable resource on this origin.
 */
function bodyPanel(body) {
  if (body.state === "unparsed") {
    return el("div", {}, [
      notice(body.problem, "bad"),
      el("p", { class: "hint", text: "The original is unchanged. Download the .eml to read it elsewhere." }),
    ]);
  }
  if (body.state === "no-body") {
    // §5C: distinct from a body that was refused, and from one this reader may not see.
    return notice("This message has no body. That is what the sender sent.");
  }

  const parts = [];

  if (body.truncated) {
    parts.push(notice(
      "This body was too large to render in full, so it is shown truncated. The complete original is " +
      "unchanged and downloadable.",
    ));
  }

  if (body.blockedRemote > 0) {
    // Never silent. A reader has to know something was withheld, and why.
    parts.push(notice(
      `${body.blockedRemote} remote image${body.blockedRemote === 1 ? "" : "s"} withheld. Loading them ` +
      `would tell the sender you opened this message.`,
    ));
  }

  if (body.state === "text-only") {
    parts.push(el("pre", { class: "body-text", text: body.text }));
    return el("div", {}, parts);
  }

  const frame = el("iframe", {
    class: "body-frame",
    // No allow-scripts and no allow-same-origin. This is the boundary.
    sandbox: "",
    referrerpolicy: "no-referrer",
    loading: "lazy",
    title: "Message body",
  });
  // A second, independent block on remote fetching: even if a URL survived sanitising, the frame's own
  // policy refuses to load it.
  frame.setAttribute(
    "srcdoc",
    `<!doctype html><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
      `<style>body{font:14px/1.55 system-ui,sans-serif;margin:0;color-scheme:light dark}` +
      `img[data-mailda-blocked]{outline:1px dashed currentColor;outline-offset:2px;opacity:.5;min-width:12px;min-height:12px}` +
      `</style>${body.html}`,
  );
  parts.push(frame);
  return el("div", {}, parts);
}

async function openBody(receiptId, host) {
  host.replaceChildren(el("p", { class: "hint", text: "Reading…" }));
  const response = await apiFetch(`/api/messages/${encodeURIComponent(receiptId)}/body`);
  if (!response.ok) {
    host.replaceChildren(notice(`The body could not be read (${response.status}).`, "bad"));
    return;
  }
  host.replaceChildren(bodyPanel(await response.json()));
}

/* ------------------------------------------------------------------ composing ------------- */

/**
 * The composer.
 *
 * Sealing and dispatching are separate steps (ADR 35), and this surface makes that visible rather than
 * hiding it behind a Send button: a sealed message sits `held` for its mailbox's window, and the undo is
 * a real cancellation of something that never left — not a recall, which would be a lie.
 */
function composer(context) {
  const to = field("to", "To", { value: context.to ?? "", required: "required", class: "mono" });
  const subject = field("subject", "Subject", { value: context.subject ?? "", required: "required" });
  const bodyInput = el("textarea", { id: "body", rows: "10", required: "required" });
  bodyInput.value = context.body ?? "";
  const errors = el("div", { class: "errors", role: "alert" });
  const submit = el("button", { class: "primary", type: "submit", text: "Seal and send" });

  const form = el("form", { novalidate: "novalidate" }, [
    to.node,
    subject.node,
    el("label", { class: "field-row", for: "body" }, [el("span", { text: "Message" }), bodyInput]),
    el("p", {
      class: "hint",
      text:
        "Sealing records exactly what will be sent before anything leaves. It then waits, so you can " +
        "still stop it — nothing is recalled, because a recall would not be honest.",
    }),
    submit, errors,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errors.replaceChildren();
    submit.disabled = true;
    submit.textContent = "Sealing…";
    try {
      const response = await apiFetch("/api/sends", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mailboxId: context.mailboxId,
          inReplyToMessageId: context.inReplyToMessageId,
          to: to.input.value.split(/[,;]+/).map((s) => s.trim()).filter(Boolean),
          subject: subject.input.value,
          body: bodyInput.value,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        // The server's four-part message, verbatim — it names the remedy.
        errors.replaceChildren(notice(result.message ?? "This message could not be sealed.", "bad"));
        return;
      }
      return renderOutbox(result.id);
    } finally {
      submit.disabled = false;
      submit.textContent = "Seal and send";
    }
  });

  show(
    el("div", { class: "split" }, [
      el("div", { class: "split-lede", "data-reveal": "" }, [
        el("h1", { text: context.inReplyToMessageId ? "Reply" : "New message" }),
        el("p", {
          text:
            "This will be sent from the mailbox, not from you. Who wrote it is recorded here and does " +
            "not travel with the message — a name in the From line would tell every correspondent who " +
            "works here.",
        }),
      ]),
      panel(context.inReplyToMessageId ? "Reply" : "Compose", null, [form]),
    ]),
  );
}

/* ------------------------------------------------------------------ the outbox ------------- */

/**
 * The seven states of ADR 39, named as they are named everywhere else (§16).
 *
 * `sent` and `delivered` are absent because they would be claims nobody observed. The wording here is
 * the product's argument, not an apology for it.
 */
const SEND_STATES = {
  held: { label: "held", note: "Not sent yet. You can still stop this." },
  cancelled: { label: "cancelled", note: "Stopped before it left." },
  throttled: { label: "throttled", note: "Rate-limited by the mail service. It has not left, and will be retried." },
  refused: { label: "refused", note: "The mail service would not accept it. It never left." },
  suppressed: { label: "suppressed", note: "The mail service will never deliver to this recipient." },
  handed_over: { label: "handed over", note: "Accepted by the mail service. Whether it arrived is not knowable from here." },
  outcome_unknown: { label: "outcome unknown", note: "We do not know whether it left. It will not be retried automatically." },
};

async function renderOutbox(highlightId) {
  const response = await apiFetch("/api/sends");
  if (!response.ok) return show(notice(`The outbox could not be read (${response.status}).`, "bad"));
  const { sends, daily, capability } = await response.json();

  const rows = sends.flatMap((send) => {
    const state = SEND_STATES[send.state] ?? { label: send.state, note: "" };
    const row = el("tr", { class: send.id === highlightId ? "entry open" : "entry", "data-reveal": "" }, [
      el("td", { text: send.subject }),
      el("td", { class: "dim mono", text: (JSON.parse(send.envelope_to) || []).join(", ") }),
      el("td", {}, [el("span", { class: `state state-${send.state}`, text: state.label })]),
      el("td", { class: "num mono dim", text: new Date(send.state_at).toLocaleTimeString(undefined, { hour12: false }) }),
      el("td", { class: "num" }, [
        send.state === "held"
          ? el("button", {
              class: "linkish",
              text: "stop",
              onclick: async () => {
                const result = await apiFetch(`/api/sends/${encodeURIComponent(send.id)}/cancel`, { method: "POST" });
                const outcome = await result.json();
                if (!outcome.cancelled) window.alert(outcome.reason ?? "It could not be stopped.");
                renderOutbox(send.id);
              },
            })
          : send.fidelity === "authored" && send.state !== "cancelled"
            ? el("a", { class: "mono", href: `/api/sends/${encodeURIComponent(send.id)}/submitted`, text: ".eml" })
            : el("span", { class: "dim mono", text: "—" }),
      ]),
    ]);

    const detail = el("tr", { class: "detail", hidden: send.id === highlightId ? null : "hidden" }, [
      el("td", { colspan: "5" }, [
        el("dl", {}, [
          el("dt", { text: "what this means" }), el("dd", { text: state.note }),
          el("dt", { text: "manifest" }), el("dd", { class: "mono", text: send.id }),
          ...(send.last_error === null ? [] : [el("dt", { text: "reported" }), el("dd", { text: send.last_error })]),
        ]),
      ]),
    ]);

    const toggle = () => { detail.hidden = !detail.hidden; row.classList.toggle("open", !detail.hidden); };
    row.addEventListener("click", (event) => {
      if (event.target.tagName !== "A" && event.target.tagName !== "BUTTON") toggle();
    });
    return [row, detail];
  });

  const limit = daily.throttledAtCount === null
    ? `${daily.handedOver} handed over today. Your daily limit is not published by Cloudflare; it will be recorded here the first time you hit it.`
    : `${daily.handedOver} handed over today. You were first throttled at ${daily.throttledAtCount} — that is your observed daily limit.`;

  show(
    el("div", { class: "ledger-head", "data-reveal": "" }, [
      el("h1", { text: "Outbox" }),
      el("p", { class: "count mono", text: `${sends.length} message${sends.length === 1 ? "" : "s"}` }),
    ]),
    capability.canSend ? null : notice(capability.detail, "bad"),
    notice(limit),
    sends.length === 0
      ? el("p", { class: "hint", text: "Nothing has been sealed yet." })
      : el("div", { class: "scroller" }, [
          el("table", {}, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "Subject" }), el("th", { text: "To" }), el("th", { text: "State" }),
              el("th", { class: "num", text: "When" }), el("th", { class: "num", text: "Submitted" }),
            ])]),
            el("tbody", {}, rows),
          ]),
        ]),
  );
}

/* ------------------------------------------------------------------ audit and logs -------- */

/**
 * The audit trail, in the product.
 *
 * An administrator should not have to open the Cloudflare dashboard to answer "who did that". And the
 * verification button is the reason this is a chain rather than a list: a log you have to trust is not
 * evidence, and this one can be checked in front of you.
 */
async function renderAudit() {
  const response = await apiFetch("/api/audit");
  if (!response.ok) return show(notice(`The audit trail could not be read (${response.status}).`, "bad"));
  const { entries } = await response.json();

  const verdict = el("div", { class: "errors" });
  const verify = el("button", {
    class: "primary",
    text: "Verify the chain",
    onclick: async () => {
      verdict.replaceChildren(el("p", { class: "hint", text: "Re-hashing…" }));
      const result = await (await apiFetch("/api/audit/verify", { method: "POST" })).json();
      verdict.replaceChildren(
        result.intact
          ? notice(
              `Verified: ${result.checked} entr${result.checked === 1 ? "y" : "ies"} re-hashed and each ` +
              `follows the one before it.` +
              (result.resumeFrom === null ? "" : ` More remain; verification is batched.`),
            )
          // The broken link, not a bare verdict — an investigation needs where, not whether.
          : notice(
              `Chain broken at entry ${result.brokenAt.seq} (${result.brokenAt.id}): ` +
              `${result.brokenAt.reason}`,
              "bad",
            ),
      );
    },
  });

  const rows = entries.map((entry) =>
    el("tr", { class: "entry", "data-reveal": "" }, [
      el("td", { class: "num mono dim", text: String(entry.seq) }),
      el("td", { class: "mono", text: entry.action }),
      el("td", {}, [el("span", { class: `state state-audit-${entry.outcome}`, text: entry.outcome })]),
      el("td", { class: "dim mono", text: entry.actor_user_id ?? entry.actor_kind }),
      el("td", { class: "dim mono", text: entry.subject ?? "—" }),
      el("td", { class: "num mono dim", text: new Date(entry.at).toLocaleString(undefined, { hour12: false }) }),
    ]),
  );

  show(
    el("div", { class: "ledger-head", "data-reveal": "" }, [
      el("h1", { text: "Audit" }),
      el("p", { class: "count mono", text: `${entries.length} most recent` }),
    ]),
    notice(
      "Every entry carries the hash of the one before it, so a deletion, a reordering or an edit " +
      "breaks verification at a nameable point. This cannot stop someone with database access from " +
      "rewriting the whole chain — you own the database — but it turns trusting this log into " +
      "checking it.",
    ),
    verify,
    verdict,
    entries.length === 0
      ? el("p", { class: "hint", text: "Nothing recorded yet." })
      : el("div", { class: "scroller" }, [
          el("table", {}, [
            el("thead", {}, [el("tr", {}, [
              el("th", { class: "num", text: "#" }), el("th", { text: "Action" }),
              el("th", { text: "Outcome" }), el("th", { text: "Actor" }),
              el("th", { text: "Subject" }), el("th", { class: "num", text: "When" }),
            ])]),
            el("tbody", {}, rows),
          ]),
        ]),
  );
}

/** The operational log — why something behaved oddly, as opposed to who did what. */
async function renderLogs(level = null) {
  const response = await apiFetch(`/api/logs${level === null ? "" : `?level=${level}`}`);
  if (!response.ok) return show(notice(`The log could not be read (${response.status}).`, "bad"));
  const { entries, counts } = await response.json();

  const rows = entries.flatMap((entry) => {
    const detail = el("tr", { class: "detail", hidden: "hidden" }, [
      el("td", { colspan: "4" }, [
        el("dl", {}, [
          el("dt", { text: "event" }), el("dd", { class: "mono", text: entry.event }),
          ...(entry.request_id === null ? [] : [
            el("dt", { text: "request" }), el("dd", { class: "mono", text: entry.request_id }),
          ]),
          ...(entry.detail === null ? [] : [
            el("dt", { text: "detail" }), el("dd", { class: "mono", text: entry.detail }),
          ]),
        ]),
      ]),
    ]);
    const row = el("tr", { class: "entry", "data-reveal": "" }, [
      el("td", {}, [el("span", { class: `state state-log-${entry.level}`, text: entry.level })]),
      el("td", { class: "mono", text: entry.event }),
      el("td", { text: entry.message }),
      el("td", { class: "num mono dim", text: new Date(entry.at).toLocaleString(undefined, { hour12: false }) }),
    ]);
    row.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      row.classList.toggle("open", !detail.hidden);
    });
    return [row, detail];
  });

  const summary = counts.map((c) => `${c.n} ${c.level}`).join(", ") || "nothing recorded";

  show(
    el("div", { class: "ledger-head", "data-reveal": "" }, [
      el("h1", { text: "Log" }),
      el("p", { class: "count mono", text: summary }),
    ]),
    el("div", { class: "row-actions" }, [
      el("button", { class: "linkish", text: "all", onclick: () => renderLogs() }),
      el("button", { class: "linkish", text: "errors", onclick: () => renderLogs("error") }),
      el("button", { class: "linkish", text: "warnings", onclick: () => renderLogs("warn") }),
    ]),
    entries.length === 0
      ? el("p", { class: "hint", text: "Nothing recorded at this level." })
      : el("div", { class: "scroller" }, [
          el("table", {}, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "Level" }), el("th", { text: "Event" }),
              el("th", { text: "Message" }), el("th", { class: "num", text: "When" }),
            ])]),
            el("tbody", {}, rows),
          ]),
        ]),
  );
}

/* ------------------------------------------------------------------ routing -------------- */

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
  // Needed by the composer: From is the mailbox (ADR 36), so composing requires knowing which one.
  nodeState.mailboxId = messages[0]?.mailbox_id ?? nodeState.mailboxId;
  renderStatus(sessionReadout());
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
