import { BUDGETS } from "@mailda/budgets";
import { api } from "./support.mjs";

/**
 * Asking a person for an administrator's email and password, and checking them before going on (7 October 2026).
 *
 * `mailda upgrade` asked once, went on to the backup, and there `sessionCookie` stopped at the first 401, as it
 * should for a scheduled job whose credentials come from the environment: wrong credentials will be wrong on the
 * fourth try too. A person at a terminal is different. A mistyped password is the likeliest 401 there, and the
 * upgrade ended with "could not sign in" and had to be started again, backup prompt and all. So credentials typed
 * at a prompt are tried at once, and a refusal asks again.
 *
 * At most `PROMPT_ATTEMPTS` times, which stays well inside the Node's own lockout
 * (`auth.max_failed_logins_per_15min`, from `docs/receipts/password-hash-cost.md`): a person who has three
 * refusals in a row has the wrong address or has forgotten the password, and a fourth guess would only spend the
 * attempts the Node counts. The cap is a presentation choice, not a measurement.
 */
export const PROMPT_ATTEMPTS = 3;

/**
 * What to do with one sign-in's answer. Pure, so the whole decision is tested without a network or a terminal.
 *
 *   accept     the Node signed in; go on.
 *   retry      401, and attempts remain: ask again.
 *   give_up    401 on the last attempt.
 *   locked     429: the Node has locked this address. Asking again would not help, and would count.
 *   later      anything else (unreachable, 5xx): the credentials were not judged, so they are kept and the step
 *              that uses them, which retries such failures itself, reports what happens.
 */
export function afterSignIn(status, attempt, max = PROMPT_ATTEMPTS) {
  if (status !== null && status >= 200 && status < 300) return "accept";
  if (status === 401) return attempt < max ? "retry" : "give_up";
  if (status === 429) return "locked";
  return "later";
}

/** One sign-in attempt: the status, or null when the Node could not be reached, and its body when it gave one. */
async function tryOnce(origin, email, password, fetchImpl) {
  const answer = await fetchImpl(`${origin}${api("POST", "/api/auth/login")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);
  if (answer === null) return { status: null, body: null };
  const body = await answer.json().catch(() => null);
  return { status: answer.status, body };
}

/**
 * Asks for an administrator's email and password, tries them, and asks again on a refusal. Sets MAILDA_EMAIL and
 * MAILDA_PASSWORD for the steps that follow (`sessionCookie` reads them) and returns them.
 *
 * The email is offered again as the default on a retry, since a mistyped password is likelier than a mistyped
 * address. A locked address and a run out of attempts end the command through `fail`, naming what to do next.
 */
export async function askAdministrator(origin, { ask, readSecret, fail, out = (text) => process.stdout.write(text), fetchImpl = fetch, max = PROMPT_ATTEMPTS }) {
  let email = "";
  for (let attempt = 1; attempt <= max; attempt += 1) {
    const typed = (await ask(email === "" ? "   email: " : `   email [${email}]: `)).trim();
    email = typed === "" ? email : typed;
    const password = await readSecret("   password (not echoed): ");
    const { status, body } = await tryOnce(origin, email, password, fetchImpl);
    const next = afterSignIn(status, attempt, max);
    if (next === "accept" || next === "later") {
      process.env.MAILDA_EMAIL = email;
      process.env.MAILDA_PASSWORD = password;
      return { email, password };
    }
    if (next === "locked") {
      fail(`${origin} has locked sign-in for ${email}.\n\n`
        + `  why      ${typeof body?.message === "string" ? body.message : "too many failed sign-ins"}\n`
        + `  fix      wait, then run this again; the Node allows ${BUDGETS["auth.max_failed_logins_per_15min"]} failed sign-ins `
        + `in ${BUDGETS["auth.failed_login_window_seconds"] / 60} minutes`);
    }
    if (next === "retry") {
      out(`   ${origin} refused that email and password (try ${attempt} of ${max}); enter them again.\n`);
      continue;
    }
    fail(`${origin} refused the email and password ${max} times, so nothing was changed.\n\n`
      + `  why      the address is not an administrator of this Node, or the password is not theirs\n`
      + `  fix      check them, or set a new one with \`mailda set-password <email>\`; the Node locks an address after ${BUDGETS["auth.max_failed_logins_per_15min"]} failed sign-ins in `
      + `${BUDGETS["auth.failed_login_window_seconds"] / 60} minutes`);
  }
  return null;
}
