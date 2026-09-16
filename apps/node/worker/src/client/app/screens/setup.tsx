import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Nothing } from "../chrome.tsx";
import {
  beginConsent, onboardReceiving, onboardSending, receivingProposal, reportUnselectable,
  resolveProviderAccount, sendingProposal, setProviderClient, subscribeDeliveryEvents, subscriptionProposal,
  useProvider, useRouting,
  type ProviderBinding, type ProviderCeremony, type ReceivingProposal, type SendingProposal, type SubscriptionProposal,
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
 * opened a terminal can finish setup**, and the two steps that remain in the dashboard are the two that
 * cannot leave it: a client this Node is not allowed to create for itself, and a consent only a human may
 * give.
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

/** Copies to the clipboard and says so, because a button that silently succeeds looks broken. */
function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="setup-copy">
      <code className="mono">{text}</code>
      <button
        type="button"
        className="linkish"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            // A clipboard that refuses is not a failure worth a banner — the text is on screen and
            // selectable, which is what it was always the fallback for.
            () => setCopied(false),
          );
        }}
      >
        {copied ? "copied" : `copy ${label}`}
      </button>
    </span>
  );
}

/** A refusal, whole. Never trimmed: the fix is usually the last sentence. */
function Refusal({ said }: { said: string | null }) {
  if (said === null) return null;
  return <pre className="notice bad butler-findings" role="alert">{said}</pre>;
}

const WORDS: Record<ProviderBinding["state"], string> = {
  no_client: "This Node has no Cloudflare client yet.",
  awaiting_consent: "The client is registered. Nobody has authorized it.",
  account_not_selectable: "Cloudflare's consent screen offered no account to choose.",
  consent_granted: "Connected.",
  grant_refused: "Cloudflare refused this grant.",
};

function Client({ ceremony, done }: { ceremony: ProviderCeremony; done: () => Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setProblem(null);
    setSaving(true);
    const outcome = await setProviderClient(clientId.trim(), secret.trim());
    setSaving(false);
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setClientId("");
    setSecret("");
    await done();
  }

  return (
    <section className="setup-block" aria-label="Create the client">
      <h2>1. Create a client, in Cloudflare</h2>
      {/*
        The steps are the Node's, not this file's. `GET /api/provider` returns them, the CLI prints the same
        list, and a second copy written here would be the one that goes stale — which on a setup screen means
        an operator following instructions to a place that has moved.
      */}
      <ol className="setup-steps">
        {ceremony.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>

      <p>
        Cloudflare will ask where to send you back. It is this, exactly:{" "}
        <Copyable text={ceremony.redirectUri} label="address" />
      </p>

      <p>Tick these permissions, and no others:</p>
      <div className="scroller">
        <table>
          <thead>
            <tr><th scope="col">Permission</th><th scope="col">What this Node does with it</th></tr>
          </thead>
          <tbody>
            {ceremony.scopes.map((one) => (
              <tr key={one.scope}>
                <td className="mono">{one.scope}</td>
                <td>
                  {one.why}
                  {/*
                    Four of these have no read-only form in Cloudflare's vocabulary. Saying so where the
                    write permission appears is the difference between a Node that asked for more than it
                    needed and one that took the only shape on offer.
                  */}
                  {one.readOnlyExists ? null : (
                    <> <span className="dim">Cloudflare offers no read-only version of this one.</span></>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="dim">{ceremony.unmeasured}</p>

      <Refusal said={problem} />
      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-client-id">
          <span>Client ID</span>
          <input
            id="setup-client-id" className="mono" value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          />
        </label>
        <label className="field-row" htmlFor="setup-client-secret">
          <span>Client secret</span>
          {/*
            `type="password"`, and the reason is not the operator's own eyes. Setup is the screen most likely
            to be shown to somebody else — shared, projected, screen-recorded for support — and this is the
            one field on it that authorizes anything.
          */}
          <input
            id="setup-client-secret" type="password" className="mono" value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || clientId.trim() === "" || secret.trim() === ""}
        >
          {saving ? "saving…" : "save this client"}
        </button>
      </div>
      <p className="dim">
        The secret is sealed and never shown again — not here, and not by any route. Saving a different client
        discards whatever the last one was granted.
      </p>
    </section>
  );
}

function Consent(
  { ceremony, refresh }: { ceremony: ProviderCeremony; refresh: () => Promise<void> },
) {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function begin() {
    setProblem(null);
    const outcome = await beginConsent(ceremony.scopes.map((one) => one.scope));
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setUrl(outcome.value.authorize.url);
  }

  async function noAccount() {
    setProblem(null);
    const outcome = await reportUnselectable();
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await refresh();
  }

  return (
    <section className="setup-block" aria-label="Authorize">
      <h2>2. Authorize, in Cloudflare</h2>
      <Refusal said={problem} />
      {url === null ? (
        <p>
          <button type="button" onClick={() => void begin()}>start the authorization</button>{" "}
          <span className="dim">Nothing is granted by asking. This only produces the address to visit.</span>
        </p>
      ) : (
        <>
          {/*
            A link the operator clicks, rather than a window this screen opens.
            
            The address arrives from a request, so by the time it exists the click that asked for it is over
            — and a popup opened outside a gesture is blocked by Safari, which presents as a button that does
            nothing. A link is also the honest shape: it says where it goes before it goes there.
          */}
          <p>
            <a href={url} target="_blank" rel="noreferrer">Open Cloudflare's consent screen</a>{" "}
            <span className="dim">opens in a new tab</span>
          </p>
          <p>
            Cloudflare sends you back to this Node when you agree. Then:{" "}
            <button type="button" className="linkish" onClick={() => void refresh()}>check again</button>
          </p>
          <p className="dim">
            If the consent screen lists no account to choose from, somebody with access to the Cloudflare
            account has turned off public OAuth app access. This Node cannot see that — Cloudflare sends no
            error — so it has to be told:{" "}
            <button type="button" className="linkish" onClick={() => void noAccount()}>
              it offered me no account
            </button>
          </p>
        </>
      )}
    </section>
  );
}

function Connected({ provider, refresh }: { provider: ProviderBinding; refresh: () => Promise<void> }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [found, setFound] = useState<number | null>(null);

  async function resolve() {
    setProblem(null);
    const outcome = await resolveProviderAccount();
    if (!outcome.ok) { setProblem(outcome.message); return; }
    setFound(outcome.value.account.found);
    await refresh();
  }

  return (
    <section className="setup-block" aria-label="The connection">
      <h2>Connected</h2>
      <dl className="setup-facts">
        <dt>Cloudflare account</dt>
        <dd className="mono">
          {provider.accountId ?? <span className="dim">not recorded</span>}
          {/*
            An account is resolved during the consent now. It can still be null — a grant covering more than
            one account records none rather than guessing, which is the ADR 40 distinction between a refusal
            and an unknown, and the only honest answer when the deployment plan reads this field.
          */}
          {provider.accountId === null ? (
            <> <button type="button" className="linkish" onClick={() => void resolve()}>ask again</button></>
          ) : null}
        </dd>
        <dt>Authorized</dt>
        <dd className="mono">
          {provider.grantedAt === null
            ? <span className="dim">unknown</span>
            : new Date(provider.grantedAt).toLocaleString()}
        </dd>
        <dt>Permissions granted</dt>
        <dd className="mono">
          {provider.scopesGranted === null || provider.scopesGranted.length === 0
            ? <span className="dim">Cloudflare named none</span>
            : provider.scopesGranted.join(", ")}
        </dd>
      </dl>
      {found !== null && found !== 1 ? (
        <p className="notice" role="status">
          {found === 0
            ? "This grant can see no account."
            : `This grant covers ${found} accounts, so none was recorded — a Node that guessed would be `
              + "guessing about where mail goes."}
        </p>
      ) : null}
      <Refusal said={problem} />
    </section>
  );
}

function Receiving({ refresh }: { refresh: () => Promise<void> }) {
  const routing = useRouting();
  const [domain, setDomain] = useState("");
  const [address, setAddress] = useState("");
  const [plan, setPlan] = useState<ReceivingProposal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function propose() {
    setProblem(null);
    setOutcome(null);
    setPlan(null);
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
    const answer = await onboardReceiving(plan.domain, plan.digest, address.trim());
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
      done.confirmed.length === 0
        ? `Nothing was confirmed in DNS for ${done.domain}, so no routing rule was made.`
          + `${done.note === null ? "" : ` ${done.note}`}`
        : `${done.domain} now has ${done.confirmed.length} confirmed record(s)`
          + `${done.rule === null ? " and no rule" : ` and mail is routed to ${done.rule}`}.`,
    );
    await refresh();
  }

  return (
    <section className="setup-block" aria-label="Receiving mail">
      <h2>Receiving</h2>
      <p className="dim">
        A subdomain of a zone in this Cloudflare account. Pointing it here writes the MX records Cloudflare
        asks for, reads them back, and only then routes an address at this Node.
      </p>

      {routing.isPending ? <Nothing kind="loading" /> : null}
      {routing.isError ? <Nothing kind="failed" detail={routing.error.message} /> : null}
      {routing.isSuccess && routing.data.routing.length > 0 ? (
        <div className="scroller">
          <table>
            <caption className="dim">What Cloudflare says about the domains this Node already routes.</caption>
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
        {/*
          Not "see what this would do", which is what the sending form's button also said. One page, two
          buttons, identical text: unambiguous beside their own fields and indistinguishable to anybody
          moving through the page by control rather than by eye.
        */}
        <button type="button" onClick={() => void propose()} disabled={busy || domain.trim() === ""}>
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
          <button
            type="button"
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
    </section>
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
      <h2>Sending</h2>
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
        <button type="button" onClick={() => void propose()} disabled={busy || domain.trim() === ""}>
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
      <h2>Delivery outcomes</h2>
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
        <button type="button" onClick={() => void propose()} disabled={busy || domain.trim() === ""}>
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
          {plan.queueName === null ? null : (
            <p>Would publish {plan.events.length} event types into <span className="mono">{plan.queueName}</span>.</p>
          )}
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy || plan.subscribed !== null || plan.error !== null}
          >
            {busy ? "working…" : "subscribe this domain"}
          </button>
        </div>
      )}
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

  if (provider.isPending) return <Nothing kind="loading" />;
  if (provider.isError) return <Nothing kind="failed" detail={provider.error.message} />;

  const { provider: binding, ceremony } = provider.data;
  const connected = binding.state === "consent_granted";

  return (
    <>
      <header className="ledger-head">
        <h1>Setup</h1>
        <p className="dim">
          {WORDS[binding.state]}
          {/*
            `reported` states are somebody's account of what they saw, and this Node saying so is the
            difference between a fact it checked and a fact it was handed. The contract makes the field
            impossible to omit; this is where that pays.
          */}
          {binding.evidence === "reported" ? " Reported by an administrator, not observed by this Node." : ""}
        </p>
      </header>

      {binding.state === "grant_refused" && binding.refusedDetail !== null
        ? <Refusal said={binding.refusedDetail} />
        : null}

      {binding.state === "account_not_selectable" ? (
        <p className="notice bad" role="alert">
          Cloudflare offered no account on the consent screen. Somebody with access to the account has turned
          off public OAuth app access; it is in Manage Account → Preferences. This Node cannot see that
          setting, so it cannot tell you when it changes back — try authorizing again once it has.
        </p>
      ) : null}

      {connected && binding.scopesMissing.length > 0 ? (
        /*
          A grant that works and is short a scope this Node asks for now. The consent block below the
          connection is the same one a first authorization uses; the sentence is what makes an operator
          who was told "connected" understand why one thing on this screen still refuses.
        */
        <>
          <p className="notice" role="status">
            This grant was made before this Node asked for{" "}
            <span className="mono">{binding.scopesMissing.join(", ")}</span>. Add those to the OAuth client
            in the Cloudflare dashboard first — a client may only request what it was registered with, and
            consenting before that is refused as <span className="mono">invalid_scope</span> — then authorize
            again below.
          </p>
          <Consent ceremony={ceremony} refresh={refresh} />
        </>
      ) : null}
      {connected
        ? <Connected provider={binding} refresh={refresh} />
        : (
          <>
            <Client ceremony={ceremony} done={refresh} />
            {/*
              Shown from `awaiting_consent` on, and not before. A consent needs a client; offering the button
              first would produce a refusal whose only cause is that the operator followed the screen in the
              order it was printed.
            */}
            {binding.state === "no_client"
              ? null
              : <Consent ceremony={ceremony} refresh={refresh} />}
          </>
        )}

      {/*
        Receiving and sending are only reachable once there is a grant. Rendering the forms unreachably would
        be nineteen routes' problem over again in a different shape: a control that exists and cannot work.
      */}
      {connected ? <Receiving refresh={refresh} /> : null}
      {connected ? <Sending /> : null}
      {connected ? <Subscription /> : null}

      {/*
        Buying a domain is not here, and that is a scope decision rather than an oversight — `mailda provider
        --buy` spends money, and the screen for that needs its own argument about who may press it.
      */}
      {connected ? (
        <p className="dim">
          Buying a domain through this grant is not on this screen yet. It spends money, and who may press
          that button is a decision this Node has not been given.
        </p>
      ) : null}
    </>
  );
}
