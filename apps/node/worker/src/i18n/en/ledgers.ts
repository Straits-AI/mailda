import type { Area } from "../areas.ts";

/**
 * The four ledgers (`src/client/app/screens/ledgers.tsx`): Outbox, Audit, Log and Doctor, and the Doctor's
 * remedies. The send and delivery vocabulary the Outbox shows is the `delivery` area's; the headings are the
 * routes' names (`route.*`); the Doctor's states are `health.status.*`.
 *
 * A count that governs a noun is a plural on `n` ("1 send", "2 sends"). A sentence with several counts is
 * assembled from one plural per count (`ledgers.collect.*`, `ledgers.evidence.checked`), never one plural over
 * two numbers (D10 to D12, `docs/i18n.md`). The Node's other counts are passed as strings: a number parameter is
 * grouped (`1,024`), and these were not.
 */
export const ledgers = {
  /** A table's time column, in every ledger. */
  "ledgers.col.at": "At",
  "ledgers.col.state": "State",
  "ledgers.col.subject": "Subject",
  "ledgers.col.message": "Message",
  /** `chrome.truncated`'s noun for the Audit and Log tables. */
  "ledgers.noun.entries": "entries",
  "ledgers.neverMind": "Never mind",
  /** A remedy's answer: the Node's count, then the Node's own sentence. */
  "ledgers.requeued": "{count} requeued. {message}",

  "ledgers.outbox.count": { one: "{n} send", other: "{n} sends" },
  "ledgers.outbox.noun": "sends",
  /**
   * D5 (`docs/i18n.md`): this said "Nothing has been sent from this Node yet", which reads the Outbox as a record
   * of what was sent, and nothing is ever recorded as sent at this scale (ADR 39). A state's note saying a send was
   * not sent is another matter, and is kept. The glossary binds this key to the Outbox row, so it must name the
   * Outbox in every locale.
   */
  "ledgers.outbox.empty": "The Outbox is empty.",
  "ledgers.outbox.daily.unmeasured":
    "{count} handed over today. Your daily limit is not published by Cloudflare; it will be recorded here the first time you hit it.",
  "ledgers.outbox.daily.throttled": "{count} handed over today. This Node was first rate-limited at {at}.",
  "ledgers.outbox.stop.failed": "It could not be stopped.",
  "ledgers.outbox.letGo.failed": "It could not be released.",
  /** `{reason}` is the Node's refusal code (`not_found`), or `api.refusal.code` when it sent none. */
  "ledgers.outbox.gate.failed":
    "{reason}: this send is no longer waiting on a Butler's gate, or you may not send as its mailbox. The outbox has been refreshed; if it is still listed, ask for send.propose on that mailbox.",
  "ledgers.outbox.resend.notice":
    "Resending {subject} mints a new message and may deliver it twice — the first attempt's outcome is unknown, not failed. Say why, for the trail:",
  "ledgers.outbox.resend.why": "Why resend",
  "ledgers.outbox.resend.anyway": "Resend anyway",
  "ledgers.outbox.col.to": "To",
  "ledgers.outbox.col.when": "When",
  "ledgers.outbox.col.submitted": "Submitted",
  "ledgers.outbox.noSubject": "(no subject)",
  "ledgers.outbox.letGo": "Let it go",
  "ledgers.outbox.release": "Release",
  "ledgers.outbox.release.title": "A Butler wrote this. Releasing it puts it in the ordinary hold window, where it can still be stopped.",
  "ledgers.outbox.stop": "Stop",
  "ledgers.outbox.retry": "Retry",
  "ledgers.outbox.resend": "Resend…",
  "ledgers.outbox.means": "What this means",
  "ledgers.outbox.why": "Why",
  "ledgers.outbox.recipients": "Recipients",
  "ledgers.outbox.manifest": "Manifest",
  "ledgers.outbox.reported": "Reported",
  /** A delivery chip on a send with more than one recipient: how many are in that state. */
  "ledgers.outbox.chip": "{n} {state}",
    /** `RecipientKind`, the envelope field an address was on. */
  "ledgers.outbox.kind.to": "to",
  "ledgers.outbox.kind.cc": "cc",
  "ledgers.outbox.kind.bcc": "bcc",

  "ledgers.audit.label": "Audit trail",
  "ledgers.audit.verify": "Verify chain",
  "ledgers.audit.intact": "{count} entries checked, chain intact.",
  "ledgers.audit.broken": "Chain broken at entry {entry}. {count} entries checked.",
  "ledgers.audit.empty": "No audited action has been taken on this Node yet.",
  "ledgers.audit.col.seq": "Seq",
  "ledgers.audit.col.action": "Action",
  "ledgers.audit.col.actor": "Actor",
  "ledgers.audit.col.outcome": "Outcome",
  /** `AUDIT_OUTCOMES`, an audit entry's outcome: the act happened, this Node refused it, or it failed. */
  "ledgers.audit.outcome.ok": "ok",
  "ledgers.audit.outcome.refused": "refused",
  "ledgers.audit.outcome.failed": "failed",
  /** A machine's entry: the agent, then the person accountable for it (`agt_… for usr_…`). */
  "ledgers.audit.actorFor": "{actor} for {delegator}",

  "ledgers.log.label": "Operational log",
  /** The Log table's scrolling region, named apart from its section so the two landmarks differ. */
  "ledgers.log.entries": "Log entries",
  /** One level's count in the Log's header, e.g. `3 error`. */
  "ledgers.log.count": "{count} {level}",
  "ledgers.log.counts.none": "empty",
  /** `LogLevel`. */
  "ledgers.log.level.error": "error",
  "ledgers.log.level.warn": "warn",
  "ledgers.log.level.info": "info",
  "ledgers.log.empty": "Nothing has been logged. This Node trims its log by design.",
  "ledgers.log.col.level": "Level",
  "ledgers.log.col.event": "Event",

  "ledgers.doctor.claimed": "claimed · read {at}",
  "ledgers.doctor.unclaimed": "unclaimed · read {at}",
  "ledgers.doctor.col.check": "Check",
  "ledgers.doctor.col.detail": "Detail",
  /** `{fix}` is the Node's own words for the remedy. */
  "ledgers.doctor.fix": "Fix: {fix}",

  "ledgers.transport.label": "Sending credentials",
  "ledgers.transport.through": "Sends go through {adapter}.",
  "ledgers.transport.binding":
    "The EMAIL binding is present and is preferred: it holds no credential, and it is the only adapter that can submit the exact bytes an authored send records.",
  "ledgers.transport.none": "There is no EMAIL binding and no API token, so this Node cannot send at all.",
  "ledgers.transport.rest":
    "There is no EMAIL binding, so reconstructed sends go over the REST API for account {account}. Authored sends are refused: that API builds its own MIME, so the bytes sent would not be the bytes recorded.",
  "ledgers.transport.account": "Cloudflare account id",
  "ledgers.transport.token": "Email Sending API token",
  /** `{permission}` is Cloudflare's own name for it, in mono, as its dashboard shows it. */
  "ledgers.transport.needs":
    "Needs the {permission} permission. It is encrypted on arrival and no route returns it — to change it, supply a new one.",
  "ledgers.transport.save": "Save credentials",

  "ledgers.migrations.apply": "Apply migrations",
  "ledgers.reseal.act": "Reseal a batch",
  "ledgers.reseal.done":
    "{resealed} resealed under generation {generation}, {current} already current, {failed} failed. {remaining} remaining — run it again until that reaches 0.",
  "ledgers.previews.requeue": "Requeue failed previews",
  "ledgers.collect.arm": "Collect them…",
  "ledgers.collect.warning":
    "This deletes every object the reconciler finds no referent for — orphaned raw mail past the grace period, stranded draft bodies and export residue. It is refused for the whole organization while a legal hold stands.",
  "ledgers.collect.act": "Delete them now",
  /** Three counts, so three plurals, filled into one sentence. */
  "ledgers.collect.done": "Deleted {orphans}, {drafts}, {exports}.",
  "ledgers.collect.orphans": { one: "{n} orphan", other: "{n} orphans" },
  "ledgers.collect.drafts": { one: "{n} draft body", other: "{n} draft bodies" },
  "ledgers.collect.exports": { one: "{n} export object", other: "{n} export objects" },
  "ledgers.conflict.restore": "Restore id",
  "ledgers.conflict.scope": "What was examined",
  "ledgers.conflict.conclusion": "What was concluded",
  "ledgers.conflict.act": "Record the assessment",
  "ledgers.conflict.done":
    "Recorded against {restoreId} (generations {generations}) at {at}. The collision is not repaired; the alarm is discharged.",
  "ledgers.codes.mint": "Mint a new set",
  "ledgers.codes.mintNote": "Ten codes, shown once. Confirming one retires any previous sheet.",
  "ledgers.codes.now": "Write these down now.",
  "ledgers.codes.label": "Recovery codes",
  "ledgers.codes.set":
    "Set {set}, carrying content key generation {content} and credential key generation {credential}. Put them somewhere that survives losing this computer and this Cloudflare account.",
  "ledgers.codes.saved": "I have saved these ten codes",
  "ledgers.codes.confirmOne": "Confirm one code",
  "ledgers.codes.confirm": "Confirm",
  "ledgers.codes.confirmNote": "Compared against the hash, never spent. Type it; nothing here fills it in for you.",
  "ledgers.search.none": "The failed list is empty now.",
  "ledgers.search.col.repair": "Repair",
  "ledgers.search.col.attempts": "Attempts",
  "ledgers.search.col.error": "Error",
  "ledgers.search.repairOne": "Repair {id}",
  /** `FailedIndexRow.state`. */
  "ledgers.search.state.retryable": "retryable",
  "ledgers.search.state.unindexable": "unindexable",
  "ledgers.search.advice": "Tick the ones worth retrying — fix the cause first.",
  "ledgers.search.requeue": { one: "Requeue {n} message", other: "Requeue {n} messages" },
  "ledgers.evidence.verify": "Verify a batch",
  "ledgers.evidence.continue": "Continue from where it stopped",
  /** A batch's verdict: what was read, then whether more remains. Two sentences, joined as the locale joins them. */
  "ledgers.evidence.verdict": "{head} {tail}",
  /** `{checked}` is `ledgers.evidence.checked` or `.checkedIn`, `{faults}` is `ledgers.evidence.faultCount`. */
  "ledgers.evidence.intact": "{checked}, {bytes} bytes read: intact.",
  "ledgers.evidence.faults": "{checked}, {bytes} bytes read: {faults}.",
  "ledgers.evidence.checked": { one: "{n} object checked", other: "{n} objects checked" },
  "ledgers.evidence.checkedIn": { one: "{n} object checked in {table}", other: "{n} objects checked in {table}" },
  "ledgers.evidence.faultCount": { one: "{n} fault", other: "{n} faults" },
  "ledgers.evidence.last": "That was the last batch.",
  "ledgers.evidence.more": "More remains.",
  /** One fault: its kind, where (`receipts.blob_key rcpt_7`), and the Node's words for it. */
  "ledgers.evidence.fault": "{kind} {table}.{column} {rowId}: {detail}",
  /** `EvidenceFault.kind`. */
  "ledgers.evidence.kind.missing": "missing",
  "ledgers.evidence.kind.unreadable": "unreadable",
  "ledgers.evidence.kind.altered": "altered",
} as const satisfies Area<"ledgers">;
