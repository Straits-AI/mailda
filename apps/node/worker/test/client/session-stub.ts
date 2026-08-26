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

type Handler = (call: Call) => Promise<Response> | Response;

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
let handler: Handler = () => Response.json({ draft: null });

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
  handler = () => Response.json({ draft: null });
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
  if (path.startsWith("/api/mailboxes")) return Response.json({ mailboxes });
  if (path.startsWith("/api/messages")) return Response.json({ messages });
  return await handler(call);
}

/** `session.client.js` exports this too, and `api.ts` imports it. Nothing here exercises a countdown. */
export function sessionExpiry(): number | null {
  return null;
}
