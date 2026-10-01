import type { Area } from "../areas.ts";

/**
 * Approvals (`src/client/app/screens/approvals.tsx`): what is waiting on you, by subject kind. Its heading is the
 * route's name, `route./approvals`. Each kind's words are keyed by its token (`approvals.kind.<subjectKind>.*`);
 * a refusal is the Node's, in `<NodeWords>`, and a requester's reason is theirs, shown as written.
 */
export const approvals = {
  "approvals.waiting": { one: "{n} waiting on you", other: "{n} waiting on you" },
  "approvals.empty": "Nothing is waiting on you to decide.",

  "approvals.kind.send_manifest.title": "A message waiting to go out",
  // D1: the UI word for a policy is "rule" (Rules, 规则).
  "approvals.kind.send_manifest.what": "A rule asked for a second pair of eyes before this leaves.",
  "approvals.kind.hold_lift.title": "Lifting a legal hold",
  "approvals.kind.hold_lift.what": "Approving this ends the hold, and the mail it preserved becomes deletable again.",
  "approvals.kind.supervised_read.title": "Reading somebody else's mail",
  "approvals.kind.supervised_read.what":
    "Approving this lets the requester read a mailbox they hold no standing relation to. The person whose mailbox it is will be told when the matter closes (§7).",
  "approvals.kind.ediscovery_export.title": "Exporting mail out of this Node",
  "approvals.kind.ediscovery_export.what": "Approving this produces a copy of matching mail that leaves the system's own controls.",
  // D3: a domain is paused, never stopped (one verb).
  "approvals.kind.domain_pause.title": "Pausing a domain's mail",
  "approvals.kind.domain_pause.what": "Approving this pauses every message to that domain until somebody lifts the pause.",

  "approvals.subject": "Subject",
  "approvals.askedBy": "Asked by",
  "approvals.asked": "Asked",
  "approvals.lapses": "Lapses",
  "approvals.noLapse": "does not lapse",
  "approvals.needs": "Needs",
  "approvals.needs.one": "one approval needed",
  "approvals.needs.single": { one: "{n} approval needed", other: "{n} approvals needed" },
  "approvals.needs.staged": {
    one: "stage {stage} of {stages} · {n} approval in total",
    other: "stage {stage} of {stages} · {n} approvals in total",
  },
  "approvals.supervised.matter": "scope {scope} · subject {subject} · matter {matter}",
  "approvals.supervised.noMatter": "scope {scope} · subject {subject} · no matter cited",
  "approvals.domain": "domain {domain}",

  "approvals.decided": "You have decided this.",
  "approvals.takeBack": "Take my decision back",
  "approvals.approve": "Approve",
  "approvals.deny": "Deny",
} as const satisfies Area<"approvals">;
