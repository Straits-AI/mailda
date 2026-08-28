import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  mintAgent, revokeAgent, useAgentCapabilities, useAgents, useMe,
  type AgentRow,
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

function Minting({ onMinted }: { onMinted: () => void }) {
  const capabilities = useAgentCapabilities();
  const me = useMe();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [days, setDays] = useState("30");
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
      sponsorUserId: me.data?.userId ?? "",
      capabilities: [...chosen],
      lifetimeDays: Number(days),
    });
    if (outcome.ok) {
      setToken({ value: outcome.token, notice: outcome.notice });
      setName("");
      setChosen(new Set());
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

      <label>
        <span>Expires after (days)</span>
        <input
          type="number"
          min="1"
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
      </label>

      <p className="dim">
        There is no refresh and no way to widen a ceiling later — re-minting is the renewal, and it issues a
        new token.
      </p>

      <button type="submit" disabled={name.trim() === "" || chosen.size === 0}>Mint agent</button>

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
