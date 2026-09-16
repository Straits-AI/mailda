import type { Handlers } from "../router.ts";

import { access } from "./access.ts";
import { butlers } from "./butlers.ts";
import { governance } from "./governance.ts";
import { machine } from "./machine.ts";
import { mail } from "./mail.ts";
import { node } from "./node.ts";
import { provider } from "./provider.ts";
import { sending } from "./sending.ts";
import { session } from "./session.ts";

/**
 * One handler per registered route, grouped by the part of the product each belongs to.
 *
 * `Handlers` is a mapped type over the registry, so this literal fails to compile when a registered route
 * has no handler; each part is `satisfies Some`, so a handler for a route the registry does not know fails
 * there. The one property a type cannot see is two parts naming the same key — a spread keeps the later one
 * silently — and `test/node/route-table.test.ts` counts for it.
 */
export const HANDLERS: Handlers = {
  ...access, ...butlers, ...governance, ...machine, ...mail, ...node, ...provider, ...sending, ...session,
};
