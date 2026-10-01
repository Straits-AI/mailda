import { agents } from "./agents.ts";
import { api } from "./api.ts";
import { approvals } from "./approvals.ts";
import { butlers } from "./butlers.ts";
import { chrome } from "./chrome.ts";
import { common } from "./common.ts";
import { composer } from "./composer.ts";
import { delivery } from "./delivery.ts";
import { doctor } from "./doctor.ts";
import { drafts } from "./drafts.ts";
import { inbox } from "./inbox.ts";
import { language } from "./language.ts";
import { ledgers } from "./ledgers.ts";
import { limits } from "./limits.ts";
import { matters } from "./matters.ts";
import { onboarding } from "./onboarding.ts";
import { palette } from "./palette.ts";
import { people } from "./people.ts";
import { policies } from "./policies.ts";
import { preauth } from "./preauth.ts";
import { queue } from "./queue.ts";
import { reader } from "./reader.ts";
import { settings } from "./settings.ts";
import { setup } from "./setup.ts";
import { shell } from "./shell.ts";
import { ui } from "./ui.ts";

/**
 * Simplified Chinese (preview, `locales.ts`). Each area has the type of its English twin, so a missing or
 * extra key is a compile error in the area file that has it.
 */
export { preauth };

/** Every `app` area, by name, so `test/node/catalog.test.ts` can check that none of them shadowed another. */
export const APP_AREAS = {
  common, language, chrome, palette, shell, inbox, settings, setup, api, reader, composer, drafts, queue, ledgers, doctor, delivery,
  onboarding, people, agents, approvals, matters, limits, butlers, policies, ui,
} as const;

export const app = {
  ...common, ...language, ...chrome, ...palette, ...shell, ...inbox, ...settings, ...setup, ...api,
  ...reader, ...composer, ...drafts, ...queue, ...ledgers, ...doctor, ...delivery,
  ...onboarding, ...people, ...agents, ...approvals, ...matters, ...limits, ...butlers, ...policies, ...ui,
} as const;
