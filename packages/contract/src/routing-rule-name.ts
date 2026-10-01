/**
 * What a take-over writes into the Email Routing rule's own name, and reading it back (1 October 2026).
 *
 * A take-over replaces a rule's action with this Node's Worker. The action it had was recorded only on the Node's
 * audit trail, so a Node that was deleted took the only record of where the address used to go with it, and the
 * rule was left naming a Worker that no longer exists (critic H1 on the routing step). So the take-over also
 * writes the previous action into the rule's name, which Cloudflare keeps whatever happens to the Node, and
 * `mailda provider --put-back <rule id> --domain <d> --without-node` restores the action from it with the
 * operator's own token. The shape follows the name the live zone's admin@ rule was given by hand on 28 September
 * 2026, `mailda whymelabs.com (was info-worker-whymelabs, repointed 2026-09-28)`, with the action word added so a
 * forward and a Worker cannot be mistaken for each other.
 *
 * One module for the Worker that writes the name and the CLI that parses it, so the two cannot drift.
 */

/** The previous action, as a rule holds it: one type and at most one destination (Cloudflare documents one). */
export interface RecordedAction { action: string; destinations: string[] }

const SHAPE = /^mailda (\S+) \(was (forward|worker|drop)(?: (\S+))?, repointed (\d{4}-\d{2}-\d{2})\)$/;

/** `mailda <worker> (was <action>[ <destination>], repointed <YYYY-MM-DD>)`. */
export function takenOverName(worker: string, before: RecordedAction, at: Date): string {
  const to = before.destinations[0] === undefined ? "" : ` ${before.destinations[0]}`;
  return `mailda ${worker} (was ${before.action}${to}, repointed ${at.toISOString().slice(0, 10)})`;
}

/**
 * The action a take-over recorded in a rule's name, or null when the name is not one this module wrote. A
 * `drop` names no destination and the other two name exactly one, so a name that says otherwise is not read.
 */
export function recordedInName(name: string): (RecordedAction & { worker: string; at: string }) | null {
  const found = SHAPE.exec(name);
  if (found === null) return null;
  const [, worker, action, to, at] = found as unknown as [string, string, string, string | undefined, string];
  if ((action === "drop") !== (to === undefined)) return null;
  return { worker, action, destinations: to === undefined ? [] : [to], at };
}
