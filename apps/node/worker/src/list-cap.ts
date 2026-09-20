/**
 * A list that stops at a cap says so (AGENTS.md §3: a limit you can hit is a limit you must see).
 *
 * The query asks for one row more than the cap. That extra row is never returned; its existence is the
 * `truncated` flag, which is what lets a reader tell "these are all" from "these are the newest N".
 */
export function capped<T>(rows: readonly T[], cap: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}
