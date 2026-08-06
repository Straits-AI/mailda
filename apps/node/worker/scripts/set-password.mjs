#!/usr/bin/env node
/**
 * Sets a user's password from the operator's terminal.
 *
 * This exists because there is no other way. Mailda has no password-change flow — `setPassword` is
 * reachable only from the claim path — so a self-hosted operator who needs to rotate a credential has
 * nothing to reach for, and "reinstall the product" is not an answer. That gap deserves a real feature
 * (§28 admin); this is the operator tool that a self-hosted system needs regardless of whether the
 * product later grows a UI for it, because a lockout has to be recoverable from the outside.
 *
 * **The password is never passed as an argument and never echoed.** It is read from a TTY with echo
 * off, so it does not reach shell history, a process listing, or a terminal transcript. That is the
 * whole reason this is a script rather than a curl command.
 *
 * Usage, from the repository root:
 *
 *     node apps/node/worker/scripts/set-password.mjs <email>
 *
 * It derives the verifier locally using the *same* chained PBKDF2 the Worker uses — imported from
 * `src/auth/password.ts` rather than reimplemented, because a second implementation of a hash is a
 * second implementation to get subtly wrong — then writes it to the remote D1 catalog via wrangler.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { hashPassword } from "../src/auth/password.ts";

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const email = process.argv[2]?.trim().toLowerCase();
if (email === undefined || !email.includes("@")) {
  fail("usage: node apps/node/worker/scripts/set-password.mjs <email>");
}

/**
 * Reads a line with echo off.
 *
 * Raw mode and manual character handling rather than readline: readline echoes, and the usual trick for
 * silencing it reaches into a private field. This uses only public API, so it cannot break on a Node
 * upgrade — which matters for a tool whose failure mode is printing a password to the screen.
 */
function readSecret(prompt) {
  if (process.stdin.isTTY !== true) {
    fail("refusing to read a password from a pipe — run this in a terminal");
  }
  process.stdout.write(prompt);
  return new Promise((done, reject) => {
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const finish = (result, error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error !== undefined) reject(error); else done(result);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003") return finish(undefined, new Error("cancelled"));  // ctrl-c
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

/** One wrangler invocation, with the SQL passed via argv so nothing is written to a temp file. */
function d1(sql, params) {
  const args = ["wrangler", "d1", "execute", "CATALOG", "--remote", "--json", "--command", sql];
  for (const p of params ?? []) args.push("--param", p);
  const run = spawnSync("npx", args, { cwd: workerDir, encoding: "utf8" });
  const text = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const start = text.indexOf("[");
  if (start === -1) fail(`wrangler did not return a result:\n${text.slice(-600)}`);
  return JSON.parse(text.slice(start))[0].results;
}

const found = d1("SELECT id, email FROM users WHERE email = ? LIMIT 1", [email]);
if (found.length === 0) fail(`no user with email ${email} on this Node`);
const userId = found[0].id;

const first = await readSecret(`New password for ${email}: `);
if (first.length < 12) fail("refusing a password under 12 characters");
const again = await readSecret("Again: ");
if (first !== again) fail("the two entries did not match");

const verifier = await hashPassword(first);

// Every session is revoked in the same breath. A rotation that leaves the old sessions alive has not
// actually withdrawn anything — §28's requirement — and the whole point of rotating is that the
// previous credential is no longer trusted.
d1(
  `UPDATE users SET password_hash = ?, password_iterations = ?, password_updated_at = ? WHERE id = ?`,
  [verifier.encoded, String(verifier.effectiveIterations), new Date().toISOString(), userId],
);
d1(
  `UPDATE refresh_tokens SET revoked_at = ?, replaced_by_wrapped = NULL
     WHERE user_id = ? AND revoked_at IS NULL`,
  [new Date().toISOString(), userId],
);

console.log(`\nPassword set for ${email} (${userId}).`);
console.log(`Every existing session was revoked; sign in again.`);
console.log(`\nNot recorded in the audit trail: this ran outside the Worker, so the Node cannot`);
console.log(`attest to it. An operator with database access is outside what the chain can prove.`);
