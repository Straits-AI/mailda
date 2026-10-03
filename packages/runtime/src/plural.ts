/**
 * The Node's own English agreeing with a count: `${n} ${plural(n, "message is", "messages are")} waiting`.
 * Both forms are written out, because a suffix rule gets "person", "address" and every verb wrong, and the
 * sentence used to say `message(s)` instead. The Worker, the CLI and the Butler compiler share it. This is the
 * English agents read byte-for-byte; the interface's words are plurals in its catalog
 * (`apps/node/worker/src/i18n/format.ts`), chosen by CLDR category per locale.
 */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}
