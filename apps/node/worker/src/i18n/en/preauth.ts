import type { PreauthError } from "@mailda/contract/preauth-errors";

import type { Area } from "../areas.ts";

/**
 * A headline for every refusal code a page before sign-in can be shown (`PREAUTH_ERRORS`), so a code without
 * words, or words for no code, does not compile. The Node's own English is shown beside it, marked, unless it
 * begins with the headline, which is why a fixed sentence the Node sends is its headline here word for word
 * (`refusal()` in `src/client/app.client.js`).
 */
const refusals = {
  "preauth.refusal.already_claimed": "This Node has already been claimed. Sign in instead, or restore from backup to start over.",
  "preauth.refusal.bad_secret":
    "That bootstrap secret does not match. It was shown once by `mailda claim-secret`, and only its hash is stored — seed again if it is lost.",
  "preauth.refusal.not_installed": "This Node has no bootstrap secret recorded. Run `mailda deploy` to complete installation.",
  "preauth.refusal.weak_password": "That password is too short.",
  "preauth.refusal.not_claimed": "This Node has not been claimed yet.",
  "preauth.refusal.locked_out": "Too many failed sign-in attempts.",
  "preauth.refusal.invalid_credentials": "That email and password do not match.",
  "preauth.refusal.no_refresh_token": "Your session has ended. Please sign in again.",
  "preauth.refusal.expired": "Your session has ended. Please sign in again.",
  "preauth.refusal.unknown": "Your session has ended. Please sign in again.",
  "preauth.refusal.reuse_detected": "This session was signed out because its token was used twice. Sign in again.",
  "preauth.refusal.E_PASSKEY_REJECTED": "That passkey was not accepted.",
  "preauth.refusal.E_CHALLENGE_UNUSABLE": "This passkey sign-in can no longer be finished. Start again.",
  "preauth.refusal.E_CHALLENGE_ALREADY_SPENT": "This passkey sign-in was already used. Start again.",
  "preauth.refusal.E_INVITATION_UNUSABLE": "That invitation could not be used.",
  "preauth.refusal.E_WEAK_PASSWORD": "That password is too short.",
  "preauth.refusal.E_CROSS_SITE_REQUEST": "This Node refused a request that did not come from its own page.",
  "preauth.refusal.internal": "This Node failed to handle the request. Its operator can find this in the log.",
} as const satisfies Record<`preauth.refusal.${PreauthError}`, string>;

/**
 * Words the page needs before anybody signs in, bundled into `/app/locale.js` for every locale: the claim, the
 * recovery codes, sign-in and its passkey, the invitation, the status strip, the `<noscript>` notice
 * (`src/ui.ts`), and the refusal headlines above. Kept to those on purpose: `docs/receipts/react-shell-bundle.md`
 * counts these bytes as `shell.pre_auth_locale_bytes`.
 */
export const preauth = {
  "brand.name": "Mailda",

  "preauth.status.listening": "listening",
  "preauth.status.unclaimed": "unclaimed",
  "preauth.session.renewsIn": "session · renews in {time}",
  "preauth.session.renewing": "session · renewing",
  "preauth.session.renewed": "session · renewed",
  "preauth.session.notRenewed": "Your session could not be renewed. Please sign in again.",
  "preauth.language": "Language",

  "preauth.claim.title": "This Node is yours to claim.",
  "preauth.claim.lede":
    "It is running in your Cloudflare account, holding your data, under your keys. Nothing has been claimed yet, so it rejects incoming mail rather than filing it somewhere it cannot attribute.",
  "preauth.claim.heading": "First run",
  "preauth.claim.org": "Organization",
  "preauth.claim.orgExample": "Acme Logistics",
  "preauth.claim.email": "Owner email",
  "preauth.claim.emailHint": "You sign in with this email. Mail goes out from a mailbox's address, which setup chooses.",
  "preauth.claim.secret": "Claim secret",
  "preauth.claim.secretHint": "Shown once, by `mailda claim-secret`.",
  "preauth.claim.submit": "Claim this Node",
  "preauth.claim.busy": "Claiming…",
  "preauth.claim.failed": "Claim failed.",
  "preauth.password": "Password",
  "preauth.password.rule": "At least 12 characters. No character-class rules — length is what resists guessing.",

  "preauth.codes.title": "Write these down now.",
  "preauth.codes.lede":
    "These ten codes are the only way to recover this Node's keys. They open the escrow holding the content and credential keys — the ones that decrypt your mail — and they are shown here once. The Node keeps only a hash of each, so nothing, including us, can produce them again.",
  "preauth.codes.keep":
    "Put them somewhere that survives losing this computer and this Cloudflare account. A password manager, or paper in a different building. Each is single-use.",
  "preauth.codes.heading": "Recovery codes",
  "preauth.codes.once": "Shown once. Not recoverable.",
  "preauth.codes.next":
    "Next: run `mailda recovery-codes confirm` and type one back. That proves a person holds them — until it is done, this Node reports degraded, because ten codes nobody has read are the same as none.",
  "preauth.codes.saved": "I have saved these ten codes",

  "preauth.signin.title": "Shared inboxes that know who replied.",
  "preauth.signin.lede":
    "Every message that arrives here is kept byte for byte, encrypted at rest, and readable only by people you have granted access. Access is re-checked on every request — not carried in a token.",
  "preauth.signin.heading": "Sign in",
  "preauth.signin.email": "Email",
  "preauth.signin.submit": "Sign in",
  "preauth.signin.busy": "Signing in…",
  "preauth.signin.failed": "Sign-in failed.",
  "preauth.signin.passkey": "Sign in with a passkey",
  "preauth.signin.or": "or sign in with your password",
  "preauth.signin.invited": "I have an invitation",
  "preauth.passkey.waiting": "Waiting for your passkey…",
  "preauth.passkey.unsupported": "This browser has no passkey support. Sign in with your password.",
  "preauth.passkey.notStarted": "This Node could not start a passkey sign-in.",
  "preauth.passkey.silent": "This Node did not answer.",
  "preauth.passkey.failed": "That passkey was not accepted.",

  "preauth.join.title": "You have been invited.",
  "preauth.join.lede":
    "Paste the secret you were given and choose a password. Nobody else ever sees it — not even the administrator who invited you. You will arrive holding nothing until they grant you access to a mailbox.",
  "preauth.join.heading": "Join",
  "preauth.join.secret": "Invitation secret",
  "preauth.join.password": "Choose a password",
  "preauth.join.submit": "Join",
  "preauth.join.busy": "Joining…",
  "preauth.join.failed": "That invitation could not be used.",
  "preauth.join.member": "I already have an account",

  "preauth.unreachable": "Could not reach this Node: {reason}",
  "preauth.shell.failed":
    "The application could not be loaded ({reason}). This Node is running — /api/doctor and the original of every message are still reachable.",

  "preauth.noscript.title": "This page needs JavaScript.",
  "preauth.noscript.body":
    "Claiming a Node, signing in and reading the diagnostic all run in the browser. Nothing here is rendered on the server, so with scripting disabled this page can show you only this notice.",
  "preauth.noscript.doctor": "The diagnostic is available as plain text and needs no scripting: {link}.",

  ...refusals,
} as const satisfies Area<"preauth">;
