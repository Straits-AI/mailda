import type { DoctorCheck } from "@mailda/contract/schemas";

import type { DoctorReport } from "./api.ts";

/**
 * The health popover's rows: the doctor's findings, grouped into the six areas a person can act on.
 *
 * ## Why these six
 *
 * The memo drew five (inbound, outbound, worker, database, agent runtime). **"Agent runtime" names nothing
 * that exists**: agents are external principals (ADR 44), and what runs here is Butlers, so the row is
 * Automation. **Access and recovery is added**, because `recovery_escrow` (degraded on a Node whose recovery
 * codes were never confirmed) and the legal-hold and supervision checks can set the verdict, and a verdict no
 * row explains is a riddle. Keys sit under "Worker and keys" so a failing key never reads as the Worker
 * alone, and the evidence bucket and the indexes are where storage degrades, so it is "Database and storage".
 *
 * ## Why the mapping is a `Record`
 *
 * `HEALTH_AREA` is keyed by `DoctorCheck`, the contract's list of every name `runDoctor` emits, so a check
 * added to the doctor without a row here is a compile error rather than a finding that silently lands
 * nowhere. The wire stays a string: a newer Node's unknown name goes to "Other checks".
 */

export type HealthArea = "inbound" | "outbound" | "worker" | "storage" | "automation" | "access";

export const AREA_LABELS: Record<HealthArea, string> = {
  inbound: "Inbound routing",
  outbound: "Outbound delivery",
  worker: "Worker and keys",
  storage: "Database and storage",
  automation: "Automation",
  access: "Access and recovery",
};

/** The order the rows render in. */
const AREAS: readonly HealthArea[] = ["inbound", "outbound", "worker", "storage", "automation", "access"];

/** `null` = not a health area: `report_reduced` is rendered as the reduced-report note instead. */
export const HEALTH_AREA: Record<DoctorCheck, HealthArea | null> = {
  inbound_routing: "inbound",
  inbound_authentication: "inbound",

  outbox_draining: "outbound",
  transport_adapters: "outbound",
  send_breakers: "outbound",
  sending_events_consumer: "outbound",
  delivery_visibility: "outbound",
  delivery_attribution: "outbound",
  domain_paused: "outbound",
  send_evidence_changed: "outbound",

  workers_paid_plan: "worker",
  key_vault: "worker",
  signing_key: "worker",
  credential_key: "worker",
  provider_token: "worker",
  doctor_cost: "worker",

  catalog_reachable: "storage",
  migrations_applied: "storage",
  evidence_bucket_reachable: "storage",
  evidence_present: "storage",
  evidence_orphans: "storage",
  evidence_key_generation: "storage",
  draft_bodies_stranded: "storage",
  search_index_backlog: "storage",
  body_index_backlog: "storage",
  body_index_failed: "storage",
  preview_backlog: "storage",

  butler_execution: "automation",
  butler_paused: "automation",
  butler_run_silence: "automation",
  butler_loop_detection: "automation",
  agent_withdrawn_capabilities: "automation",

  legal_holds_active: "access",
  legal_hold_lift_pending: "access",
  legal_hold_mailbox_missing: "access",
  legal_hold_unliftable: "access",
  supervision_notice_missing: "access",
  supervision_notices_overdue: "access",
  supervision_notice_stranded: "access",
  self_granted_access: "access",
  recovery_escrow: "access",
  recovery_restore_state: "access",
  recovery_key_conflicts: "access",

  report_reduced: null,
};

/**
 * One row's state.
 *
 * - `refuse`, `degraded`, `report`: the worst severity among the area's **failing** findings.
 * - `ok`: every finding in the area passed, in a full report.
 * - `ok-visible`: every finding **this reader was shown** passed, in a reduced report. Not "ok": the member's
 *   report drops every `discloses: "data"` finding and keeps the full report's verdict (`withoutDataFindings`
 *   in `src/doctor.ts`), so a withheld failure in this area can be what made the verdict "degraded".
 * - `absent`: nothing in this area reached a reduced report ("not in your report").
 * - `none`: a full report has no check in this area ("no checks"). Never "ok": nothing was checked.
 */
export type HealthStatus = "ok" | "ok-visible" | "degraded" | "refuse" | "report" | "absent" | "none";

export interface HealthRow {
  area: HealthArea | "other";
  label: string;
  status: HealthStatus;
  /** How many of the area's findings are not ok. */
  failing: number;
}

const SEVERITY_RANK = { report: 1, degraded: 2, refuse: 3 } as const;

function areaOf(check: string): HealthArea | null | "other" {
  // `Object.hasOwn`, not `in`: a check named `constructor` from a future Node must not read the prototype.
  return Object.hasOwn(HEALTH_AREA, check) ? HEALTH_AREA[check as DoctorCheck] : "other";
}

function statusOf(findings: DoctorReport["findings"], reduced: boolean): HealthStatus {
  const failing = findings.filter((finding) => !finding.ok);
  if (failing.length > 0) {
    // `>` and `>=` pick the same word here, since equal ranks are the same severity: `mutants` reports that
    // widening as a survivor, and it is one by construction, not a gap in `health.test.tsx`.
    return failing.reduce((worst, finding) =>
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst] ? finding.severity : worst, failing[0]!.severity);
  }
  if (findings.length > 0) return reduced ? "ok-visible" : "ok";
  return reduced ? "absent" : "none";
}

export function healthRows(report: DoctorReport): { rows: HealthRow[]; reduced: boolean } {
  const reduced = report.findings.some((finding) => finding.check === "report_reduced");
  const byArea = new Map<HealthArea | "other", DoctorReport["findings"]>();
  for (const finding of report.findings) {
    const area = areaOf(finding.check);
    // `report_reduced` has no row (it is the note). Skipping it here changes nothing a reader sees, since no
    // row reads a null key, so `mutants` reports its removal as a survivor; it stays because it is what
    // narrows the key to an area for the map's type.
    if (area === null) continue;
    byArea.set(area, [...(byArea.get(area) ?? []), finding]);
  }
  const row = (area: HealthArea | "other", label: string): HealthRow => {
    const findings = byArea.get(area) ?? [];
    return {
      area, label, status: statusOf(findings, reduced), failing: findings.filter((finding) => !finding.ok).length,
    };
  };
  const rows = AREAS.map((area) => row(area, AREA_LABELS[area]));
  if (byArea.has("other")) rows.push(row("other", "Other checks"));
  return { rows, reduced };
}
