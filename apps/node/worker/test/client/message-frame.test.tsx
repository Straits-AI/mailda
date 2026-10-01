import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messageBodyResponse } from "@mailda/contract/schemas";

import { install } from "/app/locale.js";
import { answerWith, reset } from "./session-stub.ts";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { CONTENT_SECURITY_POLICY } from "../../src/security-headers.ts";

/**
 * The message reader still renders through a frame, and the policy still permits one (#97).
 *
 * ## Why this test exists at all
 *
 * The CSP added in #97 could have been written `frame-src 'none'`, which is what a hardening checklist
 * says and what most applications want. This one renders sanitised mail into an iframe with `sandbox=""`
 * (ADR 37) and that iframe **is** the trust boundary for hostile mail HTML. A policy that broke it would
 * break the reading pane, and the way that gets diagnosed is somebody deleting the policy — trading a real
 * defence for a checklist item, on a Friday.
 *
 * So the two halves are asserted in one place: **this is the frame the reader renders**, and **that is the
 * directive that has to keep allowing it**.
 *
 * ## What this cannot prove, said plainly
 *
 * happy-dom does not enforce a Content-Security-Policy, so nothing here fails because of one. What it
 * proves is that the reader's frame is the shape the policy was written for — a `srcdoc` frame, not a
 * cross-origin URL — and that `frame-src` is not `'none'`. Enforcement is a browser question, and the
 * browser answer is `pnpm --filter @mailda/worker run axe`, which drives the real application against a
 * running Node with the real header on it.
 *
 * One more thing this cannot prove, and it is the ticket's own premise: that `frame-src 'none'` would break
 * the reader. Measured in Chromium, it does **not** — a `sandbox=""` `srcdoc` frame renders under `'none'`
 * and under no `frame-src` at all, because a `srcdoc` navigation inherits the parent policy rather than
 * being matched against a source list. `security-headers.ts` records the run and why `'self'` is still the
 * right value: one engine's decision not to enforce a directive is not a policy, and `'self'` is the honest
 * description of what this application frames.
 */

// `useNavigate` needs a router around it; nothing here navigates. Only that: a reader with a message open must
// render without `Link` or a router hook, and this partial mock is what would throw if it did.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");
const { frameHead } = await import("../../src/client/app/screens/reader.tsx");

const MESSAGE = {
  id: "msg_01",
  message_id: "<a@example.net>",
  subject: "An invoice",
  from_addr: "billing@example.net",
  envelope_from: "billing@example.net",
  envelope_to: "support@example.test",
  mailbox_id: "mbx_test",
  raw_bytes: 2048,
  accepted_at: "2026-08-26T09:00:00.000Z",
  parse_error: null,
  conversation_id: null,
  case_id: "case_01",
  auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
  attachments: 1, attachments_dangerous: 0, labels_json: "[]", read: 1,
  place: "inbox", from_name: null, preview: null, standing_content: 1, case_mine: 0, case_state: "open",
};

/** What `/api/messages/:id/body` returns for an HTML message: sanitised markup, for a sandboxed frame. */
// Parsed against the contract, so this fixture cannot drift into a body shape the Node never sends — the
// shape it had before 0057 lacked `attachments`, and the pane crashed on it while the test still described
// a Node that no longer existed.
const BODY = messageBodyResponse.parse({
  state: "html",
  html: "<p>Invoice 4417 is attached.</p>",
  text: null,
  blockedRemote: 1,
  truncated: false,
  problem: null,
  attachments: [{ filename: "invoice-4417.pdf", declaredType: "application/pdf", bytes: 20480, verdict: "plain" }],
  links: [], recipients: { to: [], cc: [], replyTo: null }, script: null,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ShellProvider><Inbox /></ShellProvider>
    </QueryClientProvider>,
  );
}

let body: typeof BODY = BODY;

beforeEach(() => {
  reset();
  body = BODY;
  answerWith((call) => {
    if (call.path.endsWith("/body")) return Response.json(body);
    if (call.path.startsWith("/api/messages")) return Response.json({ messages: [MESSAGE] });
    return Response.json({});
  });
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
  install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
});

/** Opens the one message and returns its frame. */
async function openFrame(): Promise<HTMLIFrameElement> {
  mount();
  // `findBy`, not a hand-rolled microtask drain: the list arrives from a query and the body arrives from
  // a second one the click starts, so this waits for each in turn rather than guessing how many ticks
  // React and TanStack Query need between them.
  const row = await screen.findByRole("button", { name: /An invoice/ });
  await act(async () => { row.click(); });
  return await waitFor(() => {
    const found = document.querySelector("iframe.message-body");
    expect(found, "the reading pane rendered no frame, so there is nothing for frame-src to permit").not
      .toBeNull();
    return found as HTMLIFrameElement;
  });
}

/** Opens the one message and returns its plain-text body. */
async function openText(): Promise<HTMLPreElement> {
  mount();
  const row = await screen.findByRole("button", { name: /An invoice/ });
  await act(async () => { row.click(); });
  return await waitFor(() => {
    const found = document.querySelector("pre.message-text");
    expect(found, "the reading pane rendered no plain-text body").not.toBeNull();
    return found as HTMLPreElement;
  });
}

/** The frame document's root start tag, as the reader wrote it. */
const head = (frame: HTMLIFrameElement): string => /^<!doctype html><html[^>]*>/.exec(frame.getAttribute("srcdoc")!)![0];

/** The CSP as a directive map, so a test reads one directive rather than matching a whole string. */
function directive(name: string): string[] {
  const found = CONTENT_SECURITY_POLICY.split(";")
    .map((part) => part.trim().split(/\s+/))
    .find((parts) => parts[0] === name);
  return found === undefined ? [] : found.slice(1);
}

describe("the reading pane renders mail into a sandboxed frame", () => {
  it("puts the sanitised body in an iframe the policy allows", async () => {
    const frame = await openFrame();

    // `srcdoc`, not `src`: an opaque-origin document rather than a same-origin one that happens to be
    // sandboxed. It is also why `frame-src 'self'` is the right value — there is no third-party origin in
    // this product's frames, so `'self'` is both sufficient and the whole of what is needed.
    //
    // Asserted as "present" before "contains", because a frame switched to `src` returns `null` here and
    // `toContain(null)` complains about its arguments instead of saying which frame arrived.
    expect(frame.getAttribute("srcdoc"), "the frame has no srcdoc, so the body is loaded some other way").not
      .toBeNull();
    expect(frame.getAttribute("srcdoc")).toContain("Invoice 4417");
    expect(frame.getAttribute("src")).toBeNull();
    // Neither allow-scripts nor allow-same-origin. The two omissions are the actual boundary; the CSP is
    // about the document *around* the frame, and asserting this here keeps the two from being confused.
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  /*
   * The frame is opaque-origin and cannot see the shell's `<html>`, so it is told the viewer's theme on its own
   * root, by the first bytes of its document — and only ever one of the three words, because what reaches a
   * `srcdoc` is markup.
   */
  it("tells the frame the viewer's theme on its own root, first", async () => {
    document.documentElement.dataset.theme = "light";
    const frame = await openFrame();
    expect(frame.getAttribute("srcdoc")!.startsWith(
      '<!doctype html><html data-theme="light"><link rel="stylesheet" href="/app/frame.css">',
    )).toBe(true);
    expect(frame.getAttribute("srcdoc")!.startsWith(frameHead("light", null))).toBe(true);
  });

  it("tells it dark when the shell wears no theme", async () => {
    const frame = await openFrame();
    expect(frame.getAttribute("srcdoc")!.startsWith('<!doctype html><html data-theme="dark">')).toBe(true);
  });

  it("never carries an unchecked attribute into the frame's markup", async () => {
    document.documentElement.dataset.theme = 'x" onload="alert(1)';
    const frame = await openFrame();
    expect(frame.getAttribute("srcdoc")!.startsWith('<!doctype html><html data-theme="dark">')).toBe(true);
    expect(frame.getAttribute("srcdoc")).not.toContain("onload");
  });

  /*
   * The glyph forms Han is drawn in come from the message (critic M9): a GB2312 message in an English interface is
   * still Simplified, and a Japanese one read in a Chinese interface is still Japanese. The viewer's locale is the
   * guess only when the message says nothing, and English guesses nothing. Never `lang`: the frame is the sender's.
   */
  it("takes the script the message says, whatever the interface's language", async () => {
    body = messageBodyResponse.parse({ ...BODY, script: "sc" });
    expect(head(await openFrame())).toBe('<!doctype html><html data-theme="dark" data-script="sc">');
  });

  it("keeps the message's script over the viewer's", async () => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
    body = messageBodyResponse.parse({ ...BODY, script: "jp" });
    expect(head(await openFrame())).toBe('<!doctype html><html data-theme="dark" data-script="jp">');
  });

  it("guesses the viewer's script only for a message that says none, and English guesses nothing", async () => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
    expect(head(await openFrame())).toBe('<!doctype html><html data-theme="dark" data-script="sc">');
    cleanup();
    install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
    expect(head(await openFrame())).toBe('<!doctype html><html data-theme="dark">');
  });

  it("narrows the message's script to one it knows, so a newer Node's is the viewer's guess, never markup", async () => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
    body = messageBodyResponse.parse({ ...BODY, script: "kr" });
    expect(head(await openFrame())).toBe('<!doctype html><html data-theme="dark" data-script="sc">');
  });

  /*
   * A plain-text body is drawn in the shell's own document, not a frame, so it is where the interface's `lang` and
   * its SC stack would reach the sender's text. It clears the one (`lang=""`) and carries the message's script.
   */
  it("gives a plain-text body the message's script and no interface lang", async () => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
    body = messageBodyResponse.parse({ ...BODY, state: "text-only", html: null, text: "直骨誤", script: "jp" });
    const pre = await openText();
    expect(pre.getAttribute("lang")).toBe("");
    expect(pre.getAttribute("data-script")).toBe("jp");
    cleanup();
    install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
    body = messageBodyResponse.parse({ ...BODY, state: "text-only", html: null, text: "hello", script: null });
    const plain = await openText();
    expect(plain.getAttribute("lang")).toBe("");
    expect(plain.hasAttribute("data-script")).toBe(false);
  });

  it("is permitted by frame-src, which is therefore not 'none'", () => {
    /*
     * The assertion the ticket asked for, stated as a dependency rather than as a preference: this reader
     * needs a frame, so the policy that ships with it may not forbid frames. `'self'` rather than a
     * `'none'` with an exception, because browsers disagree about whether a `srcdoc` frame is checked
     * against `frame-src` at all — `'self'` is correct under either reading, and the reader keeps working
     * without depending on which reading a given browser took.
     */
    expect(directive("frame-src")).toEqual(["'self'"]);
    expect(directive("frame-src"), "frame-src 'none' breaks the message reader").not.toContain("'none'");
  });
});

/*
 * Not asserted here: that the *contents* of the frame need nothing `default-src 'none'` refuses. A
 * `srcdoc` document inherits the parent's policy, so that property is real and load-bearing — but it is a
 * property of the sanitiser's output, and asserting it against a fixture written in this file would only
 * prove the fixture. `test/security-headers.test.ts` asserts it against what `sanitizeHtml` actually
 * produces from hostile input, which is the assertion worth having.
 */
