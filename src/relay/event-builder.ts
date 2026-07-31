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
import { signEvent, type NsecOrHex, type NostrEvent } from "./signer.js";

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
export async function buildMessage(
  opts: BuildMessageOptions,
): Promise<NostrEvent> {
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
export async function buildForumPost(
  opts: BuildForumPostOptions,
): Promise<NostrEvent> {
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
export async function buildEdit(
  opts: BuildEditOptions,
): Promise<NostrEvent> {
  const tags: string[][] = [
    ["client", "buzz-mcp"],
    ["t", "euc"],
    ["e", opts.originalEventId, "", "edit"],
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
export async function buildReaction(
  opts: BuildReactionOptions,
): Promise<NostrEvent> {
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
