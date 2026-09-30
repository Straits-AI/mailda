import { Fragment, type ReactNode } from "react";

import { current, rich } from "/app/locale.js";
import type { Key, Source } from "../../i18n/catalog.ts";
import type { ArgsFor } from "../../i18n/format.ts";

/**
 * The one door for the Node's own English (ADR 46): an error's `message`, a doctor finding's `detail` or `fix`,
 * a breaker's sentence. The API stays English and byte-stable for the agents that parse it, so the interface
 * shows those words as they came, marked `lang="en"` (WCAG 3.1.2) so a screen reader reading a Chinese page
 * reads them with an English voice. In an English interface the mark would say nothing, so none is added and
 * the page is exactly what it was.
 *
 * Only words the Node wrote go in here, and they arrive as an expression. The untranslated-text check
 * (`test/node/untranslated.test.ts`) flags a literal inside this element like any other, because a literal is
 * the interface's own prose however it is marked. A failure whose words may be either the Node's or this
 * interface's fallback goes through `marked()` below, which asks.
 */
export function NodeWords({ children }: { children: ReactNode }): ReactNode {
  return current().locale === "en" ? children : <span lang="en">{children}</span>;
}

/**
 * A failure's words as they should be shown: inside `<NodeWords>` when the Node wrote them, as they are when this
 * interface did (`Said` in `api.ts`). An `Error` that is not a `ReadFailure` carries no `fromNode`: its words are
 * the browser's ("Failed to fetch"), not the Node's, and are shown unmarked.
 */
export function marked(what: { readonly message: string; readonly fromNode?: boolean }): ReactNode {
  return what.fromNode === true ? <NodeWords>{what.message}</NodeWords> : what.message;
}

/**
 * A message with elements inside it, in the translation's order: `sentence("key", { who: <strong>{name}</strong> })`.
 * The translation can move `{who}` and can never add an element, because a catalog value is text.
 */
export function sentence<K extends Key>(key: K, ...args: ArgsFor<Source[K], ReactNode>): ReactNode {
  return rich<K, ReactNode>(key, ...args).map((part, index) => <Fragment key={index}>{part}</Fragment>);
}
