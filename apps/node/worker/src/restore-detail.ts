/**
 * Reading a persisted restore's detail — a leaf module, imported by both sides.
 *
 * `restoreDetail` lived in `doctor.ts`, which imports `recovery.ts`. When the conflict acknowledgement needed
 * to read the same field from the other direction, importing it back would have closed a cycle — the same one
 * `packages/contract/src/relations.ts` exists to break, whose symptom last time was a suite reporting *no
 * tests* rather than an error naming the loop.
 *
 * So it moves here rather than being copied. Two parsers of one stored shape would disagree the first time
 * that shape moved, and the disagreement would be an acknowledgement silently failing to match the collision
 * it was written for — which is precisely the thing the key is supposed to guarantee.
 */

/**
 * A persisted restore's detail, read defensively enough to survive a row this version did not write.
 *
 * The first version caught invalid JSON and then trusted the shape — so a row carrying `"content": 7` reached
 * `.map()` and took the whole diagnostic down with it. `doctor` is what somebody opens when things have
 * already gone wrong, and a disaster report that 500s on a malformed historical record is one that fails at
 * exactly the moment it is needed.
 *
 * Unreadable is a value, not an exception: the caller reports the record rather than the numbers.
 */
export function restoreDetail(raw: string | null): {
  restored: number; conflicted: string[]; error?: string; readable: boolean;
} {
  if (raw === null) return { restored: 0, conflicted: [], readable: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { restored: 0, conflicted: [], readable: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { restored: 0, conflicted: [], readable: false };

  const numbers = (part: unknown): number[] | null =>
    part === undefined ? []
      : Array.isArray(part) && part.every((n) => typeof n === "number") ? part
      : null;
  const side = (part: unknown): { content: number[]; credential: number[] } | null => {
    if (part === undefined) return { content: [], credential: [] };
    if (typeof part !== "object" || part === null) return null;
    const content = numbers((part as { content?: unknown }).content);
    const credential = numbers((part as { credential?: unknown }).credential);
    return content === null || credential === null ? null : { content, credential };
  };

  const restored = side((parsed as { restored?: unknown }).restored);
  const conflicted = side((parsed as { conflicted?: unknown }).conflicted);
  const error = (parsed as { error?: unknown }).error;
  if (restored === null || conflicted === null) return { restored: 0, conflicted: [], readable: false };
  return {
    restored: restored.content.length + restored.credential.length,
    conflicted: [
      ...conflicted.content.map((n) => `content ${n}`),
      ...conflicted.credential.map((n) => `credential ${n}`),
    ],
    ...(typeof error === "string" ? { error } : {}),
    readable: true,
  };
}

/**
 * The generations a restore reported as conflicted, in the one spelling every reader agrees on.
 *
 * Sorted and joined here rather than at each call site, because the acknowledgement and the check would
 * otherwise have to arrive at the same string independently — and an acknowledgement that fails to match its
 * own conflict is the exact failure the key exists to prevent.
 */
export function conflictKey(conflicted: readonly string[]): string {
  return [...conflicted].sort().join(",");
}
