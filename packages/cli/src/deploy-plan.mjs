/**
 * What a deploy would do to this account, before it does any of it (#162 L1, ADR 42).
 *
 * ## Why a plan needs three verbs and not one
 *
 * `mailda deploy` already works. What it cannot do is *say what it is about to do* — and #92's drill measured
 * three reasons that matters, every one of which makes a create-only plan wrong:
 *
 * **1. Auto-provisioning creates or fails and never adopts.** It will not reuse an existing `mailda-catalog`,
 * and it fails *after* creating whatever came before it in the list. Three attempts each died on the next
 * resource — D1, then R2, then the queue — each leaving behind what the previous had made
 * (`deploy-drill-live-account.md`, `temporary-account-provisioning.md`). So a plan that can only say *"create
 * these three"* is wrong from the second attempt onwards, which is the common case after any failure.
 *
 * **2. A deleted D1 is never re-provisioned by a deploy.** The binding is linked server-side — Cloudflare's
 * own changelog says resources *"stay linked across future deploys even without adding the resource IDs"* — so
 * the Worker keeps reading a dead id while the CLI resolves the same name to a live one. Any flow that treats
 * *"deploy again"* as a repair **reports success and changes nothing**. A plan has to be able to say that.
 *
 * **3. Teardown is an ordered sequence, and every step of the order was found by getting it wrong.** A Worker
 * cannot be deleted while it consumes a queue (`code: 10064`); a non-empty R2 bucket refuses; and a Workflow
 * survives its script's deletion, which matters most because the Workflow name is the one resource name that
 * does not derive from the Worker's (#99).
 *
 * So: **create** for what is absent, **adopt** for what is present — which the platform will not do, so the
 * plan says what to delete instead — and **unwind** for the order to delete it in.
 *
 * ## Pure, for `promotionVerdict`'s reason
 *
 * Every function here takes values and returns values. The gate this file's sibling replaced was an inline
 * `if` asserted *lexically*, and the assertion survived the condition being mutated to `if (false && …)` —
 * which disables it completely. A decision that can be called with inputs and checked against outputs cannot
 * fail that way. Reading the account is the caller's job; deciding what it means is this file's.
 */

/**
 * Every resource a deploy of this config would touch, read from `wrangler.jsonc` rather than restated.
 *
 * ## The names are derived, because wrangler derives them
 *
 * `d1_databases`, `r2_buckets` and `queues` in this repository declare a **binding and no name and no id** —
 * ADR 24 requires the repository byte-identical across installs, so an account-specific id in committed
 * config is exactly the collision it forbids. wrangler therefore auto-provisions them and names them
 * `<worker>-<binding>` with the binding lowercased and underscores hyphenated.
 *
 * That rule is **measured, not assumed**: the drill's Node called `mailda` got `mailda-catalog`,
 * `mailda-evidence` and `mailda-sending-events`, and a second Node called `mailda2` got `mailda2-catalog`,
 * `mailda2-evidence` and `mailda2-sending-events`. Deriving it here rather than hardcoding three strings is
 * what makes a plan correct for a Node somebody renamed.
 *
 * **The Workflow is the exception, and it is the whole of #99.** Its name is written in the config —
 * `mailda-butler-runs` — so it does *not* derive from the Worker's name, and a Workflow is owned by exactly
 * one script. A second Node deploying with that name in its config **succeeded, exit 0, with no warning**,
 * and the ownership moved. `derived: false` is how the plan knows to ask who owns it rather than assuming
 * nobody does.
 */
export function resourcesFrom(configText) {
  const config = parseJsonc(configText);
  const worker = config.name;
  if (typeof worker !== "string" || worker === "") {
    throw new Error(
      "E_PLAN_NO_WORKER_NAME  wrangler.jsonc declares no `name`\n"
      + "  why  every auto-provisioned resource is named after the Worker, so without it a plan cannot say "
      + "which D1, bucket or queue a deploy would reach for",
    );
  }

  /** `CATALOG` -> `mailda-catalog`. wrangler's own rule, measured against the drill's two Nodes. */
  const derive = (binding) => `${worker}-${binding.toLowerCase().replaceAll("_", "-")}`;

  const resources = [];
  for (const one of config.d1_databases ?? []) {
    resources.push({
      kind: "d1",
      binding: one.binding,
      // A declared `database_name` wins, because then wrangler is not deriving anything.
      name: one.database_name ?? derive(one.binding),
      derived: one.database_name === undefined,
    });
  }
  for (const one of config.r2_buckets ?? []) {
    resources.push({
      kind: "r2",
      binding: one.binding,
      name: one.bucket_name ?? derive(one.binding),
      derived: one.bucket_name === undefined,
    });
  }
  for (const one of config.queues?.producers ?? []) {
    resources.push({
      kind: "queue",
      binding: one.binding,
      name: one.queue ?? derive(one.binding),
      derived: one.queue === undefined,
    });
  }
  for (const one of config.workflows ?? []) {
    resources.push({
      kind: "workflow",
      binding: one.binding,
      name: one.name,
      /*
       * Always false, and stated as a fact about the config rather than about this resource kind: a Workflow
       * entry **requires** a name, so there is nothing for wrangler to derive. That is the asymmetry #99 is.
       */
      derived: false,
    });
  }
  return { worker, resources };
}

/**
 * `wrangler.jsonc` without its comments.
 *
 * Comments stripped and then `JSON.parse`, rather than the `/"name"\s*:\s*"([^"]+)"/` this repository's
 * deploy path uses elsewhere. The regex reads the *first* `"name"` in the file, and this config has five —
 * the Worker's, the Workflow's, two Durable Object bindings' and the `send_email` binding's. It happens to
 * work because the Worker's is first, which is a property of the file's ordering rather than of the config,
 * and reordering `wrangler.jsonc` would silently make a plan describe the wrong Worker.
 *
 * Trailing commas are **not** handled. JSONC permits them, `JSON.parse` does not, and stripping them with a
 * regex means writing a JSON tokeniser badly — so a config carrying one fails loudly here rather than
 * producing a plan built from a partial parse.
 */
function parseJsonc(text) {
  const withoutComments = text
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
  try {
    return JSON.parse(withoutComments);
  } catch (cause) {
    throw new Error(
      `E_PLAN_UNREADABLE_CONFIG  wrangler.jsonc could not be parsed: ${String(cause)}\n`
      + "  why  a plan describes what a deploy would do, and one built from a partial parse would describe "
      + "resources this config does not declare\n"
      + "  fix  check for a trailing comma, which JSONC allows and this parser deliberately does not",
    );
  }
}

/**
 * What a `wrangler … list` table said, as presence facts.
 *
 * ## Substring matching, and why that is right here rather than lazy
 *
 * These four commands have **no `--json`** — checked against wrangler 4.118.0, where `d1 list`,
 * `r2 bucket list`, `queues list` and `workflows list` all print a table and none accepts the flag. So the
 * only thing available is the text, and the question being asked of it is narrow: *does a resource with this
 * exact name appear*.
 *
 * The names are matched with word-ish boundaries rather than bare `includes`, because
 * `mailda-catalog` is a substring of `mailda-catalog-2` and a plan that confused the two would report a
 * resource as present when the deploy would create it. This is the same failure the runbook's teardown check
 * exists for: *"`wrangler d1 list` … should each show nothing named `mailda`"*, which is true of a leftover
 * and of a lookalike.
 *
 * `null` for a list that could not be read, which is **not** the same as an empty list. A missing permission
 * or a failed call means the plan does not know, and reporting "absent, will create" from an unread list is
 * how a plan promises a create that fails on a leftover.
 */
export function presenceIn(listText, name) {
  if (listText === null || listText === undefined) return null;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeForPattern(name)}([^A-Za-z0-9_-]|$)`, "m");
  return pattern.test(listText);
}

function escapeForPattern(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which script owns a Workflow, from `wrangler workflows list`.
 *
 * The row is `│ <name> │ <script> │ …`, matched on the Workflow's own name so a second unrelated Workflow in
 * the account cannot be mistaken for this one. Lifted from `refuseIfWorkflowBelongsElsewhere` in
 * `mailda.mjs`, which found this format against the live account during the drill — so the format is measured
 * and the two now read it the same way instead of twice.
 *
 * `null` when the list could not be read or the Workflow is not in it. A caller must not read that as
 * *nobody owns it*: the whole finding is that deploying over somebody else's Workflow does not refuse, it
 * reassigns, so an unknown owner is a reason to say so rather than to proceed.
 */
export function workflowOwnerIn(listText, name) {
  if (listText === null || listText === undefined) return null;
  const row = listText.split("\n").find((line) => line.includes(name));
  if (row === undefined) return null;
  const cells = row.split("│").map((cell) => cell.trim()).filter(Boolean);
  return cells[1] ?? null;
}

/**
 * The five dispositions a resource can be in, and what each one costs an operator who is told the wrong one.
 *
 * | disposition | the account | what a deploy does |
 * |:--|:--|:--|
 * | `create` | absent | provisions it. The only case a create-only plan describes correctly |
 * | `linked` | present, bound to this Worker | nothing. A redeploy of a working Node |
 * | `cannot_adopt` | present, no Worker to be bound to | **fails**, after creating whatever came before it |
 * | `orphaned` | absent, and the Worker exists | **reports success and changes nothing** |
 * | `stolen` | present, owned by another script | **succeeds and takes it**, silently |
 * | `unknown` | could not be read | anything. The plan says so rather than guessing |
 */
export function dispositionOf({ resource, installed, present, owner, workerName }) {
  if (present === null) return "unknown";

  if (resource.kind === "workflow") {
    /*
     * Checked before presence, because for a Workflow *who owns it* is the question and presence is only how
     * the question arises. The measured failure is not a refusal — the second Node's deploy exited 0 with no
     * warning and the ownership moved — so a plan that only reported "present" would describe a create.
     */
    if (present && owner !== null && owner !== workerName) return "stolen";
    if (present && owner === null) return "unknown";
    if (present) return "linked";
    return "create";
  }

  if (installed) return present ? "linked" : "orphaned";
  return present ? "cannot_adopt" : "create";
}

/**
 * The order a teardown has to happen in, and the reason each step is where it is.
 *
 * Every one of these was found by getting it wrong (`docs/disaster-recovery.md`). The order is declared as
 * data rather than written as a sequence of calls so a plan can *filter* it — a leftover D1 on an account
 * with no Worker needs three of these steps and not six, and printing the other three would tell an operator
 * to delete a Worker that is not there.
 */
export const UNWIND_ORDER = [
  {
    step: "queue-consumer",
    /** `code: 10064`. The Worker cannot be deleted while it consumes a queue. */
    why: "a Worker cannot be deleted while it consumes a queue (code: 10064)",
  },
  {
    step: "worker",
    why: "the script itself, once nothing holds it",
  },
  {
    step: "r2",
    /** A non-empty bucket refuses, so the objects go first. */
    why: "the objects first, because a non-empty bucket refuses to be deleted",
  },
  {
    step: "d1",
    why: "auto-provisioning never adopts, so a leftover database breaks the next attempt",
  },
  {
    step: "queue",
    why: "same reason as the database, and after the consumer that read it is gone",
  },
  {
    step: "workflow",
    /*
     * Last, and the only step whose *necessity* is a measurement rather than an ordering: a Workflow survives
     * its script's deletion and keeps pointing at a script that no longer exists. It is also the one name
     * that collides between Nodes, so leaving it behind leaves the name taken.
     */
    why: "a Workflow survives its script's deletion, and its name is the one that collides between Nodes",
  },
];

/**
 * What a deploy would do, and whether it should be allowed to.
 *
 * The verdict is derived from the dispositions rather than tracked alongside them, so it cannot disagree with
 * the list it summarises — the failure `budget-plan-scope.test.ts` and the tier table in
 * `machine-surfaces.md` both exist to catch, which is a count in a document that stopped matching its code.
 */
export function planFor({ configText, inventory }) {
  const { worker, resources } = resourcesFrom(configText);
  const installed = inventory.worker;

  const items = resources.map((resource) => {
    const listText = inventory.lists[resource.kind];
    const present = presenceIn(listText, resource.name);
    const owner = resource.kind === "workflow" ? workflowOwnerIn(listText, resource.name) : null;
    return {
      ...resource,
      present,
      owner,
      disposition: dispositionOf({ resource, installed, present, owner, workerName: worker }),
    };
  });

  const blocking = items.filter(
    (one) => one.disposition === "cannot_adopt"
      || one.disposition === "orphaned"
      || one.disposition === "stolen",
  );

  /*
   * `unknown` does not block, and that is the same trade `refuseIfWorkflowBelongsElsewhere` makes: a plan
   * refusing because a *diagnostic* was unavailable is the wrong direction, and a plan that names what went
   * unchecked is the right one. It is reported in `unread` and printed.
   */
  const unread = items.filter((one) => one.disposition === "unknown");

  return {
    worker,
    /*
     * `installed === null` means the Worker's own existence could not be established, and that **does** block
     * — unlike the resource lists. `mailda deploy` branches on it: a first install deploys directly and every
     * later deploy takes the canary path, so being wrong here means skipping the canary on a live Node. The
     * deploy path already draws this line for the same reason.
     */
    verdict: installed === null
      ? "unknown"
      : blocking.length > 0
        ? "blocked"
        : installed ? "redeploy" : "install",
    installed,
    items,
    unread,
    unwind: unwindFor({ items, installed, worker }),
  };
}

/**
 * The steps that would clear this account, in order, with only the ones that apply.
 *
 * Filtered rather than printed whole: a leftover database on an account with no Worker needs the database and
 * the queue removed and nothing else, and telling an operator to delete a Worker that is not there is how a
 * runbook loses the reader's trust in the steps that *are* necessary.
 */
export function unwindFor({ items, installed, worker }) {
  const leftovers = items.filter((one) => one.disposition === "cannot_adopt" || one.disposition === "stolen");
  if (leftovers.length === 0) return [];

  const kinds = new Set(leftovers.map((one) => one.kind));
  const named = (kind) => leftovers.find((one) => one.kind === kind)?.name ?? null;

  return UNWIND_ORDER.flatMap((entry) => {
    switch (entry.step) {
      case "queue-consumer":
        /*
         * Only when there is both a Worker holding the consumer and a queue to detach from it. The command
         * needs **both** names — `wrangler queues consumer worker remove <queue> <worker>` — which is why
         * this step carries a pair where every other carries one name.
         */
        return installed === true && kinds.has("queue")
          ? [{ ...entry, target: named("queue"), consumer: worker, kind: "queue-consumer" }]
          : [];
      case "worker":
        return installed === true ? [{ ...entry, target: null, kind: "worker" }] : [];
      default:
        return kinds.has(entry.step) ? [{ ...entry, target: named(entry.step), kind: entry.step }] : [];
    }
  });
}

/**
 * What each disposition means, in the words an operator needs rather than the enum's.
 *
 * Three of the six say a deploy does something **other than what it looks like it does**, and that is the
 * whole reason this text exists rather than the disposition name alone. `cannot_adopt` printed as
 * "cannot_adopt" tells an operator nothing; printed as *"the deploy will NOT reuse this — it fails on it,
 * after creating whatever comes before it"* it tells them why they are about to lose ten minutes.
 */
export const DISPOSITION_SAYS = {
  create: "absent — the deploy provisions it",
  linked: "present and bound to this Worker — nothing to do",
  cannot_adopt:
    "PRESENT, and there is no Worker. Auto-provisioning creates or fails and never adopts, so the deploy "
    + "will NOT reuse this — it fails on it, after creating whatever comes before it",
  orphaned:
    "MISSING, and the Worker exists. The binding is linked server-side, so deploying again reports success "
    + "and changes nothing while the Worker keeps reading a resource that is gone",
  stolen:
    "PRESENT and owned by another Worker. Deploying takes it — exit 0, no warning — and the other Node "
    + "keeps a binding pointing at a Workflow now running this Node's code",
  unknown: "could not be read, so this line is a gap rather than an answer",
};

/**
 * The exact command for each unwind step, so an operator copies rather than reconstructs.
 *
 * `r2` is two commands because a non-empty bucket refuses, and the object delete is per key — which is a
 * limit of the teardown rather than of this renderer, and printing one command that does not work would be
 * worse than printing two that do.
 */
export const COMMAND_FOR = {
  "queue-consumer": (step) => `wrangler queues consumer worker remove ${step.target} ${step.consumer}`,
  worker: () => 'wrangler delete --env "" --force',
  r2: (step) => `wrangler r2 object delete ${step.target}/<key> --remote   # per key, then:\n`
    + `        wrangler r2 bucket delete ${step.target}`,
  d1: (step) => `wrangler d1 delete ${step.target} -y`,
  queue: (step) => `wrangler queues delete ${step.target}`,
  workflow: (step) => `wrangler workflows delete ${step.target}`,
};

/**
 * The plan as text, returned rather than printed.
 *
 * ## Why this is here and not in `mailda.mjs`
 *
 * `mailda.mjs` dispatches on `process.argv` at the top level, so importing it *runs* it — this repository's
 * own note, and the reason `deploy-parse.mjs` exists at all. The first draft of this renderer was in that
 * file and therefore untestable, which is the wrong place for it: **the words are the deliverable of
 * `--plan`.** A plan whose figures are right and whose sentences say the opposite is a plan an operator acts
 * wrongly on, and that is a failure only a test over the text can catch.
 */
/**
 * Greedy word wrap, so a disposition's sentence does not run off the terminal.
 *
 * Three of the six sentences are long because they have to be — they say what a deploy does *instead* of what
 * it appears to do — and an operator scanning a plan for the `!` lines is exactly the reader who will not
 * follow a sentence that wrapped at a random column.
 */
function wrapped(text, width) {
  const lines = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current !== "") lines.push(current);
  return lines;
}

export function renderPlan(plan) {
  const out = [];
  out.push(`\n== plan for the Worker \`${plan.worker}\`\n`);
  out.push(
    plan.verdict === "unknown"
      ? "   Cannot say. This account's Worker state could not be established, and the two deploy paths"
        + " differ.\n"
      : plan.verdict === "install"
        ? "   A first install. Nothing here yet, so the deploy runs directly — no previous version to"
          + " protect.\n"
        : plan.verdict === "redeploy"
          ? "   A redeploy. Everything is in place, so the deploy uploads a canary and checks it before"
            + " moving traffic.\n"
          : "   BLOCKED. What a deploy would do here is not what it looks like it would do.\n",
  );

  out.push("\n   create / adopt\n");
  for (const item of plan.items) {
    const benign = item.disposition === "create" || item.disposition === "linked";
    out.push(`     ${benign ? " " : "!"} ${item.kind} \`${item.name}\`\n`);
    for (const line of wrapped(DISPOSITION_SAYS[item.disposition], 88)) out.push(`         ${line}\n`);
    if (item.owner !== null && item.owner !== undefined) out.push(`         owner: ${item.owner}\n`);
  }

  if (plan.unread.length > 0) {
    out.push(`\n   not checked: ${plan.unread.map((one) => one.kind).join(", ")}\n`);
    out.push(
      "     A list this account would not return. Named rather than assumed empty, because a plan that\n"
      + '     reported "absent, will create" from an unread list would promise a create that fails.\n',
    );
  }

  if (plan.unwind.length === 0) {
    out.push("\n   unwind: nothing to remove.\n");
  } else {
    out.push("\n   unwind — in this order, because the platform refuses out of order\n");
    for (const [index, step] of plan.unwind.entries()) {
      out.push(`     ${index + 1}. ${COMMAND_FOR[step.kind](step)}\n         ${step.why}\n`);
    }
    out.push(
      "\n     Then deploy again. Not `wrangler deploy` as a repair: for an orphaned binding it changes\n"
      + "     nothing, which is why that case offers no unwind at all.\n",
    );
  }

  /*
   * The plan says what is unmeasured about itself, in the same place as the answers. #162 requires a plan
   * correct on a **second** attempt, and the honest limit is that this reads names rather than ids.
   */
  out.push(
    "\n   This plan reads resource *names*, not ids. It cannot see whether a present resource is the one\n"
    + "   this Worker's binding points at — only whether the name is taken. For an orphaned binding that\n"
    + "   distinction is the whole defect, which is why it is reported as one rather than as a create.\n",
  );
  return out.join("");
}
