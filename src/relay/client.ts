/**
 * NIP-98 `Authorization: Nostr <base64(kind27235-event)>` HTTP wrapper.
 *
 * Pure module: takes a `NsecOrHex` secret and a request descriptor, performs
 * a single `globalThis.fetch` call. No retry, no timeout, no rate-limit —
 * those are out of scope for this PR and belong to the higher-level relay
 * client added in a later PR.
 *
 * Reference: https://github.com/nostr-protocol/nips/blob/master/98.md
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

import { signEvent, type Hex64, type NsecOrHex, type NostrEvent } from "./signer.js";

// ─── Public types ──────────────────────────────────────────────────────────

export type SignedFetchMethod = "GET" | "POST" | "PUT" | "DELETE";

export type SignedFetchOptions = {
  method: SignedFetchMethod;
  url: string;
  /** String (e.g. JSON body) or raw bytes. `undefined` for GET/DELETE. */
  body?: string | Uint8Array;
  /** Extra request headers. `Authorization` is reserved — see signedFetch. */
  headers?: Record<string, string>;
};

export type SignedFetchResult = {
  status: number;
  headers: Headers;
  bodyText: string;
};

// ─── NIP-98 helpers ────────────────────────────────────────────────────────

/**
 * NIP-98 mandates: `Authorization: Nostr <base64(base64(jsonString))>` where
 * the inner JSON is a kind:27235 event signed with the user's key. The base64
 * is of the *string* bytes of `JSON.stringify(event)`, NOT of the event object
 * (see https://github.com/nostr-protocol/nips/blob/master/98.md).
 *
 * `btoa` only works in environments where `Uint8Array → binary string` round
 * trips correctly. Node ≥18 has it via undici.
 */
function base64Encode(s: string): string {
  return btoa(s);
}

/**
 * Hash the request body for the NIP-98 `payload` tag. Empty string for
 * GET/DELETE (no body). The spec says: sha256 of the raw request body bytes.
 */
function payloadHash(body: string | Uint8Array | undefined): string {
  let bytes: Uint8Array;
  if (body === undefined) {
    bytes = new TextEncoder().encode("");
  } else if (typeof body === "string") {
    bytes = new TextEncoder().encode(body);
  } else {
    bytes = body;
  }
  return bytesToHex(sha256(bytes));
}

function buildAuthHeader(secret: NsecOrHex, opts: SignedFetchOptions): string {
  const event: NostrEvent = signEvent(secret, {
    kind: 27235,
    tags: [
      ["u", opts.url],
      ["method", opts.method],
      ["payload", payloadHash(opts.body)],
    ],
    content: "",
    created_at: Math.floor(Date.now() / 1000),
  });
  const json = JSON.stringify(event);
  return `Nostr ${base64Encode(json)}`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Perform a NIP-98-signed `fetch`. Attaches `Authorization: Nostr <…>`
 * derived from a fresh kind:27235 event signed with `secret`. Returns the
 * response status, headers, and body text.
 *
 * The input `opts` and any `Uint8Array` body are NOT mutated. String bodies
 * are also passed through by reference, but the underlying fetch may encode
 * them differently (the `bodyText` field of the result is the response,
 * not the request).
 */
export async function signedFetch(
  secret: NsecOrHex,
  opts: SignedFetchOptions,
): Promise<SignedFetchResult> {
  const authHeader = buildAuthHeader(secret, opts);

  // Don't mutate caller's headers bag — clone it.
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  headers["Authorization"] = authHeader;

  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    // RequestInit.body is BodyInit | null; Uint8Array is valid at runtime,
    // but the lib.dom / undici typings differ. Cast through BodyInit.
    init.body = opts.body as BodyInit;
  }

  const res = await fetch(opts.url, init);
  // Buffer the body as text so callers can inspect/re-parse.
  const bodyText = await res.text();
  return { status: res.status, headers: res.headers, bodyText };
}

export type { Hex64, NsecOrHex, NostrEvent };
