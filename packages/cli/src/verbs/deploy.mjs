import { doctor } from "./doctor.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { activeVersionFrom, contractingAmong, deployExitCode, promotionVerdict, servedVersionOf, versionIdFrom } from "../deploy-parse.mjs";
import { planFor, renderPlan, resourcesFrom as resourcesFromConfig } from "../deploy-plan.mjs";
import { workerDir, fail, capture, run, flag, sessionCookie, doctorReport, ENV, runPreflight } from "../support.mjs";
/**
 * Whether this account has no `mailda` Worker yet.
 *
 * **Found by running the drill, not by reading**, and it broke the sequence this file shipped with. On a
 * fresh account:
 *
 *   - `wrangler d1 migrations apply` fails with *"Couldn't find an auto-provisioned D1 DB named
 *     'mailda-catalog' … Run 'wrangler deploy' to provision it"*, because `wrangler.jsonc` declares its D1
 *     and R2 bindings with **no ids and no names** — ADR 24 requires the repository to be byte-identical
 *     across installs, so the resources are provisioned from the deploy;
 *   - and `wrangler versions upload` fails with *"You cannot upload a new version of a Worker that does not
 *     yet exist"*.
 *
 * So neither of the first two steps of the expand-canary-check-shift sequence can run first on a new Node,
 * and the sequence as shipped would have failed every customer's very first deploy. A plain `wrangler
 * deploy` is the only thing that can go first — and it is *safe* there for the reason the canary exists:
 * there is no previous version to protect and no user to serve a broken one to.
 *
 * ## Ambiguity refuses rather than guesses
 *
 * A network failure would also make this probe fail, and treating that as "first install" would send an
 * **existing** Node down the direct-deploy path — skipping the canary, on a Node with users. So only
 * wrangler's own words for absence count; anything else stops the command.
 */
function firstInstall() {
  // Quiet, by `capture`'s own rule: this is a question — is there a Worker — and the answer is one word
  // below. Echoing every version ever uploaded above the plan was fifteen entries a person scrolled past.
  const probe = capture("npx", ["wrangler", "versions", "list", ...ENV], { quiet: true });
  if (probe.status === 0) return false;
  if (/does not yet exist|workers\.api\.error\.script_not_found|\[code: 10007\]/i.test(probe.text)) return true;
  fail(
    "could not tell whether this account already has a Mailda Worker.\n\n"
    + "  why      the two paths differ: a first install deploys directly, and every later one uploads a\n"
    + "           canary and checks it before moving traffic. Guessing wrong on an existing Node would\n"
    + "           skip the check, so this refuses rather than picks.\n"
    + "  fix      check `wrangler whoami` and CLOUDFLARE_ACCOUNT_ID, then re-run. wrangler said:\n"
    + `           ${probe.text.trim().split("\n").slice(-3).join(" ")}`,
  );
  return true;
}


/**
 * Refuses to deploy if this account's Butler Workflow already belongs to another Worker (#99).
 *
 * ## The theft this stops, measured rather than supposed
 *
 * Every other resource a Node provisions derives its name from the Worker's, so a second Node collides with
 * nothing — `mailda2-catalog`, `mailda2-evidence`, `mailda2-sending-events`. The Workflow's name is written
 * in `wrangler.jsonc` because Cloudflare **requires** it on the binding, and a Workflow is owned by exactly
 * one script.
 *
 * Drilled on a live account (`deploy-drill-live-account.md`): deploying a second Node beside the first
 * **succeeded, exit 0, no warning**, and ownership of `mailda-butler-runs` moved from `mailda` to `mailda2`.
 * The first Node kept a binding pointing at a Workflow now served by the second Node's code against the
 * second Node's bindings — a cross-Node execution path into another organization's D1. It does not refuse;
 * it reassigns.
 *
 * ## Why here as well as in a test
 *
 * `test/node/workflow-name-world.test.ts` holds the naming rule for this repository. It cannot help an
 * operator who edits `wrangler.jsonc`, changes the Worker name, forgets the Workflow, and runs `mailda
 * deploy` without running a suite. This check asks the **account** rather than the file, so it sees who
 * actually owns the Workflow rather than what the config intends.
 *
 * Not fatal when the answer cannot be read. `wrangler workflows list` needs a permission a deploy token may
 * not carry, and refusing every deploy because a *diagnostic* was unavailable is the wrong trade — a warning
 * that names what went unchecked is. The reverse of `firstInstall`, deliberately: there, being wrong means
 * skipping the canary on a live Node, so ambiguity stops the command.
 */
function refuseIfWorkflowBelongsElsewhere() {
  const config = readFileSync(resolve(workerDir, "wrangler.jsonc"), "utf8");
  const workerName = /"name"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? null;
  const workflowName = /"workflows"[\s\S]{0,400}?"name"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? null;
  if (workerName === null || workflowName === null) return;

  /*
   * **The config's own consistency, checked before the account's.** `workflow-name-world.test.ts` holds this
   * rule, and it only runs when somebody runs the suite — which an operator standing up a second Node in
   * their own account has no reason to do. They edit `name`, deploy, and the Workflow silently moves.
   *
   * One comparison, here, because both values are already parsed. Refusing beats warning: the measured
   * failure is that deploying over another Node's Workflow does not refuse, it **reassigns**.
   */
  if (workflowName !== `${workerName}-butler-runs`) {
    fail(
      `refusing to deploy: this config deploys the Worker \`${workerName}\` and names its Workflow\n`
      + `\`${workflowName}\`.\n\n`
      + "  why      every other resource a Node provisions derives its name from the Worker's, so a second\n"
      + "           Node in one account collides with nothing. A Workflow's name is written in the config\n"
      + "           because Cloudflare requires it on the binding, and a Workflow is owned by exactly one\n"
      + "           script — so a name that does not follow the Worker's is a name some other Node may\n"
      + "           already hold, and deploying would take it without saying so (#99).\n"
      + `  fix      in wrangler.jsonc, set the workflows entry's \`name\` to \`${workerName}-butler-runs\`.`,
    );
  }

  const listed = capture("npx", ["wrangler", "workflows", "list"]);
  if (listed.status !== 0) {
    process.stdout.write(
      `\n   note: could not read this account's Workflows, so whether \`${workflowName}\` already belongs to\n`
      + "         another Worker went unchecked. If a second Node in this account shares that name, this\n"
      + "         deploy will take its Butler engine without saying so (#99).\n",
    );
    return;
  }

  /*
   * `wrangler workflows list` prints a table; the row is `│ <name> │ <script> │ …`. Matched on the workflow's
   * own name so a second, unrelated Workflow in the account cannot be mistaken for this one.
   */
  const row = listed.text.split("\n").find((line) => line.includes(workflowName));
  const owner = row?.split("│").map((cell) => cell.trim()).filter(Boolean)[1] ?? null;
  if (owner !== null && owner !== workerName) {
    fail(
      `refusing to deploy: the Workflow \`${workflowName}\` belongs to the Worker \`${owner}\`, and this\n`
      + `config deploys \`${workerName}\`.\n\n`
      + "  why      a Workflow is owned by exactly one script. Deploying would move it to this Worker —\n"
      + `           silently, with no warning from wrangler — and \`${owner}\` would keep a BUTLER_RUNS\n`
      + "           binding pointing at a Workflow now running this Node's code against this Node's\n"
      + "           bindings. That is one organization's Butler runs executing inside another's.\n"
      + "  fix      give this Node its own Workflow: in wrangler.jsonc, set the workflows entry's `name`\n"
      + `           to \`${workerName}-butler-runs\`, so it derives from the Worker name the way every other\n`
      + "           resource here already does. Then deploy again.",
    );
  }
}


/* ------------------------------------------------------------------ deploy ------------------------- */

/**
 * Expand, canary, check, shift (#98).
 *
 * ## What the previous order got wrong, and why swapping it was not the fix
 *
 * It deployed the Worker and *then* applied migrations, so new code served requests against a schema that
 * did not yet have what it needed — and if the migration failed, the incompatible Worker stayed deployed
 * while `doctor` was optional. The reason given was that *"the Worker bundles them"*. That is false:
 * `wrangler d1 migrations apply` reads the `.sql` files from `migrations/` and needs no deployed Worker.
 *
 * Simply reversing it is also unsafe, and that is the substance of this change rather than a caveat. A
 * migration that **drops, renames or narrows** breaks the code that is *currently* serving, so applying it
 * first opens the same window pointing the other way. No order makes both safe. What does is splitting
 * migrations by phase — `test/node/migration-phase-world.test.ts` derives the phase from the statements
 * rather than trusting a comment, because the comment convention it replaces was observed by five of
 * thirty-nine files and was **wrong on both of the five that contracted**.
 *
 * ## The rollback is that traffic never moved
 *
 * `wrangler versions upload` publishes a version and shifts **no traffic**. So the sequence is: expand,
 * upload, check the canary, and only then `versions deploy` to shift. A failed check needs no undo — the
 * previous version is still the one serving, which is a stronger guarantee than a rollback step that has to
 * run correctly during an incident.
 *
 * `doctor` against the canary is therefore not the closing courtesy it used to be. It is the gate that
 * decides whether traffic moves, which is why it can no longer be skipped.
 *
 * ## How the canary is reached, after two drills spent looking in the wrong place
 *
 * It used to be checked at `canary-mailda.<subdomain>.workers.dev`, from `--preview-alias`. That hostname
 * **404s and always will**, and two rounds of the live drill recorded the cause as "unestablished, possibly
 * an account setting". It is not a setting. Measured against the account: the script's subdomain settings
 * already read `{"enabled": true, "previews_enabled": true}`, the alias is recorded on every version, and no
 * preview hostname routes at all. Cloudflare does not generate preview URLs for Workers that implement a
 * **Durable Object**, and ADR 28 put both root keys in `KeyVault`. No configuration reaches that.
 *
 * So the canary is reached on the production hostname instead:
 *
 *   1. upload it — no traffic;
 *   2. publish a deployment of `canary@0% + incumbent@100%`, because an override is only applied to a version
 *      **in the current deployment**, and 0% means nothing reaches it but the override;
 *   3. send `Cloudflare-Workers-Version-Overrides: mailda="<id>"` to `/api/doctor`;
 *   4. **require the report to name that id.** This is the gate. Cloudflare routes by percentage when an
 *      override cannot be applied — no error, no header — so a check that read only `verdict` would ask the
 *      incumbent how it is, hear `ok`, and promote a canary nothing had examined. That is why the Worker has
 *      a `version_metadata` binding at all.
 *   5. promote to 100%.
 *
 * The 0% step is a real deployment, so `wrangler deployments list` gains an entry per deploy. That is the
 * cost of the mechanism and it is visible rather than hidden.
 *
 * ## What the canary check does **not** cover, and it is not what you would guess
 *
 * **Durable Object code is not the canary's.** Cloudflare guarantees global uniqueness by running exactly one
 * version of each Durable Object at a time, and under a gradual deployment each object is assigned a version
 * by the traffic percentages. The canary has **0%**, so `KeyVault` and `OutboxSweeper` run the *previous*
 * version's code while the canary's `fetch` runs the new one.
 *
 * Two consequences, and the first is more useful than it sounds:
 *
 *   - What the canary actually validates is **mixed-version compatibility** — new Worker code against old DO
 *     code — which is the state every gradual rollout passes through anyway, and the state a big-bang deploy
 *     never tests at all. So the check is exercising something real.
 *   - But a change *inside* a Durable Object class is **not** what the canary checked. A broken `restore()` or
 *     a broken alarm would pass the gate and only take effect once traffic moved. This is the one part of the
 *     sequence where "checked before promotion" is not true, and it is written here rather than left for
 *     somebody to find out during a rollout.
 *
 * Nothing here fixes that; it is a property of how Durable Objects and versions interact. What would is a
 * check that exercises the DO paths after promotion and can still roll back — which needs the rollback to be
 * a real step again, and is a decision rather than an omission.
 *
 * **It does not refuse Workers Free**, and the README no longer says it does. A Worker cannot read its
 * account's plan and this CLI has no documented endpoint for it either; the honest state is unverified,
 * which is what `doctor` reports.
 */
/**
 * Asks the account about each resource **by name**, or admits it could not (#162 L1).
 *
 * ## This read a list once, and the list lied
 *
 * `wrangler r2 bucket list` returns exactly 20 buckets and stops — alphabetically, no marker, no flag. On the
 * first live account this met, `mailda-evidence` was past that boundary, so the plan reported it absent on a
 * Worker that exists and called a healthy Node `orphaned`. `deploy-plan.mjs` carries the full account.
 *
 * One `info` call per declared resource instead. Four calls rather than four, the same cost, and the answer
 * is about the resource asked for rather than about whatever fitted on the first page.
 *
 * `quiet`, because these are questions rather than acts — `capture`'s own distinction — and echoing four
 * error messages for resources a first install is *expected* not to have would bury the plan under them.
 */
function accountInventory() {
  const { resources } = resourcesFromConfig(readFileSync(resolve(workerDir, "wrangler.jsonc"), "utf8"));

  /**
   * The `info` verb per kind, measured against wrangler 4.118.0.
   *
   * `"wrangler"` first, like every other `capture` call in this file. Omitting it produced
   * `npm error could not determine executable to run` — status 1 with no resource-kind marker in it, so
   * every probe answered **`unknown`** rather than `absent`. The plan printed four gaps instead of four
   * false creates, which is the fail-safe direction working: a broken probe could not become a claim about
   * the account.
   */
  const INFO = {
    d1: (name) => ["wrangler", "d1", "info", name],
    r2: (name) => ["wrangler", "r2", "bucket", "info", name],
    queue: (name) => ["wrangler", "queues", "info", name],
    workflow: (name) => ["wrangler", "workflows", "describe", name],
  };

  const probes = {};
  for (const resource of resources) {
    const args = INFO[resource.kind];
    if (args === undefined) continue;
    probes[resource.name] = capture("npx", [...args(resource.name), ...ENV], { quiet: true });
  }

  return {
    /*
     * The Worker's own existence comes from `firstInstall`, which already refuses rather than guesses — being
     * wrong there means skipping the canary on a live Node, and the plan inherits that judgement instead of
     * making a second one that could disagree with it.
     */
    worker: !firstInstall(),
    probes,
  };
}


export async function deploy(argv) {
  const contracting = flag(argv, "contract") !== null || argv.includes("--contract");

  /*
   * `--plan` answers and stops. It runs preflight first for the same reason the deploy does — the account has
   * to be settled before any list means anything — and then acts on nothing.
   */
  if (argv.includes("--plan")) {
    /*
     * `needsUrl: false`. A plan promotes nothing, so the canary reason the URL exists for does not apply —
     * and a plan for a **first install** runs before there is a Node to have a URL, which is the case this
     * command was written for. The account still has to be settled, because a resource list read against the
     * wrong account is worse than no list at all.
     */
    const settled = await runPreflight(argv, { needsUrl: false });
    if (!settled.ok) fail(settled.report);
    const plan = planFor({
      configText: readFileSync(resolve(workerDir, "wrangler.jsonc"), "utf8"),
      inventory: accountInventory(),
      // Settled above. Null in the single-account case, where there is nothing to disambiguate.
      account: settled.accountId === null
        ? null
        : { id: settled.accountId, name: settled.accountName },
    });
    process.stdout.write(renderPlan(plan));
    process.exit(plan.verdict === "blocked" || plan.verdict === "unknown" ? 1 : 0);
  }

  /*
   * Preflight first, and before `refuseIfWorkflowBelongsElsewhere` specifically. That guard is the one that
   * used to run first and silently no-op: on an ambiguous account `wrangler workflows list` fails, and the
   * guard printed a note and returned, so #99's protection against one Node stealing another's Butler engine
   * was skipped in exactly the situation where nothing else worked either. Settling the account before the
   * guard runs is what makes the guard's answer mean something.
   */
  const ready = await runPreflight(argv);
  if (!ready.ok) fail(ready.report);
  const origin = ready.origin;

  /*
   * **Is there anything here yet?** Measured against a real account rather than assumed, and it changed this
   * whole function — see `firstInstall` for what the drill found.
   */
  refuseIfWorkflowBelongsElsewhere();

  const first = firstInstall();
  if (first) {
    process.stdout.write(
      "\n== first install: no Worker exists yet\n"
      + "   Deploying directly. There is no previous version to protect, so there is nothing a canary could\n"
      + "   roll back to and nothing a migration could break — and the bindings do not exist until a deploy\n"
      + "   provisions them, which is why neither step below can come first.\n",
    );
    if (run("npx", ["wrangler", "deploy", ...ENV]) !== 0) fail("the first deploy failed.");
    process.stdout.write("\n== applying migrations for the first time\n");
    if (run("npx", ["wrangler", "d1", "migrations", "apply", "CATALOG", "--remote", ...ENV]) !== 0) {
      fail("applying migrations failed. The Worker is deployed against an empty schema — re-run to finish.");
    }
    process.stdout.write("\n== attaching the delivery-events consumer on a new Node\n");
    if (run("node", ["scripts/attach-queue-consumer.mjs"]) !== 0) {
      fail("attaching the consumer failed. Delivery outcomes will be unobserved until it is.");
    }
    if (origin !== null) {
      process.stdout.write("\n== asking the Node how it is\n");
      /*
       * The same rule as the canary path: a first install that ends with the Node refusing exits 2, and
       * anything less than that is not this command's failure. There is no previous version to name here —
       * that is what makes a first install a first install — so the refusal below prints no rollback.
       */
      const verdict = await doctor(["--url", origin]);
      if (verdict === "refuse") {
        process.stderr.write(
          "\n  the first install completed and the Node reports `refuse`.\n\n"
          + "  why      there is no previous version to fall back to on a first install, which is also why\n"
          + "           this step could not be a gate.\n"
          + "  fix      read the findings above; `mailda doctor` repeats them.\n\n",
        );
      }
      process.exit(deployExitCode(verdict));
    }
    return;
  }

  /*
   * The gate needs the Node's own hostname, so a missing one is refused **here** — before a migration has
   * been applied or a version uploaded. The canary used to be checked at a preview URL that wrangler
   * printed, so no origin was needed; it is needed now because that URL does not exist for a Worker with
   * Durable Objects, and the check reaches the canary through the production hostname instead.
   */
  /*
   * Unreachable in practice: preflight above refuses a missing origin as one of its numbered problems, and
   * this deploy needs one for the canary gate. Kept as an assertion rather than deleted, because "some other
   * caller cannot reach here" is the kind of claim that stops being true quietly — and the cost of it being
   * wrong is a gate that checks `undefined/api/doctor` and reads as an unreachable canary.
   */
  if (origin === null) {
    fail(
      "this deploy needs the Node's URL, and nothing has been changed.\n\n"
      + "  why      the canary is checked by overriding to it on the Node's own hostname. There is no\n"
      + "           preview URL to check instead: Cloudflare does not generate one for a Worker that\n"
      + "           implements a Durable Object, and this one holds its root keys in `KeyVault`.\n"
      + "  fix      re-run with `--url https://<your-node>` or set MAILDA_URL.",
    );
  }

  /*
   * Expansion first, because it is safe ahead of the code by construction, and refuse a contraction unless
   * the operator said so. A pending `-- phase: contract` migration applied here would break the version
   * currently serving — before the canary has even been uploaded, and while nothing has gone wrong yet.
   */
  process.stdout.write("\n== checking which migrations are pending\n");
  const pending = capture("npx", ["wrangler", "d1", "migrations", "list", "CATALOG", "--remote", ...ENV]);
  if (pending.status !== 0) {
    /*
     * **"The bindings are not provisioned" is a state, not a failure to list migrations** (#150).
     *
     * `firstInstall()` above asks whether the *Worker* exists, and that was the same question as "are the
     * bindings there" only until a resource could be deleted independently of the script. It can be: an
     * operator tidying up, a Cloudflare-side incident, or — routinely — a half-finished provisioning run,
     * since auto-provisioning creates or fails and never adopts, so every retry leaves the resources the
     * previous attempt made.
     *
     * Such a Node is not a first install, so it takes the canary path and dies here. Measured during #92's
     * drill, where the whole sequence stopped on wrangler's raw error and a two-word summary.
     *
     * And wrangler's advice — *"Run 'wrangler deploy' to provision it"* — is a dead end: the binding is
     * linked server-side, so a deploy inherits the dead one and provisions nothing. Following it produces no
     * error and no change, which is worse than the refusal.
     *
     * Matched on wrangler's own words for an absent auto-provisioned resource, and on nothing else — the
     * ambiguity rule `firstInstall` argues for. A network failure must not be read as "unprovisioned",
     * because the fix named below deletes a Worker.
     */
    if (/Couldn't find an auto-provisioned/i.test(pending.text)) {
      fail(
        "this Node's script exists but its bindings do not, so there is nothing to migrate.\n\n"
        + "  why      a deleted or half-provisioned D1, R2 bucket or queue leaves a Worker that is not a\n"
        + "           first install and cannot be deployed to. Auto-provisioning creates or fails and never\n"
        + "           adopts, so a leftover from one attempt blocks the next\n"
        + "  fix      do NOT run `wrangler deploy` — the binding is linked server-side, so it inherits the\n"
        + "           dead one, provisions nothing, and reports success. Delete the Worker and redeploy:\n"
        + "           docs/disaster-recovery.md has the order, including that the queue consumer must be\n"
        + "           removed first and the Workflow deleted separately.\n"
        + `           wrangler said: ${pending.text.trim().split("\n").slice(-2).join(" ")}`,
      );
    }
    fail(
      `could not list migrations (exit ${pending.status}).\n\n`
      + "  why      the expand step decides what is safe to apply before the canary is uploaded, so a\n"
      + "           sequence that cannot read the pending list must not continue\n"
      + `  fix      ${pending.text.trim().split("\n").slice(-3).join(" ")}`,
    );
  }
  const contractions = contractingAmong(pending.text, resolve(workerDir, "migrations"));
  if (contractions.length > 0 && !contracting) {
    fail(
      `refusing to apply a contracting migration: ${contractions.join(", ")}\n\n`
      + "  why      it drops, renames or narrows something, so it breaks the version currently serving —\n"
      + "           which is still the version serving until the canary below is checked and promoted.\n"
      + "  fix      deploy the expansion and the new code first, then run `mailda deploy --contract` in a\n"
      + "           later release, once you no longer want to roll back to the version that needs the old\n"
      + "           shape. Or split the migration so the contraction is its own file.",
    );
  }

  process.stdout.write("\n== applying migrations\n");
  if (run("npx", ["wrangler", "d1", "migrations", "apply", "CATALOG", "--remote", ...ENV]) !== 0) {
    fail("applying migrations failed. Nothing was deployed, so the version currently serving is unchanged.");
  }

  /*
   * Which version is serving now. Read **before** the upload, so the pair below is built from the version
   * this command found live rather than from whatever the list says after it has changed.
   */
  process.stdout.write("\n== reading the version currently serving\n");
  const deployments = capture("npx", ["wrangler", "deployments", "list", ...ENV]);
  if (deployments.status !== 0) fail(`could not list deployments (exit ${deployments.status}).`);
  const serving = activeVersionFrom(deployments.text);
  if (serving === null) {
    fail(
      "could not tell which version is currently serving.\n\n"
      + "  why      the canary is checked by placing it alongside that version at 0% and overriding to it.\n"
      + "           Without the incumbent's id this command cannot build that pair, and guessing would\n"
      + "           publish a deployment that drops the version now serving.\n"
      + "  fix      nothing has changed. Run `wrangler deployments list` and check the output.",
    );
  }

  process.stdout.write("\n== uploading a canary version (no traffic)\n");
  const uploaded = capture("npx", [
    "wrangler", "versions", "upload", "--message", "mailda deploy", ...ENV,
  ]);
  if (uploaded.status !== 0) {
    fail(`uploading the canary failed (exit ${uploaded.status}). No traffic moved.`);
  }
  const version = versionIdFrom(uploaded.text);
  if (version === null) {
    fail(
      "could not find the new version's id in wrangler's output.\n\n"
      + "  why      the id is what promotes this version, and guessing it would promote something else.\n"
      + "  fix      the canary is uploaded and serving no traffic, so nothing is broken. Read the id from\n"
      + "           the output above and finish with `wrangler versions deploy <id>@100`.",
    );
  }

  /*
   * Put the canary **in** the current deployment at 0%. A version override is only applied if the version is
   * in the current deployment, so without this step the header below would be ignored and the check would
   * silently interrogate the incumbent. 0% means no request reaches it except one carrying the override.
   */
  process.stdout.write("\n== placing the canary in the deployment at 0%\n");
  if (run("npx", [
    "wrangler", "versions", "deploy", `${version}@0`, `${serving}@100`, "--yes", ...ENV,
  ]) !== 0) {
    fail(
      "could not place the canary in the deployment.\n\n"
      + `  why      the canary cannot be reached without being in it, and ${serving} is still at 100%.\n`
      + "  fix      nothing was promoted. Re-run, or check `wrangler deployments list`.",
    );
  }

  /*
   * The gate. Against the **canary**, reached through a version override on the production hostname — a
   * Worker with Durable Objects gets no preview URL, which two rounds of the deploy drill spent on an
   * account setting that was already correct (`preview-urls-and-durable-objects.md`).
   *
   * The identity check is the gate, not the verdict. Cloudflare routes by percentage when an override cannot
   * be applied, so a report that came from the incumbent would say `ok` and promote an unexamined canary.
   */
  process.stdout.write(`\n== asking the canary how it is (${origin}, version ${version})\n`);

  /*
   * One cookie, used for **both** reports, and that is load-bearing rather than tidy. Asking the canary
   * authenticated and the incumbent anonymously would compare 21 findings against 9 — twelve of them would
   * read as new, and every deploy would be blocked by a difference in who was asking rather than in what
   * the code does. Like for like or not at all.
   */
  const cookie = await sessionCookie(origin);
  const asked = cookie === null ? {} : { cookie };
  process.stdout.write(`   checking ${cookie === null ? "anonymously" : "signed in"}\n`);

  /*
   * **Retried, because a fresh version is not immediately overridable.** Cloudflare's own words: *"It can
   * take up to a couple of seconds to be available globally after a recent change."* This deploy publishes
   * the canary at 0% and asks for it in the next breath, so the first attempt races propagation — and when
   * the override is not applied the request is routed by traffic percentage instead, which means the
   * **incumbent answers and nothing says so**.
   *
   * The gate below catches that and refuses, which is the safe direction and is what it did for three
   * deploys running until somebody read why. Refusing on a race is still a gate that has to be overridden
   * by hand every time, which is the failure `promotionVerdict`'s own history warns about — so the race is
   * waited out rather than reported.
   *
   * Six attempts over roughly fifteen seconds. Bounded, because a version that never becomes overridable is
   * a real condition — a Node with no `version_metadata` binding cannot report its version at all — and the
   * refusal below is the honest answer to it.
   */
  const overridden = { ...asked, "Cloudflare-Workers-Version-Overrides": `mailda="${version}"` };
  let report = await doctorReport(origin, overridden, "the canary");
  for (let attempt = 1; attempt < 6 && servedVersionOf(report) !== version; attempt++) {
    process.stdout.write(`   the override has not propagated yet; retrying (${attempt}/5)\n`);
    await new Promise((resume) => setTimeout(resume, 3000));
    report = await doctorReport(origin, overridden, "the canary");
  }

  const answered = servedVersionOf(report);
  if (answered !== version) {
    fail(
      `the override did not reach the canary: ${answered ?? "the report named no version"} answered.\n\n`
      + "  why      Cloudflare routes a request by traffic percentage when a version override cannot be\n"
      + `           applied, so this check just asked ${serving} how it is. Promoting on that answer would\n`
      + "           move every request onto a version nothing examined.\n"
      + "  fix      no traffic moved. This was retried for fifteen seconds, so it is not the propagation\n"
      + "           delay Cloudflare documents. If the Node predates the `version_metadata` binding it\n"
      + "           cannot report its version and this gate cannot run — deploy once by hand to install it:\n"
      + `           \`wrangler versions deploy ${version}@100\`.`,
    );
  }
  /*
   * Judged against what is already serving, not against perfection — and the drill is what taught this. The
   * gate was `shouldPromote(canary.verdict)`, which refused a canary whose only finding was the *same* one
   * the incumbent had (`signing_key`, self-healing on an unclaimed Node). A version neither better nor worse
   * than the one taking every request was withheld, and an operator was told to promote it by hand. Every
   * deploy to such a Node would go that way, and a gate that always has to be overridden is not a gate.
   *
   * The incumbent's report is fetched **without** the override header, which reaches it because it holds
   * 100% of the traffic. Asked after the canary rather than before, so the two are as close together in time
   * as the sequence allows — a finding that appeared between them belongs to the Node, not to the canary.
   */
  const incumbent = await doctorReport(origin, asked, "the version now serving");
  const gate = promotionVerdict({ canary: report, incumbent });

  for (const check of gate.carried) {
    process.stdout.write(`   carried  ${check}  — the version now serving reports this too\n`);
  }

  /*
   * How much the gate could see, printed next to its verdict. A reduced report says so in a finding of its
   * own, and the number it withholds is the honest measure of this check's reach — 9 of 21 on the Node this
   * was drilled against. "The gate passed" is worth less without it.
   */
  const withheld = (report.findings ?? []).find((one) => one?.check === "report_reduced");
  process.stdout.write(
    `   compared ${(report.findings ?? []).length} finding(s)`
    + `${withheld === undefined ? " — the whole report" : `, and ${withheld.detail}`}\n`,
  );

  if (!gate.promote) {
    fail(
      `${gate.why}, so traffic was not moved.\n\n`
      + "  why      the version that was serving before this command ran is still the one serving. There is\n"
      + "           nothing to roll back, which is why the canary is uploaded before it is promoted.\n"
      + "  fix      read the findings above. To promote it anyway once you have decided they are\n"
      + `           acceptable: \`wrangler versions deploy ${version}@100\`.`,
    );
  }

  process.stdout.write("\n== moving traffic to the checked version\n");
  if (run("npx", ["wrangler", "versions", "deploy", `${version}@100`, "--yes", ...ENV]) !== 0) {
    fail("promoting the canary failed. The previous version is still serving.");
  }

  /*
   * The consumer last, because it attaches to a queue the deploy provisions — and out of band, because a
   * consumer cannot name a queue whose name Cloudflare derives (`queue-provisioning.md`).
   */
  process.stdout.write("\n== attaching the delivery-events consumer\n");
  if (run("node", ["scripts/attach-queue-consumer.mjs"]) !== 0) {
    fail("attaching the consumer failed. The new version is live but delivery outcomes are unobserved.");
  }

  /*
   * Unconditional now, where it used to depend on `--url` being passed. The canary path refuses without an
   * origin long before this line, so there is no branch left in which it could be absent — and this run is
   * the one that covers what the canary could not: Durable Object code, which runs the promoted version only
   * after traffic moves.
   */
  process.stdout.write("\n== asking the live Node how it is\n");
  const after = await doctor(["--url", origin]);

  /*
   * The deploy's own exit code, not doctor's. A carried degradation is the incumbent's condition and the gate
   * already refused anything the canary made worse, so it is not this command's failure — see
   * `deployExitCode`.
   *
   * `refuse` is different and is the one case the canary gate provably cannot have caught: Durable Object code
   * runs the promoted version only **after** traffic moves, so a broken `KeyVault` or `OutboxSweeper` appears
   * exactly here and nowhere earlier. Hence the rollback command, with the version that was serving before
   * this ran — the one value a person cannot look up mid-incident.
   */
  if (after === "refuse") {
    process.stderr.write(
      `\n  the deploy completed and the Node now reports \`refuse\`.\n\n`
      + "  why      the canary gate cannot see this one. A Durable Object runs the promoted version only\n"
      + "           after traffic moves, so a fault inside `KeyVault` or `OutboxSweeper` appears here and\n"
      + "           could not have appeared earlier.\n"
      + `  fix      to put the previous version back: \`wrangler versions deploy ${serving}@100\`\n\n`,
    );
  }
  process.exit(deployExitCode(after));
}

export async function preflight(argv) {
  const outcome = await runPreflight(argv);
  if (!outcome.ok) fail(outcome.report);
  process.stdout.write("\n");
}
