import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answer, reset } from "./session-stub.ts";

/**
 * The audit table says **who**, and for a machine's act it says who is accountable (audit P1-1).
 *
 * ## What was missing, and it was not a column
 *
 * `audit_entries.delegator_user_id` had existed since #109 L1, inside the hashed form, so the trail *knew*
 * which person stood behind an `agt_`. Two things stopped anybody asking it: the route did not select the
 * column, and this table rendered no actor at all — not the identifier, not the kind, not the delegator. So
 * the interface answered *what happened* and never *who did it*, which is half of what an audit trail is for.
 *
 * A field inside the hash that no surface exposes is worse than a missing one. A missing field is an obvious
 * gap; a written-and-invisible one reads as a question already answered, and the whole delegated-agent layer
 * rests on the claim that an agent's act lands under the agent *and* under the person.
 *
 * ## Why a client test rather than only a route test
 *
 * Because the route already selected `actor_user_id` and the table already ignored it. Asserting the API's
 * payload would have passed against an interface that showed nothing — the same shape as the defect. The
 * assertion has to be made where a person reads it.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Audit } = await import("../../src/client/app/screens/ledgers.tsx");

interface StubEntry {
  actor_user_id: string | null;
  actor_kind: string;
  delegator_user_id: string | null;
}

function mount(entries: StubEntry[]) {
  answer("/api/audit", () => ({
    entries: entries.map((entry, index) => ({
      id: `aud_${index}`,
      seq: index + 1,
      at: "2026-08-28T09:00:00.000Z",
      action: "supervised.opened",
      subject: "rcpt_x",
      outcome: "ok",
      detail: "{}",
      hash: "0".repeat(64),
      ...entry,
    })),
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Audit /></QueryClientProvider>);
}

beforeEach(() => {
  reset();
});

describe("the audit table attributes every entry", () => {
  it("names the machine and the person accountable for its act", async () => {
    mount([{
      actor_user_id: "agt_reader00000000000000001",
      actor_kind: "agent",
      delegator_user_id: "usr_ana000000000000000001",
    }]);
    /*
     * Both identifiers in one cell, because they are one answer. Split across two columns, a reader can take
     * the first without the second — and "a machine did it" without "for this person" is the reading the whole
     * layer exists to prevent.
     */
    expect(
      await screen.findByText("agt_reader00000000000000001 for usr_ana000000000000000001"),
      "the trail shows the machine without the person accountable for it",
    ).toBeTruthy();
  });

  it("shows a person's own act as just themselves", async () => {
    // The control. If the label appended "for" unconditionally, or printed a bare "null", this would catch it
    // — and nearly every entry in a real trail is this case, so it is the one a reader sees most.
    mount([{
      actor_user_id: "usr_ana000000000000000001",
      actor_kind: "user",
      delegator_user_id: null,
    }]);
    expect(await screen.findByText("usr_ana000000000000000001")).toBeTruthy();
    expect(screen.queryByText(/ for /), "a person acting for themselves was shown a delegator").toBeNull();
  });

  it("falls back to the kind for an actor that has no identifier", async () => {
    /*
     * `node` and `installer` have no id by construction — `audit.ts` says that is the only reason
     * `actor_kind` is a column at all. Printing an empty cell for them would make the two rows that have no
     * actor look like the rows whose actor was lost.
     */
    mount([{ actor_user_id: null, actor_kind: "node", delegator_user_id: null }]);
    expect(await screen.findByText("node")).toBeTruthy();
  });

  it("has an Actor column at all", async () => {
    // The header, asserted separately: a cell whose column is unlabelled is a string a reader has to guess at.
    mount([{ actor_user_id: "usr_a", actor_kind: "user", delegator_user_id: null }]);
    expect(await screen.findByRole("columnheader", { name: "Actor" })).toBeTruthy();
  });
});
