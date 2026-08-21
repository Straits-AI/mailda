import { isoCBOR } from "@simplewebauthn/server/helpers";

/**
 * A software authenticator, for testing the passkey ceremonies end to end (#84).
 *
 * ## Why this exists rather than a fixture
 *
 * The alternative was a recorded assertion captured from a real browser. That would prove the verification
 * accepts **one** response and nothing else — it could not be re-signed, so it could not answer *"does a
 * wrong challenge fail"*, *"does a wrong origin fail"*, *"does a replay fail"*. Every negative test is where
 * the security property actually lives, and a fixture cannot produce one.
 *
 * So this holds a real P-256 key and signs real assertions. What it proves is what a browser would do:
 * `verifyAuthenticationResponse` accepts what a correct authenticator produces and rejects what it does not.
 *
 * ## What it deliberately does not do
 *
 * No attestation statement — `fmt: "none"`, `attStmt: {}` — because that is what this Node requests and
 * therefore what it must verify. An authenticator here that produced `packed` attestation would be exercising
 * a path production never takes, which is the shape of a test that passes while the product is broken.
 */

const AAGUID = new Uint8Array(16);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** `authData`: the structure both ceremonies sign over. */
async function authenticatorData(
  rpId: string,
  flags: number,
  counter: number,
  attested?: { credentialId: Uint8Array; coseKey: Uint8Array },
): Promise<Uint8Array> {
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, false);
  const head = concat(await sha256(utf8(rpId)), new Uint8Array([flags]), counterBytes);
  if (attested === undefined) return head;

  const idLength = new Uint8Array(2);
  new DataView(idLength.buffer).setUint16(0, attested.credentialId.length, false);
  return concat(head, AAGUID, idLength, attested.credentialId, attested.coseKey);
}

export interface Ceremony {
  /** The JSON a browser's `PublicKeyCredential` serialises to, which is what the routes accept. */
  credential: Record<string, unknown>;
}

export class SoftwareAuthenticator {
  #keys: CryptoKeyPair | null = null;
  #credentialId: Uint8Array;
  counter = 0;

  constructor(credentialId = "test-credential") {
    this.#credentialId = utf8(credentialId);
  }

  get id(): string {
    return b64url(this.#credentialId);
  }

  async #pair(): Promise<CryptoKeyPair> {
    // `generateKey` is typed as returning either a key or a pair; ECDSA always gives a pair, and the cast
    // is where that fact is stated once rather than at both use sites.
    this.#keys ??= await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
    ) as CryptoKeyPair;
    return this.#keys;
  }

  /** The public key as a COSE_Key map — `{1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}`. */
  async #coseKey(): Promise<Uint8Array> {
    const jwk = await crypto.subtle.exportKey("jwk", (await this.#pair()).publicKey) as JsonWebKey;
    const fromB64url = (value: string) => Uint8Array.from(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0),
    );
    const map = new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)],
    ]);
    return new Uint8Array(isoCBOR.encode(map as never));
  }

  /**
   * Signs, and converts the signature.
   *
   * Web Crypto's ECDSA produces a raw `r || s` pair; WebAuthn carries **DER**. Converting here is what makes
   * this authenticator behave like a real one — a test that skipped it would be verifying a signature format
   * no browser produces.
   */
  async #sign(payload: Uint8Array): Promise<Uint8Array> {
    const raw = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, (await this.#pair()).privateKey, payload as BufferSource,
    ));
    const derInt = (bytes: Uint8Array): Uint8Array => {
      let start = 0;
      while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
      const body = bytes.subarray(start);
      // A leading bit of 1 would read as negative, so DER prefixes a zero byte.
      const value = (body[0]! & 0x80) === 0 ? body : concat(new Uint8Array([0]), body);
      return concat(new Uint8Array([0x02, value.length]), value);
    };
    const r = derInt(raw.subarray(0, 32));
    const s = derInt(raw.subarray(32));
    return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
  }

  #clientData(type: string, challenge: string, origin: string): Uint8Array {
    return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** What a browser returns from `navigator.credentials.create()`. */
  async register(challenge: string, rpId: string, origin: string): Promise<Ceremony> {
    const clientDataJSON = this.#clientData("webauthn.create", challenge, origin);
    // 0x45: user present, user verified, attested credential data included.
    const authData = await authenticatorData(rpId, 0x45, this.counter, {
      credentialId: this.#credentialId, coseKey: await this.#coseKey(),
    });
    /*
     * Built with `set` rather than from an array of pairs: the library's `CBORType` is a recursive union, and
     * TypeScript widens a heterogeneous tuple array to a union of tuples that no single `Map<K, V>` accepts.
     * Three statements, no cast, and the value is what it says it is.
     */
    const attestation = new Map<string, unknown>();
    attestation.set("fmt", "none");
    attestation.set("attStmt", new Map<string, unknown>());
    attestation.set("authData", authData);
    const attestationObject = new Uint8Array(isoCBOR.encode(attestation as never));

    return {
      credential: {
        id: this.id,
        rawId: this.id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
      },
    };
  }

  /** What a browser returns from `navigator.credentials.get()`. */
  async authenticate(challenge: string, rpId: string, origin: string): Promise<Ceremony> {
    const clientDataJSON = this.#clientData("webauthn.get", challenge, origin);
    // 0x05: user present and verified. No attested credential data on an assertion.
    const authData = await authenticatorData(rpId, 0x05, this.counter);
    const signature = await this.#sign(concat(authData, await sha256(clientDataJSON)));

    return {
      credential: {
        id: this.id,
        rawId: this.id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
          userHandle: null,
        },
      },
    };
  }
}
