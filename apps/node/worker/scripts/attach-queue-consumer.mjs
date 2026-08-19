#!/usr/bin/env node
/**
 * Attaches this Worker as the consumer of its own sending-events queue.
 *
 * Usage, from the repository root:
 *
 *     pnpm --filter @mailda/worker run queue:attach-consumer            # the Worker named in wrangler.jsonc
 *     pnpm --filter @mailda/worker run queue:attach-consumer -- --name my-node
 *
 * ## Why this is a script and not configuration (#72)
 *
 * A queue name is **account-scoped**. `wrangler.jsonc` used to name one, so a second Node in one account
 * could not install: its consumer registration failed with "already has a consumer" and its producer
 * binding attached to the *first* Node's queue, sending one Node's delivery events to another Node's
 * consumer across two D1 catalogs. The fix removes the name from the producer binding, which puts the
 * queue in the same shape as D1 and R2 — provisioned per install, named after the Worker.
 *
 * That closes the collision and costs this: **a consumer block cannot be declared any more.** Measured on
 * 19 August 2026 against a scratch config, a consumers block with no `queue` field is refused at config
 * parse — `"queues.consumers[0]" should have a string "queue" field` — and the only name it could carry is
 * the derived one, which `wrangler.jsonc` cannot know. `--var` and `--define` substitute into the *script*,
 * not into config values, so there is no interpolation route either. So the attachment happens here.
 *
 * ## The other half of the same gap, still missing
 *
 * A queue with a consumer and no **event subscription** still observes nothing. The `email.sending`
 * subscription is an account-level object that wrangler's CLI cannot create — `queue-provisioning.md`
 * records `queues.subscription_creatable_by_cli: 0` and `queues.subscription_creatable_by_api: 1` — and
 * **this script does not create it.** It is deliberately out of scope: it needs an account API token and a
 * zone id, neither of which wrangler will hand over, and it has never had a script at all despite being
 * described as something `mailda deploy` does. Until that exists, an operator following the receipt's
 * `POST /accounts/{id}/event_subscriptions/subscriptions` by hand is the whole of it, and doctor's
 * `delivery_visibility` is what says so.
 *
 * ## How the queue is discovered, and why that route is trustworthy
 *
 * The derived queue name is **unmeasured**. Cloudflare documents that provisioning names a resource with
 * the Worker as a prefix, and this repository has been wrong twice this week believing documentation, so
 * nothing here guesses the string. It is read back from the deployed Worker:
 *
 *   1. `wrangler deployments status --json` — the live deployment, and the version id(s) serving it.
 *   2. `wrangler versions view <version-id> --json` — that version's `resources.bindings`, as the platform
 *      stored them. A queue producer binding appears as `{ type: "queue", name: <binding>, queue_name: … }`;
 *      wrangler reads the same two fields when it converts a deployed binding back into config, which is
 *      the evidence for that shape rather than a guess about it.
 *
 * **What is measured here and what is not, because the difference is load-bearing.** Measured: the CLI
 * surface, from `--help` on wrangler 4.118.0 — `deployments status --json`, `versions view <id> --json`,
 * `queues consumer worker add <queue> <script>` with `--batch-size` and `--batch-timeout`, and `queues info
 * <name>` all exist with those arguments. **Read from wrangler's own source, not measured against a live
 * account:** the JSON shapes. `deployments status --json` prints the deployment object whose `versions` each
 * carry a `version_id`; `versions view --json` prints the version object with `resources.bindings`; a queue
 * binding there carries `type`, `name` and `queue_name` — wrangler reads exactly those three when it turns a
 * deployed binding back into config, and `queues info` prints `Consumers: worker:<script>` from the same
 * API. That is stronger than documentation and weaker than a measurement, and it is written down as such
 * rather than presented as fact: **this script's discovery path has not been run against a Cloudflare
 * account.** The first operator to run it is the measurement, and every refusal below prints the command it
 * ran and the output it got so that a shape change reads as a shape change rather than as a mystery.
 *
 * What *is* exercised, on every test run: `test/node/attach-queue-consumer.test.ts` puts a stub `npx` on
 * `PATH` that answers those three commands in the shapes above, and runs this file for real through the
 * success path, the re-run, the foreign consumer, the unreadable read, the ambiguous deployment and the
 * deploy that provisioned nothing. That tests this script against a documented shape; it does not test the
 * shape. If the platform's JSON moves, the stub still passes and the operator gets the refusal text above.
 *
 * This is trustworthy because it is **the same binding the Worker publishes through**. Whatever name the
 * platform resolved, a consumer attached to that queue drains the queue this Node's sends land in. The
 * obvious alternative — list the account's queues and keep the ones whose producers include this script —
 * is weaker in exactly the case that matters: the producers array names the *script*, not the *binding*, so
 * a Worker with two queue producers could not be told apart, and it also cannot distinguish the queue this
 * Node provisioned from one it merely inherited.
 *
 * The binding name itself is read from `wrangler.jsonc` rather than written here, so renaming
 * `SENDING_EVENTS` cannot leave this script looking for a binding that no longer exists.
 *
 * **Zero matches** and **more than one** both refuse, loudly, and neither guesses:
 *
 *   zero  — either the Worker has never been deployed, or the deploy did not provision a queue. Automatic
 *           provisioning of Queues is documented, **not measured here**, so this is a real possibility and
 *           not a paranoid branch. The message says which commands to run to find out.
 *   many  — a gradual deployment can serve two versions at once, and two versions can carry two different
 *           queues. Attaching to one of them would drain half the sends and look healthy, which is the
 *           class of failure #72 was about. It refuses and prints both names.
 *
 * ## Idempotent, by treating the conflict as the signal
 *
 * Queues permits one consumer per queue, so a re-run collides. That collision is the answer rather than an
 * error — the same shape the migration ledger and the audit chain use (#9). On conflict this reads the
 * queue back, and the read has three outcomes rather than two, because reading it can fail:
 *
 *   this script      — the desired state already holds. Success, nothing to do.
 *   another script   — refuses (`E_QUEUE_CONSUMER_FOREIGN`). That is a queue belonging to another Worker,
 *                      and silently doing nothing about it is how #72 stayed invisible.
 *   could not read   — refuses (`E_QUEUE_CONSUMER_UNVERIFIED`), and says *that* rather than naming a
 *                      foreign consumer it never saw. A token without Queues read, or a `queues info`
 *                      whose output shape moved, produces no evidence about whose consumer it is, and
 *                      "unreadable" must not be allowed to print as "somebody else's".
 *
 * ## Two numbers, and where they come from
 *
 * `--batch-size 25` and `--batch-timeout 10` are carried over verbatim from the `max_batch_size` and
 * `max_batch_timeout` that the deleted consumers block declared. **They are not receipt-backed** — they
 * were unmeasured literals in `wrangler.jsonc` before this change and they are unmeasured literals here.
 * Stated rather than dressed up: nothing measured them, and passing them explicitly at least keeps
 * behaviour identical to the config that shipped instead of silently inheriting whatever the platform
 * default becomes. An existing consumer's settings are **not** updated by a re-run — `consumer worker add`
 * conflicts rather than patching — so changing either number means removing the consumer first.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(workerDir, "wrangler.jsonc");

/** Unmeasured, and inherited from the consumers block this replaces. See the header. */
const BATCH_SIZE = "25";
const BATCH_TIMEOUT_SECONDS = "10";

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** One wrangler invocation. Output is returned whole, because a failure's text is the diagnosis. */
function wrangler(args) {
  const run = spawnSync("npx", ["wrangler", ...args], { cwd: workerDir, encoding: "utf8" });
  return {
    ok: run.status === 0,
    text: `${run.stdout ?? ""}${run.stderr ?? ""}`,
    stdout: run.stdout ?? "",
  };
}

/**
 * JSON out of a wrangler `--json` invocation.
 *
 * Sliced from the first brace rather than parsed whole: wrangler suppresses its banner under `--json` but
 * still emits update notices and auth chatter on the same streams, and a parse that dies on those would
 * turn a working command into an unexplained failure.
 */
function wranglerJson(args, what) {
  const run = wrangler(args);
  const start = run.stdout.indexOf("{");
  if (!run.ok || start === -1) {
    fail(
      `E_QUEUE_DISCOVERY_FAILED  could not read ${what}\n` +
      `  ran      npx wrangler ${args.join(" ")}\n` +
      `  output   ${run.text.trim().slice(-900) || "(nothing)"}\n` +
      `  fix      check that wrangler is authenticated (npx wrangler whoami) and that this Worker has been ` +
      `deployed at least once. The consumer can only be attached to a queue that a deploy has created`,
    );
  }
  try {
    return JSON.parse(run.stdout.slice(start));
  } catch (error) {
    return fail(`E_QUEUE_DISCOVERY_FAILED  ${what} was not JSON: ${error.message}\n${run.text.slice(-600)}`);
  }
}

const config = parseJsonc(readFileSync(configPath, "utf8"));

/**
 * The producer binding whose queue is wanted. Read from the config, and there must be exactly one: this
 * script attaches one consumer, so a second producer is a decision about which queue carries delivery
 * outcomes, and that decision is not this script's to invent.
 */
const producers = config.queues?.producers ?? [];
if (producers.length !== 1 || typeof producers[0]?.binding !== "string") {
  fail(
    `E_QUEUE_BINDING_AMBIGUOUS  wrangler.jsonc declares ${producers.length} queue producer(s)\n` +
    `  expected one, carrying a binding name and no queue name\n` +
    `  fix      this script attaches exactly one consumer. If a second queue producer is deliberate, ` +
    `decide here which binding carries delivery outcomes`,
  );
}
const bindingName = producers[0].binding;
if (typeof producers[0].queue === "string") {
  fail(
    `E_QUEUE_NAME_COMMITTED  wrangler.jsonc names the queue "${producers[0].queue}" on binding ${bindingName}\n` +
    `  A queue name is account-scoped, so a committed one makes a second Node in the same account bind to ` +
    `the first Node's queue (#72). Remove the queue field; the deploy provisions a per-Worker queue and ` +
    `this script discovers it`,
  );
}

const nameFlagIndex = process.argv.indexOf("--name");
const workerName = nameFlagIndex === -1 ? config.name : process.argv[nameFlagIndex + 1];
if (typeof workerName !== "string" || workerName.length === 0) {
  fail("usage: pnpm --filter @mailda/worker run queue:attach-consumer [-- --name <worker-name>]");
}

console.log(`Worker   ${workerName}`);
console.log(`Binding  ${bindingName}`);

// Step 1: the live deployment, and the versions serving it.
const deployment = wranglerJson(
  ["deployments", "status", "--json", "--name", workerName],
  `the live deployment of ${workerName}`,
);
// Strings only. A version entry without an id would otherwise become the literal "undefined" in the next
// command's arguments, and the failure would name a version that does not exist rather than the shape change
// that produced it.
const versionIds = [...new Set(
  (deployment.versions ?? []).map((version) => version.version_id).filter((id) => typeof id === "string"),
)];
if (versionIds.length === 0) {
  fail(
    `E_QUEUE_NOT_DISCOVERED  ${workerName} has no deployed version, so it has no queue yet\n` +
    `  fix      deploy first: pnpm --filter @mailda/worker run deploy`,
  );
}

// Step 2: that version's bindings, as the platform stored them.
const queueNames = new Set();
for (const versionId of versionIds) {
  const version = wranglerJson(
    ["versions", "view", versionId, "--json", "--name", workerName],
    `version ${versionId} of ${workerName}`,
  );
  for (const binding of version.resources?.bindings ?? []) {
    if (binding.type === "queue" && binding.name === bindingName && typeof binding.queue_name === "string") {
      queueNames.add(binding.queue_name);
    }
  }
}

if (queueNames.size === 0) {
  fail(
    `E_QUEUE_NOT_DISCOVERED  no ${bindingName} queue binding on the deployed version(s) ` +
    `${versionIds.join(", ")} of ${workerName}\n` +
    `  Either the deploy did not provision a queue for that binding, or the binding is named something ` +
    `else on the deployed version than in wrangler.jsonc.\n` +
    `  fix      npx wrangler versions view ${versionIds[0]} --name ${workerName}   to see what the ` +
    `deployed version actually binds, then redeploy. Automatic provisioning of Queues is documented rather ` +
    `than measured by this repository (docs/receipts/queue-provisioning.md), so a deploy that created no ` +
    `queue is a real outcome and not a paranoid branch`,
  );
}
if (queueNames.size > 1) {
  fail(
    `E_QUEUE_AMBIGUOUS  the deployed version(s) of ${workerName} bind ${bindingName} to ` +
    `${queueNames.size} different queues: ${[...queueNames].join(", ")}\n` +
    `  A gradual deployment can serve two versions at once. Attaching the consumer to one of them would ` +
    `drain half this Node's delivery events and look healthy.\n` +
    `  fix      finish or roll back the deployment (npx wrangler deployments status --name ${workerName}), ` +
    `then re-run this`,
  );
}

const queueName = [...queueNames][0];
console.log(`Queue    ${queueName}   (discovered from the deployed binding, never derived)`);

// Step 3: attach, and let a conflict answer the question.
const add = wrangler([
  "queues", "consumer", "worker", "add", queueName, workerName,
  "--batch-size", BATCH_SIZE, "--batch-timeout", BATCH_TIMEOUT_SECONDS,
]);

if (add.ok) {
  console.log(`\nAttached ${workerName} as the consumer of ${queueName}.`);
  console.log(`Batch    ${BATCH_SIZE} messages / ${BATCH_TIMEOUT_SECONDS}s — unmeasured, carried over from`);
  console.log(`         the consumers block wrangler.jsonc used to declare.`);
} else if (/already has a consumer|11004/.test(add.text)) {
  // The conflict is the signal — but only if the consumer already there is *this* Worker. Whose it is
  // decides whether the desired state holds or whether this is #72 happening again.
  const info = wrangler(["queues", "info", queueName]);
  const consumers = /^Consumers:(.*)$/m.exec(info.text)?.[1];
  if (!info.ok || consumers === undefined) {
    // Reading failed, so there is no evidence about whose consumer this is. Refuse on the unread fact
    // rather than on an invented one: a token without Queues read, or a changed output shape, would
    // otherwise print as "another Worker holds your queue" and send an operator after a collision that may
    // not exist. Unverified is its own answer (AGENTS.md: an unverified claim ends a question wrongly).
    fail(
      `E_QUEUE_CONSUMER_UNVERIFIED  ${queueName} already has a consumer, and which one could not be read\n` +
      `  ran        npx wrangler queues info ${queueName}\n` +
      `  output     ${info.text.trim().slice(-900) || "(nothing)"}\n` +
      `  If it is ${workerName} the desired state already holds and there is nothing to do; if it is another ` +
      `Worker, this Node cannot observe delivery outcomes at all (#72). This refuses rather than guess ` +
      `which.\n` +
      `  fix        npx wrangler queues consumer list ${queueName}   to see who holds it, then re-run`,
    );
  }
  const mine = consumers.split(",").some((entry) => entry.trim() === `worker:${workerName}`);
  if (!mine) {
    fail(
      `E_QUEUE_CONSUMER_FOREIGN  ${queueName} already has a consumer, and it is not ${workerName}\n` +
      `  consumers  ${consumers.trim()}\n` +
      `  Queues permits one consumer per queue, so this Node cannot observe delivery outcomes on this ` +
      `queue while another Worker holds it. That is the account-scoped collision #72 is about, and this ` +
      `refuses rather than leaving it to look like silence.\n` +
      `  fix        confirm which Worker should drain ${queueName}. If it is this one, remove the other ` +
      `consumer: npx wrangler queues consumer worker remove ${queueName} <script-name>`,
    );
  }
  console.log(`\n${workerName} is already the consumer of ${queueName}. Nothing to do.`);
  console.log(`Batch settings are not updated by a re-run — consumer worker add conflicts rather than`);
  console.log(`patching — so changing them means removing the consumer first.`);
} else {
  fail(
    `E_QUEUE_CONSUMER_ADD_FAILED  could not attach ${workerName} to ${queueName}\n` +
    `  output   ${add.text.trim().slice(-900) || "(nothing)"}\n` +
    `  fix      the queue exists and was discovered from the deployed binding, so this is a permission or ` +
    `platform failure rather than a naming one. npx wrangler whoami, then retry`,
  );
}

console.log(`\nDelivery outcomes still need an email.sending event subscription, which this script does`);
console.log(`not create: wrangler cannot, and the API route needs an account token and a zone id`);
console.log(`(docs/receipts/queue-provisioning.md). doctor's delivery_visibility says when it is missing.`);
