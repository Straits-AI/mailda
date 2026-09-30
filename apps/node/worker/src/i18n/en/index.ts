import { api } from "./api.ts";
import { chrome } from "./chrome.ts";
import { common } from "./common.ts";
import { inbox } from "./inbox.ts";
import { language } from "./language.ts";
import { palette } from "./palette.ts";
import { preauth } from "./preauth.ts";
import { settings } from "./settings.ts";
import { shell } from "./shell.ts";

/**
 * The source catalog: its literals are the type every other locale must match, and the parameter names a
 * call site must pass. `preauth` is bundled into `/app/locale.js`; `app` is served per locale.
 */
export { preauth };

/** Every `app` area, by name, so `test/node/catalog.test.ts` can check that none of them shadowed another. */
export const APP_AREAS = { common, language, chrome, palette, shell, inbox, settings, api } as const;

export const app = { ...common, ...language, ...chrome, ...palette, ...shell, ...inbox, ...settings, ...api } as const;
