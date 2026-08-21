import type { Ctx } from "@mailda/runtime";

import { auditedBatch, log } from "../audit.ts";
import { unprocessable } from "../errors.ts";
import {
  base64url, credentialById, relyingPartyFor, spendChallenge, type StoredCredential,
} from "./passkey.ts";
import { issueSession, sessionCookies, type IssuedSession } from "./session.ts";

/**
 * Finishing a WebAuthn ceremony (#84, ADR 29).
 *
 * Split from `passkey.ts` so the storage and the *verification* are separable: everything here reaches
 * `@simplewebauthn/server`, and everything there is D1. That matters for one practical reason — the library
 * is +128.9 KiB gzip (`passkey-verification.md`) and it is imported **dynamically**, so nothing on the mail
 * path pays for its initialization.
 *
 * ## The five checks, named, because omitting one is an auth bypass
 *
 * These are what the library performs and what this file must configure correctly. They are listed rather
 * than trusted, because a reader auditing this needs to know what to look for:
 *
 * 1. **The challenge was issued by this Node, for this ceremony, and has not been spent.** Enforced *before*
 *    the library is called — `spendChallenge` deletes the row and checks `changes`, so two redemptions of one
 *    challenge resolve to one winner. A library given a challenge it was simply handed would verify a replay
 *    happily.
 * 2. **The origin matches.** Derived from the request, so it cannot disagree with the browser.
 * 3. **The relying-party id hash matches.** Same source, same reason.
 * 4. **User presence.** Somebody touched the authenticator. `requireUserVerification` is deliberately
 *    *false* — see below.
 * 5. **The signature counter did not go backwards**, which is the spec's clone detector.
 *
 * ## `userVerification: "preferred"` rather than `"required"`, and it is a decision
 *
 * `required` means the authenticator must have verified the *person* — a PIN, a fingerprint, a face — and
 * not merely their presence. It is the stronger property and it is not required here, because a Node whose
 * only sign-in demanded it would lock out every security key without a PIN and every browser whose platform
 * authenticator is not set up. Passkeys are being made **primary**, and a primary mechanism that some
 * hardware cannot satisfy is a mechanism people route around by using the password fallback for ever.
 *
 * Stated as the trade it is: this Node accepts *possession of the authenticator* as the second factor and
 * does not require a third. The password path it replaces required neither.
 */

/**
 * Registration: verify the attestation, store the public key.
 *
 * The credential id is the authenticator's own and the primary key of `credentials`, so a re-registration of
 * the same authenticator collides — which is what `excludeCredentials` in the challenge exists to prevent,
 * and this is the refusal for a browser that ignored it.
 */
export async function finishPasskeyRegistration(
  env: Env,
  ctx: Ctx,
  request: Request,
  who: { orgId: string; userId: string },
  body: Record<string, unknown>,
): Promise<Response> {
  const rp = relyingPartyFor(request);
  const response = body.credential as Record<string, unknown> | undefined;
  const label = String(body.label ?? "").trim() || "passkey";
  if (response === undefined) {
    throw unprocessable("E_PASSKEY_NO_CREDENTIAL", {
      what: "no credential was submitted",
      why: "registration finishes by verifying what the authenticator produced, and there is nothing to "
        + "verify",
      fix: "post { credential, label } with the browser's PublicKeyCredential, JSON-serialised",
    });
  }

  // Spent *first*: an invalid attestation must not leave a usable challenge behind for a second attempt.
  const challenge = challengeFrom(response);
  await spendChallenge(env, ctx, challenge, "register");

  const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      // See the header: possession, not personhood.
      requireUserVerification: false,
    });
  } catch (error) {
    throw refusal((error as Error).message);
  }
  if (!verification.verified || verification.registrationInfo === undefined) {
    throw refusal("the authenticator's attestation did not verify");
  }

  const info = verification.registrationInfo;
  const at = new Date(ctx.now()).toISOString();
  const credentialId = info.credential.id;

  await auditedBatch<never>(
    env, ctx, who.orgId,
    {
      action: "auth.passkey_registered", outcome: "ok", actorUserId: who.userId, subject: who.userId,
      // The label and the credential id. Not the public key: it discloses nothing, and an audit entry
      // carrying material nobody reads is material somebody eventually parses.
      detail: { credentialId, label },
    },
    (entry) => [
      env.CATALOG.prepare(
        `INSERT INTO credentials
           (id, user_id, org_id, public_key, sign_count, transports, label, created_at, last_used_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
      ).bind(
        credentialId, who.userId, who.orgId, base64url(info.credential.publicKey),
        info.credential.counter, JSON.stringify(info.credential.transports ?? []), label, at,
      ),
      entry,
    ],
  );

  return Response.json({ registered: { id: credentialId, label, createdAt: at } });
}

/**
 * Authentication: verify the assertion, issue a session.
 *
 * **The credential id identifies the account.** Nothing in the request says who the caller is, which is what
 * keeps this route from answering *"does this address have a passkey"* — see the challenge route's note on
 * `allowCredentials`.
 */
export async function finishPasskeyAuthentication(
  env: Env,
  ctx: Ctx,
  request: Request,
  body: Record<string, unknown>,
): Promise<Response> {
  const rp = relyingPartyFor(request);
  const response = body.credential as Record<string, unknown> | undefined;
  if (response === undefined) throw refusal("no credential was submitted");

  const challenge = challengeFrom(response);
  await spendChallenge(env, ctx, challenge, "authenticate");

  const stored = await credentialById(env, String(response.id ?? ""));
  /*
   * An unknown credential and a bad signature are the **same refusal**, for `login`'s reason: distinguishing
   * them tells an anonymous caller whether a credential exists. There is no timing arm here the way there is
   * for passwords, because there is no derivation to skip — the verification either runs or there is nothing
   * to run it against, and both paths are one indexed read.
   */
  if (stored === null) throw refusal("that passkey is not registered on this Node");

  const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
      credential: {
        id: stored.id,
        // Copied into a fresh buffer: the librarys type requires a plain `ArrayBuffer` backing, and a
        // subarray view of one carries `ArrayBufferLike`.
        publicKey: new Uint8Array(fromBase64urlBytes(stored.publicKey)) as Uint8Array<ArrayBuffer>,
        counter: stored.signCount,
        transports: (stored.transports ?? undefined) as never,
      },
    });
  } catch (error) {
    throw refusal((error as Error).message);
  }
  if (!verification.verified) throw refusal("that signature did not verify");

  const at = new Date(ctx.now()).toISOString();
  const next = verification.authenticationInfo.newCounter;

  /*
   * The counter is stored as **max(old, new)**, and the check the library performs is *"did not decrease"*
   * rather than *"increased"*.
   *
   * Many platform authenticators — the syncing passkeys this ADR is actually about — report a constant 0
   * for ever, which is legitimate and explicitly permitted. Requiring an increase would reject them on their
   * second use, which is to say it would reject the format. The clone-detection property survives in the
   * weaker form: a counter that goes *backwards* still means two authenticators are answering for one
   * credential.
   */
  await env.CATALOG.prepare(
    "UPDATE credentials SET sign_count = MAX(sign_count, ?), last_used_at = ? WHERE id = ?",
  ).bind(next, at, stored.id).run();

  const session = await issueSession(env, ctx, { orgId: stored.orgId, userId: stored.userId });

  /*
   * Logged rather than audited, matching `auth.signed_in`'s treatment: a sign-in is an operational event and
   * the audit trail records acts on other people's things. The mechanism is recorded because *"which of the
   * two ways in was used"* is the question an operator investigating an account has, and ADR 29's whole
   * point is that one of them is meant to be rare.
   */
  await log(env, ctx, {
    level: "info",
    event: "auth.signed_in",
    message: `${stored.userId} signed in with a passkey`,
    detail: { userId: stored.userId, credentialId: stored.id, mechanism: "passkey" },
  });

  return sessionResponseFor(session, stored);
}

/** A refusal that says nothing about which part failed. See the note in `finishPasskeyAuthentication`. */
function refusal(detail: string): ReturnType<typeof unprocessable> {
  return unprocessable("E_PASSKEY_REJECTED", {
    what: "that passkey did not verify",
    why: "an unknown credential, a wrong origin, a stale challenge and a bad signature are one answer here "
      + "on purpose: telling an anonymous caller which it was hands them half of it (§5C). The Node's own "
      + `log records the detail: ${detail}`,
    fix: "try again, or sign in with your password and register this device",
  });
}

/**
 * The challenge the client claims to be answering, read out of `clientDataJSON`.
 *
 * Read here **only to look the row up**, and never trusted: `spendChallenge` proves this Node issued it, and
 * the library independently compares it against `expectedChallenge`. Reading it from the client is safe
 * exactly because both of those happen — a forged value finds no row.
 */
function challengeFrom(response: Record<string, unknown>): string {
  const client = (response.response as Record<string, unknown> | undefined)?.clientDataJSON;
  if (typeof client !== "string") throw refusal("the credential carried no clientDataJSON");
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64urlBytes(client))) as { challenge?: string };
    if (typeof parsed.challenge !== "string") throw new Error("no challenge");
    return parsed.challenge;
  } catch {
    throw refusal("the credential's clientDataJSON did not parse");
  }
}

function fromBase64urlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * The same cookies every other sign-in issues, from the same builder.
 *
 * `sessionCookies` is exported by `session.ts`, so this imports it rather than restating the contract — the
 * first draft of this file had a module-level function pointer wired in by `index.ts` to dodge a cycle that
 * does not exist. Sharing the builder is what makes the property true rather than likely: **nothing
 * downstream learns which mechanism signed you in**, because there is one place that knows how a session
 * becomes cookies.
 */
function sessionResponseFor(session: IssuedSession, credential: StoredCredential): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of sessionCookies(session)) headers.append("set-cookie", cookie);
  return new Response(
    JSON.stringify({
      signedIn: true,
      userId: session.userId,
      organizationId: session.orgId,
      accessExpiresAt: session.accessExpiresAt,
      // Which credential, so a person signing in on a new device sees which of theirs answered.
      credentialId: credential.id,
    }),
    { headers },
  );
}
