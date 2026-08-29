import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, reset, seen } from "./session-stub.ts";

/**
 * Choosing what a machine may do, in the product's words (#109, the capability layer).
 *
 * ## What this screen replaced
 *
 * `POST /api/agents` shipped taking a list of route strings, so minting a credential meant composing
 * `["GET /api/messages", "GET /api/messages/:receiptId/body", …]` by hand. Two things were wrong with that and
 * the second is the one a test can catch:
 *
 * 1. An administrator deciding what a machine may do is answering *"may it read mail?"*, not writing a
 *    routing table.
 * 2. **A ceiling assembled by hand has no completeness.** Reading mail takes four routes; grant three and the
 *    agent works until it needs the fourth, which arrives later as a refusal in the middle of something and
 *    reads as a bug rather than as a ceiling.
 *
 * So the screen offers capabilities and the Node expands them. The assertions below are about the two facts
 * that could go wrong once a name stands in for a set: that the request carries **names** rather than routes,
 * and that a partially-held capability is shown as partial rather than rounded up to its name.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/agents" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Agents } = await import("../../src/client/app/screens/agents.tsx");

const CAPABILITIES = [
  {
    id: "mail.read",
    says: "Read mail: list it, open a message, and fetch the original bytes.",
    reachesContent: true,
    routes: ["a", "b", "c", "d"],
  },
  {
    id: "hold.read",
    says: "Read the legal holds in force.",
    reachesContent: false,
    routes: ["e"],
  },
];

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agt_one000000000000000000001",
    name: "nightly triage",
    sponsorUserId: "usr_ana000000000000000001",
    createdBy: "usr_ana000000000000000001",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    actions: ["a", "b", "c", "d"],
    held: [{ id: "mail.read", says: "Read mail.", reachesContent: true, held: 4, total: 4 }],
    unnamed: [],
    ...overrides,
  };
}

/** What a POST to `/api/agents` carried, for the tests that are about the request rather than the render. */
const posted: unknown[] = [];

/**
 * One handler for the whole surface, rather than `answer` per prefix.
 *
 * `answer` matches a **path prefix**, so `answer("/api/agents", …)` would also answer the mint `POST` with an
 * agent *list* — a shape the screen then reads a token out of and finds nothing. Method-aware routing is the
 * point here, so the blanket handler is the right one, and it returns `undefined` for everything else so the
 * stub's mailbox and inbox defaults still apply.
 */
function mount(agents: unknown[], minted?: unknown) {
  answerWith((call) => {
    if (call.path.startsWith("/api/agent-capabilities")) return Response.json({ capabilities: CAPABILITIES });
    if (call.path.startsWith("/api/me")) {
      return Response.json({ userId: "usr_ana000000000000000001", email: "ana@example.com" });
    }
    if (call.path === "/api/agents" && call.method === "POST") {
      posted.push(call.body);
      return Response.json(minted ?? { agent: agent(), token: "tok_secret", notice: "Shown once." });
    }
    if (call.path.startsWith("/api/agents/") && call.method === "DELETE") {
      return Response.json({ revoked: true, message: "Revoked." });
    }
    if (call.path.startsWith("/api/agents")) return Response.json({ agents });
    if (call.path.startsWith("/api/mailboxes")) {
      return Response.json({ mailboxes: [{ id: "mbx_support", name: "Support", addresses: null }] });
    }
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Agents /></QueryClientProvider>);
}

beforeEach(() => {
  reset();
  posted.length = 0;
});

describe("the ceiling is chosen and shown as capabilities", () => {
  it("offers each capability with what it says, not with its routes", async () => {
    mount([]);
    expect(await screen.findByText("mail.read")).toBeTruthy();
    /*
     * The description beside the name, because this is the moment the decision is made. A capability whose
     * consequence is one hover away is one nobody reads — and `export.read` reaches message bytes while
     * sounding administrative, so getting this wrong is not a cosmetic matter.
     */
    expect(
      screen.getByText("Read mail: list it, open a message, and fetch the original bytes."),
      "a capability was offered with no description of what granting it does",
    ).toBeTruthy();
  });

  it("marks the capabilities that reach message content", async () => {
    /*
     * §7's whole model turns on metadata against content, so it is the one fact a chooser must not have to
     * infer from a name. Asserted here as well as in the vocabulary's own closed world, because a flag the
     * Node sets and the screen ignores is the same as no flag.
     */
    mount([]);
    await screen.findByText("mail.read");
    /*
     * Scoped to the capability list. The mailbox relations carry the same marker for the same reason, and
     * counting every one on the page would make this assertion about the fixture's size rather than about the
     * capability being marked.
     */
    const marked = (await screen.findByText("mail.read")).closest("label")!;
    expect(marked.textContent, "the capability that reaches content is not marked as doing so")
      .toContain("reaches message content");
    const unmarked = screen.getByText("hold.read").closest("label")!;
    expect(unmarked.textContent, "a capability that reaches no content is marked as if it did")
      .not.toContain("reaches message content");
  });

  it("sends capability names, never the routes behind them", async () => {
    /*
     * The regression that matters. If the screen expanded capabilities itself and posted routes, everything
     * would still work — and the expansion would then live in two places, with the client's copy free to
     * drift from the Node's. That is the divergence `packages/contract` exists to prevent.
     */
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(await screen.findByPlaceholderText("what this agent is for"), {
      target: { value: "triage" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Mint agent" }));

    await waitFor(() => expect(posted.length).toBe(1));
    expect(
      posted[0],
      "the screen expanded capabilities into routes itself, which puts the expansion in two places",
    ).toMatchObject({ capabilities: ["mail.read"] });
    expect(JSON.stringify(posted[0]), "a route string reached the request body").not.toContain("/api/");
  });

  it("shows the token once, with the sentence that says so", async () => {
    // Only its hash is stored and there is no refresh, so nothing can produce it again. A copy button with no
    // warning lets somebody navigate away believing it was "sent" somewhere.
    mount([], {
      agent: agent(),
      token: "tok_shown_once",
      notice: "This token is shown once and cannot be shown again.",
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(await screen.findByPlaceholderText("what this agent is for"), {
      target: { value: "triage" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Mint agent" }));

    expect(await screen.findByText("tok_shown_once")).toBeTruthy();
    expect(screen.getByText("This token is shown once and cannot be shown again.")).toBeTruthy();
  });

  it("refuses to mint with nothing chosen", async () => {
    /*
     * An agent with an empty ceiling can do nothing and there is no route that widens one, so the Node refuses
     * it — and offering a button that produces that refusal is teaching somebody to press it. Disabled here
     * *and* refused there: the screen is not the check, it just stops posing the question.
     */
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(await screen.findByPlaceholderText("what this agent is for"), {
      target: { value: "triage" },
    });
    expect(screen.getByRole("button", { name: "Mint agent" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByRole("button", { name: "Mint agent" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("reading a pinned ceiling back", () => {
  it("shows a whole capability as its name", async () => {
    mount([agent()]);
    expect(await screen.findByText("nightly triage")).toBeTruthy();
    expect(screen.queryByText(/4 of 4/), "a whole capability was shown as a fraction").toBeNull();
  });

  it("shows a partly-held capability as held of total, not rounded up to the name", async () => {
    /*
     * The heart of why the display is derived rather than stored. The routes are what is pinned, so an agent
     * minted before `mail.read` gained a fourth route holds three of four — and `mail.read` alone would imply
     * a route it does not have and, the ceiling being pinned with no widening route, never will.
     */
    mount([agent({
      actions: ["a", "b", "c"],
      held: [{ id: "mail.read", says: "Read mail.", reachesContent: true, held: 3, total: 4 }],
    })]);
    expect(await screen.findByText("3 of 4", { exact: false })).toBeTruthy();
  });

  it("shows pinned routes this Node no longer names rather than dropping them", async () => {
    /*
     * Reachable without any mistake: an agent minted before a route was renamed holds a string that matches
     * no capability. The authority is still in `agent_actions` and still checked, so hiding it would
     * under-report a live ceiling — which is the one thing this screen must not do.
     */
    mount([agent({ unnamed: ["GET /api/renamed-away"] })]);
    expect(await screen.findByText("GET /api/renamed-away")).toBeTruthy();
  });

  it("offers withdraw only while there is something to withdraw", async () => {
    // The Node's revoke writes no audit entry when nothing changed, so a button on a revoked agent is an
    // offer that completes by doing nothing — and reads as if it did something.
    mount([agent({ revokedAt: "2026-08-02T00:00:00.000Z" })]);
    await screen.findByText("revoked");
    expect(screen.queryByRole("button", { name: "withdraw" })).toBeNull();
  });

  it("calls DELETE with the agent's id when withdrawn", async () => {
    mount([agent()]);
    await screen.findByText("nightly triage");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: "withdraw" }));
    await waitFor(() =>
      expect(seen("/api/agents/agt_one000000000000000000001").length).toBeGreaterThan(0));
  });
});

describe("the mint form completes the authority, not only the credential", () => {
  /*
   * An agent's reach is its capabilities **intersected with its relations**, and this form wrote only the
   * first — so a credential minted here authenticated, called the relation-free diagnostics, and could not
   * read a mailbox. A token that works and does nothing, with no error to explain it, because the journey
   * ended one step before the agent was usable.
   */
  it("sends the chosen mailbox relations with the mint", async () => {
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(await screen.findByPlaceholderText("what this agent is for"), {
      target: { value: "triage" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    // The relation's own checkbox, reached through its label rather than by index — the capability
    // checkboxes come first and their count is not this test's business.
    const relation = (await screen.findByText("mailbox.content.read")).closest("label")!
      .querySelector("input")!;
    fireEvent.click(relation);
    fireEvent.click(screen.getByRole("button", { name: "Mint agent" }));

    await waitFor(() => expect(posted.length).toBe(1));
    expect(
      posted[0],
      "the form minted a credential with no reach, which authenticates and reads nothing",
    ).toMatchObject({ grants: [{ mailboxId: "mbx_support", relation: "mailbox.content.read" }] });
  });

  it("offers each relation with what it lets the agent do", async () => {
    // `mailbox.metadata.read` is exact and says nothing about the consequence. The distinction between it and
    // `mailbox.content.read` is the one somebody granting access is most likely to get wrong.
    mount([]);
    expect(
      await screen.findByText("See that mail exists — senders, subjects, when. Not the message itself."),
    ).toBeTruthy();
  });

  it("warns when a mail-reading capability is chosen with no mailbox", async () => {
    /*
     * The exact state the form used to produce by construction: capabilities that read mail, no relation, and
     * a credential that finds nothing. Said before minting rather than discovered afterwards through an
     * automation that quietly does nothing.
     */
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    // Awaited: the capability list arrives from the Node, so the checkboxes do not exist on the first render.
    await screen.findByText("mail.read");
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(
      await screen.findByText(/the agent will authenticate and find nothing it may read/),
    ).toBeTruthy();
  });

  it("says the reach stops when the sponsor's access does", async () => {
    // The whole argument for sponsoring, and it is invisible in a list of checkboxes.
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    await screen.findByText("mail.read");
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(await screen.findByText(/stops the moment the sponsor loses that access/)).toBeTruthy();
  });

  it("grants nothing by default", async () => {
    /*
     * Least privilege has to be what takes no effort. Copying the sponsor's relations in would be the widest
     * possible ceiling arrived at by doing nothing, which is the opposite of the model.
     */
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(await screen.findByPlaceholderText("what this agent is for"), {
      target: { value: "diagnostic" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Mint agent" }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ grants: [] });
  });
});
