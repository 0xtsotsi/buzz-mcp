/**
 * Unit tests for the env schema in `src/config/schema.ts`.
 *
 * Phase 1 of the multi-relay plan: the schema is the line of defense. Every
 * failure mode that v0.1.x produced silently (missing key, malformed JSON,
 * wrong-format secret) is converted into a thrown `ZodError` at
 * `createServer()` time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/schema.js";

const VALID_KEY = "a".repeat(64);

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  // Reset the test defaults each test so we don't accidentally inherit
  // BUZZ_PRIVATE_KEY from the operator's shell.
  process.env["BUZZ_PRIVATE_KEY"] = VALID_KEY;
  delete process.env["BUZZ_RELAY_URL"];
  delete process.env["BUZZ_RELAY_URLS"];
  delete process.env["BUZZ_RELAY_DEFAULT"];
  delete process.env["BUZZ_RELAY_ALLOWED"];
  delete process.env["BUZZ_MCP_MODE"];
  delete process.env["CF_ACCESS_CLIENT_ID"];
  delete process.env["CF_ACCESS_CLIENT_SECRET"];
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("parseEnv — required keys", () => {
  it("throws when BUZZ_PRIVATE_KEY is missing", () => {
    delete process.env["BUZZ_PRIVATE_KEY"];
    expect(() => parseEnv()).toThrow(/BUZZ_PRIVATE_KEY/);
  });

  it("throws when BUZZ_PRIVATE_KEY is not 64 lowercase hex characters", () => {
    process.env["BUZZ_PRIVATE_KEY"] = "nope";
    expect(() => parseEnv()).toThrow(/lowercase hex/);
  });

  it("throws when BUZZ_PRIVATE_KEY is the wrong length", () => {
    process.env["BUZZ_PRIVATE_KEY"] = "a".repeat(63);
    expect(() => parseEnv()).toThrow(/lowercase hex/);
  });

  it("accepts a 64-char hex key", () => {
    const config = parseEnv();
    expect(config.secret).toBe(VALID_KEY);
  });
});

describe("parseEnv — relay URLs", () => {
  it("defaults to https://coreprt.webrnds.com when no URL is set", () => {
    const config = parseEnv();
    expect(config.defaultRelay).toBe("https://coreprt.webrnds.com");
    expect(config.relays).toEqual(["https://coreprt.webrnds.com"]);
  });

  it("uses BUZZ_RELAY_URL when set", () => {
    process.env["BUZZ_RELAY_URL"] = "https://relay-a.test";
    const config = parseEnv();
    expect(config.defaultRelay).toBe("https://relay-a.test");
    expect(config.relays).toEqual(["https://relay-a.test"]);
  });

  it("parses BUZZ_RELAY_URLS as a JSON array", () => {
    process.env["BUZZ_RELAY_URLS"] = JSON.stringify([
      "https://relay-a.test",
      "https://relay-b.test",
    ]);
    const config = parseEnv();
    expect(config.relays).toEqual(["https://relay-a.test", "https://relay-b.test"]);
    expect(config.defaultRelay).toBe("https://relay-a.test");
  });

  it("errors when BUZZ_RELAY_URLS is not valid JSON", () => {
    process.env["BUZZ_RELAY_URLS"] = "not json";
    expect(() => parseEnv()).toThrow(/BUZZ_RELAY_URLS is not valid JSON/);
  });

  it("errors when BUZZ_RELAY_URLS is a JSON but not an array", () => {
    process.env["BUZZ_RELAY_URLS"] = JSON.stringify({ url: "https://x.test" });
    expect(() => parseEnv()).toThrow(/BUZZ_RELAY_URLS/);
  });

  it("errors when BUZZ_RELAY_URLS is an empty array (Q3: silent fall-through is unsafe)", () => {
    process.env["BUZZ_RELAY_URLS"] = JSON.stringify([]);
    expect(() => parseEnv()).toThrow(/non-empty/);
  });

  it("merges BUZZ_RELAY_URL + BUZZ_RELAY_URLS with URL first, deduped", () => {
    process.env["BUZZ_RELAY_URL"] = "https://relay-a.test";
    process.env["BUZZ_RELAY_URLS"] = JSON.stringify([
      "https://relay-a.test",
      "https://relay-b.test",
    ]);
    const config = parseEnv();
    expect(config.relays).toEqual(["https://relay-a.test", "https://relay-b.test"]);
  });
});

describe("parseEnv — mode", () => {
  it("defaults to mutate-with-confirm (Phase 1's new default)", () => {
    const config = parseEnv();
    expect(config.mode).toBe("mutate-with-confirm");
  });

  it("accepts explicit mode values", () => {
    process.env["BUZZ_MCP_MODE"] = "mutate";
    expect(parseEnv().mode).toBe("mutate");
    process.env["BUZZ_MCP_MODE"] = "read-only";
    expect(parseEnv().mode).toBe("read-only");
  });

  it("rejects unknown mode values", () => {
    process.env["BUZZ_MCP_MODE"] = "lol";
    expect(() => parseEnv()).toThrow();
  });
});

describe("parseEnv — relay allowlist", () => {
  it("is undefined when BUZZ_RELAY_ALLOWED is unset", () => {
    const config = parseEnv();
    expect(config.relayAllowed).toBeUndefined();
  });

  it("errors at startup when the configured default relay is not in the allowlist", () => {
    process.env["BUZZ_RELAY_URL"] = "https://relay-a.test";
    process.env["BUZZ_RELAY_ALLOWED"] = JSON.stringify(["https://relay-b.test"]);
    expect(() => parseEnv()).toThrow(/is not in BUZZ_RELAY_ALLOWED/);
  });

  it("accepts an allowlist that contains the configured relays", () => {
    process.env["BUZZ_RELAY_URL"] = "https://relay-a.test";
    process.env["BUZZ_RELAY_ALLOWED"] = JSON.stringify([
      "https://relay-a.test",
      "https://relay-b.test",
    ]);
    const config = parseEnv();
    expect(config.relayAllowed).toEqual(["https://relay-a.test", "https://relay-b.test"]);
  });
});

describe("parseEnv — relay host overrides", () => {
  it("collects BUZZ_RELAY_HOST_0..3 into relayHosts", () => {
    process.env["BUZZ_RELAY_URL"] = "https://relay-a.test";
    process.env["BUZZ_RELAY_HOST_0"] = "host-a.test";
    process.env["BUZZ_RELAY_HOST_2"] = "host-c.test";
    const config = parseEnv();
    expect(config.relayHosts).toEqual({
      "0": "host-a.test",
      "2": "host-c.test",
    });
  });
});

describe("parseEnv — Cloudflare Access", () => {
  it("sets cfAccess only when BOTH id and secret are non-empty", () => {
    process.env["CF_ACCESS_CLIENT_ID"] = "id";
    delete process.env["CF_ACCESS_CLIENT_SECRET"];
    expect(parseEnv().cfAccess).toBeUndefined();

    process.env["CF_ACCESS_CLIENT_SECRET"] = "secret";
    const config = parseEnv();
    expect(config.cfAccess).toEqual({ clientId: "id", clientSecret: "secret" });
  });
});

describe("parseEnv — channel cache TTL", () => {
  it("defaults to 5 minutes (Q1)", () => {
    const config = parseEnv();
    expect(config.channelCacheTtlMs).toBe(5 * 60 * 1000);
  });

  it("accepts an integer override", () => {
    process.env["BUZZ_CHANNEL_CACHE_TTL_MS"] = "30000";
    expect(parseEnv().channelCacheTtlMs).toBe(30_000);
  });

  it("rejects a non-positive override", () => {
    process.env["BUZZ_CHANNEL_CACHE_TTL_MS"] = "0";
    expect(() => parseEnv()).toThrow();
  });
});
