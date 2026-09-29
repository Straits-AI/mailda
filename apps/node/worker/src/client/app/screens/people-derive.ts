import { type MailboxQueue, type PersonRow, withdrawalKey } from "../api.ts";

/**
 * What People works out from the reads it already makes (28 September 2026). Pure, so each rule is tested on its
 * own; nothing here is read from the Node that `GET /api/provider`, `GET /api/mailboxes` and `GET /api/people`
 * did not already answer.
 */

/** A mailbox's addresses, lower-cased. `GET /api/mailboxes` carries them comma-separated, or null for none. */
export function addressesOf(box: Pick<MailboxQueue, "addresses">): string[] {
  return box.addresses === null ? [] : box.addresses.split(",").map((one) => one.trim().toLowerCase());
}

/**
 * The domains this Node receives for, as far as People can see: the receiving domain the install or Setup
 * provisioned (`provisioned.receiving`, from the audit trail) first, then the domain of every address on a
 * mailbox listed, sorted. Both, because the mailbox list is only the caller's own (`send.propose`), so an
 * administrator who holds nothing on the provisioned mailbox sees its domain only through the first.
 */
export function nodeDomains(receiving: string | null | undefined, boxes: ReadonlyArray<Pick<MailboxQueue, "addresses">>): string[] {
  const fromAddresses = boxes.flatMap(addressesOf).map((address) => address.slice(address.lastIndexOf("@") + 1)).sort();
  const first = receiving?.trim().toLowerCase() ?? "";
  return [...new Set([first, ...fromAddresses])].filter((domain) => domain !== "");
}

/**
 * The address a local-part field means: `local@domain`, or what was typed when it carries its own `@` (a pasted
 * address, or one on a domain this Node does not know yet), so the address sent is the address shown.
 */
export function addressFrom(local: string, domain: string | undefined): string {
  const typed = local.trim().toLowerCase();
  return typed === "" || typed.includes("@") || domain === undefined ? typed : `${typed}@${domain}`;
}

/** `email` split at its `@` when its domain is one this Node receives for, so an invitee there keeps their own. */
export function ownAddressOn(email: string, domains: readonly string[]): { local: string; domain: string } | null {
  const typed = email.trim().toLowerCase();
  const at = typed.lastIndexOf("@");
  const domain = typed.slice(at + 1);
  // `at >= 0` survives mutation: "@domain" would give an empty local part, which the field shows as it shows none.
  return at > 0 && domains.includes(domain) ? { local: typed.slice(0, at), domain } : null;
}

/**
 * Whom People offers a mailbox to: a person with an account whose email is an address on a mailbox they hold
 * nothing on directly, and on which no relation of theirs was withdrawn (`withdrawn`, keyed by `withdrawalKey`).
 * The invite bundle creates exactly that (a mailbox at the invitee's address, held by nobody but the administrator
 * who made it), and this is the other half, read from the people and mailbox lists and the withdrawals rather than
 * from anything the invitation kept.
 *
 * What it does not see, and the prompt does not claim: a relation held through a team (`GET /api/people` files a
 * team's tuples under the team, not its members), a withdrawal older than the withdrawals read, and whether the
 * person arrived recently or long ago. A mailbox at an address other than the person's email is not matched:
 * nothing links the two but a person.
 */
export function arrivals(
  people: readonly PersonRow[], boxes: readonly MailboxQueue[], withdrawn: ReadonlySet<string>,
): Array<{ person: PersonRow; box: MailboxQueue; address: string }> {
  return people.flatMap((person) => {
    const address = person.email.toLowerCase();
    return boxes
      .filter((box) => addressesOf(box).includes(address)
        && !person.relations.some((held) => held.objectId === box.id)
        && !withdrawn.has(withdrawalKey(person.id, box.id)))
      .map((box) => ({ person, box, address }));
  });
}
