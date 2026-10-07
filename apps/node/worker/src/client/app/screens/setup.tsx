import { MAX_MAILBOX_NAME_CHARS } from "@mailda/contract/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { CONFIG } from "/app/config.js";
import { t } from "/app/locale.js";

import type { Text } from "../../../i18n/format.ts";
import { Nothing, Scroller } from "../chrome.tsx";
import { count, dateTime } from "../format.ts";
import { OnboardingProgress } from "../onboarding.tsx";
import { NodeWords, marked, sentence } from "../words.tsx";
import {
  addDestination, forgetProviderToken, onboardReceiving, onboardSending, putBackRule, receivingProposal, recordVerifiedDestinations,
  createMailbox, registerProviderToken, routingRulesOn, takeOverRule,
  sendingProposal, subscribeDeliveryEvents, subscriptionProposal,
  useMailboxes, useProvider, useRouting,
  type Permission, type ProviderBinding, type ReceivingProposal, type RoutingRule, type RoutingRules, type Said, type SendingProposal,
  type SubscriptionProposal, type VerifiedDestinationsState,
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


/**
 * A refusal, whole. Never trimmed: the fix is usually the last sentence. The Node's words arrive marked, through
 * `marked()` or `<NodeWords>`, so a Chinese page reads them with an English voice.
 */
function Refusal({ said }: { said: ReactNode }) {
  if (said === null) return null;
  return <pre className="notice bad butler-findings" role="alert">{said}</pre>;
}

/** The Node's own English, marked as such: a plan's refusal, Cloudflare's error, where a rule sends mail. */
const nodeSaid = (words: string): ReactNode => <NodeWords>{words}</NodeWords>;

/**
 * Where a rule sends mail, in Cloudflare's tokens: `forward → someone@example.com`, `drop`. The Node's English, so
 * marked as such wherever it lands, a sentence included (the owner's round three, G8).
 */
const goesTo = (one: { action: string; destinations: string[] }): ReactNode =>
  nodeSaid(`${one.action}${one.destinations.length === 0 ? "" : ` → ${one.destinations.join(", ")}`}`);

/** Cloudflare's event kind for a receiving server's acceptance, which this Node calls accepted (D31). */
const CLOUDFLARE_DELIVERED = "delivered";

/** A command, in mono: identifiers stay Latin in every locale. */
const SETUP_COMMAND = <span className="mono">mailda setup</span>;

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
  const [problem, setProblem] = useState<Said | null>(null);
  const [busy, setBusy] = useState(false);
  const held = binding.state === "token_held";

  async function connect() {
    setProblem(null);
    setBusy(true);
    const outcome = await registerProviderToken(token.trim(), accountId.trim() === "" ? undefined : accountId.trim());
    setBusy(false);
    setToken("");
    if (!outcome.ok) { setProblem(outcome); return; }
    setAccountId("");
    await refresh();
  }

  async function forget() {
    setProblem(null);
    setBusy(true);
    const outcome = await forgetProviderToken();
    setBusy(false);
    if (!outcome.ok) { setProblem(outcome); return; }
    await refresh();
  }

  // The Node's code, compared and never shown: the one refusal this form answers with a second field.
  const ambiguous = problem !== null && problem.message.includes("E_PROVIDER_ACCOUNT_AMBIGUOUS");
  const account = { account: binding.accountName ?? <span className="dim">{t("setup.connection.unnamed")}</span>, id: <span className="mono">{binding.accountId ?? "?"}</span> };

  return (
    <section className="setup-block" aria-label={t("setup.connection.label")}>
      <h2>{t("setup.connection.title")}</h2>
      <p>{t("setup.connection.why")}</p>
      {held ? (
        <>
          <p>
            {binding.registeredAt === null
              ? sentence("setup.connection.held", account)
              : sentence("setup.connection.heldSince", { ...account, at: dateTime(binding.registeredAt) })}
          </p>
          <Refusal said={problem === null ? null : marked(problem)} />
          <button type="button" className="quiet" onClick={() => void forget()} disabled={busy}>
            {busy ? t("setup.connection.forgetting") : t("setup.connection.forget")}
          </button>
          <p className="dim">{t("setup.connection.forgetNote")}</p>
        </>
      ) : (
        <>
          <p>{t("setup.connection.create")}</p>
          {/*
            The permissions fold (design audit, 7 October 2026): eight rows of rationale sat open between the progress
            steps and Receiving, for a section that is optional. The count stays on the line.
          */}
          <details className="setup-permissions">
          <summary>{t("setup.connection.permissionsShow", { n: permissions.length })}</summary>
          <Scroller label={t("setup.connection.permissions")}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("setup.connection.col.permission")}</th><th scope="col">{t("setup.connection.col.scope")}</th>
                  <th scope="col">{t("setup.connection.col.why")}</th>
                </tr>
              </thead>
              <tbody>
                {/* The Node's list: Cloudflare's names and scopes as tokens, and what each is for in the Node's English. */}
                {permissions.map((one) => (
                  <tr key={one.name}>
                    <td className="mono">{one.name}</td>
                    <td><NodeWords>{one.scope}</NodeWords></td>
                    <td>{nodeSaid(one.why)}{one.optional ? <> <span className="dim">{t("setup.connection.optional")}</span></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
          <p className="dim">{nodeSaid(note)}</p>
          </details>
          <p>
            <a className="linkish" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">{t("setup.connection.tokenPage")}</a>
          </p>
          <Refusal said={problem === null ? null : marked(problem)} />
          <div className="limits-ask">
            <label className="field-row" htmlFor="setup-api-token">
              <span>{t("setup.connection.token")}</span>
              <input
                id="setup-api-token" type="password" className="mono" value={token} autoComplete="off"
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            {ambiguous ? (
              <label className="field-row" htmlFor="setup-account-id">
                <span>{t("setup.connection.accountId")}</span>
                <input
                  id="setup-account-id" className="mono" value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                />
              </label>
            ) : null}
            <button type="button" className="primary" onClick={() => void connect()} disabled={busy || token.trim() === ""}>
              {busy ? t("setup.connection.connecting") : t("setup.connection.connect")}
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
  const [problem, setProblem] = useState<ReactNode>(null);
  const [outcome, setOutcome] = useState<ReactNode>(null);
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
    if (!answer.ok) { setProblem(marked(answer)); return; }
    setPlan(answer.value.proposal);
  }

  async function apply() {
    if (plan === null) return;
    setProblem(null);
    setBusy(true);
    const answer = await onboardReceiving(plan.domain, plan.digest, address.trim(), mailboxId === "" ? undefined : mailboxId, plan.apex && catchAll);
    setBusy(false);
    if (!answer.ok) { setProblem(marked(answer)); return; }
    const done = answer.value.outcome;
    setPlan(null);
    /*
     * `confirmed`, not `written`. The Node re-reads DNS after writing, and an empty read-back means it
     * deliberately left no routing rule — a rule pointing at records that are not there is a rule that says
     * a domain receives mail when nothing reaches Cloudflare at all.
     */
    // Whether the address itself reaches this Node is `routing`, whichever path was taken: a rule of its own
    // outranks the catch-all, and a check that could not be made is said, never read as fine (28 September 2026).
    const here = done.routing.state === "catch_all" || done.routing.state === "rule_written";
    // The Node's own sentence after ours: why the address is not routed here, or what it noticed in DNS.
    const then = (said: string | null) => (said === null ? null : <>{" "}{nodeSaid(said)}</>);
    const before = done.catchAll === null ? null : done.catchAll.before.enabled
      ? goesTo(done.catchAll.before)
      : sentence("setup.rule.disabled", { rule: goesTo(done.catchAll.before) });
    setOutcome(
      done.catchAll !== null
        ? <>{sentence("setup.receiving.done.catchAll", { domain: done.domain, before })}{then(here ? null : done.routing.detail)}</>
        : done.confirmed.length === 0
          ? <>{t("setup.receiving.done.nothing", { domain: done.domain })}{then(done.note)}</>
          : here
            ? sentence("setup.receiving.done.routed", { domain: done.domain, n: done.confirmed.length, rule: done.rule === null ? "?" : nodeSaid(done.rule) })
            : <>{t("setup.receiving.done.notRouted", { domain: done.domain, n: done.confirmed.length })}{then(done.routing.detail)}</>,
    );
    await refresh();
  }

  return (
    <section className="setup-block" aria-label={t("setup.receiving.label")}>
      <h2>{t("setup.receiving.heading")}</h2>
      <p className="dim">{t("setup.receiving.about")}</p>

      {routing.isPending ? <Nothing kind="loading" /> : null}
      {routing.isError ? <Nothing kind="failed" detail={marked(routing.error)} /> : null}
      {routing.isSuccess && routing.data.routing.length > 0 ? (
        <Scroller label={t("setup.receiving.routed")}>
          <table>
            <caption className="dim table-caption">{t("setup.receiving.routedCaption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("setup.domain")}</th><th scope="col">{t("setup.receiving.col.zone")}</th>
                <th scope="col">{t("setup.receiving.col.receiving")}</th><th scope="col">{t("setup.receiving.col.records")}</th>
              </tr>
            </thead>
            <tbody>
              {routing.data.routing.map((row) => (
                <tr key={row.domain}>
                  <td className="mono">{row.domain}</td>
                  <td className="mono dim">{row.zone ?? t("setup.receiving.noZone")}</td>
                  <td>
                    {row.error !== null
                      ? <span className="bad">{t("setup.receiving.unread")}</span>
                      : row.enabled === true
                        ? <span>{row.status === null ? t("setup.receiving.on") : sentence("setup.receiving.onStatus", { status: nodeSaid(row.status) })}</span>
                        : <span className="dim">{t("setup.receiving.off")}</span>}
                  </td>
                  <td className="mono num">{row.error === null ? count(row.required.length) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      ) : null}

      <Refusal said={problem} />
      {outcome === null ? null : <p className="notice" role="status">{outcome}</p>}

      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-receive-domain">
          <span>{t("setup.receiving.subdomain")}</span>
          <input
            id="setup-receive-domain" className="mono" placeholder="mail.example.com" value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <label className="field-row" htmlFor="setup-receive-address">
          <span>{t("setup.receiving.address")}</span>
          <input
            id="setup-receive-address" className="mono" placeholder="inbox@mail.example.com" value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        {boxes.length > 1 ? (
          <label className="field-row" htmlFor="setup-receive-mailbox">
            <span>{t("setup.intoMailbox")}</span>
            <select id="setup-receive-mailbox" className="mono" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)}>
              <option value="">{t("setup.chooseMailbox")}</option>
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
          {t("setup.receiving.propose")}
        </button>
      </div>

      {plan === null ? null : (
        <div className="setup-plan">
          <h3>{t("setup.receiving.plan", { domain: plan.domain })}</h3>
          {plan.refusal === null ? null : <Refusal said={nodeSaid(plan.refusal)} />}
          {/*
            The apex warning is its own paragraph and comes first. Enabling Email Routing on a zone writes MX
            and SPF at the apex, which decides where the **whole domain's** mail goes — and `creates` is empty
            in exactly that case, because a zone that is not routing yet lists no records. An operator reading
            a short list would otherwise conclude this was the smaller change.
          */}
          {plan.enablesZone === null ? null : (
            <p className="notice bad" role="alert">
              {sentence("setup.receiving.enablesZone", { zone: <span className="mono">{plan.enablesZone}</span> })}
            </p>
          )}
          {plan.creates.length === 0 ? (
            <p className="dim">{t("setup.receiving.noRecords")}</p>
          ) : (
            <Scroller label={t("setup.receiving.plan", { domain: plan.domain })}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t("setup.receiving.col.type")}</th><th scope="col">{t("setup.receiving.col.name")}</th>
                    <th scope="col">{t("setup.receiving.col.pointsAt")}</th><th scope="col">{t("setup.receiving.col.priority")}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.creates.map((record) => (
                    <tr key={`${record.type} ${record.name} ${record.content}`}>
                      <td className="mono">{record.type}</td>
                      <td className="mono">{record.name}</td>
                      <td className="mono">{record.content}</td>
                      <td className="mono num">{record.priority === null ? "—" : count(record.priority)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )}
          {plan.present.length === 0 ? null : (
            <p className="dim">{sentence("setup.receiving.present", { records: nodeSaid(plan.present.join(", ")) })}</p>
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
                <span>{t("setup.receiving.catchAll", { domain: plan.domain })}</span>
              </label>
              <p className="dim">
                {plan.catchAll === null
                  ? t("setup.receiving.catchAll.none")
                  : plan.catchAll.enabled
                    ? sentence("setup.receiving.catchAll.enabled", { rule: goesTo(plan.catchAll) })
                    : sentence("setup.receiving.catchAll.disabled", { rule: goesTo(plan.catchAll) })}
                {t("join.sentence")}{t("setup.receiving.catchAll.then")}
              </p>
              <OwnRules domain={plan.domain} rules={plan.ownRules} />
            </div>
          ) : (
            <p className="dim">{t("setup.receiving.subdomainNote", { domain: plan.domain })}</p>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={busy || plan.refusal !== null || address.trim() === ""}
          >
            {busy ? t("setup.working") : t("setup.receiving.apply")}
          </button>
          {address.trim() === "" ? (
            <p className="dim">{t("setup.receiving.needsAddress")}</p>
          ) : null}
        </div>
      )}

      <ExistingRules boxes={boxes} refresh={refresh} />
    </section>
  );
}

/**
 * The addresses with a routing rule of their own (28 September 2026). An enabled literal rule outranks the
 * catch-all, so "every address" read as literally all while `sales@` and `info@` went on to another Worker. Named
 * with where each goes, from the Node's classification; the take-over never touches them. A disabled rule's row
 * says Cloudflare does not say whether the catch-all then applies, so the heading claims only enabled ones.
 * Unread is said, never "none".
 */
function OwnRules({ domain, rules }: { domain: string; rules: ReceivingProposal["ownRules"] }) {
  if (rules.error !== null) {
    return (
      <p className="notice bad" role="alert">
        {sentence("setup.ownRules.unread", { domain, said: nodeSaid(rules.error) })}
      </p>
    );
  }
  if (rules.addresses.length === 0) return <p className="dim">{t("setup.ownRules.none", { domain })}</p>;
  return (
    <>
      <p>{t("setup.ownRules.some", { domain, n: rules.addresses.length })}</p>
      <ul>
        {rules.addresses.map((one) => (
          <li key={one.address}>
            {sentence("setup.ownRules.row", {
              address: <span className="mono">{one.address}</span>,
              goes: one.state === "rule_written"
                ? t("setup.thisNode")
                : one.state === "rule_disabled"
                  ? sentence("setup.ownRules.disabled", { where: nodeSaid(one.where) })
                  : nodeSaid(one.where),
            })}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The rules already on a zone, and taking one over (#258).
 *
 * A zone that received mail before this Node existed has rules that send it elsewhere, and onboarding an
 * address with such a rule keeps the rule. So the rules are shown with where each goes, and one can be
 * pointed here in two clicks. A rule holds one action (measured), so this replaces; the action it had is on
 * the audit entry and in the rule's own name, and "put back" restores it.
 *
 * The choice and what it changes are the Node's words (`takeOver`, 1 October 2026), the ones `mailda setup` and
 * `mailda upgrade` print for the same rule, so the two cannot say different things. A forward rule's address files
 * only into a mailbox chosen for it, a new one named after it offered first, never into the only one by default.
 */
function ExistingRules({ boxes, refresh }: { boxes: Array<{ id: string; name: string }>; refresh: () => Promise<void> }) {
  const [domain, setDomain] = useState("");
  const [listing, setListing] = useState<RoutingRules | null>(null);
  const [mailboxId, setMailboxId] = useState("");
  const [arming, setArming] = useState<string | null>(null);
  // A forward rule's choice (ADR 47): which of its two buttons armed the confirm; "to" is a Worker rule's forward to
  // addresses chosen here (amended 7 October 2026). Undefined otherwise.
  const [forward, setForward] = useState<"keep" | "stop" | "to" | undefined>(undefined);
  // With "to": the addresses, comma-separated, filled in from the verified ones the Worker's code names.
  const [forwardTo, setForwardTo] = useState("");
  // With keep: also send a copy when the forward is refused as not verified (ADR 47, amended 3 October 2026). Off
  // until ticked, every time the confirm is armed.
  const [copy, setCopy] = useState(false);
  const [problem, setProblem] = useState<ReactNode>(null);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  async function list() {
    setProblem(null);
    setOutcome(null);
    setArming(null);
    setBusy(true);
    const answer = await routingRulesOn(domain.trim());
    setBusy(false);
    if (!answer.ok) { setProblem(marked(answer)); return; }
    setListing(answer.value.routing);
  }

  function arm(rule: RoutingRule, choice?: "keep" | "stop" | "to") {
    setArming(rule.id);
    setForward(choice);
    setCopy(false);
    setForwardTo((rule.takeOver?.forwardTo?.found ?? []).filter((one) => one.verified === "verified").map((one) => one.to).join(", "));
    // The mailbox already named after the address first, then (a forward) a new one, else the only one, else none yet.
    const { named, fresh } = namedAfter(rule, boxes);
    setMailboxId(named?.id ?? (rule.takeOver?.asksMailbox ? (fresh ? NEW_MAILBOX : "") : boxes.length === 1 ? boxes[0]!.id : ""));
  }

  async function act(rule: RoutingRule) {
    if (listing === null) return;
    setProblem(null);
    setBusy(true);
    let into = mailboxId === "" ? undefined : mailboxId;
    let made: string | null = null;
    if (rule.offer === "take_over" && into === NEW_MAILBOX) {
      const created = await createMailbox(rule.to);
      if (!created.ok) { setBusy(false); setProblem(marked(created)); return; }
      into = created.mailboxId;
      made = rule.to;
      // Listed from now on, so a take-over refused below is retried into this mailbox, never by making a second.
      await refresh();
    }
    const answer = rule.offer === "put_back"
      ? await putBackRule(listing.domain, rule.id)
      : await takeOverRule(listing.domain, rule.id, rule.digest, rule.takeOver?.filesInto === null ? into : undefined,
        forward === "to" ? undefined : forward, (forward === "keep" || forward === "to") && copy,
        forward === "to" ? forwardTo.split(",").map((one) => one.trim()).filter((one) => one !== "") : undefined);
    setBusy(false);
    setArming(null);
    if (!answer.ok) {
      setProblem(made === null ? marked(answer) : <>{marked(answer)}{"\n\n"}{t("setup.rules.mailboxStays", { name: made })}</>);
      return;
    }
    const done = answer.value.outcome;
    await refresh();
    // The listing again first, since listing clears the last outcome, which used to wipe this line as it appeared.
    await list();
    setOutcome(
      <>
        {sentence("setup.rules.done", { address: done.to, before: goesTo(done.before), after: goesTo(done.after) })}
        {done.mailbox === null ? null : <>{t("join.sentence")}{t("setup.rules.filedInto", { name: done.mailbox.name })}</>}
        {done.nameRecorded === false ? <>{t("join.sentence")}{t("setup.rules.nameNotRecorded")}</> : null}
        {(done.keptForward ?? null) === null ? null : <>{t("join.sentence")}{t("setup.rules.keptForward", { to: done.keptForward ?? "" })}</>}
        {(done.keptForward ?? null) !== null || (done.forwards ?? []).length === 0 ? null
          : <>{t("join.sentence")}{t("setup.rules.forwardsTo", { to: (done.forwards ?? []).join(", ") })}</>}
        {done.copy === true ? <>{t("join.sentence")}{t("setup.rules.copyOn", { address: done.to })}</> : null}
      </>,
    );
  }

  return (
    <div className="setup-plan">
      <h3>{t("setup.rules.title")}</h3>
      <p className="dim">{t("setup.rules.about")}</p>
      <Refusal said={problem} />
      {outcome === null ? null : <p className="notice" role="status">{outcome}</p>}
      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-rules-domain">
          <span>{t("setup.domain")}</span>
          <input
            id="setup-rules-domain" className="mono" placeholder="example.com" value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <button className="quiet" type="button" onClick={() => void list()} disabled={busy || domain.trim() === ""}>
          {t("setup.rules.list")}
        </button>
      </div>
      {listing === null ? null : listing.error !== null ? (
        <Refusal said={nodeSaid(listing.error)} />
      ) : listing.rules.length === 0 ? (
        <p className="dim">{t("setup.rules.none", { zone: listing.zone ?? "" })}</p>
      ) : (
        <Scroller label={t("setup.rules.on", { zone: listing.zone ?? "" })}>
          <table>
            <caption className="dim table-caption">{t("setup.rules.caption", { zone: listing.zone ?? "" })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("setup.rules.col.address")}</th><th scope="col">{t("setup.rules.col.goesTo")}</th><th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {listing.rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="mono">
                    {rule.catchAll ? <span className="dim">{t("setup.rules.catchAll")}</span> : rule.to}
                    {rule.enabled ? "" : <span className="dim">{t("join.sentence")}{t("setup.rules.disabled")}</span>}
                  </td>
                  <td className="mono">{rule.ours ? t("setup.thisNode") : goesTo(rule)}</td>
                  <td>
                    {/* The catch-all is left alone here (see above); every other row offers what the Node says it would do. */}
                    {rule.catchAll ? null : rule.offer === null ? (
                      <span className="dim">{rule.refusal === null ? null : nodeSaid(`${rule.refusal.what}: ${rule.refusal.fix}`)}</span>
                    ) : arming === rule.id ? (
                      <>
                        {rule.takeOver === null ? null : <p><NodeWords>{forward === "keep" ? rule.takeOver.keep?.says
                          : forward === "to" ? rule.takeOver.forwardTo?.says : rule.takeOver.says}.</NodeWords></p>}
                        {forward !== "to" || (rule.takeOver?.forwardTo ?? null) === null ? null : (
                          <>
                            <p className="dim">{rule.takeOver!.forwardTo!.found === null
                              ? nodeSaid(rule.takeOver!.forwardTo!.foundError ?? "")
                              : t(rule.takeOver!.forwardTo!.found.some((one) => one.verified === "verified") ? "setup.rules.foundIn" : "setup.rules.foundNothing",
                                { worker: rule.destinations[0] ?? "" })}</p>
                            <label className="field-row" htmlFor={`setup-forward-to-${rule.id}`}>
                              <span>{t("setup.rules.forwardTo")}</span>
                              <input id={`setup-forward-to-${rule.id}`} className="mono" value={forwardTo} onChange={(event) => setForwardTo(event.target.value)} />
                            </label>
                          </>
                        )}
                        {rule.takeOver === null ? null : rule.takeOver.filesInto !== null || (!rule.takeOver.asksMailbox && boxes.length === 1) ? (
                          // No choice to make, so the mailbox is named before the confirm, as `mailda setup`'s plan names it.
                          <p>{t("setup.rules.filesInto", { name: rule.takeOver.filesInto?.name ?? boxes[0]!.name })}</p>
                        ) : (
                          <MailboxChoice rule={rule} boxes={boxes} value={mailboxId} onChange={setMailboxId} />
                        )}
                        {forward !== "keep" && forward !== "to" ? null : (
                          <>
                            <label className="field-row" htmlFor={`setup-copy-${rule.id}`}>
                              <input id={`setup-copy-${rule.id}`} type="checkbox" checked={copy} onChange={(event) => setCopy(event.target.checked)} />
                              <span>{t("setup.rules.copy")}</span>
                            </label>
                            <p className="dim">{t("setup.rules.copyAbout", {
                              address: rule.to,
                              mailbox: rule.takeOver?.filesInto?.name ?? boxes.find((box) => box.id === mailboxId)?.name ?? rule.to,
                              size: t("composer.size.mb", { size: (Math.floor(CONFIG.outboundMaxBytes / 104_857.6) / 10).toFixed(1) }),
                            })}</p>
                          </>
                        )}
                        <button type="button" className="primary" disabled={busy || (forward === "to" && forwardTo.trim() === "")} onClick={() => void act(rule)}>
                          {busy ? t("setup.working") : rule.offer === "put_back" ? t("setup.rules.putBack.confirm") : t("setup.rules.takeOver.confirm", { address: rule.to })}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="quiet" disabled={busy} onClick={() => arm(rule, (rule.takeOver?.keep ?? null) === null ? undefined : "stop")}>
                          {rule.offer === "put_back" ? t("setup.rules.putBack") : <NodeWords>{rule.takeOver?.label ?? "?"}</NodeWords>}
                        </button>
                        {/* A forward rule's third choice, in the Node's words (ADR 47). */}
                        {rule.offer === "take_over" && (rule.takeOver?.keep ?? null) !== null ? (
                          <>{" "}<button type="button" className="quiet" disabled={busy} onClick={() => arm(rule, "keep")}>
                            <NodeWords>{rule.takeOver!.keep!.label}</NodeWords>
                          </button></>
                        ) : null}
                        {/* A Worker rule's other choice, in the Node's words (ADR 47, amended 7 October 2026). */}
                        {rule.offer === "take_over" && (rule.takeOver?.forwardTo ?? null) !== null ? (
                          <>{" "}<button type="button" className="quiet" disabled={busy} onClick={() => arm(rule, "to")}>
                            <NodeWords>{rule.takeOver!.forwardTo!.label}</NodeWords>
                          </button></>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
      )}
    </div>
  );
}

/** The mailbox choice that makes a new one named after the address, which is never a mailbox id. */
const NEW_MAILBOX = "new";

/**
 * The mailbox already named after the rule's address (made by a take-over refused after it), and whether a new one
 * may be offered: only while none has the name, and while the address fits a mailbox name. `mailda setup` offers the same.
 */
function namedAfter(rule: RoutingRule, boxes: Array<{ id: string; name: string }>) {
  const named = boxes.find((box) => box.name.toLowerCase() === rule.to.toLowerCase()) ?? null;
  return { named, fresh: named === null && rule.to.length <= MAX_MAILBOX_NAME_CHARS };
}

/** Which mailbox a taken-over address files into: the one named after it first, a new one while it may be made. */
function MailboxChoice({ rule, boxes, value, onChange }: {
  rule: RoutingRule; boxes: Array<{ id: string; name: string }>; value: string; onChange: (id: string) => void;
}) {
  const { named, fresh } = namedAfter(rule, boxes);
  const ordered = named === null ? boxes : [named, ...boxes.filter((box) => box !== named)];
  return (
    <label className="field-row" htmlFor={`setup-rules-mailbox-${rule.id}`}>
      <span>{t("setup.intoMailbox")}</span>
      <select id={`setup-rules-mailbox-${rule.id}`} className="mono" value={value} onChange={(event) => onChange(event.target.value)}>
        {rule.takeOver?.asksMailbox && (named !== null || fresh) ? null : <option value="">{t("setup.chooseMailbox")}</option>}
        {fresh ? <option value={NEW_MAILBOX}>{t("setup.rules.newMailbox", { address: rule.to })}</option> : null}
        {ordered.map((box) => <option key={box.id} value={box.id}>{box.name}</option>)}
      </select>
    </label>
  );
}

function Sending() {
  const [domain, setDomain] = useState("");
  const [plan, setPlan] = useState<SendingProposal | null>(null);
  const [problem, setProblem] = useState<ReactNode>(null);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  async function propose() {
    setProblem(null);
    setOutcome(null);
    setPlan(null);
    setBusy(true);
    const answer = await sendingProposal(domain.trim());
    setBusy(false);
    if (!answer.ok) { setProblem(marked(answer)); return; }
    setPlan(answer.value.proposal);
  }

  async function apply() {
    if (plan === null) return;
    setProblem(null);
    setBusy(true);
    const answer = await onboardSending(plan.domain, plan.digest);
    setBusy(false);
    if (!answer.ok) { setProblem(marked(answer)); return; }
    setPlan(answer.value.proposal);
    setOutcome(
      answer.value.proposal.onboarded
        ? t("setup.sending.done", { domain: answer.value.proposal.domain })
        : t("setup.sending.notDone", { domain: answer.value.proposal.domain }),
    );
  }

  return (
    <section className="setup-block" aria-label={t("setup.sending.label")}>
      <h2>{t("setup.sending.heading")}</h2>
      <p className="dim">{t("setup.sending.about")}</p>

      <Refusal said={problem} />
      {outcome === null ? null : <p className="notice" role="status">{outcome}</p>}

      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-send-domain">
          <span>{t("setup.domain")}</span>
          <input
            id="setup-send-domain" className="mono" placeholder="example.com" value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <button className="quiet" type="button" onClick={() => void propose()} disabled={busy || domain.trim() === ""}>
          {t("setup.sending.propose")}
        </button>
      </div>

      {plan === null ? null : (
        <div className="setup-plan">
          <h3>{plan.domain}</h3>
          {plan.error === null ? null : <Refusal said={nodeSaid(plan.error)} />}
          {/*
            `coveredBy` is not `onboarded`. An apex already onboarded covers this name for sending, and saying
            "done" would hide that removing the apex takes this with it. Two facts, shown as two.
          */}
          {plan.coveredBy === null ? null : (
            <p className="notice">{sentence("setup.sending.coveredBy", { domain: <span className="mono">{plan.coveredBy}</span> })}</p>
          )}
          {plan.onboarded ? <p className="notice" role="status">{t("setup.sending.onboarded")}</p> : null}
          {plan.creates.length === 0 ? null : (
            <p>{sentence("setup.sending.creates", { records: <span className="mono">{plan.creates.join(", ")}</span> })}</p>
          )}
          {plan.leavesBehind.length === 0 ? null : (
            /*
              What this act cannot undo. Named on the screen rather than in a document, because it is the
              part an operator would otherwise discover from a Cloudflare invoice.
            */
            <p className="notice bad" role="alert">
              {sentence("setup.sending.leavesBehind", { said: nodeSaid(plan.leavesBehind.join(", ")) })}
            </p>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={busy || plan.onboarded || plan.error !== null}
          >
            {busy ? t("setup.working") : t("setup.sending.apply")}
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
  const [problem, setProblem] = useState<ReactNode>(null);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  async function propose() {
    setProblem(null);
    setOutcome(null);
    setPlan(null);
    setBusy(true);
    const answer = await subscriptionProposal(domain.trim());
    setBusy(false);
    if (!answer.ok) { setProblem(marked(answer)); return; }
    setPlan(answer.value.proposal);
  }

  async function apply() {
    if (plan === null) return;
    setProblem(null);
    setBusy(true);
    const answer = await subscribeDeliveryEvents(plan.domain, plan.digest);
    setBusy(false);
    if (!answer.ok) { setProblem(marked(answer)); return; }
    setPlan(answer.value.proposal);
    setOutcome(
      answer.value.proposal.subscribed === null
        ? t("setup.outcomes.notDone", { domain: answer.value.proposal.domain })
        : t("setup.outcomes.done", { domain: answer.value.proposal.domain }),
    );
  }

  return (
    <section className="setup-block" aria-label={t("setup.outcomes.title")}>
      <h2>{t("setup.outcomes.heading")}</h2>
      <p className="dim">{sentence("setup.outcomes.about", { delivered: <NodeWords><code>{CLOUDFLARE_DELIVERED}</code></NodeWords> })}</p>

      <Refusal said={problem} />
      {outcome === null ? null : <p className="notice" role="status">{outcome}</p>}

      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-subscribe-domain">
          <span>{t("setup.domain")}</span>
          <input
            id="setup-subscribe-domain" className="mono" placeholder="example.com" value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <button className="quiet" type="button" onClick={() => void propose()} disabled={busy || domain.trim() === ""}>
          {t("setup.outcomes.propose")}
        </button>
      </div>

      {plan === null ? null : (
        <div className="setup-plan">
          <h3>{plan.domain}</h3>
          {plan.error === null ? null : <Refusal said={nodeSaid(plan.error)} />}
          {plan.sendingDomain === null || plan.sendingDomain === plan.domain ? null : (
            <p className="notice">{sentence("setup.outcomes.carriedBy", { domain: <span className="mono">{plan.sendingDomain}</span> })}</p>
          )}
          {plan.subscribed === null ? null : (
            <p className="notice" role="status">{sentence("setup.outcomes.subscribed", { name: <span className="mono">{plan.subscribed}</span> })}</p>
          )}
          {plan.queueName === null || plan.subscribed !== null ? null : (
            <p>{sentence("setup.outcomes.publish", { n: plan.events.length, queue: <span className="mono">{plan.queueName}</span> })}</p>
          )}
          {plan.consumerAttached === false ? (
            <p className="notice bad" role="alert">
              {sentence("setup.outcomes.noConsumer", { queue: <span className="mono">{plan.queueName}</span> })}
            </p>
          ) : null}
          <button
            type="button"
            className="primary"
            onClick={() => void apply()}
            disabled={busy || (plan.subscribed !== null && plan.consumerAttached !== false) || plan.error !== null}
          >
            {busy ? t("setup.working") : t("setup.outcomes.apply")}
          </button>
        </div>
      )}

      <VerifiedDestinations />
    </section>
  );
}

/**
 * The one kind of silence no subscription fixes (28 September 2026): Cloudflare published no delivery event for
 * mail to a verified destination address of the account, in the one case measured. The read records which of
 * this Node's recipients those are, so the Outbox and doctor say so instead of waiting. The answer is counts,
 * never an address: which recipients they are is the Outbox's to show, bounded by who may read the send.
 */
function VerifiedDestinations() {
  const [read, setRead] = useState<VerifiedDestinationsState | null>(null);
  const [problem, setProblem] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  // The account's list can hold anybody's inbox, so the addresses are fetched only when asked for (ADR 47).
  const [showAddresses, setShowAddresses] = useState(false);
  const queryClient = useQueryClient();

  async function readList() {
    setProblem(null);
    setRead(null);
    setBusy(true);
    const answer = await recordVerifiedDestinations(showAddresses);
    setBusy(false);
    if (!answer.ok) { setProblem(marked(answer)); return; }
    setRead(answer.value.destinations);
    // The read re-checks each kept forward's destination, which People shows.
    await queryClient.invalidateQueries({ queryKey: ["forwards"] });
  }

  return (
    <>
      <h3>{t("setup.verified.title")}</h3>
      <p className="dim">{sentence("setup.verified.about", { command: SETUP_COMMAND })}</p>
      <Refusal said={problem} />
      {read === null ? null : <VerifiedDestinationsRead read={read} />}
      <label className="field-row" htmlFor="setup-verified-addresses">
        <input id="setup-verified-addresses" type="checkbox" checked={showAddresses} onChange={(event) => setShowAddresses(event.target.checked)} />
        <span>{t("setup.verified.showAddresses")}</span>
      </label>
      <button className="quiet" type="button" onClick={() => void readList()} disabled={busy}>
        {busy ? t("setup.working") : t("setup.verified.read")}
      </button>
      <AddDestination />
    </>
  );
}

/** Registering a destination address (ADR 47): Cloudflare mails the link, and the answer says what ends the wait. */
function AddDestination() {
  const [email, setEmail] = useState("");
  const [problem, setProblem] = useState<ReactNode>(null);
  const [said, setSaid] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    setProblem(null);
    setSaid(null);
    setBusy(true);
    const answer = await addDestination(email.trim());
    setBusy(false);
    if (!answer.ok) { setProblem(marked(answer)); return; }
    const { destination } = answer.value;
    const named = { email: <span className="mono">{destination.email}</span> };
    setSaid(destination.state === "verified" ? sentence("setup.destination.verified", named)
      : sentence(destination.added ? "setup.destination.waiting" : "setup.destination.alreadyWaiting", named));
  }

  return (
    <>
      <h3>{t("setup.destination.title")}</h3>
      <p className="dim">{t("setup.destination.about")}</p>
      <Refusal said={problem} />
      {said === null ? null : <p className="notice" role="status">{said}</p>}
      <div className="limits-ask">
        <label className="field-row" htmlFor="setup-destination-email">
          <span>{t("setup.destination.email")}</span>
          <input id="setup-destination-email" className="mono" type="email" placeholder="someone@example.com" value={email}
            onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button className="quiet" type="button" onClick={() => void add()} disabled={busy || email.trim() === ""}>
          {busy ? t("setup.working") : t("setup.destination.add")}
        </button>
      </div>
    </>
  );
}

/**
 * A read's three answers. `error` is tested first: a failed read leaves `recipients` counted and `verified`
 * null, and saying "0 of 3" there would turn could not read into none verified.
 */
function VerifiedDestinationsRead({ read }: { read: VerifiedDestinationsState }) {
  if (read.error !== null) {
    return (
      <Refusal
        said={<>
          {sentence("setup.verified.failed", { said: nodeSaid(read.error) })}{t("join.sentence")}
          {read.readAt === null ? t("setup.verified.failed.never") : t("setup.verified.failed.stands", { at: dateTime(read.readAt) })}
        </>}
      />
    );
  }
  // A read that succeeded names its time, in the viewer's zone (the owner's round three, G4), and its account.
  const at = { at: read.readAt === null ? "" : dateTime(read.readAt), account: read.accountId ?? "" };
  // `?? null`: a Node older than ADR 47 answers without either field.
  const listed = (read.listed ?? null) === null ? null : (
    <>
      <p className="dim">{t("setup.verified.listed", { verified: read.listed!.verified, waiting: read.listed!.waiting })}</p>
      {(read.addresses ?? null) === null ? null : (
        <ul className="grant-list" aria-label={t("setup.verified.addresses")}>
          {read.addresses!.map((one) => (
            <li key={one.email}><span className="mono">{one.email}</span>{" "}<span className="dim">{t(`setup.verified.state.${one.state}`)}</span></li>
          ))}
        </ul>
      )}
    </>
  );
  if (read.recipients === 0) return <><p className="notice" role="status">{t("setup.verified.nobody", at)}</p>{listed}</>;
  return (
    <>
      <p className="notice" role="status">
        {t("setup.verified.some", { ...at, n: read.verified ?? 0, recipients: t("setup.verified.recipients", { n: read.recipients }) })}
      </p>
      {listed}
    </>
  );
}

/**
 * A section that exists and cannot act from here yet. Rendered rather than omitted: a person on this screen
 * looking for "receiving" must find it, and the one sentence says what would make it live.
 */
function Inert({ title }: { title: Text }) {
  return (
    <section className="setup-block" aria-label={title}>
      <h2>{title}</h2>
      <p className="dim">{sentence("setup.inert", { command: <span className="mono">curl -fsSL https://mailda.site/update.sh | bash</span> })}</p>
    </section>
  );
}

export function Setup() {
  const provider = useProvider();
  const queryClient = useQueryClient();

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["provider"] });
    await queryClient.invalidateQueries({ queryKey: ["provider-routing"] });
    // A take-over can make a mailbox named after its address.
    await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
  }

  // The heading is rendered before the branches, as the inbox does: a screen's name must not depend on
  // whether its data arrived (axe: no level-one heading on /setup while loading).
  const heading = <header className="ledger-head"><h1>{t("route./setup")}</h1></header>;
  if (provider.isPending) return <>{heading}<Nothing kind="loading" /></>;
  if (provider.isError) return <>{heading}<Nothing kind="failed" detail={marked(provider.error)} /></>;

  const { provider: binding, provisioned, permissions, note } = provider.data;
  const connected = binding.state === "token_held";

  return (
    <>
      <header className="ledger-head">
        <h1>{t("route./setup")}</h1>
        <p className="dim">{connected ? t("setup.connected") : t("setup.unconnected")}</p>
      </header>

      <OnboardingProgress binding={binding} provisioned={provisioned} />
      {connected ? null : (
        <p className="dim">{sentence("setup.unconnected.why", { command: SETUP_COMMAND })}</p>
      )}

      <Connection binding={binding} permissions={permissions} note={note} refresh={refresh} />

      {/*
        Receiving and sending are only reachable once there is a credential. Rendering the forms unreachably
        would be nineteen routes' problem over again in a different shape: a control that exists and cannot work.
      */}
      {connected ? <Receiving refresh={refresh} /> : <Inert title={t("setup.receiving.title")} />}
      {connected ? <Sending /> : <Inert title={t("setup.sending.title")} />}
      {connected ? <Subscription /> : <Inert title={t("setup.outcomes.title")} />}

      {/*
        Buying a domain is not here, and that is a scope decision rather than an oversight — `mailda provider
        --buy` spends money, and the screen for that needs its own argument about who may press it.
      */}
      {connected ? (
        <p className="dim">{t("setup.buying")}</p>
      ) : null}
    </>
  );
}
