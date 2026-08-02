/**
 * The ambient primitives seam (#6).
 *
 * Time, randomness and identifier minting are reached through an explicit `ctx`,
 * never through `Date.now()`, `Math.random()` or `crypto.randomUUID()`. Lint bans the
 * bare calls everywhere except this file.
 *
 * Two reasons it is a parameter and not a module singleton:
 *   - Workers reuse isolates across requests, so a module-level clock leaks one
 *     request's time into another's.
 *   - §27 needs frozen-clock deterministic replay, which is then just an injection.
 */

/** Crockford base32, excluding I, L, O and U. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;

export interface Ctx {
  /** Milliseconds since the epoch. Frozen during synchronous execution on Workers. */
  now(): number;
  /** A typed-prefix ULID, e.g. `id("msg")` -> `msg_01JQR8X4K2N7VB3TCFMH9DYEWZ`. */
  id(prefix: string): string;
  /** Cryptographically secure random bytes. */
  random(byteLength: number): Uint8Array;
}

const PREFIX_PATTERN = /^[a-z][a-z0-9]{0,9}$/;

export interface CtxSources {
  now: () => number;
  randomBytes: (byteLength: number) => Uint8Array;
}

export function createCtx(sources: CtxSources): Ctx {
  return {
    now: sources.now,
    random: sources.randomBytes,
    id(prefix: string): string {
      if (!PREFIX_PATTERN.test(prefix)) {
        throw new Error(
          `E_BAD_ID_PREFIX  prefix=${JSON.stringify(prefix)}\n` +
            `  expected  1-10 chars, lowercase letters and digits, starting with a letter\n` +
            `  why       prefixes appear in errors, logs and agent context where no column name is present (#6)`,
        );
      }
      return `${prefix}_${encodeTime(sources.now())}${encodeRandom(sources.randomBytes(RANDOM_BYTES))}`;
    },
  };
}

/** The live production sources. The only place bare Date.now and getRandomValues appear. */
export const systemSources: CtxSources = {
  // eslint-disable-next-line no-restricted-syntax -- the seam has to bottom out somewhere
  now: () => Date.now(),
  randomBytes: (byteLength) => crypto.getRandomValues(new Uint8Array(byteLength)),
};

export function createSystemCtx(): Ctx {
  return createCtx(systemSources);
}

function encodeTime(millis: number): string {
  if (!Number.isInteger(millis) || millis < 0 || millis > 0xffffffffffff) {
    throw new Error(`E_BAD_ULID_TIME  now()=${millis} is outside the 48-bit ULID timestamp range`);
  }
  let remaining = millis;
  let out = "";
  for (let index = 0; index < TIME_CHARS; index++) {
    out = ENCODING[remaining % 32]! + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/** 10 bytes -> 16 base32 chars, taken 5 bits at a time. */
function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length !== RANDOM_BYTES) {
    throw new Error(`E_BAD_ULID_RANDOM  expected ${RANDOM_BYTES} bytes, got ${bytes.length}`);
  }
  let bitBuffer = 0;
  let bitCount = 0;
  let out = "";
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += ENCODING[(bitBuffer >>> bitCount) & 31]!;
    }
  }
  return out.padEnd(RANDOM_CHARS, ENCODING[0]!).slice(0, RANDOM_CHARS);
}

/**
 * A ctx for tests and for §27 replay: time advances only when told to, and randomness
 * is a reproducible counter rather than entropy.
 */
export function createFrozenCtx(startMillis = 1_754_000_000_000): Ctx & { advance(ms: number): void } {
  let current = startMillis;
  let counter = 0n;
  const ctx = createCtx({
    now: () => current,
    // The counter is written big-endian across the whole buffer rather than folded
    // into each byte. An earlier version did `(counter + index) & 0xff`, which cycles
    // with period 256 — call 257 collided with call 1, and the primary key caught it
    // during seeding. A deterministic source still has to be collision-free.
    randomBytes: (byteLength) => {
      const out = new Uint8Array(byteLength);
      let remaining = counter;
      for (let index = byteLength - 1; index >= 0; index--) {
        out[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
      }
      counter += 1n;
      return out;
    },
  });
  return Object.assign(ctx, {
    advance(ms: number) {
      current += ms;
    },
  });
}
