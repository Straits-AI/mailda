/**
 * Client-side session lifecycle.
 *
 * The whole job of this file is that a signed-in user never sees a 401 caused by ordinary token
 * expiry. An access token lives ten minutes; a session lives thirty days; nothing about that
 * should ever be visible.
 *
 * Five things have to be true for that, and each is a separate failure mode:
 *
 *  1. **Refresh ahead of expiry, not after it.** Waiting for a 401 means every ten minutes one
 *     request fails first. The token's expiry is published in a non-secret cookie precisely so
 *     the page can see it coming.
 *
 *  2. **One refresh at a time, across tabs.** Refresh tokens rotate, so two simultaneous
 *     refreshes present the same token twice — and the server reads a second presentation as
 *     theft. Getting this wrong signs the user out *because* they had two tabs open. A Web Lock
 *     serialises across tabs of the origin; the promise below serialises within one.
 *
 *  3. **Recheck inside the lock.** The tab that waited usually finds the token already renewed
 *     by the tab that went first, and must then do nothing at all rather than refresh again.
 *
 *  4. **Wake-ups, because timers stop.** A background tab's timers are throttled and a sleeping
 *     laptop's do not run. A timer alone means a session that looks fine and is not. Every
 *     return to visibility, focus, network, or history restore rechecks.
 *
 *  5. **Distinguish "retry" from "over".** A 401 whose `x-mailda-refreshable` is `false` means
 *     the session is genuinely finished and the honest response is the sign-in form. Treating
 *     the two alike gives either an infinite retry loop or a spurious sign-out.
 *
 * Deliberately *not* handled: retrying a request whose body is a stream. Exactly one retry
 * happens after a refresh, and a used-up stream cannot be replayed. Every caller here sends a
 * string body; a future streaming upload has to buffer or re-create its body itself, and this
 * comment is where that constraint is recorded rather than discovered.
 */

/*
 * Imported rather than read off `window`, which is what it was until #97.
 *
 * The values arrived in an inline `<script>` setting MAILDA_CONFIG on the window, and an inline script is the
 * one thing a Content-Security-Policy worth having cannot permit. `/app/config.js` is the same two values
 * as a same-origin module, so `script-src 'self'` covers it. Static, not dynamic: these are read at module
 * evaluation, and a `fetch` here would make the token lifecycle either wait on a request or start with the
 * wrong margin — in the file whose whole job is that nobody sees a 401 from ordinary expiry.
 *
 * The `?? 120` and `?? "mailda_at_exp"` defaults went with the global. They existed because a `window`
 * property may not be there; an import cannot be missing without the module failing loudly, which is the
 * honest failure for "the interface does not know when its own token expires".
 */
import { CONFIG } from "./config.js";

/** From `docs/receipts/password-hash-cost.md`, handed down by the server rather than guessed. */
const REFRESH_MARGIN_MS = CONFIG.refreshMarginSeconds * 1000;
const EXPIRY_COOKIE = CONFIG.expiryCookie;

let inFlight = null;
let timer = null;
let clockSkewMs = 0;
const listeners = new Set();

/**
 * Server time minus client time.
 *
 * The expiry is a server timestamp compared against a client clock, and those disagree. A client
 * running fast refreshes early, which costs nothing. A client running slow would refresh late —
 * so the reactive 401 path stays in place as the backstop rather than being replaced by the
 * proactive one. Both directions are covered; neither alone is enough.
 */
function now() {
  return Date.now() + clockSkewMs;
}

function noteServerTime(response) {
  const header = response.headers.get("date");
  if (header === null) return;
  const serverTime = Date.parse(header);
  if (Number.isFinite(serverTime)) clockSkewMs = serverTime - Date.now();
}

/** The published expiry. Not a credential — one integer, readable by design. */
export function accessExpiresAt() {
  const match = new RegExp("(?:^|;\\s*)" + EXPIRY_COOKIE + "=([^;]*)").exec(document.cookie);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function isSignedIn() {
  return accessExpiresAt() !== null;
}

function needsRefresh() {
  const expiresAt = accessExpiresAt();
  return expiresAt !== null && expiresAt - REFRESH_MARGIN_MS <= now();
}

/** Serialises across tabs where Web Locks exist, and degrades to in-tab only where they do not. */
async function withLock(run) {
  if (navigator.locks?.request === undefined) return run();
  return navigator.locks.request("mailda-refresh", run);
}

function emit(event) {
  for (const listener of listeners) listener(event);
}

export function onSessionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Refreshes, once. Concurrent callers — in this tab or another — join the same attempt rather than
 * starting a second one.
 *
 * ## Why `force` exists
 *
 * There are two reasons to refresh and they need different skip rules.
 *
 * **Proactive** (`force: false`): the published expiry is close. If another tab got there first the
 * right answer is to do nothing, because refreshing a token that was just replaced is what trips
 * reuse detection.
 *
 * **Reactive** (`force: true`): the server rejected the access token. Its *expiry* may be nowhere
 * near — a signing key was withdrawn, a key aged past its verification window, a backup was
 * restored, the token was minted by a Node that has since been re-keyed. `needsRefresh()` looks at
 * the clock and says everything is fine, and it is wrong.
 *
 * The first version had only the proactive rule, so every non-expiry 401 was unrecoverable: the
 * client short-circuited, retried with the same dead token, got 401 again, and told nobody. The page
 * then showed "you are not signed in" above a session countdown that was still ticking.
 *
 * A forced refresh still has one legitimate skip, and `seenExpiry` is how it is detected: if the
 * published expiry has changed since the caller decided to force, some other tab has already
 * replaced the token and this attempt would rotate for nothing. The expiry is readable, so this
 * works without ever seeing the token itself.
 */
export async function refresh({ force = false, seenExpiry = null } = {}) {
  if (inFlight !== null) {
    const joined = await inFlight;
    // A joined attempt that decided to skip has not helped a caller who needs a *new* token.
    if (!force || joined.skipped !== true) return joined;
  }
  return startRefresh(force, seenExpiry);
}

function startRefresh(force, seenExpiry) {
  inFlight = withLock(async () => {
    const currentExpiry = accessExpiresAt();

    if (!force) {
      // The waiting tab's most common outcome: the tab ahead already renewed, so there is nothing
      // left to do.
      if (currentExpiry !== null && !needsRefresh()) return { ok: true, skipped: true };
    } else if (seenExpiry !== null && currentExpiry !== seenExpiry) {
      // Someone else replaced the token while we queued for the lock. That is the only safe reason
      // to skip a forced refresh.
      return { ok: true, skipped: true };
    }

    const response = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
    noteServerTime(response);

    if (response.ok) {
      scheduleRefresh();
      emit({ type: "refreshed" });
      return { ok: true, skipped: false };
    }

    const body = await response.json().catch(() => ({}));
    // The server has already cleared the cookies. Nothing is retryable from here.
    stop();
    emit({ type: "signed-out", reason: body.error ?? "session_ended", message: body.message });
    return { ok: false, reason: body.error ?? "session_ended", message: body.message };
  }).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Refreshes only if the token is inside the margin. Cheap enough to call before any request. */
export async function ensureFresh() {
  if (!isSignedIn()) return { ok: false, reason: "signed_out" };
  if (!needsRefresh()) return { ok: true, skipped: true };
  return refresh();
}

function scheduleRefresh() {
  clearTimeout(timer);
  const expiresAt = accessExpiresAt();
  if (expiresAt === null) return;
  // Fires at expiry-minus-margin, or immediately if that moment has already passed.
  const delay = Math.max(0, expiresAt - REFRESH_MARGIN_MS - now());
  timer = setTimeout(() => {
    refresh().catch(() => {
      /* A failed refresh has already emitted signed-out. Nothing to add. */
    });
  }, delay);
}

export function stop() {
  clearTimeout(timer);
  timer = null;
}

/**
 * The authenticated fetch. Proactive refresh first, then exactly one retry if the response is a
 * 401 the server says is refreshable.
 */
export async function apiFetch(path, init = {}) {
  await ensureFresh();

  const request = { credentials: "same-origin", ...init };
  let response = await fetch(path, request);
  noteServerTime(response);
  if (response.status !== 401) return response;

  if (response.headers.get("x-mailda-refreshable") === "false") {
    stop();
    const body = await response.clone().json().catch(() => ({}));
    emit({ type: "signed-out", reason: body.error ?? "session_ended", message: body.message });
    return response;
  }

  // Forced: the token was rejected, and its expiry is not evidence about why.
  const refreshed = await refresh({ force: true, seenExpiry: accessExpiresAt() });
  if (!refreshed.ok) return response;

  response = await fetch(path, request);
  noteServerTime(response);

  // A 401 that survives a *successful* refresh is not recoverable, and the page must not be left
  // showing a live session above a signed-out screen. Say the session is over, once.
  if (response.status === 401) {
    stop();
    emit({
      type: "signed-out",
      reason: "refresh_did_not_help",
      message: "Your session could not be renewed. Please sign in again.",
    });
  }
  return response;
}

/**
 * Wake-ups. A throttled or suspended timer is the ordinary case, not the exception — a laptop
 * that slept for an hour wakes with a token that expired 50 minutes ago and a timer that never
 * fired. Each of these events means "you may have missed time".
 */
export function start() {
  scheduleRefresh();

  /**
   * Deliberately **not** gated on `document.visibilityState`.
   *
   * The first version skipped the work whenever the document reported hidden, which was wrong in
   * two ways. It discarded the *reschedule* as well as the refresh, so a tab could sit on a stale
   * timer indefinitely. And "hidden" is not the same as "nobody needs this session": a page can
   * report hidden while focused (every automated browser does), a background tab regaining network
   * still wants its session alive, and `pageshow` fires before a restored page is painted.
   *
   * Nothing is saved by the guard either. Concurrent rechecks collapse into one attempt through the
   * Web Lock, and the recheck inside the lock means a tab that finds the token already renewed does
   * nothing at all. The expensive case was already impossible.
   */
  const recheck = () => {
    scheduleRefresh();
    ensureFresh().catch(() => {});
  };

  document.addEventListener("visibilitychange", recheck);
  window.addEventListener("focus", recheck);
  window.addEventListener("online", recheck);
  // Restored from the back/forward cache: the page resumes with stale timers and stale state.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) recheck();
  });
}

/** Records a session the page just received, so timers start without waiting for a reload. */
export function adopt() {
  scheduleRefresh();
  emit({ type: "signed-in" });
}

export async function logout() {
  stop();
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  emit({ type: "signed-out", reason: "signed_out" });
}
