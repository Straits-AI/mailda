import { useState } from "react";

import { LOCALE_FLAG, chooseLocale, current, storedLocale, t } from "/app/locale.js";
import { OFFERED, localeEntry, type Locale } from "../../../i18n/locales.ts";
import type { Said } from "../api.ts";
import { useCompose } from "../shell-context.tsx";
import { marked, sentence } from "../words.tsx";

/**
 * Settings > Language: the interface's language for this viewer in this browser (ADR 46), beside Appearance
 * and built the same way.
 *
 * **Only offered locales are listed.** A preview locale (`locales.ts`) is reachable through its review flag and
 * nowhere else, so no viewer is offered a language whose screens are still partly English. While English is
 * the only offered locale the block says so rather than showing a choice that is not one.
 *
 * **Choosing reloads the page**, because every surface reads its words once, and first flushes an open draft,
 * because a reload would otherwise lose what was typed in the autosave pause. A draft the Node will not save
 * stops the reload and says why, as signing out does.
 *
 * **When this browser will not keep the choice**, the page reloads with the choice in its address instead, so
 * it still applies to that page, and says it will not last.
 */
export function Language() {
  const compose = useCompose();
  const [unreadable] = useState(() => !storedLocale().readable);
  const [problem, setProblem] = useState<Said | null>(null);
  const now = current();

  async function choose(locale: Locale) {
    setProblem(null);
    const unsaved = await compose.save();
    if (unsaved !== null) {
      setProblem(unsaved);
      return;
    }
    if (chooseLocale(locale).saved) location.reload();
    else location.assign(`${location.pathname}?${new URLSearchParams({ [LOCALE_FLAG]: locale })}`);
  }

  return (
    <section className="settings-block" aria-labelledby="settings-language">
      <h2 id="settings-language">{t("language.heading")}</h2>
      <p>{t("language.scope")}</p>
      {OFFERED.length > 1 ? (
        <fieldset className="theme-choice">
          <legend>{t("language.legend")}</legend>
          {OFFERED.map((locale) => (
            <label key={locale} className="theme-option" lang={locale}>
              <input
                type="radio"
                name="language"
                value={locale}
                checked={now.locale === locale}
                onChange={() => void choose(locale)}
              />
              {localeEntry(locale).endonym}
            </label>
          ))}
        </fieldset>
      ) : (
        <p>{t("language.only")}</p>
      )}
      {now.source === "flag" ? (
        <p className="notice" role="status">
          {t("language.flag", { language: localeEntry(now.locale).endonym })}
        </p>
      ) : null}
      {problem === null ? null : (
        <p className="bad" role="alert">{sentence("language.draft", { problem: marked(problem) })}</p>
      )}
      {unreadable ? <p className="notice" role="status">{t("language.unreadable")}</p> : null}
    </section>
  );
}
