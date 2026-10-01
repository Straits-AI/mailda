import { Link, useRouterState } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { t } from "/app/locale.js";

import type { Text } from "../../i18n/format.ts";
import {
  useDeliveryEvents, useDoctor, useProvider, useRouting,
  type DeliveryRow, type DoctorReport, type ProviderBinding, type Provisioned, type ProvisionedAct, type RoutingRow,
} from "./api.ts";
import { count, recordDay } from "./format.ts";
import { NodeWords, sentence } from "./words.tsx";

/**
 * Onboarding progress, derived and never stored.
 *
 * A founder finishing a Node's setup could not see how far along it was: the Setup screen is five numbered
 * sections, each knowing its own state, and nothing said "two of five, next is receiving". Nothing outside
 * Setup said setup was unfinished at all, so an inbox on a Node that cannot receive looked like an inbox.
 *
 * ## One rule: every step reads a structured field the Node already serves
 *
 * No step is decided by a sentence. `doctor`'s findings carry prose deliberately (`inbound_routing` says
 * that an address exists and that nothing having arrived is consistent with both correct setup and none),
 * and a checklist that parsed that prose would be AGENTS.md's rung four: coupled to wording, failing when a
 * sentence is rewritten rather than when the fact changes. So:
 *
 * | step | source | done when |
 * |:--|:--|:--|
 * | connected | `GET /api/provider` state | `token_held` |
 * | an address | `doctor` `inbound_routing.ok` | an address is configured (that is what `ok` means there) |
 * | routed | `GET /api/provider/email-routing` | a domain enabled with no record still required |
 * | sending | `GET /api/provider/delivery-events` | a domain onboarded for sending, enabled, no record required |
 * | outcomes | the same | a subscription, enabled, with a queue and a consumer |
 *
 * The last three spend the token (each is live Cloudflare calls and may renew a token), which is why the
 * Setup screen reads them and the shell's one-line notice reads only the first two. The notice is honest
 * about that: it names a step it can see is undone, and says nothing when both of its sources are fine.
 *
 * ## What "unknown" means
 *
 * A source that could not be read, or one this Node did not ask for because an earlier step blocks it. It
 * is a third state rather than folded into "to do", because "not connected, so routing was not checked" and
 * "checked, and not routed" call for different next actions.
 */

/**
 * `optional` is the connection's state when there is none: a Node the installer set up with wrangler's
 * login (25 September 2026) works without a token, and the token is for changing that setup from this
 * screen. It is not "to do", and it is left out of the count.
 */
export type StepState = "done" | "todo" | "unknown" | "optional";

export interface Step {
  id: "connected" | "address" | "routed" | "sending" | "outcomes";
  label: Text;
  /** The label inside a sentence ("next: mail routed to this Node"): English lowercases its first word, and only that. */
  phrase: Text;
  state: StepState;
  /** What makes it that state, in the source's own terms; shown beside the label. A source's own words are in `<NodeWords>`. */
  detail: ReactNode;
}

export interface Sources {
  provider: ProviderBinding | null;
  /**
   * The audit trail's record of what was set up, read when there is no token to read the account with.
   * Live reads win when connected; a record is shown as a record, with its date.
   */
  provisioned?: Provisioned | null;
  doctor: DoctorReport | null;
  /** `undefined` means not asked (the step before it is undone); `null` means asked and not readable. */
  routing?: RoutingRow[] | null;
  delivery?: DeliveryRow[] | null;
}

type Reading = Pick<Step, "state" | "detail">;
const reading = (state: StepState, detail: ReactNode): Reading => ({ state, detail });
const notAsked = (why: ReactNode): Reading => reading("unknown", why);

/** One domain and what is true of it: this interface's words, or the source's own inside `<NodeWords>`. */
const ofDomain = (domain: string, said: ReactNode): ReactNode => sentence("onboarding.domain", { domain, said });
const nodeSaid = (words: string): ReactNode => <NodeWords>{words}</NodeWords>;

/** Each domain's line, joined as the locale joins clauses. */
function joined(lines: ReactNode[]): ReactNode {
  return lines.map((line, index) => <Fragment key={index}>{index === 0 ? null : t("onboarding.join")}{line}</Fragment>);
}

/** A provisioning act from the audit trail, said as what it is: a dated record, not a live read. */
const recorded = (act: ProvisionedAct | null): Reading => {
  if (act === null) return reading("todo", t("onboarding.record.none"));
  // An observation says who did not do it: this Node found it in place, and claims no more than that.
  const how: "observed" | "install" | "token" = act.observed ? "observed" : act.authority === "operator" ? "install" : "token";
  return reading("done", t(`onboarding.record.${how}`, { domain: act.domain, date: recordDay(act.at) }));
};

/**
 * The receiving record, with its outcome (28 September 2026): an onboard whose address a rule of its own sends
 * elsewhere, or that could not be written, is not mail routed here however the intent reads; one that could not be
 * checked is unknown. An onboard from before outcomes were recorded has none and reads as the record it is.
 */
const recordedReceiving = (act: ProvisionedAct | null): Reading => {
  const routing = act?.routing ?? null;
  if (act === null || routing === null || routing.state === "catch_all" || routing.state === "rule_written") return recorded(act);
  return reading(routing.state === "unconfirmed" ? "unknown" : "todo", ofDomain(act.domain, nodeSaid(routing.detail)));
};

const required = (n: number): Text => t("onboarding.required", { n });

/** Why a routed domain is not ready: Cloudflare's error, else what is missing. */
const routingGap = (row: RoutingRow): ReactNode => row.error !== null
  ? nodeSaid(row.error)
  : row.enabled === true ? required(row.required.length) : t("onboarding.routed.off");

/** Why a domain is not ready to send. */
const sendingGap = (row: DeliveryRow): ReactNode => row.sending === null
  ? t("onboarding.sending.notOnboarded")
  : row.sending.error !== null
    ? nodeSaid(row.sending.error)
    : row.sending.enabled === true ? required(row.sending.required.length) : t("onboarding.sending.off");

/** Why a domain's delivery outcomes are not observed. */
const outcomesGap = (row: DeliveryRow): ReactNode => row.error !== null
  ? nodeSaid(row.error)
  : row.subscription === null ? t("onboarding.outcomes.noSubscription")
  : row.enabled !== true ? t("onboarding.outcomes.off")
  : row.queueId === null ? t("onboarding.outcomes.noQueue")
  : t("onboarding.outcomes.noConsumer");

export function onboardingSteps(sources: Sources): Step[] {
  const { provider, doctor, routing, delivery } = sources;
  const provisioned = sources.provisioned ?? null;

  const connected = provider === null
    ? notAsked(t("onboarding.connected.unread"))
    : provider.state === "token_held"
      ? reading("done", t("onboarding.connected.account", { account: provider.accountName ?? provider.accountId ?? "?" }))
      : reading("optional", t("onboarding.connected.optional"));
  // Without a token the account cannot be read, so nothing live was asked for; the audit trail's record of
  // the install's acts stands in. Live reads only exist once connected, which is why this needs no second guard.
  const record = connected.state !== "done" && provisioned !== null;
  const unasked = (): Reading => notAsked(connected.state === "done" ? t("onboarding.notRead") : t("onboarding.needsConnection"));

  const inbound = doctor?.findings.find((one) => one.check === "inbound_routing") ?? null;
  const address = doctor === null
    ? notAsked(t("onboarding.address.unread"))
    : inbound === null
      ? notAsked(t("onboarding.address.unreported"))
      : inbound.ok
        ? reading("done", t("onboarding.address.done"))
        : reading("todo", t("onboarding.address.todo"));

  const routedRows = (routing ?? []).filter((row) => row.enabled === true && row.required.length === 0 && row.error === null);
  const routed = record
    ? recordedReceiving(provisioned.receiving)
    : routing === undefined
    ? unasked()
    : routing === null
      ? notAsked(t("onboarding.routed.unread"))
      : routing.length === 0
        ? reading("todo", t("onboarding.routed.none"))
        : routedRows.length > 0
          ? reading("done", routedRows.map((row) => row.domain).join(", "))
          : reading("todo", joined(routing.map((row) => ofDomain(row.domain, routingGap(row)))));

  const sendingRows = (delivery ?? []).filter((row) => row.sending !== null && row.sending.enabled === true && row.sending.required.length === 0 && row.sending.error === null);
  const sending = record
    ? recorded(provisioned.sending)
    : delivery === undefined
    ? unasked()
    : delivery === null
      ? notAsked(t("onboarding.delivery.unread"))
      : sendingRows.length > 0
        ? reading("done", sendingRows.map((row) => row.domain).join(", "))
        : reading("todo", delivery.length === 0 ? t("onboarding.sending.none") : joined(delivery.map((row) => ofDomain(row.domain, sendingGap(row)))));

  const observedRows = (delivery ?? []).filter((row) => row.subscription !== null && row.enabled === true && row.queueId !== null && row.consumers.length > 0);
  const outcomes = record
    ? recorded(provisioned.deliveryEvents)
    : delivery === undefined
    ? unasked()
    : delivery === null
      ? notAsked(t("onboarding.delivery.unread"))
      : observedRows.length > 0
        ? reading("done", observedRows.map((row) => row.domain).join(", "))
        : reading("todo", delivery.length === 0 ? t("onboarding.outcomes.none") : joined(delivery.map((row) => ofDomain(row.domain, outcomesGap(row)))));

  const step = (id: Step["id"], how: Reading): Step =>
    ({ id, label: t(`onboarding.step.${id}`), phrase: t(`onboarding.step.${id}.phrase`), ...how });
  return [step("address", address), step("routed", routed), step("sending", sending), step("outcomes", outcomes), step("connected", connected)];
}

const CHIP: Record<StepState, string> = { done: "verdict-ok", todo: "severity-degraded", unknown: "state-outcome_unknown", optional: "severity-report" };

/**
 * Whether this Node can be used as an inbox: an address exists and mail is routed to it. Those two are what
 * `E_MAILBOX_HAS_NO_ADDRESS` and an empty inbox stand for; sending and outcomes are worth doing and are not
 * what makes the screen a lie. A founder who ran the install, then the update, then opened the app saw an
 * inbox and took it as ready (25 September 2026). It was not, and nothing said so.
 */
export type Readiness = "ready" | "not-ready";
export function readinessOf(steps: Step[]): Readiness {
  const done = (id: Step["id"]) => steps.find((step) => step.id === id)?.state === "done";
  return done("address") && done("routed") ? "ready" : "not-ready";
}

/**
 * Readiness from the two cheap sources every screen already has: the connection state with the audit
 * trail's record, and `doctor`. `unknown` is a `/api/provider` that refused (a member, not an
 * administrator, gets 404): a member cannot set anything up, so the shell renders as it always did.
 */
export function useReadiness(): { state: "loading" | "unknown" | Readiness; steps: Step[]; next: Step | null } {
  const provider = useProvider();
  const doctor = useDoctor();
  if (provider.isError) return { state: "unknown", steps: [], next: null };
  if (provider.isPending || doctor.isPending) return { state: "loading", steps: [], next: null };
  const steps = onboardingSteps({
    provider: provider.data.provider,
    provisioned: provider.data.provisioned,
    doctor: doctor.isSuccess ? doctor.data : null,
  });
  return { state: readinessOf(steps), steps, next: steps.find((step) => step.state === "todo" || step.state === "unknown") ?? null };
}

/** The five steps and a count, rendered from steps already derived. */
export function ProgressList({ steps }: { steps: Step[] }) {
  // The optional connection is not counted: a Node is set up without it.
  const counted = steps.filter((step) => step.state !== "optional");
  const done = counted.filter((step) => step.state === "done").length;
  const next = counted.find((step) => step.state !== "done");
  const tally = { done: <span className="mono num">{count(done)}</span>, total: <span className="mono num">{count(counted.length)}</span> };
  return (
    <section className="onboarding" aria-label={t("onboarding.progress.label")}>
      <p className="dim">
        {next === undefined ? sentence("onboarding.progress.done", tally) : sentence("onboarding.progress.next", { ...tally, next: next.phrase })}
        {counted.length < steps.length ? <>{t("join.sentence")}{t("onboarding.progress.optional")}</> : null}
      </p>
      <ol>
        {steps.map((step) => (
          <li key={step.id}>
            <span className={`state ${CHIP[step.state]}`}>{t(`onboarding.state.${step.state}`)}</span>
            <span className="onboarding-label">{step.label}</span>
            <span className="dim onboarding-detail">{step.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The list at the top of Setup. Reads the token-spending sources only once connected. */
export function OnboardingProgress({ binding, provisioned }: { binding: ProviderBinding; provisioned: Provisioned }) {
  const connected = binding.state === "token_held";
  const doctor = useDoctor();
  const routing = useRouting();
  const delivery = useDeliveryEvents(connected);
  const steps = onboardingSteps({
    provider: binding,
    provisioned,
    doctor: doctor.isSuccess ? doctor.data : null,
    routing: !connected ? undefined : routing.isSuccess ? routing.data.routing : routing.isError ? null : undefined,
    delivery: !connected ? undefined : delivery.isSuccess ? delivery.data.delivery : delivery.isError ? null : undefined,
  });
  return <ProgressList steps={steps} />;
}

/**
 * One line above every screen but Setup, while a step the shell can see cheaply is undone. It reads the
 * connection state, the audit trail's record and `doctor`, all cheap, and never the token-spending sources:
 * a glance at the inbox must not renew a token. It never nags about the connection, which is optional.
 */
export function SetupUnfinished() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const provider = useProvider();
  const doctor = useDoctor();
  if (path === "/setup" || !provider.isSuccess) return null;
  const steps = onboardingSteps({
    provider: provider.data.provider,
    provisioned: provider.data.provisioned,
    doctor: doctor.isSuccess ? doctor.data : null,
  });
  const address = steps.find((step) => step.id === "address")!;
  const routed = steps.find((step) => step.id === "routed")!;
  const said = address.state === "todo"
    ? sentence("onboarding.unfinished.address", { step: address.phrase, detail: address.detail })
    : routed.state === "todo" ? t("onboarding.unfinished.routed") : null;
  if (said === null) return null;
  return (
    <p className="notice setup-unfinished" role="status">
      {said}{" "}
      <Link to="/setup" className="linkish">{t("onboarding.unfinished.go")}</Link>
    </p>
  );
}
