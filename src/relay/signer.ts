/**
 * Local-only Nostr signer.
 *
 * Implements:
 *   - BIP-340 Schnorr signatures over secp256k1 (NIP-01 event signing)
 *   - NIP-19 bech32 `nsec1…` decoding to 32-byte hex
 *
 * Pure: no MCP types, no IO, no network. Reused by the NIP-98 fetch wrapper
 * and (in later PRs) by the publish_event tool.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { decode as nip19Decode } from "nostr-tools/nip19";
import { z } from "zod";

// ─── Branded string types ──────────────────────────────────────────────────
// These are runtime-equivalent to `string`; the brand only exists to give the
// type checker a hint and to prevent mixing raw user input with internal hex.

/** 64-char lowercase hex string (x-only pubkey, secret key, or event id). */
export type Hex64 = string & { readonly __brand: "Hex64" };

/** Either a 64-char lowercase hex secret, or a bech32 `nsec1…` encoding. */
export type NsecOrHex = string & { readonly __brand: "NsecOrHex" };

// ─── Internal validators (Zod) ─────────────────────────────────────────────

const HEX64_REGEX = /^[0-9a-f]{64}$/;
const NSEC_REGEX = /^nsec1[023456789ac-hj-np-z]{58}$/;

/** Strict 64-char lowercase hex. */
const hex64Validator = z.string().regex(HEX64_REGEX, "must be 64 lowercase hex characters");

/** Either 64-char hex or a canonical bech32 `nsec1…`. */
const nsecOrHexValidator = z.union([
  hex64Validator,
  z.string().regex(NSEC_REGEX, "must be 64-char hex or nsec1… bech32"),
]);

const kindValidator = z.number().int().min(0).max(65535, "kind must fit in a uint16");

const tagsValidator = z
  .array(z.array(z.string()))
  .refine((tags) => tags.every((t) => t.length >= 1), {
    message: "each tag must have at least one element (the name)",
  });

// ─── Event types ───────────────────────────────────────────────────────────

/**
 * A NIP-01 event with the fields that go into the signed serialization.
 * `pubkey` and `created_at` are optional; `signEvent` fills them in.
 */
export type UnsignedEvent = {
  kind: number;
  tags: string[][];
  content: string;
  created_at?: number;
  pubkey?: string;
};

/** A fully-signed NIP-01 event. `id` and `sig` are hex. */
export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function asHex64(s: string): Hex64 {
  return s as Hex64;
}

/**
 * Resolve an `NsecOrHex` to its 32-byte secret. Decodes `nsec1…` via NIP-19
 * and validates the hex form via Zod. Throws on bad input.
 */
export function encodeNsec(secret: NsecOrHex): Hex64 {
  const parsed = nsecOrHexValidator.parse(secret);
  if (HEX64_REGEX.test(parsed)) {
    return asHex64(parsed);
  }
  // nsec1… bech32 path — defer the checksum check to nip19.
  const decoded = nip19Decode(parsed);
  if (decoded.type !== "nsec") {
    throw new Error(`encodeNsec: expected nsec1… but got nip19 type "${decoded.type}"`);
  }
  const bytes = decoded.data;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error(`encodeNsec: nsec payload must decode to 32 bytes (got ${bytes?.length})`);
  }
  return asHex64(bytesToHex(bytes));
}

/**
 * Internal: turn an NsecOrHex into raw 32-byte secret. Always re-validates.
 */
function toSecretBytes(secret: NsecOrHex): Uint8Array {
  return hexToBytes(encodeNsec(secret));
}

/**
 * NIP-01 event serialization. The exact UTF-8 JSON string that gets hashed
 * to compute `id`.
 */
function serializeEvent(evt: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): string {
  return JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Derive the x-only (32-byte) Schnorr public key for a secret.
 *
 * @throws if `secret` is not 64-char hex or a valid `nsec1…`.
 */
export function getPublicKey(secret: NsecOrHex): Hex64 {
  const bytes = toSecretBytes(secret);
  const pub = schnorr.getPublicKey(bytes); // 32-byte x-only
  return asHex64(bytesToHex(pub));
}

/**
 * BIP-340 Schnorr-sign a raw message. Deterministic for a given secret+message
 * pair (uses BIP-340 default auxRand, which is non-zero).
 *
 * @throws if `secret` is not 64-char hex or a valid `nsec1…`.
 */
export function signSchnorr(secret: NsecOrHex, msg: Uint8Array): Uint8Array {
  const bytes = toSecretBytes(secret);
  return schnorr.sign(msg, bytes);
}

/**
 * Sign a NIP-01 event. Fills in `pubkey`, `created_at`, `id`, and `sig` if
 * absent. Returns a new event object; the input is not mutated.
 *
 * @throws if `secret` is not 64-char hex or a valid `nsec1…`, or if `event`
 * has out-of-range fields.
 */
export function signEvent(secret: NsecOrHex, event: UnsignedEvent): NostrEvent {
  // Validate the secret up-front so an invalid `secret` fails before any
  // partial work is done.
  const pubkeyHex = event.pubkey ?? getPublicKey(secret);
  hex64Validator.parse(pubkeyHex);

  const created_at = event.created_at ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(created_at) || created_at < 0) {
    throw new Error(
      `signEvent: created_at must be a non-negative integer (got ${event.created_at})`,
    );
  }

  const kind = kindValidator.parse(event.kind);
  const tags = tagsValidator.parse(event.tags);
  if (typeof event.content !== "string") {
    throw new Error("signEvent: content must be a string");
  }

  // 1. Compute the id per NIP-01: sha256 of the UTF-8 JSON serialization.
  const serialized = serializeEvent({
    pubkey: pubkeyHex,
    created_at,
    kind,
    tags,
    content: event.content,
  });
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));

  // 2. Schnorr-sign the id bytes (which is what BIP-340 / NIP-01 want —
  //    `schnorr.sign` hashes internally for the challenge).
  const sig = bytesToHex(signSchnorr(secret, hexToBytes(id)));

  return {
    id,
    pubkey: pubkeyHex,
    created_at,
    kind,
    tags,
    content: event.content,
    sig,
  };
}
