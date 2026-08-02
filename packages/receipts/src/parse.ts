import { parse as parseYaml } from "yaml";

/** The kinds of number a receipt may establish. See AGENTS.md. */
export const RECEIPT_KINDS = ["platform-limit", "measured-tripwire", "slo"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export interface Receipt {
  id: string;
  kind: ReceiptKind;
  measuredOn: string;
  staleWhen: string;
  /** Dotted budget name to value. A receipt may establish several related numbers. */
  values: Record<string, number>;
  /** Path the receipt was read from, for error messages. */
  source: string;
}

/**
 * Every failure here names the file, the field and what was expected, because the
 * reader is as likely to be an agent as a human. See AGENTS.md, "A limit developers
 * can hit is a limit they must see".
 */
export class ReceiptError extends Error {
  constructor(source: string, problem: string, fix: string) {
    super(`E_RECEIPT_INVALID  ${source}\n  problem  ${problem}\n  fix      ${fix}`);
    this.name = "ReceiptError";
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseReceipt(source: string, text: string): Receipt {
  const matched = FRONTMATTER.exec(text);
  if (!matched) {
    throw new ReceiptError(
      source,
      "no YAML frontmatter block found",
      "start the file with a --- delimited block carrying id, kind, measured_on, stale_when and values",
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(matched[1]!);
  } catch (cause) {
    throw new ReceiptError(source, `frontmatter is not valid YAML: ${String(cause)}`, "fix the YAML syntax");
  }

  if (typeof raw !== "object" || raw === null) {
    throw new ReceiptError(source, "frontmatter did not parse to a mapping", "use key: value pairs");
  }
  const front = raw as Record<string, unknown>;

  const id = requireString(source, front, "id");
  const kindText = requireString(source, front, "kind");
  if (!(RECEIPT_KINDS as readonly string[]).includes(kindText)) {
    throw new ReceiptError(
      source,
      `kind=${kindText} is not a known receipt kind`,
      `use one of: ${RECEIPT_KINDS.join(", ")}`,
    );
  }

  const measuredOn = requireString(source, front, "measured_on");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(measuredOn)) {
    throw new ReceiptError(source, `measured_on=${measuredOn} is not an ISO date`, "use YYYY-MM-DD");
  }

  const staleWhen = requireString(source, front, "stale_when").trim();
  if (staleWhen.length === 0) {
    throw new ReceiptError(
      source,
      "stale_when is empty",
      "state the condition that invalidates this measurement — a receipt that can never go stale is a receipt nobody will recheck",
    );
  }

  const valuesRaw = front["values"];
  if (typeof valuesRaw !== "object" || valuesRaw === null || Array.isArray(valuesRaw)) {
    throw new ReceiptError(source, "values is missing or is not a mapping", "add values: with dotted-name: number pairs");
  }

  const values: Record<string, number> = {};
  for (const [name, value] of Object.entries(valuesRaw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ReceiptError(
        source,
        `values.${name} is ${JSON.stringify(value)}, not a finite number`,
        "record the measured number; units belong in the name, not the value",
      );
    }
    if (!/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(name)) {
      throw new ReceiptError(
        source,
        `values.${name} is not a dotted lowercase budget name`,
        "use a name like d1.paid.max_database_bytes",
      );
    }
    values[name] = value;
  }

  if (Object.keys(values).length === 0) {
    throw new ReceiptError(source, "values is empty", "a receipt with no numbers establishes nothing — delete it or add a value");
  }

  return { id, kind: kindText as ReceiptKind, measuredOn, staleWhen, values, source };
}

function requireString(source: string, front: Record<string, unknown>, field: string): string {
  const value = front[field];
  if (typeof value !== "string") {
    throw new ReceiptError(source, `${field} is missing or not a string`, `add ${field}: to the frontmatter`);
  }
  return value;
}
