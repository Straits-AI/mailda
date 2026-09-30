import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { t } from "/app/locale.js";
import { isAppRoute } from "../../app-routes.ts";
import type { Text } from "../../i18n/format.ts";

/**
 * The document's title on a signed-in screen (WCAG 2.4.2): the screen, then the product, "Outbox · Mailda".
 * Every screen used to be titled "Mailda", so a tab, a history entry and a screen reader's first words said the
 * same thing everywhere.
 */
export function titleFor(path: string): Text {
  return isAppRoute(path) ? t("title.route", { screen: t(`route.${path}`), brand: t("brand.name") }) : t("brand.name");
}

/**
 * Sets the title on every navigation, and gives the page back its plain name when the shell unmounts: signing out
 * returns the page to the sign-in screen, which is titled for the product, not for the screen left behind.
 */
export function DocumentTitle(): null {
  const path = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => {
    document.title = titleFor(path);
    return () => { document.title = t("brand.name"); };
  }, [path]);
  return null;
}
