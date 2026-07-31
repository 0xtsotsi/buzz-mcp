import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

import {
  signedFetch,
  type SignedFetchOptions,
} from "../../src/relay/client.js";
import { getPublicKey } from "../../src/relay/signer.js";

const SECRET =
  "0000000000000000000000000000000000000000000000000000000000000001";
const EXPECTED_PUBKEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

type CapturedCall = {
  url: string;
  init: RequestInit | undefined;
};

let captured: CapturedCall[];
let originalFetch: typeof globalThis.fetch;

function decodeAuthEvent(authValue: string): {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
  pubkey: string;
  id: string;
  sig: string;
} {
  expect(authValue.startsWith("Nostr ")).toBe(true);
  const b64 = authValue.slice("Nostr ".length);
  const json = atob(b64);
  return JSON.parse(json);
}

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured.push({ url: String(url), init });
    const headers = new Headers(init?.headers ?? {});
    return new Response("ok", { status: 200, headers });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("signedFetch", () => {
  it("attaches a NIP-98 Authorization header with kind=27235 for GET", async () => {
    const opts: SignedFetchOptions = {
      method: "GET",
      url: "https://relay.example/api/hello",
    };
    const before = JSON.stringify(opts);
    await signedFetch(SECRET, opts);
    // Don't mutate the input.
    expect(JSON.stringify(opts)).toBe(before);

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call.url).toBe("https://relay.example/api/hello");
    expect(call.init?.method).toBe("GET");

    const authHeader = (call.init?.headers as Record<string, string>)[
      "Authorization"
    ];
    expect(authHeader).toBeTruthy();

    const evt = decodeAuthEvent(authHeader);
    expect(evt.kind).toBe(27235);
    expect(evt.pubkey).toBe(EXPECTED_PUBKEY);
    expect(evt.id).toMatch(/^[0-9a-f]{64}$/);
    expect(evt.sig).toMatch(/^[0-9a-f]{128}$/);

    const tagsByName = new Map(evt.tags.map((t) => [t[0], t.slice(1)]));
    expect(tagsByName.get("u")).toEqual(["https://relay.example/api/hello"]);
    expect(tagsByName.get("method")).toEqual(["GET"]);

    // Payload is sha256 of empty string for GET.
    const expectedPayload = bytesToHex(sha256(new TextEncoder().encode("")));
    expect(tagsByName.get("payload")).toEqual([expectedPayload]);
  });

  it("hashed the JSON body for POST and passed the body through verbatim", async () => {
    const body = JSON.stringify({ hello: "world" });
    const opts: SignedFetchOptions = {
      method: "POST",
      url: "https://relay.example/api/echo",
      body,
      headers: { "Content-Type": "application/json" },
    };
    await signedFetch(SECRET, opts);

    expect(captured).toHaveLength(1);
    const call = captured[0];
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe(body);

    const headers = call.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");

    const evt = decodeAuthEvent(headers["Authorization"]);
    const tagsByName = new Map(evt.tags.map((t) => [t[0], t.slice(1)]));
    expect(tagsByName.get("method")).toEqual(["POST"]);

    const expectedPayload = bytesToHex(sha256(new TextEncoder().encode(body)));
    expect(tagsByName.get("payload")).toEqual([expectedPayload]);
  });

  it("hashed a Uint8Array body for POST", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await signedFetch(SECRET, {
      method: "PUT",
      url: "https://relay.example/api/upload",
      body: bytes,
    });
    const call = captured[0];
    const evt = decodeAuthEvent(
      (call.init?.headers as Record<string, string>)["Authorization"],
    );
    const tagsByName = new Map(evt.tags.map((t) => [t[0], t.slice(1)]));
    const expectedPayload = bytesToHex(sha256(bytes));
    expect(tagsByName.get("payload")).toEqual([expectedPayload]);
    expect(call.init?.body).toBe(bytes); // passed by reference, not mutated
  });

  it("the NIP-98 event id matches sha256 of the serialized event", async () => {
    await signedFetch(SECRET, {
      method: "GET",
      url: "https://relay.example/ping",
    });
    const evt = decodeAuthEvent(
      (captured[0].init?.headers as Record<string, string>)["Authorization"],
    );
    const serialized = JSON.stringify([
      0,
      evt.pubkey,
      evt.created_at,
      evt.kind,
      evt.tags,
      evt.content,
    ]);
    const expectedId = bytesToHex(
      sha256(new TextEncoder().encode(serialized)),
    );
    expect(evt.id).toBe(expectedId);
  });

  it("does not mutate the input opts bag", async () => {
    const opts: SignedFetchOptions = {
      method: "POST",
      url: "https://relay.example/api/mut",
      body: "hello",
      headers: { "Content-Type": "text/plain" },
    };
    const snapshot = JSON.stringify(opts);
    await signedFetch(SECRET, opts);
    expect(JSON.stringify(opts)).toBe(snapshot);
    // Confirm headers bag did not gain an Authorization field.
    expect(opts.headers!["Authorization"]).toBeUndefined();
  });

  it("returns status, headers, and body text from the underlying fetch", async () => {
    const result = await signedFetch(SECRET, {
      method: "GET",
      url: "https://relay.example/anything",
    });
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe("ok");
    expect(result.headers).toBeInstanceOf(Headers);
  });
});
