import { DELIVERY_REASONS, DELIVERY_STATES, SEND_REASONS, SEND_STATES, oneOf } from "@mailda/contract/schemas";
import { createElement, type ReactNode } from "react";

import { t } from "/app/locale.js";

/**
 * The words for the tokens `/app/delivery.js` returns (ADR 46): that module decides which state, reason and
 * reading a reader is shown, and cannot import anything, so the catalog lookup is here. Each token is narrowed
 * to the contract's closed list before its key is built, so a key is only ever one the catalog has.
 *
 * A token outside the list, from a newer Node, is shown as it came with no note, in `<code>` (`shown`): an
 * identifier, as the ledgers show every token the Node names things by, so it cannot pass for a translated word.
 * The Node's own token is a poorer label than a word, and a better one than a blank.
 */
export interface Words {
  readonly label: string;
  readonly note: string;
  /** The label is the token itself: this client has no words for it. */
  readonly raw?: true;
}

const raw = (token: string): Words => ({ label: token, note: "", raw: true });

/** The label as it is drawn: a word, or a raw token in `<code>`. */
export function shown(words: Words): ReactNode {
  return words.raw === true ? createElement("code", null, words.label) : words.label;
}

/** A send's state, or `never_submitted`, the stronger reading of `outcome_unknown` (`describeSend`). */
export function sendStateWords(token: string): Words {
  if (token === "never_submitted") {
    return { label: t("send.state.never_submitted"), note: t("send.state.never_submitted.note") };
  }
  if (!oneOf(SEND_STATES, token)) return raw(token);
  return { label: t(`send.state.${token}`), note: t(`send.state.${token}.note`) };
}

/** Why a send is `awaiting` or `withheld`. */
export function sendReasonWords(token: string): Words {
  if (!oneOf(SEND_REASONS, token)) return raw(token);
  return { label: t(`send.reason.${token}`), note: t(`send.reason.${token}.note`) };
}

/**
 * A recipient's delivery state, `unobserved`, or a reason token: the summary puts a reason where a recipient
 * with no state has one (`summariseDelivery`), and the recipient row shows it beside `unobserved`.
 */
export function deliveryWords(token: string): Words {
  if (token === "unobserved") return { label: t("delivery.state.unobserved"), note: t("delivery.state.unobserved.note") };
  if (oneOf(DELIVERY_STATES, token)) {
    return { label: t(`delivery.state.${token}`), note: t(`delivery.state.${token}.note`) };
  }
  if (!oneOf(DELIVERY_REASONS, token)) return raw(token);
  return { label: t(`delivery.reason.${token}`), note: t(`delivery.reason.${token}.note`) };
}
