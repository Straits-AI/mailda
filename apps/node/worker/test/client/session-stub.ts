/**
 * Stands in for `/app/session.js` when a component is rendered in a test.
 *
 * That path is a browser-absolute specifier the bundler leaves external (`build-client.mjs`), so under
 * vitest it resolves to nothing unless something says what it is. `vitest.client.config.ts` aliases it
 * here.
 *
 * **A stub rather than the real `session.client.js`**, and the reason is the point of the suite: these
 * tests are about *when* a request is made and *whether* one was made at all. Handing them a real
 * `apiFetch` would put a network at the centre of an assertion about a timer. What they need is a seam
 * they can count calls through and resolve at a moment of their choosing, which is what this is.
 */

export interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

/** Every call made since the last `reset`, in order. The assertion surface. */
export const calls: Call[] = [];

/**
 * What a test answers a call with.
 *
 * `undefined` means **not mine** — fall through to the built-in defaults for the mailbox list and the inbox.
 * That is what lets a suite answer one path explicitly without having to reproduce every other path the
 * screen it mounts happens to fetch.
 */
type Handler = (call: Call) => Promise<Response | undefined> | Response | undefined;

/** The default mailbox list: one, with one address, so nothing has to be chosen. */
export interface StubMailbox {
  id: string;
  name: string;
  addresses: string | null;
}

const ONE_MAILBOX: StubMailbox[] = [{ id: "mbx_test", name: "Support", addresses: "support@example.test" }];

let mailboxes: StubMailbox[] = ONE_MAILBOX;
/** The inbox list. Empty by default, which is the state most of these tests are about. */
let messages: unknown[] = [];
let handler: Handler = () => undefined;

/**
 * What every call other than the mailbox list answers.
 *
 * The mailbox list is handled separately because it is **scenery** for most tests: `useMailboxes` runs on
 * mount whatever the test is about, and a suite where every handler had to remember to answer it would
 * fail with a render error instead of the assertion it was written for. `answerMailboxes` is there for the
 * tests where the list *is* the subject.
 */
export function answerWith(next: Handler): void {
  handler = next;
}

/**
 * Answer the draft routes and nothing else.
 *
 * `answerWith` hands a test *every* call, which is right when a suite wants control of the whole surface
 * and wrong when it only cares about one route — a blanket handler silently answers `/api/mailboxes` too,
 * and the screen then renders with no mailbox and fails somewhere unrelated to what the test is about.
 * Naming the path is how a test says what it means.
 */
export function answerDrafts(next: (call: Call) => Promise<Response> | Response): void {
  handler = (call) => (call.path.startsWith("/api/drafts") ? next(call) : undefined);
}

export function answerMailboxes(rows: StubMailbox[]): void {
  mailboxes = rows;
}

export function answerMessages(rows: unknown[]): void {
  messages = rows;
}

export function reset(): void {
  calls.length = 0;
  mailboxes = ONE_MAILBOX;
  messages = [];
  handler = () => undefined;
}

/**
 * The seam.
 *
 * Records the call before awaiting the handler, so a test that never resolves its handler can still
 * assert the request was *made* — which is the difference between "the save is in flight" and "the save
 * never happened", and those are the two states #90 is about telling apart.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const call: Call = {
    path,
    method: init.method ?? "GET",
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
  };
  calls.push(call);
  /*
   * **The test's own handler wins.** The defaults below are scenery for the suites that do not care about
   * these two paths, and for a while they were consulted *first* — which silently stole `/api/messages`
   * from a test that had explicitly answered it with `answerWith`, so that test rendered an empty inbox and
   * failed looking for a message it had supplied. A default that overrides an explicit instruction is not a
   * default.
   *
   * `answered` is how the fallback is distinguished from a handler that genuinely wants to return nothing:
   * a handler may return `undefined` to mean "not mine, use the default".
   */
  const answered = await handler(call);
  if (answered !== undefined) return answered;
  if (path.startsWith("/api/mailboxes")) return Response.json({ mailboxes });
  if (path.startsWith("/api/messages")) return Response.json({ messages });
  return Response.json({ draft: null });
}

/** `session.client.js` exports this too, and `api.ts` imports it. Nothing here exercises a countdown. */
export function sessionExpiry(): number | null {
  return null;
}
