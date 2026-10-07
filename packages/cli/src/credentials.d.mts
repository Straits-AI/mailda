/** Types for `credentials.mjs`: asking a person for an administrator's email and password, tried at once. */
export declare const PROMPT_ATTEMPTS: number;

export type AfterSignIn = "accept" | "retry" | "give_up" | "locked" | "later";
export declare function afterSignIn(status: number | null, attempt: number, max?: number): AfterSignIn;

export interface AskAdministratorDeps {
  ask(prompt: string): Promise<string>;
  readSecret(prompt: string): Promise<string>;
  fail(message: string): never;
  out?(text: string): void;
  fetchImpl?(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<Response>;
  max?: number;
}
export declare function askAdministrator(
  origin: string,
  deps: AskAdministratorDeps,
): Promise<{ email: string; password: string } | null>;
