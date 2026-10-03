import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "./session-stub.ts";
import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * Four acts the contract offered and no screen reached (26 September 2026): releasing a Butler's send,
 * running a Butler run again, signing out of every device, and the objects a completed export staged.
 *
 * Each test holds two things: that the click reaches **the route the contract names**, and that the Node's
 * refusal is rendered as text rather than swallowed. The release test also holds the gate the button is
 * bound to — a policy hold must not offer it — because one button for two gates is exactly the failure
 * `ledgers.tsx` explains beside *let it go*.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Outbox } = await import("../../src/client/app/screens/ledgers.tsx");
const { Butlers } = await import("../../src/client/app/screens/butlers.tsx");
const { Matters } = await import("../../src/client/app/screens/matters.tsx");
const { Settings } = await import("../../src/client/app/screens/settings.tsx");
const { ShellProvider, useCompose } = await import("../../src/client/app/shell-context.tsx");

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const REFUSED = "E_REFUSED_FOR_TEST  refused, for the test\n  why      the four-part message\n  fix      none";

function send(state_reason: string) {
  return {
    id: `snd_${state_reason}`, subject: `on ${state_reason}`, envelope_to: JSON.stringify(["a@b.test"]),
    state: "awaiting", state_at: "2026-09-26T09:00:00.000Z", release_at: "2026-09-26T09:00:00.000Z",
    attempts: 0, last_error: null, transport_message_id: null, fidelity: "authored", has_submitted: 0, is_copy: 0,
    state_reason, policy_outcome: "allow", recipients: [], retry: { mode: null, why: "acceptance_observed" },
  };
}

const SENDS = {
  sends: [send("butler_release_required"), send("policy_hold")], truncated: false,
  daily: { handedOver: 0, throttledAtCount: null, firstThrottledAt: null },
  capability: { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "" },
};

const posted = (path: string) => calls.find((call) => call.method === "POST" && call.path === path);
/** The alert with words in it: a screen inside the shell also has the shell's toast alert region, empty. */
async function alert(): Promise<string> {
  let said = "";
  await waitFor(() => {
    said = screen.getAllByRole("alert").map((one) => one.textContent ?? "").find((text) => text !== "") ?? "";
    expect(said).not.toBe("");
  });
  return said;
}

beforeEach(reset);

describe("releasing a Butler's send from the outbox", () => {
  function mountOutbox(released: boolean) {
    answerWith((call) => {
      if (call.path.startsWith("/api/sends") && call.method === "GET") return Response.json(SENDS);
      if (call.path.endsWith("/release")) {
        return Response.json(released ? { released: true, runId: null, resumed: false } : { released: false, reason: "not_found" }, { status: released ? 200 : 409 });
      }
      return undefined;
    });
    mount(<Outbox />);
  }

  it("offers release on the Butler-gated row only, and posts to the release route", async () => {
    mountOutbox(true);
    await screen.findByText("on butler_release_required");
    // One gate, one button: the policy hold beside it gets *let it go* and not this.
    expect(screen.getAllByRole("button", { name: "Release" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Let it go" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => { expect(posted("/api/sends/snd_butler_release_required/release")).toBeDefined(); });
    expect(posted("/api/sends/snd_butler_release_required/release-hold")).toBeUndefined();
  });

  it("renders the Node's refusal with its reason token", async () => {
    mountOutbox(false);
    await screen.findByText("on butler_release_required");
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await alert()).toContain("not_found: this send is no longer waiting on a Butler's gate");
  });
});

describe("an Outbox row with no subject", () => {
  it("names its button (no subject), so the row is not a nameless control", async () => {
    answerWith((call) => (call.path.startsWith("/api/sends") && call.method === "GET"
      ? Response.json({ ...SENDS, sends: [{ ...send("policy_hold"), subject: "" }, { ...send("butler_release_required"), subject: "  " }] })
      : undefined));
    mount(<Outbox />);
    await waitFor(() => { expect(screen.getAllByRole("button", { name: "(no subject)" })).toHaveLength(2); });
  });
});

describe("running a Butler run again", () => {
  const RUN = {
    id: "run_1", butler_id: "btl_1", version_id: "bv_1", trigger_event: "delivery", trigger_key: "k",
    state: "finished", outcome_reason: null, started_at: "2026-09-26T09:00:00.000Z",
    finished_at: "2026-09-26T09:00:01.000Z", nodes_executed: 3, effects: 1, refusals: 0,
    subrequests_spent: 2, replay_of: null, replayed_by: null,
  };

  function mountButlers(refuse: boolean) {
    answerWith((call) => {
      if (call.path === "/api/butlers") return Response.json({ butlers: [] });
      if (call.path === "/api/butler-runs") return Response.json({ runs: [RUN, { ...RUN, id: "run_2", finished_at: null, state: "running" }] });
      if (call.path.endsWith("/replay")) {
        return refuse
          ? Response.json({ error: "E_REFUSED_FOR_TEST", message: REFUSED }, { status: 409 })
          : Response.json({ mode: "re-run", runId: "bv_1-brp_2", replayOf: "run_1" });
      }
      return undefined;
    });
    mount(<Butlers />);
  }

  it("posts mode re-run to the replay route for a finished run, and names the new run", async () => {
    mountButlers(false);
    // The unfinished run has no button: two rows, one control.
    await waitFor(() => { expect(screen.getAllByRole("button", { name: "Run again" })).toHaveLength(1); });
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() => { expect(posted("/api/butler-runs/run_1/replay")).toBeDefined(); });
    expect(posted("/api/butler-runs/run_1/replay")!.body).toEqual({ mode: "re-run" });
    expect((await screen.findByRole("status")).textContent).toContain("bv_1-brp_2");
  });

  it("says what a re-run is, and renders the refusal whole", async () => {
    mountButlers(true);
    await waitFor(() => { expect(screen.getByText(/nothing leaves this Node by itself/)).toBeDefined(); });
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(await alert()).toBe(REFUSED);
  });
});

/*
 * Both sign-outs live on Settings since the redesign moved them out of the bottom bar, which now holds only
 * the connection and the health verdict. Settings is also past the first-run gate, so a gated administrator
 * can always leave.
 */
describe("signing out everywhere", () => {
  function mountSettings(ok: boolean) {
    answerWith((call) => {
      if (call.path === "/api/auth/logout-everywhere") {
        return ok
          ? Response.json({ error: "signed_out", message: "Signed out of 3 sessions.", refreshable: false })
          : Response.json({ error: "E_REFUSED_FOR_TEST", message: REFUSED }, { status: 409 });
      }
      return undefined;
    });
    mount(<ShellProvider><Settings /></ShellProvider>);
  }

  it("posts to the logout-everywhere route, beside the ordinary sign out", async () => {
    mountSettings(true);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => { expect(posted("/api/auth/logout-everywhere")).toBeDefined(); });
    // This page signs out after the Node revoked, so the order is revoke then sign out, not sign out alone.
    await waitFor(() => { expect(session.signOuts).toBe(1); });
  });

  it("renders a refusal rather than pretending the other devices were signed out", async () => {
    mountSettings(false);
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    expect(await alert()).toBe(REFUSED);
    expect(session.signOuts).toBe(0);
  });
});

describe("signing out saves the open draft first", () => {
  /*
   * Signing out unmounts the shell, and the composer's last-chance save then runs with no session: the words
   * typed in the autosave pause were lost (the recorded loss `d-signout-pause` used to assert). So Settings asks
   * the shell's composer to save first, and a save the Node refuses keeps the session and says why.
   */
  function OpenComposer() {
    const compose = useCompose();
    return <button type="button" onClick={() => compose.open({ mailboxId: "mbx_test" })}>Open composer</button>;
  }
  const puts = () => calls.filter((call) => call.path === "/api/drafts" && call.method === "PUT");

  async function typeAndSignOut(refuse: boolean, button: "Sign out" | "Sign out everywhere") {
    answerWith((call) => {
      if (call.path === "/api/drafts" && call.method === "PUT") {
        return refuse
          ? Response.json({ error: "E_LEGAL_HOLD", message: "A legal hold covers this mailbox." }, { status: 409 })
          : Response.json({ draft: { id: "dft_1", to: [], cc: [], bcc: [], subject: "", body: "", updatedAt: "2026-09-26T09:00:00.000Z" } });
      }
      if (call.path === "/api/auth/logout-everywhere") return Response.json({ error: "signed_out", message: "Signed out of 1 session.", refreshable: false });
      return undefined;
    });
    mount(<ShellProvider><OpenComposer /><Settings /></ShellProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Open composer" }));
    const body = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(body, { target: { value: "typed in the pause" } });
    expect(puts(), "the autosave already wrote, so this proves nothing").toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: button }));
  }

  it("writes the pause's words before the session ends, for either sign-out", async () => {
    for (const button of ["Sign out", "Sign out everywhere"] as const) {
      await typeAndSignOut(false, button);
      await waitFor(() => { expect(session.signOuts).toBe(1); });
      expect(puts()).toHaveLength(1);
      expect((puts()[0]!.body as { body: string }).body).toBe("typed in the pause");
      cleanup();
      reset();
    }
  });

  it("keeps the session when the Node refuses the draft, says why, and offers that same sign-out, by its name, anyway", async () => {
    // By name because "Sign out everywhere anyway" ends every session on every device, beside a plain Sign out.
    for (const button of ["Sign out", "Sign out everywhere"] as const) {
      await typeAndSignOut(true, button);
      expect(await alert()).toBe(
        "Your draft was not saved on your Node when you asked to sign out, so you are still signed in: A legal hold covers this mailbox.",
      );
      expect(session.signOuts).toBe(0);
      expect(posted("/api/auth/logout-everywhere"), "the refused draft did not hold the revocation back").toBeUndefined();
      fireEvent.click(screen.getByRole("button", { name: `${button} anyway` }));
      await waitFor(() => { expect(session.signOuts).toBe(1); });
      expect(posted("/api/auth/logout-everywhere") !== undefined, `${button} anyway ran the other sign-out`)
        .toBe(button === "Sign out everywhere");
      cleanup();
      reset();
    }
  });
});

describe("a completed export's objects", () => {
  const EXPORT = {
    id: "exp_1", matterId: "mat_1", mailboxId: "mbx_test", requestedBy: "usr_me", maxMessages: 10,
    state: "completed", stateReason: null, messagesEmitted: 2, requestedAt: "2026-09-26T09:00:00.000Z",
    completedAt: "2026-09-26T09:05:00.000Z",
  };
  const MANIFEST = {
    version: 1, exportId: "exp_1", count: 2,
    messages: [
      { receiptId: "rcp_a", object: "rcp_a.eml", bytes: 1200, sha256: "aa" },
      { receiptId: "rcp_b", object: "rcp_b.eml", bytes: 3400, sha256: "bb" },
    ],
  };

  function mountMatters(ok: boolean) {
    answerWith((call) => {
      if (call.path === "/api/exports") return Response.json({ exports: [EXPORT] });
      if (call.path === "/api/exports/exp_1/objects/manifest.json") {
        return ok ? Response.json(MANIFEST) : Response.json({ error: "not_found", message: "No such export object, or you do not have access to it." }, { status: 404 });
      }
      if (call.path.startsWith("/api/matters")) return Response.json({ matters: [] });
      if (call.path.startsWith("/api/holds")) return Response.json({ holds: [] });
      if (call.path.startsWith("/api/supervised")) return Response.json({ supervised: [] });
      return undefined;
    });
    mount(<Matters />);
  }

  it("reads the manifest through the object route and links every object it names", async () => {
    mountMatters(true);
    fireEvent.click(await screen.findByRole("button", { name: "Objects" }));
    const link = await screen.findByRole("link", { name: "rcp_b.eml" });
    expect(link.getAttribute("href")).toBe("/api/exports/exp_1/objects/rcp_b.eml");
    expect(screen.getByRole("link", { name: "rcp_a.eml" })).toBeDefined();
    expect(screen.getByRole("link", { name: "manifest.json" }).getAttribute("href")).toBe("/api/exports/exp_1/objects/manifest.json");
    expect(calls.filter((call) => call.path === "/api/exports/exp_1/objects/manifest.json")).toHaveLength(1);
  });

  it("renders the Node's 404 for anybody but the requester", async () => {
    mountMatters(false);
    fireEvent.click(await screen.findByRole("button", { name: "Objects" }));
    expect(await alert()).toContain("No such export object, or you do not have access to it.");
  });
});
