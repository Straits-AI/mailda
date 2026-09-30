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
 * Simplified Chinese (preview, `locales.ts`). Each area has the type of its English twin, so a missing or
 * extra key is a compile error in the area file that has it.
 */
export { preauth };

/** Every `app` area, by name, so `test/node/catalog.test.ts` can check that none of them shadowed another. */
export const APP_AREAS = { common, language, chrome, palette, shell, inbox, settings, api } as const;

export const app = { ...common, ...language, ...chrome, ...palette, ...shell, ...inbox, ...settings, ...api } as const;
