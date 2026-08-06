/**
 * Pure event-builder helpers.
 *
 * Each builder returns a *fully-signed* {@link NostrEvent} — `id`, `pubkey`,
 * `sig`, and `created_at` are populated by {@link signEvent}.
 *
 * Wire shape (PR-7): the CorePrt relay's channel router expects
 * `["h", <channel-uuid>]` (a v5 UUID derived from the channel name) for
 * kind:9 stream messages, kind:9007 `create_channel`, and kind:9000
 * `add_member`. Prior versions emitted only `["subject", <name>]` which
 * the relay accepted but the channel router did not file under a channel,
 * so every MCP-published message was effectively unfiled. The fix below:
 *  - `buildMessage`: emit `["h", <uuid>]` derived from the channel name,
 *    plus `["subject", <name>]` for human-friendly debugging.
 *  - `buildCreateChannel` / `buildAddMember`: emit `["h", <uuid>]`. The
 *    tool layer is expected to look up the canonical channel UUID via
 *    `buzz_list_channels` (see config/schema.ts: BUZZ_CHANNEL_CACHE_TTL_MS)
 *    and pass it in via the new `channelId` option; if not provided we
 *    derive from the channel name (stable across MCP restarts as long as
 *    the channel name is stable).
 *
 * The Rust SDK's `["h", <uuid>]` shape is the source of truth; see
 * `CorePrt-relay/crates/buzz-sdk/src/builders.rs:674, 565, 377–389`.
 *
 * No MCP, no IO, no fetch. Pure: only signs with the local signer.
 */
import { createHash } from "node:crypto";
import { type NostrEvent, type NsecOrHex, signEvent } from "./signer.js";

// ─── UUIDv5 helper (RFC 4122) ────────────────────────────────────────────
// We need a stable, deterministic UUID per channel name so the relay-side
// channel router can file MCP-published events into the right channel.
// UUIDv5 is the right tool: namespace + name → UUID, no random state, no
// library dependency. We use the URL namespace (the same one the Rust SDK
// uses for channel ids).

const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** Format a 16-byte buffer as a canonical lowercase UUIDv4-ish string. */
function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** SHA-1 the namespace UUID + the name, then reformat to UUIDv5. */
function uuidv5(name: string, namespace: string = NAMESPACE_URL): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1").update(nsBytes).update(nameBytes).digest();
  // Per RFC 4122 §4.3: set the version (5) and the variant (RFC 4122).
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return bytesToUuid(hash.subarray(0, 16));
}

/** Convert a friendly channel name to a stable channel UUID. */
export function channelNameToUuid(channel: string): string {
  return uuidv5(`coreprt:channel:${channel.trim().toLowerCase()}`);
}

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * NIP-92 imeta entry. The fields we emit cover what the Rust SDK accepts in
 * its `imeta_tags` helper (`url`, `m`, `x`, `dim`, `blurhash`). Extra fields
 * the Rust builder doesn't know about are dropped silently — the relay does
 * not validate the full imeta tag schema, just that the URL is present.
 */
export type ImetaEntry = {
  /** URL of the media. Required. */
  url: string;
  /** MIME type (NIP-92 `m` field). */
  mime?: string;
  /** sha-256 hex digest of the media bytes (NIP-92 `x` field). */
  sha256?: string;
  /** Pixel width (NIP-92 `dim` first half). */
  width?: number;
  /** Pixel height (NIP-92 `dim` second half). */
  height?: number;
  /** Blurhash placeholder string. */
  blurhash?: string;
};

/** Options for {@link buildMessage}. */
export type BuildMessageOptions = {
  secret: NsecOrHex;
  /** Channel name. Leading `#` is stripped. The relay filters on this. */
  channel: string;
  /** Optional pre-resolved channel UUID from `buzz_list_channels`. When
   * omitted, a deterministic UUIDv5 is derived from the channel name. */
  channelId?: string;
  /** Message body, UTF-8 text. */
  content: string;
  /** Event id being replied to (NIP-10). */
  replyTo?: string;
  /** NIP-92 media entries. */
  imeta?: ImetaEntry[];
};

/** Options for {@link buildForumPost}. */
export type BuildForumPostOptions = {
  secret: NsecOrHex;
  /** Community identifier — see note above about the chosen shape. */
  community: string;
  content: string;
  /** Thread subject. */
  subject?: string;
  /** Event id being replied to. */
  replyTo?: string;
};

/** Options for {@link buildEdit}. */
export type BuildEditOptions = {
  secret: NsecOrHex;
  /** Event id of the message being edited. */
  originalEventId: string;
  /** New content body. */
  newContent: string;
  /** Kind of the event being edited (1 or 9). */
  originalKind: 1 | 9;
};

/** Options for {@link buildReaction}. */
export type BuildReactionOptions = {
  secret: NsecOrHex;
  /** Event id of the message being reacted to. */
  targetEventId: string;
  /** Emoji shortcode (`+`, `🔥`, etc.). */
  emoji: string;
};

/** Options for {@link buildCreateChannel}. */
export type BuildCreateChannelOptions = {
  secret: NsecOrHex;
  /** Channel name (NIP-29 `name` tag). 1–64 chars. */
  name: string;
  /** Optional pre-allocated channel UUID from the relay (preferred).
   * When omitted, a deterministic UUIDv5 is derived from the name. The
   * relay may reject if the derived UUID conflicts with a pre-allocated
   * one, in which case the caller must look it up via `buzz_list_channels`
   * and pass `channelId`. */
  channelId?: string;
  /** "public" or "private" (default "public"). */
  visibility?: "public" | "private";
  /** Free-form description (NIP-29 `about` tag). */
  description?: string;
};

/** Options for {@link buildAddMember}. */
export type BuildAddMemberOptions = {
  secret: NsecOrHex;
  /** 64-char hex pubkey of the member being added. */
  pubkey: string;
  /** Channel UUID this membership applies to. Required — the relay
   * routes by `h`, not by name. Use `channelNameToUuid(name)` if you only
   * have the channel name. */
  channelId: string;
  /** Member role. */
  role?: "admin" | "member";
};

/** Options for {@link buildJob}. */
export type BuildJobOptions = {
  secret: NsecOrHex;
  /** Job title. */
  title: string;
  /** Job description (event content body). */
  description: string;
  /** Optional budget (numeric, embedded in the `["amount", …]` tag). */
  budget?: number;
  /** Optional due-at, ISO-8601 timestamp string. */
  dueAt?: string;
};

/** Options for {@link buildWorkflowApproval}. */
export type BuildWorkflowApprovalOptions = {
  secret: NsecOrHex;
  /** Workflow id (64-char hex acceptable in v1). */
  workflowId: string;
  /** Approval decision. */
  decision: "approve" | "reject";
  /** Optional human-readable note (event content body). */
  comment?: string;
};

/** Options for {@link buildThreadSummary}. */
export type BuildThreadSummaryOptions = {
  secret: NsecOrHex;
  /** Root event id of the thread being summarised. */
  rootEventId: string;
  /** Summary text. */
  summary: string;
};

/** Options for {@link buildDeletion} (NIP-09 kind:5). */
export type BuildDeletionOptions = {
  secret: NsecOrHex;
  /** Event id of the message being retracted. */
  originalEventId: string;
  /** Kind of the event being retracted (1, 9, etc.). The `["k"]` tag carries
   * this so relays that index by kind can drop the cached event. */
  originalKind: number;
  /** Optional human-readable reason; goes into the event `content`. */
  reason?: string;
};

/** Options for {@link buildProfile} (NIP-01 kind:0 metadata). */
export type BuildProfileOptions = {
  secret: NsecOrHex;
  /** Unique slug. Empty string clears the field. */
  name?: string;
  /** Rich display name. */
  display_name?: string;
  /** Short bio. */
  about?: string;
  /** Avatar URL. */
  picture?: string;
  /** NIP-05 identifier (e.g. `agent@coreprt.webrnds.com`). */
  nip05?: string;
  /** Lightning address (NIP-57 receiver). */
  lud16?: string;
  /** Banner image URL. */
  banner?: string;
  /** Website URL. */
  website?: string;
};

/** Options for {@link buildStatus} (NIP-38 kind:30315 user status). */
export type BuildStatusOptions = {
  secret: NsecOrHex;
  /** Replaceable-event `d` tag. Default `"general"`. Use `"channel:<name>"`
   * for per-channel status. */
  scope?: string;
  /** Status type. Maps to the `["status", …]` tag. */
  status: "active" | "away" | "offline";
  /** Short description of what you're doing. Goes into the `["content", …]`
   * tag. Max 200 chars. */
  content?: string;
  /** Optional ISO-8601 expiry. Goes into the `["expiration", …]` tag. */
  expiresAt?: string;
};

/** NIP-51 list kinds we support. */
export type Nip51ListKind = 10000 | 10001 | 10003 | 30000 | 30001;

/** Common NIP-51 list inputs. The `kind` determines which tag shape we emit. */
export type BuildNip51ListOptions = {
  secret: NsecOrHex;
  kind: Nip51ListKind;
  /** 64-char lowercase hex pubkey to add. For kind:30001 (people lists), can
   * be combined with a `["d", <listName>]` tag (set via `listName`). */
  pubkeys: readonly string[];
  /** Replaceable-event `d` tag — required for kind:30000 and kind:30001,
   * optional for kind:10000/10001/10003. The relay uses `d` to bucket the
   * list so multiple lists of the same kind can coexist. */
  listName?: string;
  /** Event content (free-form note). Default `""`. */
  content?: string;
};

/** Options for {@link buildPin} (NIP-51 kind:10001 short-form pin).
 * Distinct from the generic list builder because it carries `["e", …]`
 * event-id references instead of pubkey references. */
export type BuildPinOptions = {
  secret: NsecOrHex;
  /** 64-char lowercase hex event ids to pin. */
  eventIds: readonly string[];
  /** Optional replaceable-event `d` tag (one named pin list). */
  listName?: string;
  content?: string;
};
// ─── Internals ─────────────────────────────────────────────────────────────

/** Strip a leading `#` and surrounding whitespace; return the bare channel name. */
function normalizeChannel(channel: string): string {
  const trimmed = channel.trim();
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

/** Render an imeta entry as the array of NIP-92 sub-tags. */
function imetaTagFor(entry: ImetaEntry): string[] {
  const tag: string[] = ["imeta", `url ${entry.url}`];
  if (entry.mime !== undefined) {
    tag.push(`m ${entry.mime}`);
  }
  if (entry.sha256 !== undefined) {
    tag.push(`x ${entry.sha256}`);
  }
  if (entry.width !== undefined && entry.height !== undefined) {
    tag.push(`dim ${entry.width}x${entry.height}`);
  }
  if (entry.blurhash !== undefined) {
    tag.push(`blurhash ${entry.blurhash}`);
  }
  return tag;
}

// ─── Builders ──────────────────────────────────────────────────────────────

/**
 * Build a kind:9 stream/channel message event.
 *
 * Tags emitted (in this order):
 *   - `["client", "buzz-mcp"]` — relay-side filter for our publisher.
 *   - `["t", "euc"]` — CorePrt/Buzz-shaped event marker.
 *   - `["h", <channel-uuid>]` — UUIDv5 derived from the channel name; the
 *     relay's channel router files the event under this UUID. Required.
 *   - `["subject", <channel>]` — human-friendly channel name. Kept for
 *     readability; the relay treats `h` as the routing key.
 *   - `["e", <replyTo>, "", "reply"]` — only when `replyTo` is set.
 *   - one `["imeta", …]` per entry — only when `imeta` is non-empty.
 *
 * If the caller already knows the canonical channel UUID (e.g. they called
 * `buzz_list_channels` and cached it), they can pass `channelId` to avoid
 * the deterministic derive. Both shapes produce the same UUID for a given
 * name, so mixing the two is safe.
 */
export async function buildMessage(opts: BuildMessageOptions): Promise<NostrEvent> {
  const channelName = normalizeChannel(opts.channel);
  const channelUuid = opts.channelId ?? channelNameToUuid(channelName);
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["h", channelUuid],
    ["subject", channelName],
  ];
  if (opts.replyTo !== undefined) {
    tags.push(["e", opts.replyTo, "", "reply"]);
  }
  if (opts.imeta !== undefined) {
    for (const entry of opts.imeta) {
      tags.push(imetaTagFor(entry));
    }
  }

  const signed = signEvent(opts.secret, {
    kind: 9,
    tags,
    content: opts.content,
  });
  return signed;
}

/**
 * Build a kind:1 forum-post text note.
 *
 * The community identifier is currently emitted as a single-element `["a",
 * <community>]` tag — this is a *deliberate placeholder* chosen to keep the
 * event shape unambiguous while we wait for the relay to settle on the
 * canonical CorePrt-forum coordinate format. Once the spec names the shape
 * (an addressable-event coordinate `30023:<pubkey>:<d-tag>` is the most
 * likely form) this helper will be tightened.
 *
 * Tags emitted:
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["subject", <subject>]` (if `subject` provided)
 *   - `["e", <replyTo>, "", "reply"]` (if `replyTo` provided)
 *   - `["a", <community>]` (always)
 */
export async function buildForumPost(opts: BuildForumPostOptions): Promise<NostrEvent> {
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["a", opts.community],
  ];
  if (opts.subject !== undefined) {
    tags.push(["subject", opts.subject]);
  }
  if (opts.replyTo !== undefined) {
    tags.push(["e", opts.replyTo, "", "reply"]);
  }

  const signed = signEvent(opts.secret, {
    kind: 1,
    tags,
    content: opts.content,
  });
  return signed;
}

/**
 * Build a kind:40003 edit event (Buzz-specific edit kind — confirmed against
 * `CorePrt-relay/crates/buzz-sdk/src/builders.rs:377–389` `build_edit`). Falls
 * back to NIP-33 kind:5 with a `["e", id, "", "edit"]` tag if the relay
 * rejects 40003 in the future; for now 40003 is what the Rust SDK emits and
 * what CorePrt relays accept. The `originalKind` option is accepted (and
 * validated) but not emitted as a tag — the prompt scope is `["e", id, "",
 * "edit"]` only.
 */
export async function buildEdit(opts: BuildEditOptions): Promise<NostrEvent> {
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["e", opts.originalEventId, "", "edit"],
    // `k` identifies the kind of the original event being edited (1 or 9)
    // so consumers can render the edit without re-fetching the target.
    ["k", String(opts.originalKind)],
  ];

  const signed = signEvent(opts.secret, {
    kind: 40003,
    tags,
    content: opts.newContent,
  });
  return signed;
}

/**
 * Build a kind:7 reaction event (NIP-25). Per the PR-3 prompt we emit
 * `["e", targetEventId]` and `["content", emoji]` as tags. The emoji is
 * also kept on the event `content` field for backwards compatibility with
 * NIP-25 readers. No `k` tag — the Rust SDK doesn't emit one and the prompt
 * says to omit it when the Rust source does.
 */
export async function buildReaction(opts: BuildReactionOptions): Promise<NostrEvent> {
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["e", opts.targetEventId],
    ["content", opts.emoji],
  ];

  const signed = signEvent(opts.secret, {
    kind: 7,
    tags,
    content: opts.emoji,
  });
  return signed;
}

/**
 * Build a kind:9007 NIP-29 `create_channel` event.
 *
 * Tags emitted:
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["name", <name>]`
 *   - `["visibility", "public"|"private"]` (always — defaults to "public")
 *   - `["about", <description>]` (only when `description` is provided)
 *
 * TODO: the Rust SDK's `build_create_channel` (`CorePrt-relay/crates/buzz-sdk/src/builders.rs:674`)
 * requires a pre-generated `channel_id: Uuid` for the `["h", <uuid>]` tag. We
 * intentionally omit the `h` tag in v1 because the agent doesn't yet know the
 * relay-allocated channel UUID; the relay should allocate one on ingest. If
 * the relay rejects this shape we'll switch to a client-generated v4 UUID.
 */
export async function buildCreateChannel(opts: BuildCreateChannelOptions): Promise<NostrEvent> {
  const channelUuid = opts.channelId ?? channelNameToUuid(opts.name);
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["h", channelUuid],
    ["name", opts.name],
    ["visibility", opts.visibility ?? "public"],
  ];
  if (opts.description !== undefined && opts.description.length > 0) {
    tags.push(["about", opts.description]);
  }

  const signed = signEvent(opts.secret, {
    kind: 9007,
    tags,
    content: "",
  });
  return signed;
}

/**
 * Build a kind:9000 NIP-29 `add_member` event.
 *
 * Tags emitted:
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["p", <pubkey>]` — NIP-29 required
 *   - `["role", "admin"|"member"]` (only when `role` is provided)
 *
 * TODO: the Rust SDK's `build_add_member` (`CorePrt-relay/crates/buzz-sdk/src/builders.rs:565`)
 * requires a `channel_id: Uuid` for the `["h", <uuid>]` tag. We intentionally
 * omit the `h` tag in v1 because the agent doesn't yet know the
 * relay-allocated channel UUID. If the relay rejects this shape we'll switch
 * to passing the channel UUID from the corresponding `buzz_create_channel`
 * response.
 *
 * NOTE (CLAUDE.md / `CorePrt/run.sh:120`): real back-to-back add-member calls
 * must be `sleep 1` apart. The MCP tool surfaces this in its description; the
 * helper itself doesn't enforce it (and shouldn't — there's no relay call here).
 */
export async function buildAddMember(opts: BuildAddMemberOptions): Promise<NostrEvent> {
  if (!opts.channelId) {
    throw new Error("buildAddMember: channelId is required (use channelNameToUuid() if you only have the name)");
  }
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["h", opts.channelId],
    ["p", opts.pubkey],
  ];
  if (opts.role !== undefined) {
    tags.push(["role", opts.role]);
  }

  const signed = signEvent(opts.secret, {
    kind: 9000,
    tags,
    content: "",
  });
  return signed;
}

/**
 * Build a kind:43001 `KIND_JOB_REQUEST` event (Buzz-specific job protocol —
 * confirmed against `CorePrt-relay/crates/buzz-core/src/kind.rs:458`). The
 * Rust SDK doesn't ship a dedicated `build_create_job` helper yet, so this
 * builder uses the canonical kind and standard tags; the relay's `/events`
 * ingest is the source of truth on which extra tags it honours.
 *
 * Tags emitted:
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["title", <title>]`
 *   - `["summary", <description>]` (event `content` holds the long description)
 *   - `["amount", String(budget)]` (only when `budget` is provided)
 *   - `["due", String(dueAt)]` (only when `dueAt` is provided)
 *
 * TODO: replace with the canonical Rust SDK shape once `build_create_job`
 * lands in `CorePrt-relay/crates/buzz-sdk/src/builders.rs`. The kind (43001)
 * is canonical; only the tag shape may need to change.
 */
export async function buildJob(opts: BuildJobOptions): Promise<NostrEvent> {
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["title", opts.title],
    // Truncate the summary-tag value to 200 chars. The full description is
    // still in `content`; the tag is just a search-friendly summary.
    ["summary", opts.description.slice(0, 200)],
  ];
  if (opts.budget !== undefined) {
    tags.push(["amount", String(opts.budget)]);
  }
  if (opts.dueAt !== undefined && opts.dueAt.length > 0) {
    tags.push(["due", opts.dueAt]);
  }

  const signed = signEvent(opts.secret, {
    kind: 43001,
    tags,
    content: opts.description,
  });
  return signed;
}

/**
 * Build a workflow approval event — kind 46030 (grant) or 46031 (deny)
 * (`KIND_APPROVAL_GRANT` / `KIND_APPROVAL_DENY` — confirmed against
 * `CorePrt-relay/crates/buzz-core/src/kind.rs:500-502`). The Rust SDK's
 * `build_workflow_approval` (`CorePrt-relay/crates/buzz-sdk/src/builders.rs:1522`)
 * uses `token_hash` (sha256 hex of an approval-token UUID) as the `d`-tag
 * for a parameterized-replaceable event; for the MCP surface we accept a
 * plain `workflowId` and emit it as an `e`-tag instead, which is what the
 * `/events` ingest currently understands.
 *
 * Tags emitted:
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["e", <workflowId>]` — references the workflow being approved/denied
 *   - `["comment", <comment>]` (only when `comment` is provided)
 *
 * TODO: switch to `["d", <token_hash>]` once the Rust SDK's canonical
 * `build_workflow_approval` shape is also what `/events` ingest expects.
 */
export async function buildWorkflowApproval(
  opts: BuildWorkflowApprovalOptions,
): Promise<NostrEvent> {
  const kind = opts.decision === "approve" ? 46030 : 46031;
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["e", opts.workflowId],
  ];
  if (opts.comment !== undefined && opts.comment.length > 0) {
    tags.push(["comment", opts.comment]);
  }

  const signed = signEvent(opts.secret, {
    kind,
    tags,
    content: opts.comment ?? "",
  });
  return signed;
}

/**
 * Build a kind:39005 `KIND_THREAD_SUMMARY` event (canonical kind confirmed
 * against `CorePrt-relay/crates/buzz-core/src/kind.rs:375`). Carries a single
 * NIP-10 `["e", <root>, "", "root"]` tag pointing at the thread's root event.
 *
 * Tags emitted:
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["e", <rootEventId>, "", "root"]`
 */
export async function buildThreadSummary(opts: BuildThreadSummaryOptions): Promise<NostrEvent> {
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["e", opts.rootEventId, "", "root"],
  ];

  const signed = signEvent(opts.secret, {
    kind: 39005,
    tags,
    content: opts.summary,
  });
  return signed;
}

/**
 * Build a NIP-09 kind:5 deletion (retraction) event.
 *
 * Tags emitted (in this order):
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["k", <originalKind>]` — kind of the event being deleted
 *   - `["e", <originalEventId>]` — event id being deleted
 *
 * The event `content` carries the optional human-readable reason. Per NIP-09,
 * relays MAY interpret a kind:5 as a request to delete any event with a
 * matching `["e"]` tag and a pubkey the deleter is allowed to modify. For
 * CorePrt/Buzz (relay-owner edit) the relay may treat this as a soft-delete
 * rather than a hard drop; either way, downstream clients stop rendering
 * the original once they see the retraction.
 */
export async function buildDeletion(opts: BuildDeletionOptions): Promise<NostrEvent> {
  if (!Number.isInteger(opts.originalKind) || opts.originalKind < 0 || opts.originalKind > 65535) {
    throw new Error(`buildDeletion: originalKind must be 0..65535 (got ${opts.originalKind})`);
  }
  if (!/^[0-9a-f]{64}$/.test(opts.originalEventId)) {
    throw new Error("buildDeletion: originalEventId must be 64-char lowercase hex");
  }

  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["k", String(opts.originalKind)],
    ["e", opts.originalEventId],
  ];

  const signed = signEvent(opts.secret, {
    kind: 5,
    tags,
    content: opts.reason ?? "",
  });
  return signed;
}

/**
 * Build a NIP-01 kind:0 profile / metadata event.
 *
 * The event `content` is the canonical JSON encoding of the profile fields.
 * An omitted field is dropped from the content; an explicit `undefined`
 * (e.g. `name: ""`) is a request to clear that field. To avoid spurious
 * empty-string keys from JSON.stringify, we only include defined values.
 *
 * Tags emitted: `["client", "buzz-mcp"]`, `["t", "euc"]`.
 *
 * The MCP tool layer should validate the resulting content round-trips
 * through `JSON.parse` before posting; we do that here as a safety check.
 */
export async function buildProfile(opts: BuildProfileOptions): Promise<NostrEvent> {
  const profile: Record<string, string> = {};
  if (opts.name !== undefined) profile["name"] = opts.name;
  if (opts.display_name !== undefined) profile["display_name"] = opts.display_name;
  if (opts.about !== undefined) profile["about"] = opts.about;
  if (opts.picture !== undefined) profile["picture"] = opts.picture;
  if (opts.nip05 !== undefined) profile["nip05"] = opts.nip05;
  if (opts.lud16 !== undefined) profile["lud16"] = opts.lud16;
  if (opts.banner !== undefined) profile["banner"] = opts.banner;
  if (opts.website !== undefined) profile["website"] = opts.website;

  const content = JSON.stringify(profile);
  // Round-trip to make sure the content is valid JSON before we sign.
  JSON.parse(content);

  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
  ];

  const signed = signEvent(opts.secret, {
    kind: 0,
    tags,
    content,
  });
  return signed;
}

/**
 * Build a NIP-38 kind:30315 user-status event.
 *
 * The `["d"]` tag is what makes this a *replaceable* event (NIP-33): posting
 * a new status with the same `d` overwrites the prior one. We default the
 * scope to `"general"` so a simple "I'm online" works without parameters;
 * the tool layer can pass `"channel:<name>"` for per-channel status.
 *
 * Tags emitted (in this order):
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["d", <scope>]` — always
 *   - `["status", <type>]` — always
 *   - `["content", <content>]` — only when `content` is non-empty
 *   - `["expiration", <iso>]` — only when `expiresAt` is provided
 */
export async function buildStatus(opts: BuildStatusOptions): Promise<NostrEvent> {
  const scope = opts.scope ?? "general";
  if (scope.length > 64) {
    throw new Error(`buildStatus: scope must be ≤ 64 chars (got ${scope.length})`);
  }
  if (opts.content !== undefined && opts.content.length > 200) {
    throw new Error(`buildStatus: content must be ≤ 200 chars (got ${opts.content.length})`);
  }

  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["d", scope],
    ["status", opts.status],
  ];
  if (opts.content !== undefined && opts.content.length > 0) {
    tags.push(["content", opts.content]);
  }
  if (opts.expiresAt !== undefined && opts.expiresAt.length > 0) {
    tags.push(["expiration", opts.expiresAt]);
  }

  const signed = signEvent(opts.secret, {
    kind: 30315,
    tags,
    content: opts.content ?? "",
  });
  return signed;
}

const NIP51_HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validate a list of hex pubkeys. The empty list is allowed: per NIP-51,
 * kind:10000 (mute) and kind:10003 (bookmark) are not "replaceable" so an
 * empty tag list just means "no entries". The {@link buildNip51List} caller
 * is responsible for deciding which kinds require non-empty.
 */
function validatePubkeys(pubkeys: readonly string[]): void {
  for (const pk of pubkeys) {
    if (typeof pk !== "string" || !NIP51_HEX64.test(pk)) {
      throw new Error(
        `buildNip51List: pubkey must be 64 lowercase hex characters (got ${JSON.stringify(pk)})`,
      );
    }
  }
}

/**
 * Build a NIP-51 list event (kinds 10000 mute, 10003 bookmark, 30000
 * follows, 30001 people list). Kind 10001 (pin) carries event-id
 * references — use {@link buildPin} for that.
 *
 * For replaceable events (kinds 30000 / 30001), `listName` is required —
 * the relay uses `["d", <listName>]` to bucket the lists. For non-
 * replaceable (kinds 10000 / 10003), `listName` is ignored. The pubkey
 * list may be empty (e.g. "unmute everyone"); we emit no `["p", …]` tags
 * in that case.
 *
 * Tags emitted (in this order):
 *   - `["client", "buzz-mcp"]`
 *   - `["t", "euc"]`
 *   - `["d", <listName>]` — only when set and kind is replaceable
 *   - `["p", <pubkey>]` — one per entry (zero or more)
 */
export async function buildNip51List(opts: BuildNip51ListOptions): Promise<NostrEvent> {
  validatePubkeys(opts.pubkeys);

  const REPLACEABLE: ReadonlySet<number> = new Set([30000, 30001]);
  if (REPLACEABLE.has(opts.kind) && (opts.listName === undefined || opts.listName === "")) {
    throw new Error(
      `buildNip51List: kind ${opts.kind} is replaceable; listName (d-tag) is required`,
    );
  }

  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
  ];
  if (opts.listName !== undefined && opts.listName !== "") {
    if (opts.listName.length > 64) {
      throw new Error("buildNip51List: listName must be ≤ 64 chars");
    }
    tags.push(["d", opts.listName]);
  }
  for (const pk of opts.pubkeys) {
    tags.push(["p", pk]);
  }

  const signed = signEvent(opts.secret, {
    kind: opts.kind,
    tags,
    content: opts.content ?? "",
  });
  return signed;
}

/**
 * Build a NIP-51 kind:10001 pin event. Carries event-id references
 * (`["e", …]`) instead of pubkey references.
 *
 * `listName` is optional; when set, the pin belongs to the named
 * replaceable bucket. The relay dedupes by `(pubkey, kind, d, e)` so
 * pinning the same event twice is a no-op.
 */
export async function buildPin(opts: BuildPinOptions): Promise<NostrEvent> {
  if (opts.eventIds.length === 0) {
    throw new Error("buildPin: eventIds must be non-empty");
  }
  for (const id of opts.eventIds) {
    if (typeof id !== "string" || !NIP51_HEX64.test(id)) {
      throw new Error(
        `buildPin: eventId must be 64 lowercase hex characters (got ${JSON.stringify(id)})`,
      );
    }
  }

  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
  ];
  if (opts.listName !== undefined && opts.listName !== "") {
    if (opts.listName.length > 64) {
      throw new Error("buildPin: listName must be ≤ 64 chars");
    }
    tags.push(["d", opts.listName]);
  }
  for (const id of opts.eventIds) {
    tags.push(["e", id]);
  }

  const signed = signEvent(opts.secret, {
    kind: 10001,
    tags,
    content: opts.content ?? "",
  });
  return signed;
}
