import type { DoctorCheck } from "@mailda/contract/schemas";

/**
 * The Doctor's check titles (`src/client/app/screens/ledgers.tsx`), keyed by the check's name (`DOCTOR_CHECKS`):
 * a title is this interface's name for what the check looks at, shown above the check's own name in mono. The
 * finding's `detail` and `fix` stay the Node's English, in `<NodeWords>`, as does `doctor?format=text` and the CLI
 * (ADR 46), and a name a newer Node emits and this interface does not know is shown as the name alone.
 *
 * Neutral nouns, not verdicts: the title sits beside a state that may be ok or failing, so "Paused domains" is
 * right in both and "No domain is paused" in one.
 */
export const doctor = {
  "doctor.check.agent_withdrawn_capabilities": "Agents holding withdrawn capabilities",
  "doctor.check.body_index_backlog": "Body search index backlog",
  "doctor.check.body_index_failed": "Bodies the search index failed on",
  "doctor.check.body_index_partial": "Bodies indexed in part",
  "doctor.check.butler_execution": "How Butlers run",
  "doctor.check.butler_loop_detection": "Butler loop detection",
  "doctor.check.butler_paused": "Paused Butlers",
  "doctor.check.butler_run_silence": "Butlers that are not running",
  "doctor.check.catalog_reachable": "Catalog database",
  "doctor.check.credential_key": "Credential key",
  "doctor.check.delivery_attribution": "Delivery event attribution",
  "doctor.check.delivery_explanation_void": "Evidence against explained silence",
  "doctor.check.delivery_visibility": "Delivery outcomes",
  "doctor.check.doctor_cost": "This report's cost",
  "doctor.check.domain_paused": "Paused domains",
  "doctor.check.draft_bodies_stranded": "Stranded draft bodies",
  "doctor.check.evidence_bucket_reachable": "Evidence bucket",
  "doctor.check.evidence_key_generation": "Evidence key generation",
  "doctor.check.evidence_orphans": "Orphaned evidence",
  "doctor.check.evidence_present": "Evidence present",
  "doctor.check.inbound_authentication": "Inbound authentication",
  "doctor.check.inbound_routing": "Inbound routing",
  "doctor.check.kept_forwards": "Kept forwards",
  "doctor.check.key_vault": "Key vault",
  "doctor.check.legal_hold_lift_pending": "Legal hold lifts waiting for approval",
  "doctor.check.legal_hold_mailbox_missing": "Legal holds on missing mailboxes",
  "doctor.check.legal_holds_active": "Legal holds in force",
  "doctor.check.legal_hold_unliftable": "Legal holds nobody can lift",
  "doctor.check.migrations_applied": "Database migrations",
  "doctor.check.outbox_draining": "Outbox draining",
  "doctor.check.preview_backlog": "Message preview backlog",
  "doctor.check.provider_token": "Cloudflare API token",
  "doctor.check.recovery_escrow": "Recovery escrow",
  "doctor.check.recovery_key_conflicts": "Restores that collided with a live key",
  "doctor.check.recovery_restore_state": "Vault restore",
  "doctor.check.report_reduced": "Reduced report",
  "doctor.check.search_index_backlog": "Search index backlog",
  "doctor.check.self_granted_access": "Self-granted access",
  "doctor.check.send_breakers": "Send breakers",
  "doctor.check.send_evidence_changed": "Sends withheld for changed evidence",
  "doctor.check.sending_events_consumer": "Delivery events consumer",
  "doctor.check.signing_key": "Signing key",
  "doctor.check.supervision_notice_missing": "Missing supervision notices",
  "doctor.check.supervision_notices_overdue": "Overdue supervision notices",
  "doctor.check.supervision_notice_stranded": "Stranded supervision notices",
  "doctor.check.transport_adapters": "Sending transports",
  "doctor.check.workers_paid_plan": "Workers Paid plan",
} as const satisfies Record<`doctor.check.${DoctorCheck}`, string>;
