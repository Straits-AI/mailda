import { BUDGET_ORIGINS, BUDGETS, type BudgetName } from "./generated.ts";

export { BUDGETS, BUDGET_ORIGINS, type BudgetName };
export type { BudgetOrigin } from "./generated.ts";

/**
 * Thrown when a budget is exceeded. The message carries the four parts AGENTS.md
 * requires: the named budget, its limit, the ask, and where the limit came from.
 *
 * An agent reading `butler.fanout.max_effects=500, asked for 512` can act. An agent
 * reading a stack trace cannot.
 */
export class BudgetExceededError extends Error {
  readonly code = "E_BUDGET_EXCEEDED";
  readonly budget: BudgetName;
  readonly limit: number;
  readonly ask: number;

  constructor(budget: BudgetName, ask: number, context?: Record<string, string>) {
    const limit = BUDGETS[budget];
    const origin = BUDGET_ORIGINS[budget];
    const detail = context
      ? Object.entries(context)
          .map(([key, value]) => `  ${key.padEnd(8)} ${value}`)
          .join("\n") + "\n"
      : "";

    super(
      `E_BUDGET_EXCEEDED  ${budget}=${limit}, asked for ${ask}\n` +
        detail +
        `  receipt  ${origin.receipt}\n` +
        `  measured ${origin.measuredOn}\n` +
        `  stale if ${origin.staleWhen}`,
    );
    this.name = "BudgetExceededError";
    this.budget = budget;
    this.limit = limit;
    this.ask = ask;
  }
}

/**
 * Fails loudly when `ask` exceeds the named budget.
 *
 * AGENTS.md: if a good widget hits a budget, the budget is wrong. So the error names
 * the receipt — the reader's next move is to check whether the measurement still holds,
 * not to work around the limit.
 */
export function assertWithinBudget(
  budget: BudgetName,
  ask: number,
  context?: Record<string, string>,
): void {
  if (ask > BUDGETS[budget]) {
    throw new BudgetExceededError(budget, ask, context);
  }
}
