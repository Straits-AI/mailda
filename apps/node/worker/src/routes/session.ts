import { ID_PREFIXES, idPattern } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { assertRoomForAnother, credentialsOf, forgetCredential, mintChallenge, relyingPartyFor } from "../auth/passkey.ts";
import { finishPasskeyAuthentication, finishPasskeyRegistration } from "../auth/passkey-verify.ts";
import { principalFor } from "../authz-read.ts";
import { assertAdmin, isAdmin } from "../access.ts";
import { inviteToOrganization, openInvitations, redeemInvitation } from "../invitations.ts";
import { publicJwks, rotateSigningKey } from "../auth/keys.ts";
import { cookieValue, login, refreshSession, revokeAllSessions, signOut, REFRESH_COOKIE } from "../auth/session.ts";
import { sessionResponse, signedOutResponse, unauthenticated, organizationId } from "./support.ts";
import type { Some } from "../router.ts";

export const session = {
  /**
   * Inviting somebody, and joining (#83).
   *
   * `POST /api/invitations` mints one; `GET` lists what is outstanding; `POST /api/invitations/redeem`
   * turns a secret into an account. The redeem route is the **only** unauthenticated write in this
   * section, and deliberately so: the person using it has no account yet, which is the whole point. Its
   * refusal says nothing about why, for `claimNode`'s reason — distinguishing "no such invitation" from
   * "expired" is an oracle for guessing, and the second would confirm who was invited.
   */
  "POST /api/invitations": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Response.json({
      invitation: await inviteToOrganization(
        env, clock, who.orgId, who.userId, String(body.email ?? ""),
      ),
    });
  },

  "DELETE /api/invitations/:invitationId": async ({ env, clock, params, who }) => {
    const { revokeInvitation } = await import("../invitations.ts");
    return Response.json(await revokeInvitation(env, clock, who.orgId, who.userId, params.invitationId));
  },

  "GET /api/invitations": async ({ env, clock, who }) => {
    if (!(await isAdmin(env, who.orgId, who.userId))) {
      // §5C, as with `/api/people`: who has been invited and not yet arrived is the same shape of fact.
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ invitations: await openInvitations(env, clock, who.orgId) });
  },

  "POST /api/invitations/redeem": async ({ request, env, clock }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const joined = await redeemInvitation(
      env, clock, String(body.secret ?? ""), String(body.password ?? ""),
    );
    /*
     * Signed in on the way out, the same as the claim.
     *
     * Somebody who has just chosen a password and been told "now sign in" would type it again immediately,
     * and a redemption that left them at a sign-in form would make the first thing they do with the product
     * a second authentication for no reason.
     */
    // `sessionResponse`, the same helper the claim uses — one place that knows how a session becomes
    // cookies, rather than a second spelling of the contract the client depends on.
    return sessionResponse({ joined: true, userId: joined.userId, email: joined.email }, joined.session);
  },

  // ---- Session lifecycle -------------------------------------------------------------
  //
  // The client contract, stated once here because getting it wrong is what produces the
  // symptom nobody should ever see — a working session that surfaces a 401:
  //
  //   every 401 from this Node carries `refreshable: true | false`.
  //
  // `true` means the access token expired or is unverifiable and a refresh is worth trying.
  // `false` means the refresh token itself is gone, and the only honest next step is the
  // sign-in form. A client that cannot tell these apart either retries forever or signs
  // people out for a recoverable reason.
  "POST /api/auth/login": async ({ request, env, clock }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, string>;
    const orgId = await organizationId(env);
    if (orgId === null) {
      return Response.json(
        { error: "not_claimed", message: "This Node has not been claimed yet." },
        { status: 503 },
      );
    }

    const outcome = await login(env, clock, orgId, body.email ?? "", body.password ?? "");
    if (outcome.status === "locked_out") {
      return Response.json(
        {
          error: "locked_out",
          message:
            `Too many failed sign-in attempts. Try again in ` +
            `${Math.ceil(outcome.retryAfterSeconds / 60)} minute(s).`,
        },
        { status: 429, headers: { "retry-after": String(outcome.retryAfterSeconds) } },
      );
    }
    if (outcome.status !== "signed_in") {
      // `no_password_set` is a genuinely different state internally, and it is collapsed here
      // on purpose: telling an anonymous caller that an address exists but has no password
      // hands them half the answer. §5C's rule about denials applies to sign-in too.
      return Response.json(
        { error: "invalid_credentials", message: "That email and password do not match." },
        { status: 401, headers: { "x-mailda-refreshable": "false" } },
      );
    }
    return sessionResponse(
      { signedIn: true, userId: outcome.session.userId, organizationId: outcome.session.orgId },
      outcome.session,
    );
  },

  /**
   * Passkeys (#84, ADR 29).
   *
   * `POST /api/auth/passkeys/challenge`  a challenge for either ceremony. Unauthenticated for `authenticate`
   * `POST /api/auth/passkeys`            finish registration: verify the attestation, store the public key
   * `POST /api/auth/passkeys/verify`     finish authentication: verify the assertion, issue a session
   * `GET  /api/auth/passkeys`            the credentials this account holds
   * `DELETE /api/auth/passkeys`          revoke one
   *
   * **The relying party comes from `request.url`**, never from configuration. WebAuthn binds a credential
   * to an origin, and a stored relying-party id can disagree with the origin the browser is actually on —
   * at which point every ceremony fails with a mismatch nobody can act on. Deriving it makes the
   * disagreement unrepresentable, and it keeps the repository free of the customer-specific value ADR 24
   * forbids. `src/auth/passkey.ts` carries the argument.
   */
  "POST /api/auth/passkeys/challenge": async ({ request, env, clock }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const purpose = body.purpose === "register" ? "register" : "authenticate";
    const rp = relyingPartyFor(request);

    if (purpose === "register") {
      // Registration is an authenticated act: it adds a way into an account that already exists.
      const who = await principalFor(env, clock, request);
      if (who === null) return unauthenticated();
      await assertRoomForAnother(env, who.orgId, who.userId);
      const challenge = await mintChallenge(env, clock, "register", who);
      const existing = await credentialsOf(env, who.orgId, who.userId);
      return Response.json({
        publicKey: {
          challenge,
          rp: { id: rp.id, name: rp.name },
          /*
           * The user handle is the `usr_` id and never the email address. WebAuthn stores this on the
           * authenticator, where it is readable by anything that can prompt for a credential — so putting
           * an address there would publish the account's email to every site that asks.
           */
          user: { id: who.userId, name: who.userId, displayName: who.userId },
          pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }],
          // `none`: this Node has no policy that depends on what kind of authenticator this is, so asking
          // would collect a device fingerprint it cannot use and ask the user to consent to disclosing it.
          attestation: "none",
          authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
          // So a browser does not offer a key this account already holds.
          excludeCredentials: existing.map((credential) => ({
            id: credential.id, type: "public-key", transports: credential.transports ?? undefined,
          })),
          timeout: BUDGETS["auth.passkey_challenge_ttl_seconds"] * 1000,
        },
      });
    }

    /*
     * Authentication is **unauthenticated by definition**, and it deliberately names no credentials.
     *
     * An `allowCredentials` list would require the caller to say who they are first, which would make this
     * route answer *"does this address have a passkey"* to anybody who asked — the user-enumeration leak
     * `login` goes to some trouble to avoid. A discoverable credential lets the authenticator choose, and
     * the credential id it returns is what identifies the account.
     */
    const challenge = await mintChallenge(env, clock, "authenticate", null);
    return Response.json({
      publicKey: {
        challenge,
        rpId: rp.id,
        userVerification: "preferred",
        timeout: BUDGETS["auth.passkey_challenge_ttl_seconds"] * 1000,
      },
    });
  },

  "POST /api/auth/passkeys": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return await finishPasskeyRegistration(env, clock, request, who, body);
  },

  "POST /api/auth/passkeys/verify": async ({ request, env, clock }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return await finishPasskeyAuthentication(env, clock, request, body);
  },

  "GET /api/auth/passkeys": async ({ env, who }) => {
    const held = await credentialsOf(env, who.orgId, who.userId);
    return Response.json({
      // Public keys are not returned. They disclose nothing, and a list screen has no use for them —
      // sending them anyway would be a habit of returning whatever the row holds.
      passkeys: held.map((credential) => ({
        id: credential.id,
        label: credential.label,
        createdAt: credential.createdAt,
        lastUsedAt: credential.lastUsedAt,
        transports: credential.transports,
      })),
    });
  },

  "DELETE /api/auth/passkeys": async ({ request, env, clock, who }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const credentialId = String(body.credentialId ?? "");
    // The entry rides in the delete's own transaction — see `forgetCredential`. A revocation that
    // committed without its record would be the one an operator later cannot prove they performed.
    await forgetCredential(env, clock, who.orgId, who.userId, credentialId);
    return Response.json({ forgotten: true });
  },

  "POST /api/auth/refresh": async ({ request, env, clock }) => {
    const presented = cookieValue(request, REFRESH_COOKIE) ?? "";
    if (presented === "") {
      return signedOutResponse("no_refresh_token", "Your session has ended. Please sign in again.");
    }

    const outcome = await refreshSession(env, clock, presented);
    if (outcome.status === "rotated" || outcome.status === "replayed") {
      return sessionResponse(
        {
          refreshed: true,
          // Surfaced rather than hidden: `replayed` means this Node handed back a successor it
          // had already issued, and an operator debugging a client's refresh behaviour needs
          // to be able to see that happening.
          replayed: outcome.status === "replayed",
          userId: outcome.session.userId,
          organizationId: outcome.session.orgId,
        },
        outcome.session,
      );
    }
    // Every remaining case is terminal: the refresh token is unknown, expired, or the family
    // was revoked because it was presented twice outside the replay window. None of them are
    // retryable, and the cookies are cleared so a client cannot loop on a dead token.
    return signedOutResponse(
      outcome.status,
      outcome.status === "reuse_detected"
        ? "This session was signed out because its token was used twice. Sign in again."
        : "Your session has ended. Please sign in again.",
    );
  },

  "POST /api/auth/logout": async ({ request, env, clock }) => {
    const presented = cookieValue(request, REFRESH_COOKIE);
    if (presented !== null && presented !== "") await signOut(env, clock, presented);
    return signedOutResponse("signed_out", "Signed out.");
  },

  "POST /api/auth/logout-everywhere": async ({ env, clock, who }) => {
    const revoked = await revokeAllSessions(env, clock, who.orgId, who.userId);
    return signedOutResponse("signed_out", `Signed out of ${revoked} session(s).`);
  },

  // Public keys. Verification never requires a secret — that is the point of ES256 over
  // HS256, and publishing them is what keeps it true.
  "GET /.well-known/jwks.json": async ({ env, clock }) => {
    return Response.json(await publicJwks(env, clock.now()), {
      headers: { "cache-control": `max-age=${BUDGETS["auth.signing_key_cache_seconds"]}` },
    });
  },

  // Rotation. Owner-authenticated, because it is an ordinary operation that should be easy to
  // perform — a rotation procedure nobody can run is a key that never rotates.
  "POST /api/auth/rotate-signing-key": async ({ env, clock, who }) => {
    /*
     * The comment here called this owner-authenticated and the code enforced *signed in*. Repeated rotation
     * walks the verification window forward until sessions signed by retired keys stop verifying, which is
     * a sign-out for the organization performed by one member.
     *
     * **Step-up is not built** and this does not pretend otherwise: ADR 29's re-authentication ceremony
     * would be the right second factor for an act of this weight, and `org.admin` is what exists today.
     * Said here rather than left as a gap somebody assumes is covered.
     */
    await assertAdmin(env, who.orgId, who.userId);
    const rotated = await rotateSigningKey(env, clock);
    return Response.json({
      rotated: true,
      kid: rotated.kid,
      // Named explicitly so the operator can see that outstanding tokens keep working.
      retiring: rotated.retired,
      stillVerifiesForSeconds: BUDGETS["auth.signing_key_verify_grace_seconds"],
    });
  },

  "GET /api/me": async ({ env, who }) => {
    /*
     * A **principal**, not a user. An agent holding `identity.read` reaches this route, and answering with
     * `userId: "agt_…"` violated the route's own contract in the one place a caller asks who it is.
     *
     * The kind is derived from the identifier's typed prefix, the way `kindOfActor` derives an actor's —
     * so a new principal kind is a branch here rather than a field every caller has to start sending.
     */
    const person = who.delegatorUserId ?? (idPattern(ID_PREFIXES.user).test(who.userId) ? who.userId : null);
    const machine = !idPattern(ID_PREFIXES.user).test(who.userId);
    // The email belongs to the person, not to the credential: an agent has none, and its sponsor's is the
    // sponsor's to disclose elsewhere.
    const user = machine ? null : await env.CATALOG.prepare(
      "SELECT email FROM users WHERE id = ? LIMIT 1",
    ).bind(who.userId).first<{ email: string }>();
    return Response.json({
      signedIn: true,
      principalId: who.userId,
      principalKind: machine ? "agent" : "user",
      userId: machine ? null : who.userId,
      delegatorUserId: machine ? person : null,
      organizationId: who.orgId,
      email: user?.email ?? null,
    });
  },
} satisfies Some;
