import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWranglerConfig, WORKER_DIR } from "./wrangler-world";

/**
 * What `scripts/attach-queue-consumer.mjs` does, run for real against a stand-in for wrangler.
 *
 * ## Why this exists at all
 *
 * Since #72 the sending-events queue has a name only Cloudflare knows, so the consumer is attached by a
 * script instead of by configuration — and `deployability.test.ts` can only check that the script exists,
 * is wired into `package.json`, and reads its binding name out of the config. The behaviour that actually
 * decides whether an operator ends up with delivery outcomes is the part it cannot see: what the script
 * does with what the platform answers. That behaviour had **no** test, and it is a step that will be run
 * twice — once by whoever installs the Node and again by whoever wonders whether it was ever run.
 *
 * ## How it is run without an account
 *
 * The script shells out to `npx wrangler`, so `PATH` is prefixed with a directory holding an executable
 * named `npx` that answers the three commands the script issues. Nothing here touches Cloudflare: the
 * stub is the whole world, and `PATH` order guarantees it is what resolves.
 *
 * The JSON it answers with is the shape wrangler's own bundled source reads — `deployments status --json`
 * prints the deployment object with `versions[].version_id`, `versions view --json` prints the version
 * object whose `resources.bindings` is an array of `{ type, name, queue_name }`, and `queues info` prints
 * one `Consumers: worker:<script>` line. That makes this a test of the script against a **documented**
 * shape rather than a measurement of the platform, which is the honest limit of what can be checked here
 * and is why the script's discovery failures are tested as carefully as its successes.
 *
 * The stub's queue name is deliberately a string that appears **nowhere** in this repository. A script
 * that guessed, derived or hardcoded a name instead of reading it back could not print this one.
 */

const SCRIPT = join(WORKER_DIR, "scripts", "attach-queue-consumer.mjs");
const workerName = readWranglerConfig()["name"] as string;

/** Unguessable on purpose: the only way to print it is to have read it from the deployed binding. */
const DISCOVERED_QUEUE = "stub-derived-q-4f19c7";
const SECOND_QUEUE = "stub-derived-q-second-8ab3";

const STUB = `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const versionId = process.argv.slice(2)[3];
const scenario = process.env.STUB_SCENARIO;
const out = (t) => { process.stdout.write(t + "\\n"); process.exit(0); };
const err = (t) => { process.stderr.write(t + "\\n"); process.exit(1); };

if (args.startsWith("wrangler deployments status")) {
  out(JSON.stringify({ id: "dep1", versions: scenario === "two-versions"
    ? [{ version_id: "v1", percentage: 50 }, { version_id: "v2", percentage: 50 }]
    : [{ version_id: "v1", percentage: 100 }] }));
}
if (args.startsWith("wrangler versions view")) {
  const bindings = scenario === "no-queue"
    ? [{ type: "d1", name: "CATALOG" }]
    : [{ type: "d1", name: "CATALOG" }, { type: "queue", name: "SENDING_EVENTS",
        queue_name: versionId === "v2" ? ${JSON.stringify(SECOND_QUEUE)} : ${JSON.stringify(DISCOVERED_QUEUE)} }];
  out(JSON.stringify({ id: versionId, resources: { bindings, script: {}, script_runtime: {} } }));
}
if (args.startsWith("wrangler queues consumer worker add")) {
  if (scenario === "fresh") out("Added consumer.");
  err("✘ [ERROR] Queue '" + ${JSON.stringify(DISCOVERED_QUEUE)} + "' already has a consumer. [code: 11004]");
}
if (args.startsWith("wrangler queues info")) {
  if (scenario === "info-unreadable") err("✘ [ERROR] A request to the Cloudflare API failed. [code: 10000]");
  const holder = scenario === "foreign" ? "worker:some-other-node" : "worker:" + ${JSON.stringify(workerName)};
  out(["Queue Name: " + ${JSON.stringify(DISCOVERED_QUEUE)}, "Number of Consumers: 1", "Consumers: " + holder].join("\\n"));
}
err("stub npx: unhandled command: " + args);
`;

const stubDir = mkdtempSync(join(tmpdir(), "mailda-wrangler-stub-"));
writeFileSync(join(stubDir, "npx"), STUB, { mode: 0o755 });
chmodSync(join(stubDir, "npx"), 0o755);

function attach(scenario: string): { status: number | null; text: string } {
  const run = spawnSync(process.execPath, [SCRIPT], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}:${process.env["PATH"] ?? ""}`, STUB_SCENARIO: scenario },
  });
  return { status: run.status, text: `${run.stdout}${run.stderr}` };
}

describe("attaching the queue consumer out of band", () => {
  it("attaches to the queue it read back from the deployed binding, never to a name it composed", () => {
    const run = attach("fresh");
    expect(run.text).toContain(DISCOVERED_QUEUE);
    expect(run.status, run.text).toBe(0);
    // The queue name is unguessable, so printing it proves the discovery route ran end to end. And the
    // script must not have gone looking for the name #72 removed from the config.
    expect(readFileSync(SCRIPT, "utf8")).not.toContain("mailda-sending-events");
  });

  it("succeeds on a re-run, because a step that fails the second time gets run twice", () => {
    // Queues permits one consumer per queue, so the second run collides. The collision answers the
    // question rather than failing it: the consumer already there is this Worker, so the desired state
    // holds. An operator who cannot tell whether the step ran must be able to just run it again.
    const run = attach("already-mine");
    expect(run.status, run.text).toBe(0);
    expect(run.text).toContain("already the consumer");
  });

  it("refuses when another Worker holds the queue, which is #72 happening again", () => {
    const run = attach("foreign");
    expect(run.status).toBe(1);
    expect(run.text).toContain("E_QUEUE_CONSUMER_FOREIGN");
    expect(run.text).toContain("some-other-node");
  });

  it("says the consumer could not be read rather than naming a foreign one it never saw", () => {
    // Reading the queue back is a second command and it can fail on its own — a token without Queues
    // read, or an output shape that moved. "Unreadable" must not print as "somebody else's": that sends
    // an operator after a collision that may not exist, and an unverified claim ends a question wrongly.
    const run = attach("info-unreadable");
    expect(run.status).toBe(1);
    expect(run.text).toContain("E_QUEUE_CONSUMER_UNVERIFIED");
    expect(run.text).not.toContain("E_QUEUE_CONSUMER_FOREIGN");
  });

  it("refuses when two deployed versions bind two queues, rather than draining half the events", () => {
    // A gradual deployment can serve two versions at once. Attaching to one of them would observe half
    // this Node's delivery outcomes and look healthy, which is the class of failure #72 was about.
    const run = attach("two-versions");
    expect(run.status).toBe(1);
    expect(run.text).toContain("E_QUEUE_AMBIGUOUS");
    expect(run.text).toContain(SECOND_QUEUE);
  });

  it("refuses when the deploy provisioned no queue, because that is documented rather than measured", () => {
    // That a producer binding with no queue name provisions a queue is Cloudflare's documentation and is
    // unmeasured by this repository (docs/receipts/queue-provisioning.md), so a deployed version with no
    // queue binding is a real outcome. It must not be met with a guessed name.
    const run = attach("no-queue");
    expect(run.status).toBe(1);
    expect(run.text).toContain("E_QUEUE_NOT_DISCOVERED");
  });
});
