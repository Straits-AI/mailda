import type { ButlerPauseReason, ButlerVersionState } from "@mailda/contract/schemas";

import type { Area } from "../areas.ts";

/**
 * A version's state and a pause's reason, keyed by the contract's closed lists (`BUTLER_VERSION_STATES`,
 * `BUTLER_PAUSE_REASONS`; the owner's round three, G12). The English is the token as the screen showed it before.
 * A run's state is not here yet: it is shown in three places, one of them inside the Node's own line (layer 3).
 */
const tokens = {
  "butlers.version.draft": "draft",
  "butlers.version.published": "published",
  "butlers.version.superseded": "superseded",
  "butlers.pauseReason.loop_detected": "loop detected",
} as const satisfies Record<`butlers.version.${ButlerVersionState}` | `butlers.pauseReason.${ButlerPauseReason}`, string>;

/**
 * Butlers (`src/client/app/screens/butlers.tsx`): published versions, runs and pauses, the editor and its dry run.
 * The heading is the route's name (`route./butlers`).
 *
 * The Node's own words stay English inside `<NodeWords>` and are not here: a run's or a version's state, a run's
 * reason, a pause's detail, the dry run's outcomes and limits, the checker's findings. So are the program's
 * identifiers (node ids and types, `org.admin`, the source formats `yaml` and `json`). A new Butler's starter
 * source and its name ("new butler") are written into the Node as the Butler's own text, so they are data in
 * the author's hands and not the interface's words (`docs/i18n.md`, "Never persist a `t()` string as data").
 */
export const butlers = {
  ...tokens,
  "butlers.new": "New butler",
  "butlers.notAdmin": "No Butlers here, or you do not hold org.admin. Writing one is an administrator's act.",
  "butlers.empty": "Nothing is automated on this Node yet.",
  "butlers.col.name": "Name",
  "butlers.col.standing": "Standing",
  /** A column of the list and of the version history: when it was published. */
  "butlers.col.published": "Published",
  "butlers.col.draft": "Draft",
  "butlers.col.editor": "Editor",
  /** A column of the version history and of the runs: the Node's state token, shown as it came. */
  "butlers.col.state": "State",
  "butlers.unpublishedChanges": "unpublished changes",
  "butlers.open": "Open",
  /** `{run}` is the new run's id, in mono. */
  "butlers.startedAgain": "Started again as {run}.",

  /** `{reason}` is the pause's reason token, the Node's, with its underscores read as spaces. */
  "butlers.standing.paused": "paused — {reason}",
  "butlers.standing.live": "live · v{version}",
  "butlers.standing.draftOnly": "draft only, never published",

  "butlers.detail.label": "Butler {name}",
  "butlers.close": "Close",
  "butlers.format": "Format",
  "butlers.format.hint": "which parser reads the source below. Switching it does not rewrite your text",
  "butlers.source": "Source",
  "butlers.saveDraft": "Save draft",
  "butlers.publish": "Publish",
  "butlers.draft.none": "nothing saved yet",
  "butlers.draft.showingLive": "showing live v{version} — save a draft to change it",
  "butlers.draft.unpublished": "unpublished draft",

  "butlers.dry": "Dry run",
  "butlers.dry.notRun":
    "A dry run walks this program over what a real delivery gave a real run, and this Butler has not run yet. " +
    "Publish it and send it something, then come back — the walk below causes nothing, so it is safe to do " +
    "afterwards as often as you like.",
  "butlers.dry.explain":
    "Walks the draft — or the live version if there is no draft — over a past run’s input. Reads real rows and " +
    "asks the real authority questions; writes nothing.",
  /** A button per past run: `{at}` is when that run started. */
  "butlers.dry.over": "Dry run over {at}",
  "butlers.dry.noFacts": "That run recorded no trigger facts, so there is nothing to walk over. Pick a later run.",
  /** Which program the dry run walked: the draft, or a version. */
  "butlers.dry.draft": "draft",
  "butlers.dry.version": "v{version}",
  /** The program's nodes (the graph's steps, not this Node). */
  "butlers.dry.nodes": { one: "{n} node", other: "{n} nodes" },
  /** `{program}` is `butlers.dry.draft` or `.version`, `{nodes}` is `butlers.dry.nodes`, `{spend}` the subrequests. */
  "butlers.dry.summary": "{program} · {nodes} · would spend {spend}",
  "butlers.dry.noEffect": "No effect node was reached.",
  /** "would" is the outcome token the Node returns, which stays English in every locale. */
  "butlers.dry.caption":
    "“would” is a write this Node declined to make. Every other outcome is a real answer from a real read — the " +
    "same one a live run would have recorded.",
  "butlers.dry.col.node": "Node",
  "butlers.dry.col.type": "Type",
  "butlers.dry.col.outcome": "Outcome",
  "butlers.dry.col.detail": "Detail",

  "butlers.versions.caption": "Versions — publication is the versioning event, and a published one is frozen",
  "butlers.versions.col.version": "Version",
  "butlers.versions.col.by": "By",
  "butlers.versions.col.ast": "AST sha256",

  /** `{by}` is the detector that placed the pause (`loop-detector`), `{at}` when. */
  "butlers.pause.placed": "placed by {by} · {at}",
  "butlers.pause.why": "Why is it safe to resume?",
  "butlers.pause.resume": "Resume",

  "butlers.runs": "Runs",
  "butlers.runs.none": "No Butler has run yet. A run comes from a delivery.",
  /**
   * `{again}` is `butlers.runs.again`, emphasised: the button this sentence explains. One literal, not a `+` chain,
   * because a joined string's type is `string` and its placeholder would not be typed.
   */
  "butlers.runs.explain":
    "{again} starts a new run of the same published version over what this run was given, judged under today’s rules. Its effects are real; any send it proposes waits in the outbox until a person releases it, so nothing leaves this Node by itself.",
  "butlers.runs.again": "Run again",
  "butlers.runs.col.started": "Started",
  "butlers.runs.col.why": "Why it ended",
  "butlers.runs.col.nodes": "Nodes",
  "butlers.runs.col.effects": "Effects",
  "butlers.runs.col.refusals": "Refusals",
  "butlers.runs.col.spent": "Spent",
  "butlers.runs.col.again": "Again",
} as const satisfies Area<"butlers">;
