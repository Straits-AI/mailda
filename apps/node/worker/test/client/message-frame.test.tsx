import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, reset } from "./session-stub.ts";
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

// `useNavigate` needs a router around it; nothing here navigates.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");

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
};

/** What `/api/messages/:id/body` returns for an HTML message: sanitised markup, for a sandboxed frame. */
const BODY = {
  state: "html",
  html: "<p>Invoice 4417 is attached.</p>",
  text: null,
  blockedRemote: 1,
  truncated: false,
  problem: null,
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Inbox />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  reset();
  answerWith((call) => {
    if (call.path.endsWith("/body")) return Response.json(BODY);
    if (call.path.startsWith("/api/messages")) return Response.json({ messages: [MESSAGE] });
    return Response.json({});
  });
});

/** The CSP as a directive map, so a test reads one directive rather than matching a whole string. */
function directive(name: string): string[] {
  const found = CONTENT_SECURITY_POLICY.split(";")
    .map((part) => part.trim().split(/\s+/))
    .find((parts) => parts[0] === name);
  return found === undefined ? [] : found.slice(1);
}

describe("the reading pane renders mail into a sandboxed frame", () => {
  it("puts the sanitised body in an iframe the policy allows", async () => {
    mount();

    // `findBy`, not a hand-rolled microtask drain: the list arrives from a query and the body arrives from
    // a second one the click starts, so this waits for each in turn rather than guessing how many ticks
    // React and TanStack Query need between them.
    const row = await screen.findByRole("button", { name: /An invoice/ });
    await act(async () => { row.click(); });

    const frame = await waitFor(() => {
      const found = document.querySelector("iframe.message-body");
      expect(found, "the reading pane rendered no frame, so there is nothing for frame-src to permit").not
        .toBeNull();
      return found as HTMLIFrameElement;
    });

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
