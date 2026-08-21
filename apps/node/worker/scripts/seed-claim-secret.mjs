#!/usr/bin/env node
/**
 * Writes the install-time claim secret, and prints it once.
 *
 * `seedClaimSecret` was documented as *"Called by `mailda deploy`"* and `mailda deploy` did not exist, so
 * the secret a `POST /api/claim` verifies was written by nothing and the function's only caller was its own
 * test (#80). This is that caller.
 *
 * The secret is **generated here, not chosen**: a claim secret an operator invents is a claim secret an
 * operator can reuse, and this one is the single credential standing between an unclaimed Node and whoever
 * finds its URL first. It is printed once and never stored in plaintext — what lands in D1 is the hash,
 * computed by `claimSecretHash` from `src/claim.ts` rather than by a second implementation here.
 *
 *   node --experimental-strip-types apps/node/worker/scripts/seed-claim-secret.mjs [--local]
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { claimSecretHash } from "../src/claim-secret.ts";
import { d1 as run } from "./d1.mjs";

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = process.argv.includes("--local");

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const d1 = (sql, params) => run(workerDir, sql, params, { local });

/*
 * Refused rather than overwritten, and the two cases are told apart.
 *
 * A **claimed** Node has an organization and users behind that row; replacing its secret would offer a
 * second claim of something already owned. An **unclaimed** row is a secret somebody may still be holding —
 * a re-seed would silently invalidate an install link that was already sent.
 */
const existing = d1("SELECT id, claimed_at FROM node_claim LIMIT 1");
if (existing.length > 0) {
  fail(existing[0].claimed_at === null
    ? "This Node already has an unclaimed secret. Re-seeding would invalidate an install link somebody may\n"
      + "still be holding. Delete the node_claim row deliberately if that is what you want."
    : "This Node is already claimed. A second claim secret would offer to hand over an organization that\n"
      + "already has one.");
}

// 32 bytes, base64url: the same shape as the session tokens, and long enough that the URL it goes in is the
// only thing protecting it.
const secret = randomBytes(32).toString("base64url");
const id = `clm_${randomBytes(16).toString("hex")}`;
d1("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,NULL,NULL)",
  [id, await claimSecretHash(secret)]);

console.log(`\nClaim secret for this Node:\n\n  ${secret}\n`);
console.log("Printed once. Only its hash is stored, so nothing can recover it — seed again if it is lost.");
console.log("Whoever holds it can claim this Node and become its first administrator.");
