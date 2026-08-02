/**
 * Environment configuration schema for @buzz/mcp.
 *
 * The point of this module is to make bad configuration *loud*. Every field
 * is validated against a Zod schema at `createServer()` time; the server
 * refuses to start if validation fails. Silent partial-config (e.g. missing
 * BUZZ_RELAY_URLS, malformed JSON, wrong-format secret) is replaced by a
 * `ZodError` thrown at startup with a clear message.
 *
 * This is the schema referenced by the multi-relay implementation plan as
 * Phase 1 ("Configuration discipline + dry-run safety"). Phase 3 (`RelayPool`)
 * consumes the parsed `BUZZ_RELAY_URLS` array; Phase 1 only validates it.
 *
 * Pure: no IO, no MCP types. Safe to import from any module.
 */
import { z } from "zod";

/**
 * Default channel UUID cache TTL — 5 minutes.
 *
 * Tunable via `BUZZ_CHANNEL_CACHE_TTL_MS` env. The plan (Q1) calls for 5
 * minutes as a balance between relay load and human-edit propagation time.
 * Operators who want tighter consistency can set `BUZZ_CHANNEL_CACHE_TTL_MS=30000`
 * (30 s) in their env block.
 */
export const DEFAULT_CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Default per-relay HTTP timeout. 5 seconds matches the relay's own
 * liveness timeout and is generous for an ack that should arrive in <1s.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 5_000;

/**
 * Default write-confirmation mode. The plan calls for `mutate-with-confirm`
 * as the new default for any installation. Phase 1 introduces the mode; the
 * default is applied when no `BUZZ_MCP_MODE` env is set.
 *
 * Existing operators who want the v0.1.x behavior can opt out by setting
 * `BUZZ_MCP_MODE=mutate` in their env block.
 */
export const DEFAULT_MODE = "mutate-with-confirm" as const;

/**
 * Phase 1 (Phase 1 of the multi-relay plan): three modes.
 *   - `read-only`            — every write tool rejects at dispatch.
 *   - `mutate-with-confirm` — write tools log the unsigned event JSON to
 *                              stderr at WARN and return `{status: 'pending-confirm'}`
 *                              unless the caller passes `confirm: true`.
 *   - `mutate`               — write tools sign and post immediately (today's
 *                              behavior, kept for opt-out).
 *
 * The schema uses `z.enum` so an unknown value (e.g. `BUZZ_MCP_MODE=lol`)
 * fails at startup rather than silently falling through to the default.
 */
export const ModeSchema = z.enum(["read-only", "mutate-with-confirm", "mutate"]);
export type Mode = z.infer<typeof ModeSchema>;

/**
 * The full env schema. Throws on parse.
 *
 * Note: `BUZZ_RELAY_URLS` is a JSON-encoded array of strings. We parse at
 * the schema level so the rest of the codebase can rely on a real array
 * (or `undefined`). The plan's Q3 decision: if `BUZZ_RELAY_URLS` is set
 * and parses to an empty array, that's a config error — caught here.
 */
export const EnvSchema = z.object({
  BUZZ_PRIVATE_KEY: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/,
      "BUZZ_PRIVATE_KEY must be 64 lowercase hex characters (nsec1… is not supported here; decode it before setting the env)",
    ),
  BUZZ_RELAY_URL: z.string().url().optional(),
  BUZZ_RELAY_URLS: z
    .string()
    .optional()
    .transform((s: string | undefined) => {
      if (s === undefined || s === "") return undefined;
      try {
        return JSON.parse(s) as unknown;
      } catch (err) {
        throw new Error(`BUZZ_RELAY_URLS is not valid JSON: ${(err as Error).message}`);
      }
    })
    .pipe(
      z
        .array(z.string().url(), {
          error: "BUZZ_RELAY_URLS must be a JSON array of URL strings",
        })
        .min(1, "BUZZ_RELAY_URLS must be non-empty if set")
        .optional(),
    ),
  BUZZ_RELAY_DEFAULT: z.string().url().optional(),
  BUZZ_RELAY_ALLOWED: z
    .string()
    .optional()
    .transform((s: string | undefined) => {
      if (s === undefined || s === "") return undefined;
      try {
        return JSON.parse(s) as unknown;
      } catch (err) {
        throw new Error(`BUZZ_RELAY_ALLOWED is not valid JSON: ${(err as Error).message}`);
      }
    })
    .pipe(
      z
        .array(z.string().url(), {
          error: "BUZZ_RELAY_ALLOWED must be a JSON array of URL strings",
        })
        .optional(),
    ),
  BUZZ_CHANNEL_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_CHANNEL_CACHE_TTL_MS),
  BUZZ_MCP_MODE: ModeSchema.default(DEFAULT_MODE),
  BUZZ_MCP_LOG: z.string().default("info"),
  BUZZ_MCP_LOG_FILE: z.string().optional(),
  BUZZ_RELAY_HOST_0: z.string().optional(),
  BUZZ_RELAY_HOST_1: z.string().optional(),
  BUZZ_RELAY_HOST_2: z.string().optional(),
  BUZZ_RELAY_HOST_3: z.string().optional(),
  CF_ACCESS_CLIENT_ID: z.string().optional(),
  CF_ACCESS_CLIENT_SECRET: z.string().optional(),
});
// Wire up the implicit invariants below after the shape is parsed —
// see `parseEnv()` for the merged validation.

/**
 * The shape produced by `EnvSchema.parse`.
 */
export type ParsedEnv = z.infer<typeof EnvSchema>;

/**
 * Merged, validated, post-processed config. Phase 1 produces this from
 * `process.env`; Phase 3 will read `relays` and `relayHosts` from here.
 *
 * Cross-field invariants:
 *   - At least one of `BUZZ_RELAY_URL` or `BUZZ_RELAY_URLS` must result in
 *     a usable default. If neither is set, the operator's default relay
 *     (`https://coreprt.webrnds.com`) is used; this is the only case where
 *     a default is silently applied, and it matches the v0.1.x behavior
 *     documented in `index.ts:DEFAULT_RELAY_URL`.
 *   - If `BUZZ_RELAY_ALLOWED` is set, every relay the operator can reach
 *     (the merged list) must be in the allowlist. The allowlist is enforced
 *     per tool call in Phase 1; the merged-list check here is a startup
 *     sanity check that catches the "I set the allowlist but forgot to put
 *     the default relay in it" case.
 */
export interface BuzzConfig {
  readonly secret: string;
  readonly mode: Mode;
  readonly logLevel: string;
  readonly logFile: string | undefined;
  readonly channelCacheTtlMs: number;
  /** Every relay URL the operator can reach (merged from URL + URLS). */
  readonly relays: readonly string[];
  readonly defaultRelay: string;
  readonly relayAllowed: readonly string[] | undefined;
  readonly relayHosts: Record<string, string>;
  readonly cfAccess: { clientId: string; clientSecret: string } | undefined;
}

/**
 * Parse the process environment into a `BuzzConfig`. Throws on bad config.
 *
 * Phase 1 (this PR): the schema covers env validation. Phase 3 will add
 * the `RelayPool` instantiation that consumes `relays` + `relayHosts`.
 *
 * The `defaultRelay` is the first entry of the merged `relays` list, after
 * the URL→URLS merge. If `BUZZ_RELAY_URL` is set and `BUZZ_RELAY_URLS` is
 * unset, `BUZZ_RELAY_URL` becomes the only entry. If both are set, the
 * union is deduped with `BUZZ_RELAY_URL` first (legacy precedence).
 */
export function parseEnv(env: NodeJS.ProcessEnv = process.env): BuzzConfig {
  const parsed = EnvSchema.parse(env);

  const urlSingular = parsed.BUZZ_RELAY_URL;
  const urlPlural = parsed.BUZZ_RELAY_URLS ?? [];
  const merged: string[] = [];
  for (const u of [urlSingular, ...urlPlural]) {
    if (u !== undefined && !merged.includes(u)) {
      merged.push(u);
    }
  }
  if (merged.length === 0) {
    merged.push("https://coreprt.webrnds.com");
  }

  const relayAllowed = parsed.BUZZ_RELAY_ALLOWED;
  if (relayAllowed !== undefined) {
    const allow = new Set(relayAllowed);
    for (const u of merged) {
      if (!allow.has(u)) {
        throw new Error(
          `config: relay ${u} is not in BUZZ_RELAY_ALLOWED. Add it to the allowlist or remove it from BUZZ_RELAY_URL[S].`,
        );
      }
    }
  }

  const relayHosts: Record<string, string> = {};
  for (const [idx, key] of [
    ["0", "BUZZ_RELAY_HOST_0"],
    ["1", "BUZZ_RELAY_HOST_1"],
    ["2", "BUZZ_RELAY_HOST_2"],
    ["3", "BUZZ_RELAY_HOST_3"],
  ] as const) {
    const v = parsed[key as keyof ParsedEnv];
    if (typeof v === "string" && v !== "") {
      relayHosts[`${idx}`] = v;
    }
  }

  const cfAccess =
    parsed.CF_ACCESS_CLIENT_ID !== undefined &&
    parsed.CF_ACCESS_CLIENT_ID !== "" &&
    parsed.CF_ACCESS_CLIENT_SECRET !== undefined &&
    parsed.CF_ACCESS_CLIENT_SECRET !== ""
      ? {
          clientId: parsed.CF_ACCESS_CLIENT_ID,
          clientSecret: parsed.CF_ACCESS_CLIENT_SECRET,
        }
      : undefined;

  return {
    secret: parsed.BUZZ_PRIVATE_KEY,
    mode: parsed.BUZZ_MCP_MODE,
    logLevel: parsed.BUZZ_MCP_LOG,
    logFile: parsed.BUZZ_MCP_LOG_FILE,
    channelCacheTtlMs: parsed.BUZZ_CHANNEL_CACHE_TTL_MS,
    relays: merged,
    defaultRelay: merged[0],
    relayAllowed,
    relayHosts,
    cfAccess,
  };
}

/**
 * Throws if `host` is not in the configured allowlist. The allowlist is
 * a per-call check: every write tool that accepts a `relays[]` argument
 * calls this before fanning out.
 */
export function assertRelayAllowed(
  candidate: string,
  allowlist: readonly string[] | undefined,
): void {
  if (allowlist === undefined) return;
  if (!allowlist.includes(candidate)) {
    throw new Error(`relay ${candidate} is not in the BUZZ_RELAY_ALLOWED allowlist`);
  }
}
