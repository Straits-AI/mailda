import { Link, useRouterState } from "@tanstack/react-router";

import {
  useDeliveryEvents, useDoctor, useProvider, useRouting,
  type DeliveryRow, type DoctorReport, type ProviderBinding, type Provisioned, type ProvisionedAct, type RoutingRow,
} from "./api.ts";

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
 * | connected | `GET /api/provider` state | `consent_granted` with no scope missing |
 * | an address | `doctor` `inbound_routing.ok` | an address is configured (that is what `ok` means there) |
 * | routed | `GET /api/provider/email-routing` | a domain enabled with no record still required |
 * | sending | `GET /api/provider/delivery-events` | a domain onboarded for sending, enabled, no record required |
 * | outcomes | the same | a subscription, enabled, with a queue and a consumer |
 *
 * The last three spend the grant (each is live Cloudflare calls and may renew a token), which is why the
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
 * login (25 September 2026) works without a grant, and the grant is for changing that setup from this
 * screen. It is not "to do", and it is left out of the count.
 */
export type StepState = "done" | "todo" | "unknown" | "optional";

export interface Step {
  id: "connected" | "address" | "routed" | "sending" | "outcomes";
  label: string;
  state: StepState;
  /** What makes it that state, in the source's own terms; shown beside the label. */
  detail: string;
}

export interface Sources {
  provider: ProviderBinding | null;
  /**
   * The audit trail's record of what was set up, read when there is no grant to read the account with.
   * Live reads win when connected; a record is shown as a record, with its date.
   */
  provisioned?: Provisioned | null;
  doctor: DoctorReport | null;
  /** `undefined` means not asked (the step before it is undone); `null` means asked and not readable. */
  routing?: RoutingRow[] | null;
  delivery?: DeliveryRow[] | null;
}

const notAsked = (why: string): Pick<Step, "state" | "detail"> => ({ state: "unknown", detail: why });

/** A provisioning act from the audit trail, said as what it is: a dated record, not a live read. */
const recorded = (act: ProvisionedAct | null, absent: string): Pick<Step, "state" | "detail"> => act === null
  ? { state: "todo", detail: absent }
  : {
    state: "done",
    detail: `${act.domain}, set up ${act.authority === "operator" ? "at install" : "through the grant"} on `
      + `${new Date(act.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} (a record, not a live read)`,
  };

export function onboardingSteps(sources: Sources): Step[] {
  const { provider, doctor, routing, delivery } = sources;
  const provisioned = sources.provisioned ?? null;

  const connected = provider === null
    ? notAsked("the connection state could not be read")
    : provider.state === "consent_granted" && provider.scopesMissing.length === 0
      ? { state: "done" as const, detail: provider.accountId === null ? "grant held; account not resolved yet" : `account ${provider.accountId}` }
      : provider.state === "consent_granted"
        ? { state: "todo" as const, detail: `grant held, but short of ${provider.scopesMissing.join(", ")}; authorize again` }
        : provider.state === "no_client"
          ? { state: "optional" as const, detail: "only for changing the Cloudflare setup from this screen" }
          : { state: "todo" as const, detail: provider.state.replace(/_/g, " ") };
  // Without a grant the account cannot be read, so nothing live was asked for; the audit trail's record of
  // the install's acts stands in. Live reads only exist once connected, which is why this needs no second guard.
  const record = connected.state !== "done" && provisioned !== null;

  const inbound = doctor?.findings.find((one) => one.check === "inbound_routing") ?? null;
  const address = doctor === null
    ? notAsked("doctor could not be read")
    : inbound === null
      ? notAsked("doctor did not report on inbound routing")
      : inbound.ok
        ? { state: "done" as const, detail: "an address is configured" }
        : { state: "todo" as const, detail: "no address is configured; add one on People" };

  const routed = record
    ? recorded(provisioned.receiving, "not set up; the installer or the Setup screen does it")
    : routing === undefined
    ? notAsked(connected.state === "done" ? "not read" : "needs the connection first")
    : routing === null
      ? notAsked("routing could not be read through the grant")
      : routing.length === 0
        ? { state: "todo" as const, detail: "no domain to route yet" }
        : routing.some((row) => row.enabled === true && row.required.length === 0 && row.error === null)
          ? { state: "done" as const, detail: routing.filter((row) => row.enabled === true && row.required.length === 0 && row.error === null).map((row) => row.domain).join(", ") }
          : { state: "todo" as const, detail: routing.map((row) => `${row.domain}: ${row.error ?? (row.enabled === true ? `${row.required.length} record(s) still required` : "routing not enabled")}`).join("; ") };

  const sendingRows = (delivery ?? []).filter((row) => row.sending !== null && row.sending.enabled === true && row.sending.required.length === 0 && row.sending.error === null);
  const sending = record
    ? recorded(provisioned.sending, "not set up; the installer or the Setup screen does it")
    : delivery === undefined
    ? notAsked(connected.state === "done" ? "not read" : "needs the connection first")
    : delivery === null
      ? notAsked("delivery events could not be read through the grant")
      : sendingRows.length > 0
        ? { state: "done" as const, detail: sendingRows.map((row) => row.domain).join(", ") }
        : { state: "todo" as const, detail: delivery.length === 0 ? "no domain onboarded for sending yet" : delivery.map((row) => `${row.domain}: ${row.sending === null ? "not onboarded for sending" : row.sending.error ?? (row.sending.enabled === true ? `${row.sending.required.length} record(s) still required` : "sending not enabled")}`).join("; ") };

  const observedRows = (delivery ?? []).filter((row) => row.subscription !== null && row.enabled === true && row.queueId !== null && row.consumers.length > 0);
  const outcomes = record
    ? recorded(provisioned.deliveryEvents, "not set up; the installer or the Setup screen does it")
    : delivery === undefined
    ? notAsked(connected.state === "done" ? "not read" : "needs the connection first")
    : delivery === null
      ? notAsked("delivery events could not be read through the grant")
      : observedRows.length > 0
        ? { state: "done" as const, detail: observedRows.map((row) => row.domain).join(", ") }
        : { state: "todo" as const, detail: delivery.length === 0 ? "nothing to subscribe yet" : delivery.map((row) => `${row.domain}: ${row.error ?? (row.subscription === null ? "no subscription" : row.enabled !== true ? "subscription not enabled" : row.queueId === null ? "no queue" : "no consumer on the queue")}`).join("; ") };

  return [
    { id: "address", label: "An address to receive at", ...address },
    { id: "routed", label: "Mail routed to this Node", ...routed },
    { id: "sending", label: "A domain onboarded for sending", ...sending },
    { id: "outcomes", label: "Delivery outcomes observed", ...outcomes },
    { id: "connected", label: "Connected to Cloudflare (optional: for changes from this screen)", ...connected },
  ];
}

const CHIP: Record<StepState, string> = { done: "verdict-ok", todo: "severity-degraded", unknown: "state-outcome_unknown", optional: "severity-report" };
const WORD: Record<StepState, string> = { done: "done", todo: "to do", unknown: "unknown", optional: "optional" };

/** The five steps and a count, at the top of Setup. Reads the grant-spending sources only once connected. */
export function OnboardingProgress({ binding, provisioned }: { binding: ProviderBinding; provisioned: Provisioned }) {
  const connected = binding.state === "consent_granted";
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
  // The optional connection is not counted: a Node is set up without it.
  const counted = steps.filter((step) => step.state !== "optional");
  const done = counted.filter((step) => step.state === "done").length;
  const next = counted.find((step) => step.state !== "done");
  return (
    <section className="onboarding" aria-label="Setup progress">
      <p className="dim">
        <span className="mono num">{done}</span> of <span className="mono num">{counted.length}</span> steps done
        {next === undefined ? "." : `; next: ${next.label.toLowerCase()}.`}
        {counted.length < steps.length ? " The fifth is optional." : ""}
      </p>
      <ol>
        {steps.map((step) => (
          <li key={step.id}>
            <span className={`state ${CHIP[step.state]}`}>{WORD[step.state]}</span>
            <span className="onboarding-label">{step.label}</span>
            <span className="dim onboarding-detail">{step.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * One line above every screen but Setup, while a step the shell can see cheaply is undone. It reads the
 * connection state, the audit trail's record and `doctor`, all cheap, and never the grant-spending sources:
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
    ? `${address.label.toLowerCase()} (${address.detail})`
    : routed.state === "todo" ? "mail is not routed to this Node yet" : null;
  if (said === null) return null;
  return (
    <p className="notice" role="status">
      Setup is unfinished: {said}.{" "}
      <Link to="/setup" className="linkish">go to Setup</Link>
    </p>
  );
}
