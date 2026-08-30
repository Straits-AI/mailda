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
    requires: ["mailbox.content.read", "message.export"],
    routes: ["a", "b", "c", "d"],
  },
  {
    id: "hold.read",
    says: "Read the legal holds in force.",
    reachesContent: false,
    requires: [],
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
    grants: [{
      mailboxId: "mbx_support", mailboxName: "Support", relation: "mailbox.content.read", effective: true,
    }],
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
    if (call.path.startsWith("/api/people/") && call.path.endsWith("/mailboxes")) {
      return Response.json({
        mailboxes: [
          {
            mailboxId: "mbx_support",
            mailboxName: "Support",
            relations: ["mailbox.content.read", "message.export", "send.propose"],
          },
          {
            mailboxId: "mbx_billing",
            mailboxName: "Billing",
            relations: ["mailbox.content.read", "message.export"],
          },
          // A mailbox the sponsor holds nothing on: listed, and not selectable.
          { mailboxId: "mbx_legal", mailboxName: "Legal", relations: [] },
        ],
      });
    }
    if (call.path.startsWith("/api/people")) {
      return Response.json({
        people: [
          { id: "usr_ana000000000000000001", email: "ana@example.com", created_at: "", relations: [] },
          { id: "usr_ben000000000000000001", email: "ben@example.com", created_at: "", relations: [] },
        ],
      });
    }
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Agents /></QueryClientProvider>);
}

/**
 * Click one relation's checkbox **under a named mailbox**.
 *
 * Scoped, because the fixture has two mailboxes and every relation label appears under each. An unscoped
 * `findByText("mailbox.content.read")` is ambiguous — and worse, when it was not ambiguous it silently meant
 * "whichever mailbox rendered first", which is what let a per-mailbox requirement look satisfied.
 */
async function pick(relation: string, mailbox: string) {
  const { fireEvent } = await import("@testing-library/react");
  const box = (await screen.findByText(mailbox)).closest("div")!;
  const label = [...box.querySelectorAll("label")].find((one) => one.textContent?.includes(relation))!;
  fireEvent.click(label.querySelector("input")!);
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
    // `hold.read` rather than `mail.read`: this is about the request carrying names, and `mail.read` needs
    // two relations on one mailbox, which the button now requires before it will submit at all.
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Mint agent" }));

    await waitFor(() => expect(posted.length).toBe(1));
    expect(
      posted[0],
      "the screen expanded capabilities into routes itself, which puts the expansion in two places",
    ).toMatchObject({ capabilities: ["hold.read"] });
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
    // The relation-free capability, so this test is about the token and not about provisioning.
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
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

    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    expect(screen.getByRole("button", { name: "Mint agent" }).hasAttribute("disabled")).toBe(false);
  });

  it("refuses to mint a capability no chosen mailbox can satisfy", async () => {
    /*
     * The screen computed this and displayed it and then let the button be pressed anyway — "no mailbox here
     * carries all of them, so the agent will authenticate and be refused", beside an enabled control. A
     * warning next to a live button reads as advice about a choice, and this is not one: `POST /api/agents`
     * refuses the same combination, so pressing it only moves the refusal somewhere less useful.
     */
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(await screen.findByPlaceholderText("what this agent is for"), {
      target: { value: "triage" },
    });

    // `mail.read`, which needs `mailbox.content.read` and `message.export` on one mailbox, and no mailbox.
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(
      screen.getByRole("button", { name: "Mint agent" }).hasAttribute("disabled"),
      "a capability with no mailbox at all could still be minted",
    ).toBe(true);

    // Half of what it needs is still not enough, and this is the case a set-union check would have allowed.
    await pick("mailbox.content.read", "Support");
    expect(
      screen.getByRole("button", { name: "Mint agent" }).hasAttribute("disabled"),
      "a half-satisfied capability could still be minted",
    ).toBe(true);

    // The control: completing it on the same mailbox enables the button, so the assertions above are not
    // passing because the button is disabled for some unrelated reason.
    await pick("message.export", "Support");
    expect(
      screen.getByRole("button", { name: "Mint agent" }).hasAttribute("disabled"),
      "a fully satisfied capability could not be minted",
    ).toBe(false);
  });

  it("refuses when the two relations are on different mailboxes", async () => {
    /*
     * The case the arithmetic exists for. `content.read` on Support and `message.export` on Billing satisfies
     * `mail.read` on neither, because reach is decided per mailbox — and a check that unioned the selected
     * relations would call this provisioned and be wrong.
     */
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(await screen.findByPlaceholderText("what this agent is for"), {
      target: { value: "split" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    await pick("mailbox.content.read", "Support");
    await pick("message.export", "Billing");

    expect(
      screen.getByRole("button", { name: "Mint agent" }).hasAttribute("disabled"),
      "relations split across two mailboxes were counted as satisfying one capability",
    ).toBe(true);
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
    // Both relations `mail.read` needs, on the one mailbox. Picking only `content.read` left the capability
    // unsatisfied, which the form now refuses to submit — the credential it would have minted could not have
    // fetched the original bytes its own capability promises.
    await pick("mailbox.content.read", "Support");
    await pick("message.export", "Support");
    fireEvent.click(screen.getByRole("button", { name: "Mint agent" }));

    await waitFor(() => expect(posted.length).toBe(1));
    expect(
      posted[0],
      "the form minted a credential with no reach, which authenticates and reads nothing",
    ).toMatchObject({
      grants: [
        { mailboxId: "mbx_support", relation: "mailbox.content.read" },
        { mailboxId: "mbx_support", relation: "message.export" },
      ],
    });
  });

  it("offers each relation with what it lets the agent do", async () => {
    // `mailbox.metadata.read` is exact and says nothing about the consequence. The distinction between it and
    // `mailbox.content.read` is the one somebody granting access is most likely to get wrong.
    mount([]);
    expect(
      (await screen.findAllByText("See that mail exists — senders, subjects, when. Not the message itself."))
        .length,
      "the relation is offered with no description of what granting it does",
    ).toBeGreaterThan(0);
  });

  it("names the relation a chosen capability is missing", async () => {
    /*
     * The exact state the form used to produce by construction: a capability that reads mail, no relation, and
     * a credential that finds nothing. Said before minting rather than discovered afterwards through an
     * automation that quietly does nothing — and it names *which* relation, because "choose a mailbox" is not
     * an instruction somebody can act on when four relations are on offer.
     */
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    // Awaited: the capability list arrives from the Node, so the checkboxes do not exist on the first render.
    await screen.findByText("mail.read");
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(await screen.findByText(/needs mailbox\.content\.read and message\.export/)).toBeTruthy();
  });

  it("still warns when a relation is chosen but not the one the capability needs", async () => {
    /*
     * The defect the per-capability form replaces. The old warning fired only when **zero** relations were
     * chosen, so `mail.read` paired with `send.propose` reviewed as fine and minted an agent that cannot read
     * anything — a positive-looking review over a credential that does not work.
     */
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    await screen.findByText("mail.read");
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    await pick("send.propose", "Support");

    expect(
      await screen.findByText(/needs mailbox\.content\.read and message\.export/),
      "a relation that satisfies nothing silenced the warning",
    ).toBeTruthy();
  });

  it("stops warning once the required relations are granted", async () => {
    // The control. A warning that never clears is one people mint through without reading.
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    await screen.findByText("mail.read");
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    for (const relation of ["mailbox.content.read", "message.export"]) await pick(relation, "Support");
    expect(screen.queryByText(/needs mailbox\.content\.read/)).toBeNull();
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
    /*
     * `hold.read`, which needs no mailbox — and that is the whole remaining shape of this claim.
     *
     * This test used to select `mail.read` and assert it minted with `grants: []`, which made it evidence for
     * the defect rather than against it: the credential it described authenticates and is refused on every
     * route the capability names. Least privilege is still the subject, and it is still true — nothing is
     * pre-selected — but "nothing granted" is only a legitimate *mint* for a capability that needs nothing.
     * The mailbox-requiring case is covered by the two refusals above.
     */
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Mint agent" }));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]).toMatchObject({ grants: [] });
  });
});

describe("the list says where an agent reaches, and whether it still does", () => {
  it("names the mailbox and relation", async () => {
    // The list answered capabilities and standing and said nothing about which mailboxes — so an access
    // review could not ask the question it exists to ask.
    mount([agent()]);
    expect(await screen.findByText("Support")).toBeTruthy();
    expect(screen.getByText(/mailbox\.content\.read/)).toBeTruthy();
  });

  it("marks a grant the sponsor has since lost", async () => {
    /*
     * The whole reason there are two facts. A sponsor losing a relation narrows every agent that borrowed it,
     * correctly and silently — and an operator who cannot see that is left with an automation that has
     * quietly stopped doing part of its job.
     */
    mount([agent({
      grants: [{
        mailboxId: "mbx_support", mailboxName: "Support", relation: "mailbox.content.read", effective: false,
      }],
    })]);
    expect(await screen.findByText(/the sponsor no longer holds this/)).toBeTruthy();
  });

  it("does not mark a grant that is still effective", async () => {
    // The control: a warning on every row is a warning nobody reads.
    mount([agent()]);
    await screen.findByText("Support");
    expect(screen.queryByText(/the sponsor no longer holds this/)).toBeNull();
  });

  it("says so plainly when an agent reaches no mailbox at all", async () => {
    // A diagnostic agent is a real shape — `health.read` needs nothing. An empty cell would read as a
    // rendering failure rather than as a fact.
    mount([agent({ grants: [] })]);
    expect(await screen.findByText("no mailbox")).toBeTruthy();
  });
});

describe("a capability's relations must land on one mailbox, not be spread across two", () => {
  /*
   * The review collapsed every selected relation into one set, so `content.read` on Support plus
   * `message.export` on Billing read as satisfying `mail.read` — and no mailbox had the two relations that
   * route needs together. The condition is `∃m: content.read(m) ∧ export(m)`; what was tested was
   * `(∃m₁: content.read(m₁)) ∧ (∃m₂: export(m₂))`, which is a different statement and a positive-looking
   * review over a credential that does not work.
   */
  it("still warns when the two relations are on different mailboxes", async () => {
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    await screen.findByText("mail.read");
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);

    await pick("mailbox.content.read", "Support");
    await pick("message.export", "Billing");

    expect(
      await screen.findByText(/on the same mailbox/),
      "relations spread across two mailboxes were accepted as satisfying one capability",
    ).toBeTruthy();
  });

  it("clears once one mailbox carries both", async () => {
    // The control. A warning that cannot be satisfied is one people mint through.
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    await screen.findByText("mail.read");
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);

    await pick("mailbox.content.read", "Support");
    await pick("message.export", "Support");

    expect(screen.queryByText(/on the same mailbox/)).toBeNull();
  });
});

describe("the mint form asks about the sponsor, not about the caller", () => {
  /*
   * It used `useMailboxes()` — the work-queue rail, which lists mailboxes the **caller** sends from. So an
   * administrator could only select mailboxes they personally work in: a read-only sponsor's were
   * unselectable, an export-only sponsor's were, and so was any mailbox administered by somebody who does not
   * send from it. The form also always sent the signed-in user as sponsor, while the Node has supported
   * naming somebody else since the layer shipped.
   */
  it("lists every mailbox with what the sponsor holds, including the ones they hold nothing on", async () => {
    /*
     * Listed and not selectable, rather than omitted. A form that hid them leaves an administrator concluding
     * the mailbox was deleted — and "it is not here" and "you cannot use it here" are different answers.
     */
    mount([]);
    expect(await screen.findByText("Legal")).toBeTruthy();
    expect(screen.getByText("this person holds nothing here")).toBeTruthy();

    const legal = screen.getByText("Legal").closest("div")!;
    const inputs = [...legal.querySelectorAll("input")];
    expect(inputs.length, "the mailbox rendered no relations at all").toBeGreaterThan(0);
    expect(
      inputs.every((one) => one.hasAttribute("disabled")),
      "a relation the sponsor does not hold was selectable — the mint refuses it",
    ).toBe(true);
  });

  it("offers only what the sponsor holds on each mailbox", async () => {
    // Billing has no `send.propose` in the fixture: the backend would refuse that grant, so offering it would
    // be an offer that fails at mint.
    mount([]);
    const billing = (await screen.findByText("Billing")).closest("div")!;
    const propose = [...billing.querySelectorAll("label")]
      .find((one) => one.textContent?.includes("send.propose"))!;
    expect(propose.querySelector("input")!.hasAttribute("disabled")).toBe(true);

    const support = screen.getByText("Support").closest("div")!;
    const supportPropose = [...support.querySelectorAll("label")]
      .find((one) => one.textContent?.includes("send.propose"))!;
    expect(
      supportPropose.querySelector("input")!.hasAttribute("disabled"),
      "a relation the sponsor does hold was refused, so nothing can be minted",
    ).toBe(false);
  });

  it("lets an administrator name somebody else as the sponsor", async () => {
    mount([]);
    const { fireEvent } = await import("@testing-library/react");
    const chooser = await screen.findByRole("combobox");
    fireEvent.change(chooser, { target: { value: "usr_ben000000000000000001" } });

    fireEvent.change(screen.getByPlaceholderText("what this agent is for"), { target: { value: "for ben" } });
    // Relation-free, so the assertion below is about the sponsor and not about provisioning.
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Mint agent" }));

    await waitFor(() => expect(posted.length).toBe(1));
    expect(
      posted[0],
      "the form sent the signed-in user, so the Node's named-sponsor support was unreachable",
    ).toMatchObject({ sponsorUserId: "usr_ben000000000000000001" });
  });
});
