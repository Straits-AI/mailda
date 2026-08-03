/**
 * Provisional UI for Layer 1.
 *
 * §25 specifies React + TanStack Router/Query and an accessible Mailda component system.
 * This is **not** that, and must not be mistaken for it. It exists to prove the Layer 1
 * claim — that a real message reaches a human — with the smallest surface that genuinely
 * works end to end. It gets replaced by the real client, not extended into it.
 *
 * What it does keep faithfully, because these are product rules rather than UI polish:
 *   - It never claims success it has not observed (§5C). A failed claim shows the server's
 *     reason and the actual remedy.
 *   - It distinguishes "no messages yet" from "not signed in" from "Node unclaimed" —
 *     §5C requires those be different states rather than one blank screen.
 *   - Downloading the original `.eml` goes through the authorized streaming route, so what
 *     the user gets is the immutable evidence (§12), not a re-rendering of it.
 *
 * **No `innerHTML` anywhere.** Every value that reaches the DOM does so through
 * `textContent` or a property assignment. In a mail client the most dangerous strings —
 * sender address, subject — are chosen by whoever sent the message, so escaping-on-write
 * is the wrong shape: it is correct only while every author remembers it. Constructing
 * nodes makes injection impossible rather than merely handled, which is the same
 * structural-over-disciplined choice as #4's binding rule and #9's unique constraints.
 */
export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mailda</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in oklab, currentColor 14%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
         max-width: 62rem; margin-inline: auto; padding: 2rem 1.25rem 4rem; }
  header { display: flex; align-items: baseline; gap: .75rem; border-bottom: 1px solid var(--line);
           padding-bottom: .75rem; margin-bottom: 1.5rem; }
  h1 { font-size: 1.05rem; margin: 0; letter-spacing: -0.01em; }
  .layer { font-size: .78rem; opacity: .55; }
  .note { padding: .7rem .9rem; border: 1px solid var(--line); border-radius: 6px;
          font-size: .87rem; margin-bottom: 1.25rem; }
  .bad { border-color: color-mix(in oklab, #d33 45%, var(--line)); }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .55rem .6rem; border-bottom: 1px solid var(--line);
           vertical-align: top; word-break: break-word; }
  th { font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  form { display: grid; gap: .6rem; max-width: 26rem; }
  label { font-size: .82rem; opacity: .75; display: block; }
  input { padding: .5rem .6rem; font: inherit; border: 1px solid var(--line);
          border-radius: 5px; background: transparent; color: inherit; width: 100%; }
  button { padding: .5rem .95rem; font: inherit; border: 1px solid var(--line);
           border-radius: 5px; background: transparent; color: inherit; cursor: pointer; }
  button:hover { background: color-mix(in oklab, currentColor 7%, transparent); }
  a { color: inherit; text-decoration-color: var(--line); text-underline-offset: 2px; }
  .empty { opacity: .6; font-size: .9rem; padding: 1.5rem 0; }
  code { font-size: .85em; opacity: .8; }
</style>
</head>
<body>
<header><h1>Mailda</h1><span class="layer">Layer 1 &middot; provisional interface</span></header>
<main id="app"></main>

<script type="module">
const app = document.getElementById("app");

/** The only way anything reaches the DOM here: nodes and textContent, never markup. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function show(...nodes) {
  app.replaceChildren(...nodes);
}

function note(text, bad = false) {
  return el("div", { class: bad ? "note bad" : "note", text });
}

async function render() {
  const health = await fetch("/health").then((r) => r.json());
  if (!health.claimed) return renderClaim();

  const res = await fetch("/api/messages");
  if (res.status === 401) {
    // §5C: distinct from an empty mailbox. There may be messages this caller cannot see,
    // and saying "no messages" here would be a lie.
    return show(note("You are not signed in, so nothing is shown. This is not the same as an empty mailbox."));
  }

  const { messages } = await res.json();
  if (messages.length === 0) {
    return show(note("This Node is claimed and listening. No messages have arrived yet — send one to an address routed here and it will appear."));
  }

  const head = el("tr", {}, ["From", "To", "Received", "Bytes", ""].map((h, i) =>
    el("th", { text: h, ...(i === 3 ? { class: "num" } : {}) })));

  const rows = messages.map((m) => el("tr", {}, [
    el("td", { text: m.envelope_from }),
    el("td", { text: m.envelope_to }),
    el("td", { text: new Date(m.accepted_at).toLocaleString() }),
    el("td", { class: "num", text: Number(m.raw_bytes).toLocaleString() }),
    el("td", {}, [el("a", { href: "/api/messages/" + encodeURIComponent(m.id) + "/raw", text: "original .eml" })]),
  ]));

  show(el("table", {}, [el("thead", {}, [head]), el("tbody", {}, rows)]));
}

function renderClaim() {
  const org = el("input", { id: "org", value: "Acme", required: "required" });
  const email = el("input", { id: "email", type: "email", required: "required" });
  const secret = el("input", { id: "secret", required: "required", autocomplete: "off" });
  const errors = el("div");

  const form = el("form", {}, [
    el("div", {}, [el("label", { for: "org", text: "Organization name" }), org]),
    el("div", {}, [el("label", { for: "email", text: "Owner email" }), email]),
    el("div", {}, [el("label", { for: "secret", text: "Bootstrap secret" }), secret]),
    el("button", { type: "submit", text: "Claim this Node" }),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errors.replaceChildren();
    const res = await fetch("/api/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization: org.value, email: email.value, secret: secret.value }),
    });
    if (res.ok) return render();
    // §5C: the server's actual reason and remedy, never a generic failure.
    const body = await res.json().catch(() => ({ message: "Claim failed." }));
    errors.replaceChildren(note(body.message ?? "Claim failed.", true));
  });

  const intro = el("div", { class: "note" }, [
    "This Node is not claimed yet. Claim it with the one-time bootstrap secret shown during ",
    el("code", { text: "mailda deploy" }),
    ".",
  ]);

  show(intro, form, errors);
}

render().catch((error) => show(note("Could not reach this Node: " + error.message, true)));
</script>
</body>
</html>`;
}
