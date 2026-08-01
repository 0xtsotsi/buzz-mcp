/**
 * Pure event-builder helpers.
 *
 * Each builder returns a *fully-signed* {@link NostrEvent} — `id`, `pubkey`,
 * `sig`, and `created_at` are populated by {@link signEvent}. The signatures
 * here intentionally mirror the Rust SDK at
 * `~/Documents/projects/CorePrt/CorePrt-relay/crates/buzz-sdk/src/builders.rs`,
 * but deviate where CorePrt/Buzz uses UUID channel ids that we have not yet
 * resolved: we accept plain channel *names* and emit them as `["subject", …]`
 * tags, which is what the MCP tool surface expects from a model-facing API.
 * Once the relay's channel-routing shape is nailed down (UUID vs name), these
 * helpers can be tightened up — but the dev-only `["subject", …]` form keeps
 * the public contract stable for the first tool.
 *
 * No MCP, no IO, no fetch. Pure: only signs with the local signer.
 */
import { type NostrEvent, type NsecOrHex, signEvent } from "./signer.js";

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
  /** "open" or "private" (default "open"). The relay accepts "open" or "private" only — "public" was a v0.1.0 spec guess that the deployed relay rejects. */
  visibility?: "open" | "private";
  /** Free-form description (NIP-29 `about` tag). */
  description?: string;
};

/** Options for {@link buildAddMember}. */
export type BuildAddMemberOptions = {
  secret: NsecOrHex;
  /** 64-char hex pubkey of the member being added. */
  pubkey: string;
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
 *   - `["subject", <channel>]` — human channel name (dev-friendly form).
 *   - `["e", <replyTo>, "", "reply"]` — only when `replyTo` is set.
 *   - one `["imeta", …]` per entry — only when `imeta` is non-empty.
 *
 * NOTE: this shape is intentionally not a UUID `h` tag. We have not yet
 * resolved how MCP tool callers (model clients) will pick a channel —
 * they almost certainly don't have a UUID handy. The Rust SDK uses `h` for
 * its in-process callers; we deliberately emit `subject` so the relay's
 * subscription queries stay useful. PR #4 will reconcile.
 */
export async function buildMessage(opts: BuildMessageOptions): Promise<NostrEvent> {
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["subject", normalizeChannel(opts.channel)],
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
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["name", opts.name],
    ["visibility", opts.visibility ?? "open"],
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
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
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
