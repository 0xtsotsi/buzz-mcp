/**
 * Unit tests for the four event builders.
 *
 * Each builder is exercised with a fixed nsec so the resulting event id is
 * deterministic across runs. The tests assert shape, not byte-for-byte
 * event ids, because the id depends on `created_at`.
 */
import { describe, it, expect } from "vitest";
import { getPublicKey } from "../../src/relay/signer.js";
import {
  buildMessage,
  buildForumPost,
  buildEdit,
  buildReaction,
} from "../../src/relay/event-builder.js";

const SECRET =
  "0000000000000000000000000000000000000000000000000000000000000001";
const PUBKEY = getPublicKey(SECRET);

const FIXED_TAGS_KEY = "imeta";

function findTag(event: { tags: string[][] }, name: string): string[] | undefined {
  return event.tags.find((t) => t[0] === name);
}

describe("buildMessage", () => {
  it("returns a fully-signed kind:9 event", async () => {
    const evt = await buildMessage({
      secret: SECRET,
      channel: "general",
      content: "hello",
    });
    expect(evt.kind).toBe(9);
    expect(evt.pubkey).toBe(PUBKEY);
    expect(evt.id).toMatch(/^[0-9a-f]{64}$/);
    expect(evt.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(evt.content).toBe("hello");
    expect(typeof evt.created_at).toBe("number");
  });

  it("emits client + euc + subject tags", async () => {
    const evt = await buildMessage({
      secret: SECRET,
      channel: "general",
      content: "hi",
    });
    expect(findTag(evt, "client")).toEqual(["client", "buzz-mcp"]);
    expect(findTag(evt, "t")).toEqual(["t", "euc"]);
    expect(findTag(evt, "subject")).toEqual(["subject", "general"]);
  });

  it("strips a leading '#' from the channel name", async () => {
    const evt = await buildMessage({
      secret: SECRET,
      channel: "#general",
      content: "hi",
    });
    expect(findTag(evt, "subject")).toEqual(["subject", "general"]);
  });

  it("emits a NIP-10 reply tag when replyTo is set", async () => {
    const replyId = "0".repeat(64);
    const evt = await buildMessage({
      secret: SECRET,
      channel: "general",
      content: "reply",
      replyTo: replyId,
    });
    expect(findTag(evt, "e")).toEqual(["e", replyId, "", "reply"]);
  });

  it("emits imeta tags for media entries", async () => {
    const evt = await buildMessage({
      secret: SECRET,
      channel: "general",
      content: "with media",
      imeta: [
        {
          url: "https://example.com/a.png",
          mime: "image/png",
          sha256: "a".repeat(64),
          width: 800,
          height: 600,
        },
      ],
    });
    const imeta = findTag(evt, FIXED_TAGS_KEY);
    expect(imeta).toBeDefined();
    expect(imeta!.join(" ")).toContain("url https://example.com/a.png");
    expect(imeta!.join(" ")).toContain("m image/png");
    expect(imeta!.join(" ")).toContain(`x ${"a".repeat(64)}`);
    expect(imeta!.join(" ")).toContain("dim 800x600");
  });
});

describe("buildForumPost", () => {
  it("returns a fully-signed kind:1 event with a community tag", async () => {
    const evt = await buildForumPost({
      secret: SECRET,
      community: "coreprt",
      content: "first post",
    });
    expect(evt.kind).toBe(1);
    expect(evt.pubkey).toBe(PUBKEY);
    expect(evt.id).toMatch(/^[0-9a-f]{64}$/);
    expect(findTag(evt, "a")).toEqual(["a", "coreprt"]);
    expect(findTag(evt, "client")).toEqual(["client", "buzz-mcp"]);
  });

  it("emits subject + reply tags when provided", async () => {
    const replyId = "1".repeat(64);
    const evt = await buildForumPost({
      secret: SECRET,
      community: "coreprt",
      content: "thread",
      subject: "Welcome",
      replyTo: replyId,
    });
    expect(findTag(evt, "subject")).toEqual(["subject", "Welcome"]);
    expect(findTag(evt, "e")).toEqual(["e", replyId, "", "reply"]);
  });
});

describe("buildEdit", () => {
  it("returns a kind:40003 event with the original id as an e tag", async () => {
    const originalId = "2".repeat(64);
    const evt = await buildEdit({
      secret: SECRET,
      originalEventId: originalId,
      newContent: "edited",
      originalKind: 9,
    });
    expect(evt.kind).toBe(40003);
    expect(findTag(evt, "e")).toEqual(["e", originalId, "", "edit"]);
    expect(evt.content).toBe("edited");
  });
});

describe("buildReaction", () => {
  it("returns a kind:7 event with e + content tags", async () => {
    const targetId = "3".repeat(64);
    const evt = await buildReaction({
      secret: SECRET,
      targetEventId: targetId,
      emoji: "+",
    });
    expect(evt.kind).toBe(7);
    expect(findTag(evt, "e")).toEqual(["e", targetId]);
    expect(findTag(evt, "content")).toEqual(["content", "+"]);
    expect(evt.content).toBe("+");
  });
});

describe("created_at is sane", () => {
  it("is within 5s of now for all four builders", async () => {
    const before = Math.floor(Date.now() / 1000);
    const events = await Promise.all([
      buildMessage({ secret: SECRET, channel: "g", content: "a" }),
      buildForumPost({ secret: SECRET, community: "c", content: "a" }),
      buildEdit({
        secret: SECRET,
        originalEventId: "9".repeat(64),
        newContent: "a",
        originalKind: 9,
      }),
      buildReaction({
        secret: SECRET,
        targetEventId: "8".repeat(64),
        emoji: "+",
      }),
    ]);
    const after = Math.floor(Date.now() / 1000);
    for (const e of events) {
      expect(e.created_at).toBeGreaterThanOrEqual(before - 5);
      expect(e.created_at).toBeLessThanOrEqual(after + 5);
    }
  });
});
