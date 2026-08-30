import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { shortfall } from "@mailda/contract/capability";

import { Nothing } from "../chrome.tsx";
import {
  AGENT_RELATIONS, mintAgent, revokeAgent, useAgentCapabilities, useAgents, useMe, usePeople,
  useSponsorMailboxes,
  type AgentRelation, type AgentRow, type CapabilityRow,
} from "../api.ts";

/**
 * The machine identities this Node has issued (#109).
 *
 * ## Why this screen and not a CLI flag
 *
 * An agent credential could be minted before this existed — `POST /api/agents` shipped with the layer — but
 * only by composing a request with a list of route strings in it. That put the two things an administrator is
 * actually deciding out of reach of anybody who was not reading the route registry: *what may this machine
 * do*, and *whose authority is it borrowing*.
 *
 * ## Capabilities, and what "held 4 of 5" means
 *
 * The ceiling is chosen as capabilities and **stored as routes** — `capability.ts` argues that at length, and
 * the short version is §16's rule: a stored `mail.read` resolved at check time would widen every existing
 * agent the day somebody added a route to that capability. So the expansion is pinned at mint.
 *
 * Which means an agent minted before a capability grew holds part of it, and this screen says so rather than
 * rounding up. `4 of 5` is the truth. Showing `mail.read` would imply a fifth route the agent does not have
 * and — the ceiling being pinned, with no route that widens one — never will.
 *
 * ## What it refuses to do
 *
 * **No widening.** There is no edit control, because there is no route behind one. §16's rule for Butlers
 * applies unchanged: re-minting is the way to change a ceiling, and it produces a new credential with a new
 * expiry, which is the honest cost of a change.
 *
 * **No authority check here.** Every act is `org.admin`-gated on the Node and the read answers 404 for
 * anybody else (§5C). This screen renders what it is given and shows refusals verbatim — a check in the
 * interface would be a second, weaker copy of the decision, in the place it cannot be enforced.
 *
 * **The token is shown once and the screen says so.** Only its hash is stored and there is no refresh, so
 * nothing can produce it again. Same shape as the invitation secret on the People screen, and for the same
 * reason: a copy button alone lets somebody navigate away believing it was "sent" somewhere.
 */

/** Live, expired or revoked — the three states an operator needs to tell apart at a glance. */
function standing(agent: AgentRow, now: number): { label: string; state: string } {
  if (agent.revokedAt !== null) return { label: "revoked", state: "revoked" };
  if (Date.parse(agent.expiresAt) <= now) return { label: "expired", state: "expired" };
  return { label: "live", state: "live" };
}

/**
 * Which chosen capabilities cannot be satisfied by the relations selected, and what is missing.
 *
 * ## Per mailbox, which the first version was not
 *
 * It collapsed every selected relation into one set, so `content.read` on Mailbox A plus `message.export` on
 * Mailbox B read as satisfying `mail.read` — and no mailbox had the two relations that route needs together.
 * The condition is
 *
 * ```
 *   ∃m: content.read(m) ∧ message.export(m)
 * ```
 *
 * and what was tested was
 *
 * ```
 *   (∃m₁: content.read(m₁)) ∧ (∃m₂: message.export(m₂))
 * ```
 *
 * Those are not the same, and the difference is a positive-looking review over a credential that does not
 * work. A capability is satisfied when **some one mailbox** carries all of its relations; which mailbox is
 * the administrator's business, and demanding every mailbox would refuse the ordinary case of an agent that
 * reads one and drafts in another.
 *
 * ## One rule, in `@mailda/contract`
 *
 * The arithmetic above used to live here and **again** in `mintAgent`, which is two chances to make the same
 * mistake and no way to notice one of them had. `shortfall` is the single definition now; this function only
 * translates the screen's shapes into it. What the interface refuses to submit and what the Node refuses to
 * mint are therefore the same question, answered by the same code.
 */
function unmet(
  capabilities: CapabilityRow[],
  chosen: Set<string>,
  reach: Set<string>,
): { id: string; missing: string[] }[] {
  // `reach` is a set of `mailboxId::relation` keys, which is the grant list in the shape this screen holds it.
  const grants = [...reach].map((key) => {
    const [mailboxId, relation] = key.split("::");
    return { mailboxId: mailboxId!, relation: relation! };
  });

  return capabilities
    .filter((one) => chosen.has(one.id) && one.requires.length > 0)
    .map((one) => ({ id: one.id, missing: [...shortfall(one.requires, grants)] }))
    .filter((one) => one.missing.length > 0);
}

function Minting({ onMinted }: { onMinted: () => void }) {
  const capabilities = useAgentCapabilities();
  const me = useMe();
  const people = usePeople();
  /*
   * The **sponsor's** catalogue, not the caller's queue. This was `useMailboxes()` — the work-queue rail,
   * which lists mailboxes the *caller* sends from — so an administrator could only pick mailboxes they
   * personally work in, and a read-only or export-only sponsor's were unselectable.
   */
  const [sponsor, setSponsor] = useState<string | null>(null);
  const chosenSponsor = sponsor ?? me.data?.userId ?? null;
  const mailboxes = useSponsorMailboxes(chosenSponsor);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [days, setDays] = useState("30");
  /** Chosen resource authority, keyed `mailboxId::relation` so a set is the whole state. */
  const [reach, setReach] = useState<Set<string>>(new Set());
  const [token, setToken] = useState<{ value: string; notice: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  if (capabilities.isPending) return <Nothing kind="loading" />;
  if (capabilities.isError) return <Nothing kind="failed" detail={capabilities.error.message} />;

  async function mint() {
    setRefusal(null);
    const outcome = await mintAgent({
      name,
      // The caller, which is the common case: an administrator setting up their own automation. Naming
      // somebody else is a deliberate act and belongs on a route rather than defaulted to in a form.
      sponsorUserId: chosenSponsor ?? "",
      capabilities: [...chosen],
      grants: [...reach].map((key) => {
        const [mailboxId, relation] = key.split("::");
        return { mailboxId: mailboxId!, relation: relation as AgentRelation };
      }),
      lifetimeDays: Number(days),
    });
    if (outcome.ok) {
      setToken({ value: outcome.token, notice: outcome.notice });
      setName("");
      setChosen(new Set());
      setReach(new Set());
      onMinted();
    } else {
      setRefusal(outcome.message);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void mint();
      }}
    >
      {/*
        * The sponsor is chosen, not assumed. The Node has supported naming somebody else since the layer
        * shipped — an administrator setting up automation for a colleague is the ordinary case — and the form
        * always sent the signed-in user, so the wider half of the route was unreachable from the product.
        */}
      <label>
        <span>Acting for</span>
        <select
          value={chosenSponsor ?? ""}
          onChange={(event) => setSponsor(event.target.value)}
        >
          {people.isSuccess
            ? people.data.people.map((person) => (
              <option key={person.id} value={person.id}>{person.email}</option>
            ))
            : <option value={chosenSponsor ?? ""}>{me.data?.userId ?? "…"}</option>}
        </select>
        <span className="dim">
          The agent can never exceed this person, and stops when their access does.
        </span>
      </label>

      <label>
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="what this agent is for"
          required
        />
      </label>

      <fieldset>
        <legend>What it may do</legend>
        {/*
          * The description is beside each name rather than behind a tooltip, because this is the moment the
          * decision is made and a capability whose consequence is one hover away is one nobody reads.
          */}
        {capabilities.data.capabilities.map((capability) => (
          <label key={capability.id} className="check">
            <input
              type="checkbox"
              checked={chosen.has(capability.id)}
              onChange={(event) => {
                const next = new Set(chosen);
                if (event.target.checked) next.add(capability.id);
                else next.delete(capability.id);
                setChosen(next);
              }}
            />
            <span className="mono">{capability.id}</span>
            {/*
              * Marked, not inferred from the name. §7's whole authorization model turns on metadata against
              * content, and `export.read` reaches message bytes while sounding administrative.
              */}
            {capability.reachesContent
              ? <span className="state state-audit-warn">reaches message content</span>
              : null}
            <span className="dim">{capability.says}</span>
          </label>
        ))}
      </fieldset>

      {/*
        * **Which mailboxes, and how.** Minting used to write only the ceiling, so a credential made here
        * authenticated and could not read anything — the journey ended one step before the agent was usable.
        *
        * Nothing is copied from the sponsor automatically. An agent inheriting everything its sponsor holds
        * is the widest possible ceiling arrived at by default, and least privilege has to be the thing that
        * takes no effort to get wrong, not the thing that takes effort to get right.
        */}
      <fieldset>
        <legend>Which mailboxes, and how</legend>
        <p className="dim">
          Nothing is granted by default, and an agent can never exceed its sponsor: a relation the sponsor
          does not hold is refused when you mint, rather than written and silently never matching.
        </p>
        {mailboxes.isPending ? <Nothing kind="loading" /> : null}
        {mailboxes.isError ? <Nothing kind="failed" detail={mailboxes.error.message} /> : null}
        {mailboxes.isSuccess && mailboxes.data.mailboxes.length === 0
          ? <p className="dim">No mailbox on this Node yet.</p>
          : null}
        {mailboxes.isSuccess ? mailboxes.data.mailboxes.map((box) => (
          <div key={box.mailboxId} className="stack">
            <strong>{box.mailboxName}</strong>
            {box.relations.length === 0
              ? <span className="dim">this person holds nothing here</span>
              : null}
            {AGENT_RELATIONS.map((one) => {
              const key = `${box.mailboxId}::${one.relation}`;
              /*
               * Only what the sponsor holds is selectable. The backend refuses the rest — a grant the sponsor
               * does not hold is written and never matches — so offering it would be an offer that fails at
               * mint, which `docs/machine-surfaces.md` argues is worse than no offer.
               */
              const available = box.relations.includes(one.relation);
              return (
                <label key={key} className={available ? "check" : "check dim"}>
                  <input
                    type="checkbox"
                    disabled={!available}
                    checked={reach.has(key)}
                    onChange={(event) => {
                      const next = new Set(reach);
                      if (event.target.checked) next.add(key);
                      else next.delete(key);
                      setReach(next);
                    }}
                  />
                  <span className="mono">{one.relation}</span>
                  {one.reachesContent
                    ? <span className="state state-audit-warn">reaches message content</span>
                    : null}
                  <span className="dim">{one.says}</span>
                </label>
              );
            })}
          </div>
        )) : null}
      </fieldset>

      <label>
        <span>Expires after (days)</span>
        <input
          type="number"
          min="1"
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
      </label>

      {/*
        * The review, before anything is minted. Two facts an administrator cannot otherwise see together: what
        * this agent will be able to do, and that every part of it stops when the sponsor's own access does.
        * The second is the whole argument for sponsoring, and it is invisible in a list of checkboxes.
        */}
      {chosen.size === 0 && reach.size === 0 ? null : (
        <div className="notice">
          <p>
            {`This agent will hold ${chosen.size} capability(s) across ${reach.size} mailbox relation(s), `}
            {"until it expires or is withdrawn."}
          </p>
          <p className="dim">
            Every one of them also stops the moment the sponsor loses that access — an agent is bounded by the
            person it acts for, checked on each request rather than at this moment.
          </p>
          {unmet(capabilities.data.capabilities, chosen, reach).map((one) => (
            <p key={one.id}>
              <span className="mono">{one.id}</span>
              {` needs ${one.missing.join(" and ")} on the same mailbox as its other relations — no mailbox `}
              {"here carries all of them, so the agent will authenticate and be refused."}
            </p>
          ))}
        </div>
      )}
      <p className="dim">
        There is no refresh and no way to widen a ceiling later — re-minting is the renewal, and it issues a
        new token.
      </p>

      {/*
        * Disabled on the shortfall too, not only on the empty name.
        *
        * The screen has computed and displayed `unmet` all along — "no mailbox here carries all of them, so
        * the agent will authenticate and be refused" — and then let the administrator press the button
        * anyway. A warning beside an enabled control reads as advice about a choice, and this is not one:
        * `POST /api/agents` refuses the same combination. Being stopped here, next to the mailbox list that
        * fixes it, is the difference between a correction and a rejection.
        */}
      <button
        type="submit"
        disabled={name.trim() === "" || chosen.size === 0
          || unmet(capabilities.data?.capabilities ?? [], chosen, reach).length > 0}
      >
        Mint agent
      </button>

      {refusal === null ? null : <p className="notice">{refusal}</p>}
      {token === null ? null : (
        <div className="notice">
          <p>{token.notice}</p>
          <p className="mono">{token.value}</p>
        </div>
      )}
    </form>
  );
}

export function Agents() {
  const agents = useAgents();
  const client = useQueryClient();
  const [refusal, setRefusal] = useState<string | null>(null);
  const now = Date.now();

  if (agents.isPending) {
    return (
      <section className="ledger" aria-label="Agents">
        <header className="ledger-head"><h1>Agents</h1></header>
        <Nothing kind="loading" />
      </section>
    );
  }
  if (agents.isError) {
    return (
      <section className="ledger" aria-label="Agents">
        <header className="ledger-head"><h1>Agents</h1></header>
        <Nothing kind="failed" detail={agents.error.message} />
      </section>
    );
  }

  async function withdraw(agentId: string) {
    const outcome = await revokeAgent(agentId);
    if (!outcome.ok) setRefusal(outcome.message);
    await client.invalidateQueries({ queryKey: ["agents"] });
  }

  return (
    <section className="ledger" aria-label="Agents">
      <header className="ledger-head">
        <h1>Agents</h1>
      </header>

      <p className="dim">
        A machine identity acting under a named person's authority. It can never hold more than that person
        holds, and every act it takes lands in the audit trail under both.
      </p>

      {refusal === null ? null : <p className="notice">{refusal}</p>}

      {agents.data.agents.length === 0 ? (
        <Nothing kind="empty" detail="No agent has been minted on this Node." />
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Sponsor</th>
              <th scope="col">May do</th>
              <th scope="col">Where</th>
              <th scope="col">Standing</th>
              <th scope="col" className="num">Expires</th>
              <th scope="col"><span className="sr-only">Withdraw</span></th>
            </tr>
          </thead>
          <tbody>
            {agents.data.agents.map((agent) => {
              const where = standing(agent, now);
              return (
                <tr key={agent.id}>
                  <td>
                    {agent.name}
                    <span className="mono dim block">{agent.id}</span>
                  </td>
                  <td className="mono dim">{agent.sponsorUserId}</td>
                  <td>
                    <ul className="bare">
                      {agent.held.map((one) => (
                        <li key={one.id}>
                          <span className="mono">{one.id}</span>
                          {/*
                            * Only shown when it is partial, so a whole capability reads as a name and a
                            * partial one cannot be mistaken for it.
                            */}
                          {one.held === one.total
                            ? null
                            : <span className="dim">{` ${one.held} of ${one.total}`}</span>}
                        </li>
                      ))}
                      {agent.unnamed.length === 0 ? null : (
                        <li className="dim">
                          {`${agent.unnamed.length} pinned route(s) this Node no longer names: `}
                          <span className="mono">{agent.unnamed.join(", ")}</span>
                        </li>
                      )}
                    </ul>
                  </td>
                  <td>
                    {/*
                      * Granted **and** effective, because they are different facts. A sponsor losing a
                      * relation narrows every agent that borrowed it, correctly and silently — so a row
                      * showing only what was granted is an answer that was true on the day of the mint, and
                      * one showing only what is effective cannot tell a narrowed agent from an unprovisioned
                      * one.
                      */}
                    {agent.grants.length === 0
                      ? <span className="dim">no mailbox</span>
                      : (
                        <ul className="bare">
                          {agent.grants.map((grant) => (
                            <li key={`${grant.mailboxId}:${grant.relation}`}>
                              <span>{grant.mailboxName ?? grant.mailboxId}</span>
                              <span className="mono dim">{` ${grant.relation}`}</span>
                              {grant.effective
                                ? null
                                : (
                                  <span className="state state-audit-warn">
                                    not effective — the sponsor no longer holds this
                                  </span>
                                )}
                            </li>
                          ))}
                        </ul>
                      )}
                  </td>
                  <td><span className={`state state-audit-${where.state}`}>{where.label}</span></td>
                  <td className="num mono dim">{agent.expiresAt}</td>
                  <td>
                    {/*
                      * Offered only while there is something to withdraw. A button that answers "already
                      * revoked" is an offer nobody can complete, and the Node's own revoke is deliberately
                      * silent about that case — it writes no audit entry when nothing changed.
                      */}
                    {where.state === "live" ? (
                      <button type="button" className="linkish" onClick={() => void withdraw(agent.id)}>
                        withdraw
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Mint an agent</h2>
      <Minting onMinted={() => void client.invalidateQueries({ queryKey: ["agents"] })} />
    </section>
  );
}
