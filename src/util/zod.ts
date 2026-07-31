/**
 * Shared Zod schemas used across the relay client and the MCP tools that
 * later PRs will add. Kept in `util/` so both the signer (`relay/signer.ts`)
 * and the tools can compose against the same regexes without circular
 * dependencies.
 *
 * Pure: no MCP types, no IO, no network.
 */
import { z } from "zod";

// 64-char lowercase hex. Single source of truth for both pubkeys and event ids.
const HEX64_REGEX = /^[0-9a-f]{64}$/;

// Bech32 alphabet used by NIP-19 (BIP-173): `[0-9a-z]` minus `b`, `i`, `o`, `1`.
// We exclude `1` too because bech32 forbids it in the data part.
const BECH32_DATA_REGEX = /^[023456789ac-hj-np-z]+$/;

/**
 * Generic 64-char lowercase hex string. The base shape for `pubkey` and
 * `eventId`.
 */
export const hex64Schema = z
  .string()
  .regex(HEX64_REGEX, "must be 64 lowercase hex characters");
export type Hex64String = z.infer<typeof hex64Schema>;

/**
 * 64-char lowercase hex pubkey. Same shape as `hex64Schema`; named
 * separately for readability at call sites.
 */
export const pubkeySchema = hex64Schema;
export type PubkeyString = z.infer<typeof pubkeySchema>;

/**
 * 64-char lowercase hex event id.
 */
export const eventIdSchema = hex64Schema;
export type EventIdString = z.infer<typeof eventIdSchema>;

/**
 * Either a 64-char hex secret key, or a bech32 `nsec1…` NIP-19 encoding.
 *
 * Note: zod's `union` here does structural matching only; deeper validation
 * (bech32 checksum) lives in `relay/signer.ts` where nip19 decoding is
 * available. This schema just enforces the canonical shape.
 */
export const nsecSchema = z.union([
  hex64Schema,
  z
    .string()
    .regex(
      /^nsec1[023456789ac-hj-np-z]{58}$/,
      "must be a 64-char lowercase hex secret or a bech32 nsec1… string",
    ),
]);
export type NsecString = z.infer<typeof nsecSchema>;

/**
 * ISO-8601 timestamp string that:
 *   - parses via `Date.parse` to a real instant, AND
 *   - is within ±1 year of `Date.now()` (specifically: > now − 1y and < now + 60s).
 */
export const isoTimestampSchema = z
  .string()
  .refine(
    (s) => {
      const t = Date.parse(s);
      if (Number.isNaN(t)) {
        return false;
      }
      const now = Date.now();
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      return t > now - oneYearMs && t < now + 60_000;
    },
    { message: "must be a valid ISO timestamp within ±1y of now" },
  );
export type IsoTimestampString = z.infer<typeof isoTimestampSchema>;
