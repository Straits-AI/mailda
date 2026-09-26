import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  GRANTABLE_RELATIONS, addAddress, createMailbox, createTeam, grant, invite, removeAddress, renameMailbox, renameTeam,
  revokeAccess, revokeInvitation, setTeamMember,
  forgetPasskey, registerPasskey,
  useInvitations, useMailboxes, useMe, usePasskeys, usePeople, useTeamMembers, useTeams,
  type PersonRow, type TeamRow,
  type AddressRemoval, type AddressRouting, type MailboxQueue,
} from "../api.ts";

/**
 * Who works here and what each of them may reach (#39, #73, #81).
 *
 * ## Why this is the most basic thing that was missing
 *
 * Access is granted by relationship tuples and there was no screen for any of it, so giving a colleague
 * access to a mailbox meant writing a `POST /api/access` by hand with a user id you could only get out of
 * the database. There was no list of colleagues anywhere in the product. A shared mailbox that cannot be
 * shared without a database client is Layer 3's whole premise sitting behind a wall.
 *
 * ## Relations are shown as what they let somebody do
 *
 * `mailbox.metadata.read` is exact and tells an administrator nothing about the consequence of granting it.
 * "See that mail exists — senders, subjects, when. Not the message itself." is the same fact in the form the
 * decision actually needs, and the distinction between that and `mailbox.content.read` is the one somebody
 * granting access is most likely to get wrong.
 *
 * ## What this screen refuses to do
 *
 * **It does not create people.** It invites them (#83, below): the person redeems the invitation and chooses
 * their own password, and holds nothing until somebody grants it here. Creating an account with a password
 * an administrator knows is the thing this product never does.
 *
 * **It does not offer `supervised.read`.** That relation is not granted this way — it is time-boxed, needs
 * two approvals and cites a matter (§7) — and `POST /api/access` refuses it with a message explaining the
 * whole ceremony. Listing it would be offering a door that answers with a lecture.
 *
 * **It does not decide who may grant.** Every act here is `org.admin`-gated on the Node, and the read is a
 * 404 for anybody else. The screen never checks; it renders what it is given and shows refusals verbatim.
 */

function relationsFor(person: PersonRow, objectId: string): Set<string> {
  return new Set(person.relations.filter((r) => r.objectId === objectId).map((r) => r.relation));
}

/**
 * Inviting somebody (#83).
 *
 * ## The secret is shown, once, and the screen says so
 *
 * Only its hash is stored, so there is no endpoint that can produce it again. A copy button alone would let
 * somebody navigate away believing the invitation had been "sent" — nothing is sent, and the administrator
 * is the delivery mechanism. So the value is displayed, with the sentence that it will not be shown again
 * beside it, and re-minting is offered as the remedy rather than hidden as an error.
 *
 * ## What it does not do
 *
 * It does not mail the link. The Node can send, which is what makes that tempting, and it would mean posting
 * a credential to an address nobody has verified belongs to the person, from a mailbox whose sending
 * capability is itself unverified (#80). Handing it to the administrator to deliver however they already
 * trust is the smaller, honest step.
 *
 * It does not grant anything. Somebody who redeems an invitation holds exactly nothing until an
 * administrator grants access below, where the consequence of each relation is written next to it.
 */
/**
 * A second mailbox. Here rather than on Setup because a mailbox is a thing people are given access to, and
 * this is the screen that gives it; its addresses are added, listed and removed here too, and only the
 * domain's records and catch-all are Setup's business. The creator is granted read and send on it, so it
 * appears in the rail and below at once.
 */
function NewMailbox({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setProblem(null);
    setMade(null);
    const outcome = await createMailbox(name);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setMade(name.trim());
    setName("");
    await onCreated();
  }

  return (
    <section className="people-teams" aria-label="A new mailbox">
      <h2>Mailboxes</h2>
      <p className="dim">
        A shared inbox with its own queue. You may read and send from it as soon as it exists; grant others
        below, and add the addresses it receives at.
      </p>
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{problem}</pre>}
      {made === null ? null : <p className="notice" role="status">{made} exists. Add an address to it below.</p>}
      <p className="field-row">
        <label htmlFor="new-mailbox-name">Name</label>
        {" "}
        <input id="new-mailbox-name" value={name} placeholder="Invoices" onChange={(event) => setName(event.target.value)} />
        {" "}
        <button className="quiet" type="button" onClick={() => void create()} disabled={busy || name.trim() === ""}>
          create a mailbox
        </button>
      </p>
    </section>
  );
}

/**
 * An address on a mailbox, in one act (25 September 2026). The Node writes the routing rule in the same
 * request when it can, and says so; when it cannot, the address still exists and the notice names the
 * command that finishes it. Nothing here claims mail arrives: `rule_written` means a rule was read back.
 */
const ROUTING_WORDS: Record<AddressRouting["state"], string | null> = {
  catch_all: "routed by the domain's catch-all; nothing to do in Cloudflare",
  rule_written: "routing rule written",
  not_written: null,
};

function NewAddress({ boxes, onAdded }: { boxes: MailboxQueue[]; onAdded: () => Promise<void> }) {
  const [address, setAddress] = useState("");
  const [mailboxId, setMailboxId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [routing, setRouting] = useState<{ address: string; routing: AddressRouting } | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    setProblem(null);
    setRouting(null);
    const chosen = mailboxId !== "" ? mailboxId : boxes.length === 1 ? boxes[0]!.id : undefined;
    const outcome = await addAddress(address.trim(), chosen);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setRouting({ address: outcome.value.address.address, routing: outcome.value.routing });
    setAddress("");
    await onAdded();
  }

  return (
    <section className="people-teams" aria-label="A new address">
      <h3>Add an address</h3>
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{problem}</pre>}
      {routing === null ? null : (
        <p className="notice" role="status">
          {routing.address}: {ROUTING_WORDS[routing.routing.state] ?? routing.routing.detail}
        </p>
      )}
      <p className="field-row">
        <label htmlFor="new-address">Address</label>
        {" "}
        <input id="new-address" className="mono" value={address} placeholder="hello@example.com" onChange={(event) => setAddress(event.target.value)} />
        {" "}
        {boxes.length > 1 ? (
          <select aria-label="Mailbox" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)}>
            <option value="">mailbox…</option>
            {boxes.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}
          </select>
        ) : null}
        {" "}
        <button className="quiet" type="button" onClick={() => void add()} disabled={busy || address.trim() === "" || (boxes.length > 1 && mailboxId === "")}>
          add the address
        </button>
      </p>
    </section>
  );
}

/**
 * A mailbox's name and its addresses, above the access table for it (26 September 2026).
 *
 * The addresses come from `GET /api/mailboxes` itself, which has always carried them for the composer's
 * From choice; nothing new is read. Removing one says what became of its rule, in the same words adding
 * does, because an address gone from the Node while a rule still routes it is mail arriving for nobody.
 */
const REMOVAL_WORDS: Record<AddressRemoval["state"], string | null> = {
  catch_all: "removed; the domain's catch-all needed nothing",
  rule_removed: "removed, and its routing rule deleted",
  not_removed: null,
};

function MailboxHead({ box, onChanged }: { box: MailboxQueue; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(box.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const addresses = box.addresses === null ? [] : box.addresses.split(",");

  async function rename() {
    setBusy(true);
    setProblem(null);
    setSaid(null);
    const outcome = await renameMailbox(box.id, name);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setSaid(`renamed to ${name.trim()}`);
    await onChanged();
  }

  async function remove(address: string) {
    setBusy(true);
    setProblem(null);
    setSaid(null);
    const outcome = await removeAddress(address);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setSaid(`${outcome.value.address.address}: ${REMOVAL_WORDS[outcome.value.routing.state] ?? outcome.value.routing.detail}`);
    await onChanged();
  }

  return (
    <>
      <h2>{box.name}</h2>
      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{problem}</pre>}
      {said === null ? null : <p className="notice" role="status">{said}</p>}
      <p className="field-row">
        <label htmlFor={`rename-${box.id}`}>Name</label>
        {" "}
        <input id={`rename-${box.id}`} value={name} onChange={(event) => setName(event.target.value)} />
        {" "}
        <button className="quiet" type="button" onClick={() => void rename()} disabled={busy || name.trim() === "" || name.trim() === box.name}>
          rename
        </button>
      </p>
      {addresses.length === 0
        ? <p className="dim">No address yet: nothing is routed here, and a send from it is refused until one is.</p>
        : (
          <ul className="grant-list" aria-label={`Addresses of ${box.name}`}>
            {addresses.map((address) => (
              <li key={address}>
                <span className="mono">{address}</span>
                {" "}
                <button type="button" className="linkish" onClick={() => void remove(address)} disabled={busy}>remove</button>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

function Invite({ onInvited }: { onInvited: () => Promise<void> }) {
  const invitations = useInvitations();
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ secret: string; email: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function withdraw(id: string) {
    setProblem(null);
    const outcome = await revokeInvitation(id);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await onInvited();
  }

  async function send() {
    setBusy(true);
    setProblem(null);
    setMinted(null);
    const outcome = await invite(email.trim());
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setEmail("");
    setMinted({ secret: outcome.secret, email: outcome.email, expiresAt: outcome.expiresAt });
    await onInvited();
  }

  return (
    <section className="people-teams" aria-label="Invite somebody">
      <h2>Invite somebody</h2>
      <p className="dim">
        They choose their own password, so you never see it. Hand them the secret however you already trust —
        nothing is emailed. They arrive holding nothing until you grant access below.
      </p>

      {problem === null ? null : <pre className="notice bad butler-findings" role="alert">{problem}</pre>}

      <p className="field-row">
        <label htmlFor="invite-email">Address</label>
        {" "}
        <input
          id="invite-email"
          className="mono"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {" "}
        <button className="quiet" type="button" onClick={() => void send()} disabled={busy || email.trim() === ""}>
          mint an invitation
        </button>
      </p>

      {minted === null ? null : (
        <div className="notice invite-secret" role="status">
          <p>
            Give this to <span className="mono">{minted.email}</span>. It works once, until{" "}
            {new Date(minted.expiresAt).toLocaleString()}.
          </p>
          {/* Selectable, monospaced, and on its own line: this is going to be copied by hand. */}
          <p className="mono invite-value">{minted.secret}</p>
          <p className="dim">
            Shown once — only its hash is stored, so nothing can recover it. Mint another if it is lost, which
            invalidates this one.
          </p>
        </div>
      )}

      {invitations.isSuccess && invitations.data.invitations.length > 0 ? (
        <div className="scroller">
          <table>
            <caption className="dim">Invited, and not yet arrived.</caption>
            <thead>
              <tr>
                <th scope="col">Address</th><th scope="col">Invited by</th>
                <th scope="col">Expires</th><th scope="col">State</th><th scope="col">Withdraw</th>
              </tr>
            </thead>
            <tbody>
              {invitations.data.invitations.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.email}</td>
                  <td className="mono dim">{row.invitedBy}</td>
                  <td className="mono">{new Date(row.expiresAt).toLocaleString()}</td>
                  {/* An expired invitation is kept and shown as expired, so an administrator can see what
                      went stale rather than wondering whether they ever sent it. */}
                  <td>{row.expired ? <span className="dim">expired — mint another</span> : "waiting"}</td>
                  <td>
                    <button type="button" className="linkish" onClick={() => void withdraw(row.id)}>withdraw</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** One person's access to one object, as a set of toggles that say what they do. */
function Grants({
  person, objectId, objectLabel, relations, onChanged,
}: {
  person: PersonRow;
  objectId: string;
  objectLabel: string;
  relations: ReadonlyArray<(typeof GRANTABLE_RELATIONS)[number]>;
  onChanged: () => Promise<void>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const held = relationsFor(person, objectId);

  async function toggle(relation: string, on: boolean) {
    setBusy(relation);
    setProblem(null);
    const outcome = on
      ? await grant(person.id, relation, objectId)
      : await revokeAccess(person.id, relation, objectId);
    setBusy(null);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await onChanged();
  }

  return (
    <td>
      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}
      <ul className="grant-list">
        {relations.map((entry) => {
          /*
           * The relation's dots are stripped out of the **id**, not out of the label.
           *
           * `send.propose` in an id makes `#grant-…-send.propose` parse as an id plus a class, so every
           * CSS-based lookup silently matches nothing — `getElementById` is fine, which is exactly what
           * makes it a trap: the association works, and anything that reaches for the element by selector
           * quietly does not. Found by a harness that could not click the box.
           */
          const id = `grant-${person.id}-${objectId}-${entry.relation}`.replace(/[^\w-]/g, "-");
          return (
            <li key={entry.relation}>
              <label htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={held.has(entry.relation)}
                  disabled={busy === entry.relation}
                  onChange={(event) => void toggle(entry.relation, event.target.checked)}
                />
                {" "}
                <span className="mono">{entry.relation}</span>
                {" — "}
                <span className="dim">{entry.what}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="dim mono grant-object">{objectLabel}</p>
    </td>
  );
}

/**
 * One team's row, with its roster read rather than assumed.
 *
 * The checkbox reflects `membersOf`, which is the Node's answer. The first version of this screen had no
 * roster to read — `listTeams` returns a count by design — and rendered every box unchecked, so a member
 * looked like a non-member and ticking an already-ticked person was the only way to find out. A control
 * that cannot show state is worse than no control, which is why the roster route exists now.
 */
function Roster({
  team, people, onToggle, onRename,
}: {
  team: TeamRow;
  people: PersonRow[];
  onToggle: (teamId: string, userId: string, on: boolean) => Promise<void>;
  onRename: (teamId: string, name: string) => Promise<void>;
}) {
  const members = useTeamMembers(team.id);
  const inTeam = new Set(members.data?.members ?? []);
  const [name, setName] = useState(team.name);
  return (
    <tr>
      <td>
        <label className="field-row" htmlFor={`rename-${team.id}`}>
          <input id={`rename-${team.id}`} aria-label={`Name of ${team.name}`} value={name} onChange={(event) => setName(event.target.value)} />
          {" "}
          <button type="button" className="linkish" onClick={() => void onRename(team.id, name)} disabled={name.trim() === "" || name.trim() === team.name}>
            rename
          </button>
        </label>
      </td>
      <td>
        <ul className="grant-list">
          {people.map((person) => {
            const id = `team-${team.id}-${person.id}`;
            return (
              <li key={person.id}>
                <label htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={inTeam.has(person.id)}
                    // Until the roster has been read, the boxes are not offered: an unchecked box during a
                    // load is a claim about membership, which is the §5C distinction between "no" and
                    // "not answered yet" in checkbox form.
                    disabled={!members.isSuccess}
                    onChange={(event) => void onToggle(team.id, person.id, event.target.checked)}
                  />
                  {" "}
                  <span className="mono">{person.email}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </td>
    </tr>
  );
}

function Teams({ people }: { people: PersonRow[] }) {
  const teams = useTeams();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["teams"] });
    await queryClient.invalidateQueries({ queryKey: ["team-members"] });
  }

  async function add() {
    setProblem(null);
    const outcome = await createTeam(name);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setName("");
    await refresh();
  }

  async function member(teamId: string, userId: string, on: boolean) {
    setProblem(null);
    const outcome = await setTeamMember(teamId, userId, on);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await refresh();
  }

  async function rename(teamId: string, newName: string) {
    setProblem(null);
    const outcome = await renameTeam(teamId, newName);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await refresh();
  }

  return (
    <section className="people-teams" aria-label="Teams">
      <h2>Teams</h2>
      {/*
        Teams exist for one reason and saying it is more useful than a generic description: an approval stage
        can require somebody *from finance, then somebody from legal* (#73, §18). A team with no stage citing
        it changes nothing, which is why this sits below access rather than above it.
      */}
      <p className="dim">
        A team is a group an approval stage can require a decision from — one from finance, then one from
        legal. A team nothing cites changes nothing.
      </p>
      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}

      <p className="field-row">
        <label htmlFor="new-team-name">New team</label>
        {" "}
        <input id="new-team-name" value={name} onChange={(event) => setName(event.target.value)} />
        {" "}
        <button className="quiet" type="button" onClick={() => void add()} disabled={name.trim() === ""}>create</button>
      </p>

      {teams.isSuccess && teams.data.teams.length > 0 ? (
        <div className="scroller">
          <table>
            <thead>
              <tr><th scope="col">Team</th><th scope="col">Members</th></tr>
            </thead>
            <tbody>
              {teams.data.teams.map((team) => (
                <Roster key={team.id} team={team} people={people} onToggle={member} onRename={rename} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Nothing kind="empty" detail="No teams. Approval stages can name one once it exists." />
      )}
    </section>
  );
}

/**
 * Your own passkeys (#84, ADR 29).
 *
 * **On the People screen and scoped to yourself**, which is a decision rather than a placement of
 * convenience. Everything else here is an administrator acting on *other* people — granting, inviting, team
 * membership — and this is the one block that is about the person reading it. Keeping the two together is
 * what makes "who is in this organization and how do they get in" one page, and the heading says whose
 * credentials these are so nobody reads the list as somebody else's.
 *
 * Every account today is password-only, which is why registration is here at all: ADR 29 makes passkeys
 * primary, and a primary mechanism nobody can adopt without reinstalling is not primary.
 */
function Passkeys() {
  const passkeys = usePasskeys();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    setProblem(null);
    const outcome = await registerPasskey(label.trim() || "passkey");
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setLabel("");
    await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
  }

  async function forget(credentialId: string) {
    setBusy(true);
    setProblem(null);
    const outcome = await forgetPasskey(credentialId);
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await queryClient.invalidateQueries({ queryKey: ["passkeys"] });
  }

  const held = passkeys.data?.passkeys ?? [];

  return (
    <section className="passkeys" aria-label="Your passkeys">
      <h2>Your passkeys</h2>
      <p className="dim">
        A passkey signs you in with your device instead of a password. Your password still works — it is the
        fallback, and it is what gets you back in if you lose every device.
      </p>

      {problem === null ? null : <p className="notice bad" role="alert">{problem}</p>}

      {held.length === 0
        ? <p className="dim">None yet. This account signs in with a password only.</p>
        : (
          <table>
            <caption className="dim">
              “Last used” is what tells you which of these you can remove without locking yourself out.
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Added</th>
                <th scope="col">Last used</th>
                <th scope="col">Remove</th>
              </tr>
            </thead>
            <tbody>
              {held.map((passkey) => (
                <tr key={passkey.id}>
                  <td>{passkey.label}</td>
                  <td className="mono">{new Date(passkey.createdAt).toLocaleDateString()}</td>
                  <td className="mono">
                    {passkey.lastUsedAt === null
                      ? <span className="dim">never</span>
                      : new Date(passkey.lastUsedAt).toLocaleDateString()}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => void forget(passkey.id)}
                      disabled={busy}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <label className="field-row" htmlFor="passkey-label">
        <span>Name this device</span>
        <input
          id="passkey-label"
          value={label}
          placeholder="work laptop"
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <p>
        <button className="quiet" type="button" onClick={() => void add()} disabled={busy}>add a passkey</button>
      </p>
    </section>
  );
}

export function People() {
  const people = usePeople();
  const mailboxes = useMailboxes();
  const me = useMe();
  const queryClient = useQueryClient();

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["people"] });
    await queryClient.invalidateQueries({ queryKey: ["invitations"] });
    // Access decides what the rest of the interface can see, so a grant that did not refresh the rail would
    // leave somebody looking at a mailbox list that no longer matches what they hold.
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
  }

  const heading = (
    <header className="ledger-head">
      <h1>People</h1>
      {people.isSuccess ? <p className="dim mono">{people.data.people.length}</p> : null}
    </header>
  );

  if (people.isPending) return <>{heading}<Nothing kind="loading" /></>;
  if (people.isError) {
    return (
      <>
        {heading}
        <Nothing
          kind="empty"
          detail="No directory, or you do not hold org.admin. Granting access is an administrator's act."
        />
      </>
    );
  }

  const rows = people.data.people;
  const boxes = mailboxes.data?.mailboxes ?? [];
  const mailboxRelations = GRANTABLE_RELATIONS.filter((entry) => entry.object === "mailbox");
  const orgRelations = GRANTABLE_RELATIONS.filter((entry) => entry.object === "organization");
  const orgId = me.data?.organizationId ?? "";

  return (
    <>
      {heading}
      {/* Yours, not theirs: everything else on this screen is an administrator acting on other
          people, and the heading says so. */}
      <Passkeys />
      <p className="dim">Everybody with an account on this Node.</p>

      {boxes.map((box) => (
        <section key={box.id} className="people-mailbox" aria-label={`Access to ${box.name}`}>
          <MailboxHead box={box} onChanged={refresh} />
          <div className="scroller">
            <table>
              <thead>
                <tr><th scope="col">Person</th><th scope="col">May</th></tr>
              </thead>
              <tbody>
                {rows.map((person) => (
                  <tr key={person.id}>
                    <td className="mono">{person.email}</td>
                    <Grants
                      person={person}
                      objectId={box.id}
                      objectLabel={box.id}
                      relations={mailboxRelations}
                      onChanged={refresh}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="people-mailbox" aria-label="Administering the organization">
        <h2>The organization</h2>
        <div className="scroller">
          <table>
            <thead>
              <tr><th scope="col">Person</th><th scope="col">May</th></tr>
            </thead>
            <tbody>
              {rows.map((person) => (
                <tr key={person.id}>
                  <td className="mono">{person.email}</td>
                  {/*
                    `org.admin` is scoped to the organization, so the object is the org's own id — taken from
                    `/api/me`, which is the Node's answer to "which organization am I in", rather than
                    inferred from whichever tuple happened to be in the list.
                  */}
                  <Grants
                    person={person}
                    objectId={orgId}
                    objectLabel={orgId}
                    relations={orgRelations}
                    onChanged={refresh}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Invite onInvited={refresh} />
      <NewMailbox onCreated={refresh} />
      <NewAddress boxes={boxes} onAdded={refresh} />

      <Teams people={rows} />
    </>
  );
}
