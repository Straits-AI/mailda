import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { CallerError, conflict, unprocessable } from "../errors.ts";
import { boundAccount } from "./account-routing.ts";
import { cloudflareGetAll, cloudflarePost, operatorOf } from "./cloudflare-api.ts";

/**
 * The account's Email Routing destination addresses (ADR 47, 3 October 2026): read, and registered.
 *
 * A destination is account-wide and is somebody's own inbox, so what is read here goes to the administrator who asked
 * and nowhere else: never into an audit entry or a log, which carry counts and Cloudflare's id for one. Cloudflare
 * refuses to create a forward rule to an unverified destination, and `message.forward()` to one throws "destination
 * address not verified" (`docs/receipts/email-worker-forward.md`), so a kept forward needs its destination verified,
 * and only the person at the address can do that, by clicking the link Cloudflare mails them.
 *
 * Nothing here deletes a destination. A Node that registered one cannot tell who else relies on it (a forward rule
 * on another zone, another Node), so removing one is left to the dashboard.
 */

export type ListedState = "verified" | "waiting";
export interface Listed { email: string; state: ListedState }

/** One listing entry, read defensively: Cloudflare's documented test for verified is `verified` non-null. */
export interface Raw { email?: unknown; verified?: unknown; id?: unknown; tag?: unknown }
export const listedOf = (raw: Raw): Listed | null =>
  typeof raw.email === "string" && raw.email !== ""
    ? { email: raw.email, state: typeof raw.verified === "string" && raw.verified !== "" ? "verified" : "waiting" }
    : null;

/** The account's list, or why it could not be read. `accountId` null means no credential at all. */
export async function readDestinations(
  env: Env, ctx: Ctx, orgId: string,
): Promise<{ ok: true; accountId: string; listed: Listed[] } | { ok: false; error: string }> {
  const accountId = await boundAccount(env, ctx);
  if (accountId === null) return { ok: false, error: "this Node holds no Cloudflare token and no operator credential came with the request" };
  // A read that throws (a credential that cannot be unwrapped, an answer that is not a list) is could-not-read, said.
  const read = await cloudflareGetAll<Raw>(env, ctx, orgId, `/accounts/${accountId}/email/routing/addresses`)
    .catch((error: Error) => ({ ok: false as const, error: error.message }));
  if (!read.ok) return read;
  return { ok: true, accountId, listed: read.result.flatMap((one) => listedOf(one) ?? []) };
}

/** What a listing says of one address: ASCII-folded both sides, as SQLite's lower() and the rest of this Node fold. */
export function stateIn(listed: Listed[], address: string): ListedState | "absent" {
  const wanted = address.trim().toLowerCase();
  return listed.find((one) => one.email.toLowerCase() === wanted)?.state ?? "absent";
}

/** The permission the add needs, named in every refusal of it (AGENTS.md §3). */
export const ADDRESSES_EDIT = "Email Routing Addresses: Edit";

/**
 * Register `email` as a destination of the account. An address already listed is answered as listed and nothing is
 * sent, so asking twice never mails a second link. Cloudflare mails the link itself.
 */
export async function addDestination(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, email: string,
): Promise<{ email: string; state: ListedState; added: boolean }> {
  const wanted = email.trim();
  // The shape Cloudflare would be asked about, checked here so a typo is refused by name before anything is sent.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wanted)) {
    throw unprocessable("E_DESTINATION_ADDRESS_INVALID", {
      what: `${JSON.stringify(email)} is not an email address`,
      why: "a destination is one mailbox Cloudflare mails a verification link to",
      fix: "send { email } with the whole address, like someone@example.com",
    });
  }
  const read = await readDestinations(env, ctx, orgId);
  if (!read.ok) {
    throw conflict("E_DESTINATIONS_UNREADABLE", {
      what: "the account's Email Routing destination addresses could not be read",
      why: read.error,
      fix: `the token needs ${ADDRESSES_EDIT} (which includes reading them), or run it from \`mailda provider --add-destination\`, `
        + "which uses wrangler's login",
    });
  }
  const already = stateIn(read.listed, wanted);
  const authority = operatorOf(ctx) === null ? "token" : "operator";
  if (already !== "absent") return { email: wanted, state: already, added: false };

  let created: Raw;
  try {
    created = await cloudflarePost<Raw>(env, ctx, orgId, `/accounts/${read.accountId}/email/routing/addresses`, { email: wanted });
  } catch (error) {
    if (!(error instanceof CallerError)) throw error;
    // Recorded with Cloudflare's words and no address, then refused naming the permission: a missing scope is the
    // common cause, and Cloudflare's code for it was not measured on this endpoint, so every refusal names it.
    await auditedBatch(env, ctx, orgId, {
      action: "provider.destination_added", outcome: "refused", actorUserId, subject: read.accountId,
      // Cloudflare's words, with the address taken out should they quote it: the trail never names it.
      detail: { accountId: read.accountId, authority, error: error.message.split(wanted).join("<the address>") },
    }, (entry) => [entry]);
    throw unprocessable("E_DESTINATION_NOT_ADDED", {
      what: "Cloudflare did not register the destination address",
      why: error.message,
      fix: `check the credential carries ${ADDRESSES_EDIT} (GET /api/provider lists the permissions), or register it in the `
        + "Cloudflare dashboard (Email, Email Routing, Destination addresses)",
    });
  }
  const state = listedOf(created)?.state ?? "waiting";
  await auditedBatch(env, ctx, orgId, {
    action: "provider.destination_added", outcome: "ok", actorUserId,
    // Cloudflare's id for the destination, never the address: the trail is permanent and the address is somebody's.
    subject: typeof created.id === "string" ? created.id : typeof created.tag === "string" ? created.tag : read.accountId,
    detail: { accountId: read.accountId, authority, state },
  }, (entry) => [entry]);
  return { email: wanted, state, added: true };
}
