import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import { OnboardingProgress } from "../onboarding.tsx";
import {
  forgetProviderToken, onboardReceiving, onboardSending, putBackRule, receivingProposal, registerProviderToken,
  routingRulesOn, takeOverRule,
  sendingProposal, subscribeDeliveryEvents, subscriptionProposal,
  useMailboxes, useProvider, useRouting,
  type Permission, type ProviderBinding, type ReceivingProposal, type RoutingRules, type SendingProposal,
  type SubscriptionProposal,
} from "../api.ts";

/**
 * Connecting this Node to the Cloudflare account it runs in, without opening the Cloudflare dashboard.
 *
 * ## Why this screen exists
 *
 * Nineteen provider routes shipped before this file did, and every one of them was reachable only through
 * `mailda provider …`. The person those routes exist for is whoever owns the Cloudflare account — and the
 * measured answer to *"what must they do by hand?"* was: create an OAuth client in the dashboard, tick nine
 * permissions, click authorize, then run a terminal for everything after. Two of those are irreducible. The
 * rest were a CLI because nobody had written the screen.
 *
 * So the standard this is held to is not "an administrator can do it". It is **an operator who has never
 * opened a terminal can finish setup**. Since 26 September 2026 the one dashboard act is an API token the
 * operator makes and pastes here; the OAuth client and its consent are gone, one act instead of three.
 *
 * ## Nothing here decides anything
 *
 * Every write on this screen is the same request the CLI sends, and every refusal is rendered in the Node's
 * own four-part words rather than summarised. That matters more here than anywhere else in the interface: a
 * refusal on this screen usually names a thing to do in Cloudflare, and paraphrasing it to "failed" is how an
 * operator ends up back in the dashboard guessing.
 *
 * ## Propose, then confirm, and the digest is what makes that real
 *
 * Receiving and sending both show what would happen before doing it, and confirming carries back the digest
 * of the proposal that was shown. The Node re-derives what it would do *now* and refuses unless the two
 * match. Without that the button would mean "apply whatever the plan has become", which on a zone somebody
 * has edited in the meantime is a different act from the one that was read.
 */


/** A refusal, whole. Never trimmed: the fix is usually the last sentence. */
function Refusal({ said }: { said: string | null }) {
  if (said === null) return null;
  return <pre className="notice bad butler-findings" role="alert">{said}</pre>;
}

/**
 * The one connection: an API token the operator made in Cloudflare, handed to the Node once and held wrapped.
 *
 * The permissions are the Node's list (`GET /api/provider`), never this file's: a list written here would
 * be the one that goes stale. No prefilled link is offered, measured three ways not to work for a permission
 * Cloudflare added recently; the operator ticks the names the table shows. The field is cleared whether or
 * not the call worked, and the account-id field appears only after the Node said the token sees several.
 */
function Connection({ binding, permissions, note, refresh }: {
  binding: ProviderBinding; permissions: Permission[]; note: string; refresh: () => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = binding.state === "token_held";

  async function connect() {
    setProblem(null);
    setBusy(true);
    const outcome = await registerProviderToken(token.trim(), accountId.trim() === "" ? undefined : accountId.trim());
    setBusy(false);
    setToken("");
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setAccountId("");
    await refresh();
  }

  async function forget() {
    setProblem(null);
    setBusy(true);
    const outcome = await forgetProviderToken();
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await refresh();
  }

  const ambiguous = problem !== null && problem.includes("E_PROVIDER_ACCOUNT_AMBIGUOUS");

  return (
    <section className="setup-block" aria-label="Optional connection">
      <h2>Optional: connect this Node to Cloudflare from this screen</h2>
      <p>
        The install set receiving, sending and delivery outcomes up with the consent wrangler already had, so
        this Node works without a credential of its own. Connecting it is only for changing that from here:
        another receiving domain, a sending domain, taking over a routing rule.
      </p>
      {held ? (
        <>
          <p>
            Connected to account {binding.accountName ?? <span className="dim">unnamed</span>}{" "}
            (<span className="mono">{binding.accountId ?? "?"}</span>)
            {binding.registeredAt === null ? "" : ` since ${new Date(binding.registeredAt).toLocaleString()}`}.
          </p>
          <Refusal said={problem} />
          <button type="button" className="quiet" onClick={() => void forget()} disabled={busy}>
            {busy ? "forgetting…" : "forget this token"}
          </button>
          <p className="dim">Forgetting it here does not delete it in Cloudflare; that is yours to do on the token page.</p>
        </>
      ) : (
        <>
          <p>
            Create one API token in Cloudflare with exactly these permissions, restricted to this account, and
            paste it below. This Node holds it wrapped under its credential key and never shows it again.
          </p>
          <div className="scroller">
            <table>
              <thead>
                <tr><th scope="col">Permission</th><th scope="col">Scope</th><th scope="col">What this Node does with it</th></tr>
              </thead>
              <tbody>
                {permissions.map((one) => (
                  <tr key={one.name}>
                    <td className="mono">{one.name}</td>
                    <td>{one.scope}</td>
                    <td>{one.why}{one.optional ? <> <span className="dim">Optional.</span></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dim">{note}</p>
          <p>
            <a className="linkish" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">open the token page</a>
          </p>
          <Refusal said={problem} />
          <div className="limits-ask">
            <label className="field-row" htmlFor="setup-api-token">
              <span>API token</span>
              <input
                id="setup-api-token" type="password" className="mono" value={token} autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            {ambiguous ? (
              <label className="field-row" htmlFor="setup-account-id">
                <span>Account id</span>
                <input
                  id="setup-account-id" className="mono" value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                />
              </label>
            ) : null}
            <button type="button" className="primary" onClick={() => void connect()} disabled={busy || token.trim() === ""}>
              {busy ? "connecting…" : "connect"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Receiving({ refresh }: { refresh: () => Promise<void> }) {
  const routing = useRouting();
  const [domain, setDomain] = useState("");
  const [address, setAddress] = useState("");
  // Which mailbox the address reaches. Absent means "the one mailbox", which the Node refuses when there are
  // several — so the choice is offered only once there is one to make, the composer's From rule.
  const mailboxes = useMailboxes();
  const boxes = mailboxes.data?.mailboxes ?? [];
  const [mailboxId, setMailboxId] = useState("");
  const [plan, setPlan] = useState<ReceivingProposal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only meaningful on an apex; reset with every proposal so a tick for one domain cannot carry to the next.
  const [catchAll, setCatchAll] = useState(false);

  async function propose() {
    setProblem(null);
    setOutcome(null);
    setPlan(null);
    setCatchAll(false);
    setBusy(true);
    const answer = await receivingProposal(domain.trim());
    setBusy(false);
    if (!answer.ok) { setProblem(answer.message); return; }
    setPlan(answer.value.proposal);
  }

  async function apply() {
    if (plan === null) return;
    setProblem(null);
    setBusy(true);
    const answer = await onboardReceiving(plan.domain, plan.digest, address.trim(), mailboxId === "" ? undefined : mailboxId, plan.apex && catchAll);
    setBusy(false);
    if (!answer.ok) { setProblem(answer.message); return; }
    const done = answer.value.outcome;
    setPlan(null);
    /*
     * `confirmed`, not `written`. The Node re-reads DNS after writing, and an empty read-back means it
     * deliberately left no routing rule — a rule pointing at records that are not there is a rule that says
     * a domain receives mail when nothing reaches Cloudflare at all.
     */
    setOutcome(
      done.catchAll !== null
        ? `The catch-all on ${done.domain} now routes to this Node (before: ${done.catchAll.before.action}`
          + `${done.catchAll.before.destinations.length === 0 ? "" : ` → ${done.catchAll.before.destinations.join(", ")}`}`
          + `${done.catchAll.before.enabled ? "" : ", disabled"}). Addresses are managed on this Node from here; `
          + "put it back from Routing rules."
        : done.confirmed.length === 0
          ? `Nothing was confirmed in DNS for ${done.domain}, so no routing rule was made.`
            + `${done.note === null ? "" : ` ${done.note}`}`
          : `${done.domain} now has ${done.confirmed.length} confirmed record(s)`
            + `${done.rule === null ? " and no rule" : ` and mail is routed to ${done.rule}`}.`,
    );
    await refresh();
  }

  return (
    <section className="setup-block" aria-label="Receiving mail">
      <h2>3. Receiving</h2>
      <p className="dim">
        A subdomain of a zone in this Cloudflare account. Pointing it here writes the MX records Cloudflare
        asks for, reads them back, and only then routes an address at this Node.
      </p>

      {routing.isPending ? <Nothing kind="loading" /> : null}
      {routing.isError ? <Nothing kind="failed" detail={routing.error.message} /> : null}
      {routing.isSuccess && routing.data.routing.length > 0 ? (
        <div className="scroller">
          <table>
            <caption className="dim table-caption">What Cloudflare says about the domains this Node already routes.</caption>
            <thead>
              <tr>
                <th scope="col">Domain</th><th scope="col">Zone</th>
                <th scope="col">Receiving</th><th scope="col">Records Cloudflare wants</th>
              </tr>
            </thead>
            <tbody>
              {routing.data.routing.map((row) => (
                <tr key={row.domain}>
                  <td className="mono">{row.domain}</td>
                  <td className="mono dim">{row.zone ?? "no zone found"}</td>
                  <td>
                    {row.error !== null
                      ? <span className="bad">could not be read</span>
                      : row.enabled === true
                        ? <span>on{row.status === null ? "" : ` — ${row.status}`}</span>
                        : <span className="dim">off</span>}
                  </td>
                  <td className="mono num">{row.error === null ? row.required.length : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Refusal said={problem} />
      {outcome === null ? null : <p className="notice" role="status">{outcome}</p>}

      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-receive-domain">
          <span>Subdomain</span>
          <input
            id="setup-receive-domain" className="mono" placeholder="mail.example.com" value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <label className="field-row" htmlFor="setup-receive-address">
          <span>Address to route here</span>
          <input
            id="setup-receive-address" className="mono" placeholder="inbox@mail.example.com" value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        {boxes.length > 1 ? (
          <label className="field-row" htmlFor="setup-receive-mailbox">
            <span>Into mailbox</span>
            <select id="setup-receive-mailbox" className="mono" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)}>
              <option value="">choose a mailbox…</option>
              {boxes.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}
            </select>
          </label>
        ) : null}
        {/*
          Not "see what this would do", which is what the sending form's button also said. One page, two
          buttons, identical text: unambiguous beside their own fields and indistinguishable to anybody
          moving through the page by control rather than by eye.
        */}
        <button className="quiet" type="button" onClick={() => void propose()} disabled={busy || domain.trim() === ""}>
          see what pointing this here would do
        </button>
      </div>

      {plan === null ? null : (
        <div className="setup-plan">
          <h3>What would happen to {plan.domain}</h3>
          {plan.refusal === null ? null : <Refusal said={plan.refusal} />}
          {/*
            The apex warning is its own paragraph and comes first. Enabling Email Routing on a zone writes MX
            and SPF at the apex, which decides where the **whole domain's** mail goes — and `creates` is empty
            in exactly that case, because a zone that is not routing yet lists no records. An operator reading
            a short list would otherwise conclude this was the smaller change.
          */}
          {plan.enablesZone === null ? null : (
            <p className="notice bad" role="alert">
              This also turns on Email Routing for <span className="mono">{plan.enablesZone}</span>, which
              writes MX and SPF at that zone's apex. That decides where mail for the whole domain goes, not
              just this subdomain. The records below are read after that, so this list is short because
              nothing can be read yet — not because little would change.
            </p>
          )}
          {plan.creates.length === 0 ? (
            <p className="dim">No records would be created.</p>
          ) : (
            <div className="scroller">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Type</th><th scope="col">Name</th>
                    <th scope="col">Points at</th><th scope="col">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.creates.map((record) => (
                    <tr key={`${record.type} ${record.name} ${record.content}`}>
                      <td className="mono">{record.type}</td>
                      <td className="mono">{record.name}</td>
                      <td className="mono">{record.content}</td>
                      <td className="mono num">{record.priority ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {plan.present.length === 0 ? null : (
            <p className="dim">Already there: {plan.present.join(", ")}</p>
          )}
          {/*
            Cloudflare's catch-all exists for apex zones only. On an apex it is one rule and every address
            decision is then this Node's, which already bounces an address it does not know; literal rules
            already on the zone keep priority over it. On a subdomain each address needs its own rule, and
            the screen says so rather than offering a box that cannot work.
          */}
          {plan.apex ? (
            <div className="setup-catch-all">
              <label className="field-row" htmlFor="setup-receive-catch-all">
                <input
                  id="setup-receive-catch-all" type="checkbox" checked={catchAll}
                  onChange={(event) => setCatchAll(event.target.checked)}
                />
                <span>Route every address at {plan.domain} to this Node (catch-all)</span>
              </label>
              <p className="dim">
                {plan.catchAll === null
                  ? "No catch-all is set on this zone today."
                  : `Currently: ${plan.catchAll.action}${plan.catchAll.destinations.length === 0 ? "" : ` → ${plan.catchAll.destinations.join(", ")}`}, ${plan.catchAll.enabled ? "enabled" : "disabled"}.`}
                {" "}Addresses are then managed on this Node, an address it does not know bounces, and rules
                already on the zone for single addresses keep priority.
              </p>
            </div>
          ) : (
            <p className="dim">
              {plan.domain} is a subdomain, so each address gets its own rule; adding an address later
              writes one the same way.
            </p>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={busy || plan.refusal !== null || address.trim() === ""}
          >
            {busy ? "working…" : "do this"}
          </button>
          {address.trim() === "" ? (
            <p className="dim">An address to route here is needed before this can be applied.</p>
          ) : null}
        </div>
      )}

      <ExistingRules boxes={boxes} refresh={refresh} />
    </section>
  );
}

/**
 * The rules already on a zone, and taking one over (#258).
 *
 * A zone that received mail before this Node existed has rules that forward elsewhere, and onboarding an
 * address with such a rule keeps the rule. So the rules are shown with where each goes, and one can be
 * pointed here in two clicks. A rule holds one action (measured), so this replaces; the action it had is on
 * the audit entry and "put back" restores it.
 */
function ExistingRules({ boxes, refresh }: { boxes: Array<{ id: string; name: string }>; refresh: () => Promise<void> }) {
  const [domain, setDomain] = useState("");
  const [listing, setListing] = useState<RoutingRules | null>(null);
  const [mailboxId, setMailboxId] = useState("");
  const [arming, setArming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function list() {
    setProblem(null);
    setOutcome(null);
    setArming(null);
    setBusy(true);
    const answer = await routingRulesOn(domain.trim());
    setBusy(false);
    if (!answer.ok) { setProblem(answer.message); return; }
    setListing(answer.value.routing);
  }

  async function act(ruleId: string, digest: string | null) {
    if (listing === null) return;
    setProblem(null);
    setBusy(true);
    const answer = digest === null
      ? await putBackRule(listing.domain, ruleId)
      : await takeOverRule(listing.domain, ruleId, digest, mailboxId === "" ? undefined : mailboxId);
    setBusy(false);
    setArming(null);
    if (!answer.ok) { setProblem(answer.message); return; }
    const done = answer.value.outcome;
    const said = (one: { action: string; destinations: string[] }) =>
      `${one.action}${one.destinations.length === 0 ? "" : ` → ${one.destinations.join(", ")}`}`;
    setOutcome(`${done.to}: was ${said(done.before)}, now ${said(done.after)}.`);
    await refresh();
    await list();
  }

  return (
    <div className="setup-plan">
      <h3>Rules already on a zone</h3>
      <p className="dim">
        A zone that was receiving mail before this Node has rules that send it elsewhere. Pointing one here
        replaces where that address goes; the previous destination is kept on the audit trail, and put back
        restores it. The catch-all is listed and left alone.
      </p>
      <Refusal said={problem} />
      {outcome === null ? null : <p className="notice" role="status">{outcome}</p>}
      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-rules-domain">
          <span>Domain</span>
          <input
            id="setup-rules-domain" className="mono" placeholder="example.com" value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        {boxes.length > 1 ? (
          <label className="field-row" htmlFor="setup-rules-mailbox">
            <span>Into mailbox</span>
            <select id="setup-rules-mailbox" className="mono" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)}>
              <option value="">choose a mailbox…</option>
              {boxes.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}
            </select>
          </label>
        ) : null}
        <button className="quiet" type="button" onClick={() => void list()} disabled={busy || domain.trim() === ""}>
          list the rules on this zone
        </button>
      </div>
      {listing === null ? null : listing.error !== null ? (
        <Refusal said={listing.error} />
      ) : listing.rules.length === 0 ? (
        <p className="dim">No routing rules on {listing.zone}.</p>
      ) : (
        <div className="scroller">
          <table>
            <caption className="dim table-caption">Routing rules on {listing.zone}.</caption>
            <thead>
              <tr>
                <th scope="col">Address</th><th scope="col">Goes to</th><th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {listing.rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="mono">{rule.catchAll ? <span className="dim">catch-all</span> : rule.to}{rule.enabled ? "" : <span className="dim"> (disabled)</span>}</td>
                  <td className="mono">
                    {rule.ours ? "this Node" : `${rule.action}${rule.destinations.length === 0 ? "" : ` → ${rule.destinations.join(", ")}`}`}
                  </td>
                  <td>
                    {rule.catchAll ? null : arming === rule.id ? (
                      <button type="button" className="primary" disabled={busy} onClick={() => void act(rule.id, rule.ours ? null : rule.digest)}>
                        {busy ? "working…" : rule.ours ? "yes, put it back" : `yes, point ${rule.to} here`}
                      </button>
                    ) : (
                      <button type="button" className="quiet" disabled={busy} onClick={() => setArming(rule.id)}>
                        {rule.ours ? "put back" : "point here"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Sending() {
  const [domain, setDomain] = useState("");
  const [plan, setPlan] = useState<SendingProposal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function propose() {
    setProblem(null);
    setOutcome(null);
    setPlan(null);
    setBusy(true);
    const answer = await sendingProposal(domain.trim());
    setBusy(false);
    if (!answer.ok) { setProblem(answer.message); return; }
    setPlan(answer.value.proposal);
  }

  async function apply() {
    if (plan === null) return;
    setProblem(null);
    setBusy(true);
    const answer = await onboardSending(plan.domain, plan.digest);
    setBusy(false);
    if (!answer.ok) { setProblem(answer.message); return; }
    setPlan(answer.value.proposal);
    setOutcome(
      answer.value.proposal.onboarded
        ? `${answer.value.proposal.domain} is onboarded for sending.`
        : `${answer.value.proposal.domain} is still not onboarded.`,
    );
  }

  return (
    <section className="setup-block" aria-label="Sending mail">
      <h2>4. Sending</h2>
      <p className="dim">
        Onboarding a domain for sending tells Cloudflare this account may send as it. It is separate from
        receiving, and a domain can have one without the other.
      </p>

      <Refusal said={problem} />
      {outcome === null ? null : <p className="notice" role="status">{outcome}</p>}

      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-send-domain">
          <span>Domain</span>
          <input
            id="setup-send-domain" className="mono" placeholder="example.com" value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <button className="quiet" type="button" onClick={() => void propose()} disabled={busy || domain.trim() === ""}>
          see what onboarding this would do
        </button>
      </div>

      {plan === null ? null : (
        <div className="setup-plan">
          <h3>{plan.domain}</h3>
          {plan.error === null ? null : <Refusal said={plan.error} />}
          {/*
            `coveredBy` is not `onboarded`. An apex already onboarded covers this name for sending, and saying
            "done" would hide that removing the apex takes this with it. Two facts, shown as two.
          */}
          {plan.coveredBy === null ? null : (
            <p className="notice">
              Already covered by <span className="mono">{plan.coveredBy}</span>, which is onboarded. This
              name itself is not, so it stops being covered if that one is removed.
            </p>
          )}
          {plan.onboarded ? <p className="notice" role="status">Already onboarded for sending.</p> : null}
          {plan.creates.length === 0 ? null : (
            <p>Would create: <span className="mono">{plan.creates.join(", ")}</span></p>
          )}
          {plan.leavesBehind.length === 0 ? null : (
            /*
              What this act cannot undo. Named on the screen rather than in a document, because it is the
              part an operator would otherwise discover from a Cloudflare invoice.
            */
            <p className="notice bad" role="alert">
              Leaves behind, and this Node cannot remove it: {plan.leavesBehind.join(", ")}
            </p>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={busy || plan.onboarded || plan.error !== null}
          >
            {busy ? "working…" : "onboard this domain"}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The third object delivery outcomes depend on (#222): the `email.sending` subscription that publishes a
 * sending domain's events into this Node's queue. Without it every send sits unobserved for ever, and
 * nothing on this screen looks wrong — which is why it has its own section rather than a line under Sending.
 */
function Subscription() {
  const [domain, setDomain] = useState("");
  const [plan, setPlan] = useState<SubscriptionProposal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function propose() {
    setProblem(null);
    setOutcome(null);
    setPlan(null);
    setBusy(true);
    const answer = await subscriptionProposal(domain.trim());
    setBusy(false);
    if (!answer.ok) { setProblem(answer.message); return; }
    setPlan(answer.value.proposal);
  }

  async function apply() {
    if (plan === null) return;
    setProblem(null);
    setBusy(true);
    const answer = await subscribeDeliveryEvents(plan.domain, plan.digest);
    setBusy(false);
    if (!answer.ok) { setProblem(answer.message); return; }
    setPlan(answer.value.proposal);
    setOutcome(
      answer.value.proposal.subscribed === null
        ? `${answer.value.proposal.domain} is still not subscribed.`
        : `${answer.value.proposal.domain}'s delivery events now reach this Node.`,
    );
  }

  return (
    <section className="setup-block" aria-label="Delivery outcomes">
      <h2>5. Delivery outcomes</h2>
      <p className="dim">
        A sending domain reports what happened to each message — delivered, bounced, complained — only if
        a subscription publishes those events into this Node's queue. Without one, every send stays
        unobserved. The domain must be onboarded for sending first.
      </p>

      <Refusal said={problem} />
      {outcome === null ? null : <p className="notice" role="status">{outcome}</p>}

      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-subscribe-domain">
          <span>Domain</span>
          <input
            id="setup-subscribe-domain" className="mono" placeholder="example.com" value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <button className="quiet" type="button" onClick={() => void propose()} disabled={busy || domain.trim() === ""}>
          see what subscribing this would do
        </button>
      </div>

      {plan === null ? null : (
        <div className="setup-plan">
          <h3>{plan.domain}</h3>
          {plan.error === null ? null : <Refusal said={plan.error} />}
          {plan.sendingDomain === null || plan.sendingDomain === plan.domain ? null : (
            <p className="notice">
              Carried by <span className="mono">{plan.sendingDomain}</span>, the onboarded domain that covers
              this name; the subscription is made for that one.
            </p>
          )}
          {plan.subscribed === null ? null : (
            <p className="notice" role="status">Already subscribed, as <span className="mono">{plan.subscribed}</span>.</p>
          )}
          {plan.queueName === null || plan.subscribed !== null ? null : (
            <p>Would publish {plan.events.length} event types into <span className="mono">{plan.queueName}</span>.</p>
          )}
          {plan.consumerAttached === false ? (
            <p className="notice bad" role="alert">
              Nothing reads <span className="mono">{plan.queueName}</span> yet — events would sit unobserved.
              Subscribing attaches this Node as its consumer.
            </p>
          ) : null}
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={busy || (plan.subscribed !== null && plan.consumerAttached !== false) || plan.error !== null}
          >
            {busy ? "working…" : "subscribe this domain"}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * A section that exists and cannot act from here yet. Rendered rather than omitted: a person on this screen
 * looking for "receiving" must find it, and the one sentence says what would make it live.
 */
function Inert({ title }: { title: string }) {
  return (
    <section className="setup-block" aria-label={title}>
      <h2>{title}</h2>
      <p className="dim">
        Needs the connection above, or the terminal command: <span className="mono">curl -fsSL https://mailda.site/update.sh | bash</span>,
        which sets this up with the consent wrangler already has.
      </p>
    </section>
  );
}

export function Setup() {
  const provider = useProvider();
  const queryClient = useQueryClient();

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["provider"] });
    await queryClient.invalidateQueries({ queryKey: ["provider-routing"] });
  }

  // The heading is rendered before the branches, as the inbox does: a screen's name must not depend on
  // whether its data arrived (axe: no level-one heading on /setup while loading).
  if (provider.isPending) return <><header className="ledger-head"><h1>Setup</h1></header><Nothing kind="loading" /></>;
  if (provider.isError) return <><header className="ledger-head"><h1>Setup</h1></header><Nothing kind="failed" detail={provider.error.message} /></>;

  const { provider: binding, provisioned, permissions, note } = provider.data;
  const connected = binding.state === "token_held";

  return (
    <>
      <header className="ledger-head">
        <h1>Setup</h1>
        <p className="dim">{connected ? "Connected." : "This Node holds no Cloudflare credential of its own."}</p>
      </header>

      <OnboardingProgress binding={binding} provisioned={provisioned} />
      {connected ? null : (
        <p className="dim">
          Receiving, sending and delivery outcomes are set up at install, with the consent wrangler already
          had, or later with <span className="mono">mailda setup</span>. Connecting this Node, below, is
          what lets you change them from this screen.
        </p>
      )}

      <Connection binding={binding} permissions={permissions} note={note} refresh={refresh} />

      {/*
        Receiving and sending are only reachable once there is a credential. Rendering the forms unreachably
        would be nineteen routes' problem over again in a different shape: a control that exists and cannot work.
      */}
      {connected ? <Receiving refresh={refresh} /> : <Inert title="Receiving" />}
      {connected ? <Sending /> : <Inert title="Sending" />}
      {connected ? <Subscription /> : <Inert title="Delivery outcomes" />}

      {/*
        Buying a domain is not here, and that is a scope decision rather than an oversight — `mailda provider
        --buy` spends money, and the screen for that needs its own argument about who may press it.
      */}
      {connected ? (
        <p className="dim">
          Buying a domain through this credential is not on this screen yet. It spends money, and who may
          press that button is a decision this Node has not been given.
        </p>
      ) : null}
    </>
  );
}
