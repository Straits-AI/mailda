import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * The invite bundle (28 September 2026): "Also give them a mailbox at" mints the invitation, then makes a mailbox
 * named for the person and adds the address to it, three existing acts in that order, and grants the invitee
 * nothing. Once they have an account (their email is an address on a mailbox they hold nothing on directly, and no
 * relation of theirs on it was withdrawn), People offers the two relations a person needs to read and send from it,
 * named, in one click.
 */

const route = vi.hoisted(() => ({ pathname: "/people" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { People } = await import("../../src/client/app/screens/people.tsx");

const BOX = { id: "mbx_test", name: "Support", unclaimed: 0, claimed: 0, mine: 0, first_response_minutes: null, quarantine_dmarc_fail: 0, quarantine_dangerous_attachments: 0, quarantined: 0, breached: 0, addresses: "support@whymelabs.com" as string | null };
const ROUTED = { state: "routed_elsewhere", detail: "bob@whymelabs.com has an Email Routing rule of its own, named \"bob\": forward to bob@gmail.com." };

interface Person { id: string; email: string; created_at: string; relations: Array<{ relation: string; objectType: string; objectId: string }> }

function mount(opts: {
  receiving?: string;
  boxes?: Array<typeof BOX>;
  people?: Person[];
  invitation?: Response;
  mailbox?: Response;
  grant?: (relation: string) => Response;
  /** `GET /api/audit?action=access.revoked`'s answer, fresh for each read (a body reads once); the Node's own when absent. */
  withdrawals?: () => Response | Promise<Response>;
} = {}) {
  answerWith((call) => {
    if (call.path === "/api/provider") {
      const receiving = opts.receiving === undefined ? null
        : { domain: opts.receiving, at: "2026-09-28T00:00:00.000Z", authority: "operator", address: `hello@${opts.receiving}`, observed: false, routing: null };
      return Response.json({ provider: { state: "no_token" }, permissions: [], note: "", provisioned: { receiving, sending: null, deliveryEvents: null } });
    }
    if (call.path === "/api/invitations" && call.method === "POST") {
      const email = (call.body as { email: string }).email.toLowerCase();
      return opts.invitation ?? Response.json({ invitation: { invitationId: "inv_1", email, expiresAt: "2026-10-05T00:00:00.000Z", secret: "s3cret", replacedId: null } });
    }
    if (call.path === "/api/mailboxes" && call.method === "POST") return opts.mailbox ?? Response.json({ mailboxId: "mbx_new", name: (call.body as { name: string }).name });
    if (call.path === "/api/addresses" && call.method === "POST") {
      return Response.json({ address: { id: "addr_1", address: (call.body as { address: string }).address, mailboxId: "mbx_new" }, routing: ROUTED });
    }
    if (call.path === "/api/access" && call.method === "POST") {
      const relation = (call.body as { relation: string }).relation;
      return opts.grant?.(relation) ?? Response.json({ granted: true, alreadyHeld: false });
    }
    if (call.path.startsWith("/api/mailboxes")) return Response.json({ mailboxes: opts.boxes ?? [BOX] });
    if (call.path === "/api/me") return Response.json({ signedIn: true, principalId: "usr_me", principalKind: "user", userId: "usr_me", delegatorUserId: null, organizationId: "org_x", email: "me@whymelabs.com" });
    if (call.path.startsWith("/api/people")) {
      // What was granted so far, so a refresh after a grant reads the Node's new answer.
      const granted = calls.filter((one) => one.path === "/api/access" && one.method === "POST" && opts.grant?.((one.body as { relation: string }).relation).ok !== false)
        .map((one) => one.body as { subjectId: string; relation: string; objectId: string });
      return Response.json({
        people: (opts.people ?? []).map((person) => ({
          ...person,
          relations: [...person.relations, ...granted.filter((one) => one.subjectId === person.id).map((one) => ({ relation: one.relation, objectType: "mailbox", objectId: one.objectId }))]
            .filter((held) => !revoked().some((one) => one.subjectId === person.id && one.relation === held.relation && one.objectId === held.objectId)),
        })),
      });
    }
    // The Node's answer by default: every relation withdrawn so far is on the trail, as `revoke` records it.
    if (call.path === "/api/audit?action=access.revoked") {
      return opts.withdrawals?.() ?? theTrail();
    }
    if (call.path === "/api/access" && call.method === "DELETE") return Response.json({ revoked: true });
    if (call.path.startsWith("/api/invitations")) return Response.json({ invitations: [] });
    if (call.path.startsWith("/api/teams")) return Response.json({ teams: [] });
    if (call.path.startsWith("/api/auth/passkeys")) return Response.json({ passkeys: [] });
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><People /></QueryClientProvider>);
}

/** What the screen withdrew so far, from the calls it made. */
const revoked = () => calls.filter((one) => one.path === "/api/access" && one.method === "DELETE")
  .map((one) => one.body as { subjectId: string; relation: string; objectId: string });

/** `GET /api/audit?action=access.revoked` as the Node answers it: every relation the screen withdrew so far. */
const theTrail = () => Response.json({ entries: revoked().map((one, i) => ({ ...withdrawn(one.subjectId, one.objectId), id: `aud_${i}` })), truncated: false });

/** An `access.revoked` entry as `GET /api/audit` answers it. */
const withdrawn = (subject: string, objectId: string) => ({
  id: "aud_1", seq: 7, at: "2026-09-28T12:00:00.000Z", actor_user_id: "usr_me", actor_kind: "user", delegator_user_id: null,
  action: "access.revoked", subject, outcome: "ok", detail: JSON.stringify({ relation: "mailbox.content.read", objectType: "mailbox", objectId }), hash: "h",
});

const form = async () => screen.findByRole("region", { name: "Invite somebody" });
const posts = () => calls.filter((call) => call.method === "POST").map((call) => call.path);

async function inviteWithMailbox(email: string, local?: string) {
  const section = await form();
  fireEvent.change(within(section).getByLabelText("Address"), { target: { value: email } });
  fireEvent.click(within(section).getByLabelText("Also give them a mailbox at"));
  if (local !== undefined) fireEvent.change(within(section).getByLabelText("Their mailbox's address"), { target: { value: local } });
  fireEvent.click(within(section).getByText("Mint an invitation"));
}

describe("inviting somebody with a mailbox beside them", () => {
  beforeEach(reset);

  it("defaults the local part to the invitee's own when their address is on one of this Node's domains", async () => {
    mount();
    const section = await form();
    fireEvent.change(within(section).getByLabelText("Address"), { target: { value: "Bob@WhymeLabs.com" } });
    expect((within(section).getByLabelText("Their mailbox's address") as HTMLInputElement).value).toBe("bob");
    fireEvent.change(within(section).getByLabelText("Address"), { target: { value: "bob@gmail.com" } });
    expect((within(section).getByLabelText("Their mailbox's address") as HTMLInputElement).value).toBe("");
  });

  it("mints, then makes the mailbox named for them, then adds the address, and grants nothing", async () => {
    mount();
    await inviteWithMailbox("bob@whymelabs.com");
    const said = await screen.findByText(/The mailbox bob@whymelabs\.com was made/);
    expect(posts()).toEqual(["/api/invitations", "/api/mailboxes", "/api/addresses"]);
    expect(calls.find((call) => call.path === "/api/mailboxes" && call.method === "POST")!.body).toEqual({ name: "bob@whymelabs.com" });
    expect(calls.find((call) => call.path === "/api/addresses")!.body).toEqual({ address: "bob@whymelabs.com", mailboxId: "mbx_new" });
    // The routing is the Node's own answer, whole, and the invitee is said to hold nothing.
    expect(said.textContent).toContain(`at bob@whymelabs.com: ${ROUTED.detail} bob@whymelabs.com holds nothing`);
    expect(said.textContent).toContain("bob@whymelabs.com holds nothing on it until they arrive and you grant it");
    expect(screen.getByText("s3cret")).toBeTruthy();
  });

  it("keeps the mailbox's address field, and its domain picker, disabled until the box is ticked", async () => {
    mount({ receiving: "whymelabs.com", boxes: [{ ...BOX, addresses: "support@example.test" }] });
    const section = await form();
    const input = within(section).getByLabelText("Their mailbox's address") as HTMLInputElement;
    const picker = within(section).getByLabelText("Their mailbox's address: domain") as HTMLSelectElement;
    expect([input.disabled, picker.disabled]).toEqual([true, true]);
    fireEvent.click(within(section).getByLabelText("Also give them a mailbox at"));
    expect([input.disabled, picker.disabled]).toEqual([false, false]);
  });

  it("asks for the local part when the invitee's address is elsewhere, and adds it on the Node's domain", async () => {
    mount();
    const section = await form();
    fireEvent.change(within(section).getByLabelText("Address"), { target: { value: "bob@gmail.com" } });
    fireEvent.click(within(section).getByLabelText("Also give them a mailbox at"));
    expect((within(section).getByText("Mint an invitation") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText("Their mailbox's address"), { target: { value: "bob.smith" } });
    fireEvent.click(within(section).getByText("Mint an invitation"));
    await screen.findByText(/was made/);
    expect(calls.find((call) => call.path === "/api/addresses")!.body).toEqual({ address: "bob.smith@whymelabs.com", mailboxId: "mbx_new" });
  });

  it("will not mint with a mailbox whose address has no domain, when the Node knows none", async () => {
    mount({ boxes: [{ ...BOX, addresses: null }] });
    const section = await form();
    fireEvent.change(within(section).getByLabelText("Address"), { target: { value: "bob@gmail.com" } });
    fireEvent.click(within(section).getByLabelText("Also give them a mailbox at"));
    fireEvent.change(within(section).getByLabelText("Their mailbox's address"), { target: { value: "bob" } });
    expect((within(section).getByText("Mint an invitation") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText("Their mailbox's address"), { target: { value: "bob@whymelabs.com" } });
    expect((within(section).getByText("Mint an invitation") as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets a typed local part take over from the invitee's own", async () => {
    mount();
    await inviteWithMailbox("bob@whymelabs.com", "robert");
    await screen.findByText(/was made/);
    expect(calls.find((call) => call.path === "/api/addresses")!.body).toEqual({ address: "robert@whymelabs.com", mailboxId: "mbx_new" });
  });

  it("picks the invitee's own domain among several, and sends the one picked instead", async () => {
    mount({ receiving: "whymelabs.com", boxes: [{ ...BOX, addresses: "support@example.test" }] });
    const section = await form();
    fireEvent.change(within(section).getByLabelText("Address"), { target: { value: "ann@example.test" } });
    fireEvent.click(within(section).getByLabelText("Also give them a mailbox at"));
    const picker = within(section).getByLabelText("Their mailbox's address: domain") as HTMLSelectElement;
    expect(Array.from(picker.options).map((one) => one.value)).toEqual(["whymelabs.com", "example.test"]);
    expect(picker.value).toBe("example.test");
    fireEvent.change(picker, { target: { value: "whymelabs.com" } });
    fireEvent.click(within(section).getByText("Mint an invitation"));
    await screen.findByText(/was made/);
    expect(calls.find((call) => call.path === "/api/addresses")!.body).toEqual({ address: "ann@whymelabs.com", mailboxId: "mbx_new" });
  });

  it("mints the invitation alone when the box is not ticked", async () => {
    mount();
    const section = await form();
    fireEvent.change(within(section).getByLabelText("Address"), { target: { value: "bob@whymelabs.com" } });
    fireEvent.click(within(section).getByText("Mint an invitation"));
    await screen.findByText("s3cret");
    expect(posts()).toEqual(["/api/invitations"]);
  });

  it("makes no mailbox when the invitation is refused", async () => {
    mount({ invitation: Response.json({ message: "E_ALREADY_MEMBER bob@whymelabs.com already has an account" }, { status: 409 }) });
    await inviteWithMailbox("bob@whymelabs.com");
    await screen.findByText(/E_ALREADY_MEMBER/);
    expect(posts()).toEqual(["/api/invitations"]);
  });

  it("says a refused mailbox on its own line, adds no address, and still shows the secret", async () => {
    mount({ mailbox: Response.json({ message: "E_MAILBOX_NAME_TAKEN a mailbox called \"bob@whymelabs.com\" already exists" }, { status: 422 }) });
    await inviteWithMailbox("bob@whymelabs.com");
    const alert = await screen.findByText(/No mailbox was made: E_MAILBOX_NAME_TAKEN/);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(posts()).toEqual(["/api/invitations", "/api/mailboxes"]);
    expect(screen.getByText("s3cret")).toBeTruthy();
  });
});

describe("somebody arriving to a mailbox waiting for them", () => {
  beforeEach(reset);

  const BOB: Person = { id: "usr_bob", email: "bob@whymelabs.com", created_at: "2026-09-28T00:00:00.000Z", relations: [] };
  const HIS = { ...BOX, id: "mbx_bob", name: "bob@whymelabs.com", addresses: "bob@whymelabs.com" };

  const PROMPT = /has an account and holds nothing directly/;

  it("asks, naming the address, and grants read and send on that mailbox in one click", async () => {
    mount({ boxes: [BOX, HIS], people: [BOB] });
    await screen.findByText(PROMPT);
    const button = screen.getByText("Grant mailbox.content.read and send.propose on bob@whymelabs.com");
    // Only what was read: an account, and nothing held on it directly. Nothing observes an arrival.
    expect(button.closest(".notice")!.textContent!.replace(/\s+/g, " "))
      .toContain("bob@whymelabs.com has an account and holds nothing directly on the mailbox at that address. Give them the mailbox bob@whymelabs.com?");
    fireEvent.click(button);
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/access").map((call) => call.body)).toEqual([
        { subjectId: "usr_bob", relation: "mailbox.content.read", objectId: "mbx_bob" },
        { subjectId: "usr_bob", relation: "send.propose", objectId: "mbx_bob" },
      ]);
    });
  });

  it("does not ask once they hold anything on it, or when no mailbox carries their address", async () => {
    mount({
      boxes: [BOX, HIS],
      people: [
        { ...BOB, relations: [{ relation: "mailbox.metadata.read", objectType: "mailbox", objectId: "mbx_bob" }] },
        { ...BOB, id: "usr_ann", email: "ann@whymelabs.com" },
      ],
    });
    await screen.findAllByText("ann@whymelabs.com", { selector: "td" });
    expect(screen.queryByText(PROMPT)).toBeNull();
    // Nobody to ask about, so the audit trail is not read.
    expect(calls.filter((call) => call.path.startsWith("/api/audit"))).toEqual([]);
  });

  /*
   * Departure is revocation here (no deactivation flag), so a person whose access to their own mailbox an
   * administrator withdrew holds nothing on it again, and was offered it back in one click (29 September 2026).
   */
  it("does not offer back a mailbox a relation on which was withdrawn from them", async () => {
    const CY = { ...BOX, id: "mbx_cy", name: "cy@whymelabs.com", addresses: "cy@whymelabs.com" };
    mount({
      boxes: [BOX, HIS, CY],
      people: [BOB, { ...BOB, id: "usr_ann", email: "ann@whymelabs.com" }, { ...BOB, id: "usr_cy", email: "cy@whymelabs.com" }],
      // Bob's own mailbox, and withdrawals that must not hide anybody else's: Ann's on Bob's, Bob's on another.
      withdrawals: () => Response.json({ entries: [withdrawn("usr_bob", "mbx_bob"), withdrawn("usr_ann", "mbx_cy"), withdrawn("usr_bob", "mbx_test")], truncated: false }),
    });
    // Cy is asked about once the withdrawals are read, in the same render that would ask about Bob.
    await screen.findByText(PROMPT);
    expect(screen.getAllByText(PROMPT).map((one) => one.closest(".notice")!.textContent)).toEqual([expect.stringMatching(/^cy@whymelabs\.com has an account/)]);
  });

  it("reads the withdrawals again after a revocation in the table, so the one just made is not offered back", async () => {
    const ANN: Person = { ...BOB, id: "usr_ann", email: "ann@whymelabs.com" };
    const HERS = { ...BOX, id: "mbx_ann", name: "ann@whymelabs.com", addresses: "ann@whymelabs.com" };
    // The second read is held open, so the moment between the people list and the trail can be looked at.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    mount({
      boxes: [HIS, HERS],
      people: [{ ...BOB, relations: [{ relation: "mailbox.content.read", objectType: "mailbox", objectId: "mbx_bob" }] }, ANN],
      withdrawals: () => (++reads === 1 ? theTrail() : held.then(theTrail)),
    });
    const bobsRead = () => document.getElementById("grant-usr_bob-mbx_bob-mailbox-content-read") as HTMLInputElement;
    const asked = () => screen.getAllByText(PROMPT).map((one) => one.closest(".notice")!.textContent);
    // Ann is asked about, so the withdrawals are read (none yet) before Bob's is made.
    await screen.findByText(PROMPT);
    fireEvent.click(bobsRead());
    await waitFor(() => expect(reads).toBe(2));
    // The trail is read again before the people list that makes Bob a candidate: nobody is offered Bob's meanwhile.
    expect(bobsRead().checked).toBe(true);
    expect(asked()).toEqual([expect.stringMatching(/^ann@whymelabs\.com has an account/)]);
    release();
    await waitFor(() => expect(bobsRead().checked).toBe(false));
    expect(asked()).toEqual([expect.stringMatching(/^ann@whymelabs\.com has an account/)]);
  });

  it("offers nobody while the withdrawals cannot be read, and says why", async () => {
    mount({ boxes: [BOX, HIS], people: [BOB], withdrawals: () => Response.json({ message: "No trail." }, { status: 500 }) });
    const alert = await screen.findByText(/People offers nobody the mailbox at their own address/);
    expect(alert.textContent).toContain("No trail.");
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(screen.queryByText(/^Grant mailbox\.content\.read/)).toBeNull();
  });

  it("fails the read, and so offers nobody, on a withdrawal that names no object", async () => {
    const broken = { ...withdrawn("usr_ann", "mbx_x"), detail: JSON.stringify({ relation: "mailbox.content.read" }) };
    mount({ boxes: [BOX, HIS], people: [BOB], withdrawals: () => Response.json({ entries: [broken], truncated: false }) });
    expect((await screen.findByText(/People offers nobody/)).textContent).toContain("The access.revoked entry aud_1 names no person or no object");
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it("says when older withdrawals were not read, beside the prompts and only while there are some", async () => {
    mount({ boxes: [BOX, HIS], people: [BOB], withdrawals: () => Response.json({ entries: [], truncated: true }) });
    await screen.findByText(PROMPT);
    expect(screen.getByText(/Only the newest withdrawals of access were read/)).toBeTruthy();
    // Granted: nobody left to ask about, so nothing is said of what the read missed.
    fireEvent.click(screen.getByText(/^Grant mailbox\.content\.read/));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    expect(screen.queryByText(/Only the newest withdrawals/)).toBeNull();
  });

  it("names the relation a refusal stopped at, and keeps saying so after the half-done grant ends the prompt", async () => {
    mount({
      boxes: [HIS], people: [BOB],
      grant: (relation) => relation === "send.propose"
        ? Response.json({ message: "E_NOT_GRANTABLE no" }, { status: 422 })
        : Response.json({ granted: true, alreadyHeld: false }),
    });
    fireEvent.click(await screen.findByText(/^Grant mailbox\.content\.read and send\.propose/));
    // Bob now holds mailbox.content.read, so the refresh ends the prompt; the refusal must outlive it.
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    expect((await screen.findByRole("alert")).textContent)
      .toBe("send.propose on bob@whymelabs.com was not granted to bob@whymelabs.com: E_NOT_GRANTABLE no");
  });
});
