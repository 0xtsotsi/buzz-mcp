/**
 * Media upload MCP tool.
 *
 * `buzz_upload_media` uploads raw bytes to the relay via `PUT /media/upload`
 * (preferred — `CorePrt-relay/crates/buzz-relay/src/router.rs:39-46`), with
 * `/upload` as a fallback. The router mounts both routes to the same handler
 * (`api::media::upload_blob`); we try `/media/upload` first and fall back to
 * `/upload` if the relay returns 404.
 *
 * The file content comes from either:
 *   - `data`: base64-encoded bytes, or
 *   - `filePath`: a path the agent reads first.
 *
 * Path safety: `filePath` must be inside the operator's CWD. Absolute paths
 * outside CWD are rejected to prevent traversal. Files > 1 MiB are rejected.
 *
 * sha256 is computed client-side via `node:crypto`. The tool returns
 * `{url, sha256, mime}` plus the bytes-sent count; it does NOT touch any
 * filesystem outside `filePath`.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import process from "node:process";

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { signedFetchWithTimeout } from "../util/relay-call.js";
import { type NsecOrHex } from "../relay/signer.js";

const RELAY_BODY_PRINT_LIMIT = 1_000;
const TOOL_TIMEOUT_MS = 30_000; // uploads can be slow; 30s ceiling
const MAX_BYTES = 1024 * 1024; // 1 MiB hard cap

/** Reject any path that, when resolved, lies outside the CWD. */
function ensureInsideCwd(filePath: string): string {
  const cwd = process.cwd();
  // First, lexically resolve to an absolute path. Then realpathSync follows
  // symlinks so a symlink inside the CWD that targets /etc/passwd is still
  // caught by the CWD-traversal guard. realpathSync throws on non-existent
  // paths; let that bubble so the tool surfaces "file not found" instead of
  // a confusing CWD error.
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch (err) {
    throw new Error(`filePath "${filePath}" could not be resolved: ${(err as Error).message}`);
  }
  const rel = relative(cwd, realAbs);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(
      `filePath must resolve to inside the operator's CWD (${cwd}); got "${filePath}" → "${realAbs}" (rel="${rel}")`,
    );
  }
  return realAbs;
}

/** Decode a base64 string to bytes. Throws on malformed input. */
function base64ToBytes(b64: string): Uint8Array {
  // Strip data: URL prefix if any (the schema only allows the raw b64 form,
  // but be defensive).
  const cleaned = b64.replace(/^data:[^;]+;base64,/, "");
  // Buffer is broadly available in Node and handles base64 cleanly.
  return new Uint8Array(Buffer.from(cleaned, "base64"));
}

/**
 * Register `buzz_upload_media`. Tries `/media/upload` first, then `/upload`.
 * Returns `{url, sha256, mime, bytes}` on success.
 */
export function registerUploadMediaTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
): void {
  server.tool(
    "buzz_upload_media",
    "Upload media bytes to the relay (PUT /media/upload, falling back to /upload). " +
      "Provide EITHER `data` (base64-encoded bytes) OR `filePath` (resolved " +
      "relative to the operator's CWD, max 1 MiB). Returns the relay-assigned " +
      "URL plus client-side sha256 and mime.",
    {
      mime: z
        .string()
        .min(1)
        .max(128)
        .describe("MIME type, e.g. \"image/png\". Required."),
      data: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024, "data exceeds 2 MiB of base64 (~1.5 MiB decoded)")
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, "data is not valid base64")
        .optional()
        .describe("Base64-encoded bytes of the media. Mutually exclusive with `filePath`."),
      filePath: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          "Filesystem path of the media (resolved relative to the operator's CWD). " +
          "Mutually exclusive with `data`.",
        ),
      blurhash: z
        .string()
        .max(128)
        .optional()
        .describe("Optional blurhash placeholder string (informational only)."),
    },
    async (args) => {
      if ((args.data === undefined) === (args.filePath === undefined)) {
        throw new Error("provide exactly one of `data` or `filePath`");
      }

      // 1. Resolve bytes + sha256.
      let bytes: Uint8Array;
      if (args.data !== undefined) {
        bytes = base64ToBytes(args.data);
      } else {
        const absPath = ensureInsideCwd(args.filePath!);
        // Check the size BEFORE reading so a 1 GiB file doesn't blow up the
        // process. 1 MiB cap matches MAX_BYTES.
        const stat = statSync(absPath);
        if (stat.size > MAX_BYTES) {
          throw new Error(
            `media file is ${stat.size} bytes, exceeds ${MAX_BYTES}-byte (1 MiB) cap`,
          );
        }
        const nodeBuf = await readFile(absPath);
        bytes = new Uint8Array(nodeBuf.buffer, nodeBuf.byteOffset, nodeBuf.byteLength);
      }

      if (bytes.byteLength === 0) {
        throw new Error("media bytes are empty");
      }
      if (bytes.byteLength > MAX_BYTES) {
        throw new Error(
          `media is ${bytes.byteLength} bytes, exceeds ${MAX_BYTES}-byte (1 MiB) cap`,
        );
      }

      const sha256 = createHash("sha256").update(bytes).digest("hex");

      // 2. PUT to /media/upload first, fall back to /upload on 404.
      const base = relayUrl.replace(/\/$/, "");
      const endpoints = [`${base}/media/upload`, `${base}/upload`];

      let lastStatus = 0;
      let lastBody = "";
      let lastPath = "";
      for (const url of endpoints) {
        let resp;
        try {
          resp = await signedFetchWithTimeout(
            secret,
            {
              method: "PUT",
              url,
              body: bytes,
              headers: { "content-type": args.mime },
            },
            TOOL_TIMEOUT_MS,
          );
        } catch (err) {
          throw new Error(
            `relay at ${relayUrl} did not respond: ${(err as Error).message}`,
          );
        }

        lastStatus = resp.status;
        lastBody = resp.bodyText;
        lastPath = url;
        if (resp.status >= 200 && resp.status < 300) {
          // Parse the URL out of the relay's ack body — the shape is
          // `{url: "…"}`, `{sha256: "…", url: "…"}`, or just the URL string.
          let parsed: unknown;
          try {
            parsed = JSON.parse(resp.bodyText);
          } catch {
            parsed = resp.bodyText;
          }
          let returnedUrl: string | null = null;
          if (typeof parsed === "string") {
            returnedUrl = parsed;
          } else if (parsed && typeof parsed === "object") {
            const obj = parsed as { url?: unknown };
            if (typeof obj.url === "string") returnedUrl = obj.url;
          }
          if (returnedUrl === null) {
            throw new Error(
              `relay 2xx but no URL in body: ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
            );
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    url: returnedUrl,
                    sha256,
                    mime: args.mime,
                    bytes: bytes.byteLength,
                    blurhash: args.blurhash ?? null,
                    uploaded_to: url,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (resp.status !== 404) {
          // Non-404 error: don't try the next endpoint.
          throw new Error(
            `relay rejected upload: HTTP ${resp.status} — ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
          );
        }
      }

      throw new Error(
        `relay rejected upload (tried ${endpoints.join(", ")}): last HTTP ${lastStatus} — ${lastBody.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
      );
    },
  );
}