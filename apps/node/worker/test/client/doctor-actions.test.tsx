import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * The doctor screen's remedies (wave 2, stream B).
 *
 * `doctor` named a route in every `fix` and the browser offered none of them, so an administrator read
 * "POST /api/maintenance/reseal" on a screen and went to find a terminal. These are the places where a
 * plausible rendering would be **wrong**:
 *
 * 1. **A button on a finding that is fine is a button on nothing.** A remedy appears only on the finding
 *    it answers, and only while that finding fails.
 * 2. **The codes are shown, and the confirm field is not filled in for you.** A screen that typed the code
 *    back would clear the finding without a person holding the sheet (`docs/authentication.md`, #136).
 *    And nothing sends the ten back to the Node: the confirm body carries the one a person typed.
 * 3. **The content-deleting call takes two clicks.** One click must make no request.
 * 4. **A refusal arrives whole**, including a handler that sends `what/why/fix` without `message`.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/doctor" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Doctor } = await import("../../src/client/app/screens/ledgers.tsx");

const CODES = [
  "aaaa-bbbb-cccc", "dddd-eeee-ffff", "gggg-hhhh-iiii", "jjjj-kkkk-llll", "mmmm-nnnn-oooo",
  "pppp-qqqq-rrrr", "ssss-tttt-uuuu", "vvvv-wwww-xxxx", "yyyy-zzzz-0000", "1111-2222-3333",
];

const TRANSPORT = { transport: { adapter: "cloudflare", capability: { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "test" }, available: { binding: true, rest: null } } };

function finding(check: string, ok: boolean, extra: Record<string, unknown> = {}) {
  return { check, severity: ok ? "report" : "degraded", ok, detail: `${check} detail`, ...extra };
}

/** Mounts the screen against a report, and answers each act with the body a test hands it. */
function mount(findings: unknown[], answers: Record<string, { status?: number; body: unknown }> = {}) {
  answerWith((call) => {
    if (call.path === "/api/doctor") return Response.json({ verdict: "ok", claimed: true, at: "2026-09-26T00:00:00.000Z", findings });
    if (call.path === "/api/transport") return Response.json(TRANSPORT);
    const key = `${call.method} ${call.path}`;
    const answer = answers[key];
    if (answer === undefined) return undefined;
    return Response.json(answer.body, { status: answer.status ?? 200 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Doctor /></QueryClientProvider>);
}

const posts = () => calls.filter((call) => call.method === "POST");

beforeEach(reset);

describe("which finding gets which remedy", () => {
  it("offers nothing on a finding that is fine, except the verifier", async () => {
    mount([
      finding("migrations_applied", true), finding("evidence_key_generation", true), finding("evidence_orphans", true),
      finding("draft_bodies_stranded", true), finding("recovery_key_conflicts", true), finding("body_index_failed", true),
      finding("evidence_present", true),
    ]);
    await screen.findByText("evidence_present");
    const buttons = screen.getAllByRole("button").map((one) => one.textContent);
    expect(buttons).toEqual(["verify a batch", "save credentials"]);
  });

  it("puts each remedy on its own failing finding, once", async () => {
    mount([
      finding("migrations_applied", false), finding("evidence_key_generation", false),
      finding("evidence_orphans", false), finding("recovery_key_conflicts", false), finding("body_index_failed", false),
    ].map((one) => (one.check === "evidence_key_generation" ? { ...one, fix: "reseal by hand" } : one)),
    { "GET /api/search/failed": { body: { failed: [] } } });
    await screen.findByText("apply migrations");
    // The finding's own `fix` text stays beside the button: the CLI verb still works, and it is what an
    // operator has when the bundle cannot load.
    expect(screen.getByText("Fix: reseal by hand").textContent).toBe("Fix: reseal by hand");
    expect(await screen.findByText("The failed list is empty now.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "reseal a batch" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "collect them…" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "record the assessment" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "mint a new set" })).toBeNull();
  });
});

describe("recovery codes in the browser", () => {
  it("mints on click, shows all ten, and leaves the confirm field for a person to type", async () => {
    mount([finding("recovery_escrow", false)], {
      "POST /api/recovery-codes/rotate": { body: { codes: CODES, escrowed: { content: 2, credential: 1 }, set: "rcs_1", notice: "Store them, then confirm one." } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "mint a new set" }));
    const list = await screen.findByRole("list", { name: "Recovery codes" });
    expect([...list.querySelectorAll("li")].map((one) => one.textContent)).toEqual(CODES);
    expect(screen.getByText(/Store them, then confirm one\./).textContent).toContain("Write these down now.");
    expect(screen.getByText("rcs_1").closest("p")?.textContent).toContain("content key generation 2");
    // Not prefilled, and a password field: a code that is not spent by confirming is a live key.
    const field = screen.getByLabelText("confirm one code") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.type).toBe("password");
    expect(posts().map((call) => call.path)).toEqual(["/api/recovery-codes/rotate"]);
  });

  it("confirms the one code typed, sends no other, and clears the field either way", async () => {
    mount([finding("recovery_escrow", false)], {
      "POST /api/recovery-codes/confirm": { body: { confirmed: 10, alreadyConfirmed: false, message: "Confirmed. 10 code(s) marked as held; none were spent." } },
    });
    const field = await screen.findByLabelText("confirm one code") as HTMLInputElement;
    const confirm = screen.getByRole("button", { name: "confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: " dddd-eeee-ffff " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await screen.findByText("Confirmed. 10 code(s) marked as held; none were spent.");
    expect(posts().map((call) => [call.path, call.body])).toEqual([["/api/recovery-codes/confirm", { code: "dddd-eeee-ffff" }]]);
    expect(field.value).toBe("");
  });

  it("drops the sheet from the screen when the person says it is saved", async () => {
    mount([finding("recovery_escrow", false)], {
      "POST /api/recovery-codes/rotate": { body: { codes: CODES, escrowed: { content: 1, credential: 1 }, set: "rcs_1", notice: "n" } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "mint a new set" }));
    fireEvent.click(await screen.findByRole("button", { name: "I have saved these ten codes" }));
    expect(screen.queryByRole("list", { name: "Recovery codes" })).toBeNull();
    expect(document.body.textContent).not.toContain(CODES[0]);
  });
});

describe("the fix buttons", () => {
  it("applies migrations and shows the Node's own sentence", async () => {
    mount([finding("migrations_applied", false)], {
      "POST /api/prepare": { body: { applied: ["0070"], raced: [], alreadyCurrent: false, message: "Applied 1 migration(s)." } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "apply migrations" }));
    expect((await screen.findByRole("status")).textContent).toBe("Applied 1 migration(s).");
  });

  it("shows a refusal of the migration as the refusal, not as an empty result", async () => {
    // §5C: once claimed, `/api/prepare` answers 404 to anybody but an administrator, with no `message`.
    mount([finding("migrations_applied", false)], { "POST /api/prepare": { status: 404, body: { error: "not_found" } } });
    fireEvent.click(await screen.findByRole("button", { name: "apply migrations" }));
    expect((await screen.findByRole("alert")).textContent).toBe("not_found");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reseals a batch and says what remains", async () => {
    mount([finding("evidence_key_generation", false)], {
      "POST /api/maintenance/reseal": { body: { resealed: 25, alreadyCurrent: 3, failed: [{}], remaining: 40, targetGeneration: 2 } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "reseal a batch" }));
    expect((await screen.findByRole("status")).textContent)
      .toBe("25 resealed under generation 2, 3 already current, 1 failed. 40 remaining — run it again until that reaches 0.");
  });

  it("renders a refused reseal as the refusal, with nothing counted", async () => {
    mount([finding("evidence_key_generation", false)], {
      "POST /api/maintenance/reseal": { status: 503, body: { error: "E_VAULT_UNREACHABLE", message: "E_VAULT_UNREACHABLE  the key vault did not answer\n  why      it is a Durable Object\n  fix      try again" } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "reseal a batch" }));
    expect((await screen.findByRole("alert")).textContent).toContain("fix      try again");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("collects orphans only on the second click, with collect=1", async () => {
    mount([finding("evidence_orphans", false)], {
      "POST /api/maintenance/reconcile?collect=1": { body: { orphans: [], orphansDeleted: 4, draftBodiesDeleted: 1, exportObjectsDeleted: 0 } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "collect them…" }));
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "delete them now" }));
    expect((await screen.findByRole("status")).textContent).toBe("Deleted 4 orphan(s), 1 draft body/bodies, 0 export object(s).");
    expect(posts().map((call) => call.path)).toEqual(["/api/maintenance/reconcile?collect=1"]);
  });

  it("acknowledges a collision against the typed restore id, and renders the refusal whole", async () => {
    mount([finding("recovery_key_conflicts", false)], {
      "POST /api/recovery/conflicts/rst_9/acknowledge": {
        status: 422,
        body: { error: "E_RESTORE_HAD_NO_CONFLICT", message: "E_RESTORE_HAD_NO_CONFLICT  restore rst_9 reported no key collision\n  why      it went cleanly\n  fix      check the restore id" },
      },
    });
    fireEvent.change(await screen.findByLabelText("restore id"), { target: { value: " rst_9 " } });
    fireEvent.change(screen.getByLabelText("what was examined"), { target: { value: "mail of Q3" } });
    fireEvent.change(screen.getByLabelText("what was concluded"), { target: { value: "nothing of value" } });
    fireEvent.click(screen.getByRole("button", { name: "record the assessment" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("fix      check the restore id");
    expect(posts().map((call) => [call.path, call.body]))
      .toEqual([["/api/recovery/conflicts/rst_9/acknowledge", { scope: "mail of Q3", conclusion: "nothing of value" }]]);
  });

  it("lists the body index's failures with their reasons and requeues only the ticked ones", async () => {
    mount([finding("body_index_failed", false)], {
      "GET /api/search/failed": { body: { failed: [
        { messageId: "msg_a", state: "retryable", attempts: 3, error: "R2 timed out" },
        { messageId: "msg_b", state: "unindexable", attempts: 5, error: null },
      ] } },
      "POST /api/search/repair": { body: { requeued: 1, message: "Queued for the next backfill pass." } },
    });
    expect((await screen.findByText("R2 timed out")).textContent).toBe("R2 timed out");
    expect(screen.getByText("unindexable")).toBeTruthy();
    expect((screen.getByRole("button", { name: "requeue 0 message(s)" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("repair msg_b"));
    fireEvent.click(screen.getByLabelText("repair msg_b"));
    fireEvent.click(screen.getByLabelText("repair msg_a"));
    fireEvent.click(screen.getByRole("button", { name: "requeue 1 message(s)" }));
    expect((await screen.findByRole("status")).textContent).toBe("1 requeued. Queued for the next backfill pass.");
    expect(posts().map((call) => [call.path, call.body])).toEqual([["/api/search/repair", { messageIds: ["msg_a"] }]]);
  });

  it("renders a bare what/why/fix refusal rather than its code alone", async () => {
    mount([finding("body_index_failed", false)], {
      "GET /api/search/failed": { body: { failed: [{ messageId: "msg_a", state: "retryable", attempts: 1, error: null }] } },
      "POST /api/search/repair": { status: 422, body: { error: "unprocessable", what: "no message ids to repair", why: "repair is per message", fix: "pass the ids worth retrying" } },
    });
    fireEvent.click(await screen.findByLabelText("repair msg_a"));
    fireEvent.click(screen.getByRole("button", { name: "requeue 1 message(s)" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no message ids to repair");
    expect(alert.textContent).toContain("fix      pass the ids worth retrying");
  });
});

describe("every refusal is rendered as the refusal", () => {
  const REFUSAL = { status: 503, body: { error: "E_VAULT_UNREACHABLE", message: "E_VAULT_UNREACHABLE  the key vault did not answer\n  why      it is a Durable Object\n  fix      try again" } };
  it.each([
    ["recovery_escrow", "POST /api/recovery-codes/rotate", ["mint a new set"]],
    ["evidence_orphans", "POST /api/maintenance/reconcile?collect=1", ["collect them…", "delete them now"]],
    ["evidence_present", "POST /api/evidence/verify", ["verify a batch"]],
  ])("%s: a refused %s", async (check, route, clicks) => {
    mount([finding(check, check === "evidence_present")], { [route]: REFUSAL });
    for (const name of clicks) fireEvent.click(await screen.findByRole("button", { name }));
    expect((await screen.findByRole("alert")).textContent).toContain("fix      try again");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("list", { name: "Recovery codes" })).toBeNull();
  });

  it("says the failed list could not be read, rather than rendering an empty one", async () => {
    mount([finding("body_index_failed", false)], { "GET /api/search/failed": { status: 500, body: { message: "the catalog did not answer" } } });
    expect((await screen.findByText("the catalog did not answer")).textContent).toBe("the catalog did not answer");
    expect(screen.queryByText("The failed list is empty now.")).toBeNull();
  });
});

describe("verifying evidence", () => {
  it("reports the batch as the Node counted it, lists each fault, and continues from the cursor", async () => {
    let batch = 0;
    answerWith((call) => {
      if (call.path === "/api/doctor") return Response.json({ verdict: "ok", claimed: true, at: "2026-09-26T00:00:00.000Z", findings: [finding("evidence_present", true)] });
      if (call.path === "/api/transport") return Response.json(TRANSPORT);
      if (call.path.startsWith("/api/evidence/verify")) {
        batch += 1;
        return Response.json(batch === 1
          ? { checked: 50, after: null, table: "receipts", intact: false, resumeAfter: "rcpt_50", bytesRead: 1024,
              faults: [{ rowId: "rcpt_7", table: "receipts", column: "blob_key", blobKey: "k", kind: "missing", detail: "no object" }] }
          : { checked: 2, after: "rcpt_50", table: "drafts", intact: true, resumeAfter: null, bytesRead: 10, faults: [] });
      }
      return undefined;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Doctor /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "verify a batch" }));
    const first = await screen.findByRole("status");
    expect(first.textContent).toContain("50 object(s) checked in receipts, 1024 bytes read: 1 fault(s). More remains.");
    expect(first.textContent).toContain("missing receipts.blob_key rcpt_7: no object");

    fireEvent.click(screen.getByRole("button", { name: "continue from where it stopped" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 object(s) checked in drafts"));
    expect(screen.getByRole("status").textContent).toContain("intact. That was the last batch.");
    expect(posts().map((call) => call.path)).toEqual(["/api/evidence/verify", "/api/evidence/verify?after=rcpt_50"]);
  });
});
