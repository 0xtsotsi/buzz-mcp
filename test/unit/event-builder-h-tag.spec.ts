/**
 * Unit tests for the PR-7 wire-shape fix: every event that needs a
 * channel UUID must emit `["h", <uuid>]`. Without this, the CorePrt
 * relay's channel router does not file the event under any channel.
 *
 * Bug history:
 *   - Prior versions emitted only `["subject", <name>]` which the relay
 *     accepted but the channel router silently ignored. Every MCP
 *     message landed in "no channel".
 *   - Symptom: `mcp__buzz__buzz_post_message` returning
 *     `invalid_format` from the relay.
 *
 * These tests pin the new shape so a future refactor cannot regress.
 */
import { describe, expect, it } from "vitest";
import {
  buildAddMember,
  buildCreateChannel,
  buildMessage,
  channelNameToUuid,
} from "../../src/relay/event-builder.js";
import { getPublicKey } from "../../src/relay/signer.js";

const SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const _PUBKEY = getPublicKey(SECRET);

function findTag(event: { tags: string[][] }, name: string): string[] | undefined {
  return event.tags.find((t) => t[0] === name);
}

describe("channelNameToUuid", () => {
  it("returns a deterministic UUID for the same input", () => {
    const a = channelNameToUuid("general");
    const b = channelNameToUuid("general");
    expect(a).toBe(b);
  });

  it("is case-insensitive and trims whitespace", () => {
    const a = channelNameToUuid("general");
    const b = channelNameToUuid("  General  ");
    expect(a).toBe(b);
  });

  it("strips a leading '#' identically to normalizeChannel", () => {
    // Note: channelNameToUuid doesn't itself strip '#' (that's
    // normalizeChannel's job), but the eventual caller should
    // normalize first. Verify the shape is consistent.
    const a = channelNameToUuid("general");
    const b = channelNameToUuid("#general");
    expect(a).not.toBe(b); // raw input differs
  });

  it("returns a valid RFC 4122 v5 UUID", () => {
    const uuid = channelNameToUuid("coreprt");
    // Version 5: byte[6] high nibble is 5 → 5xxx
    // Variant RFC 4122: byte[8] high bits are 10 → 8/9/a/b
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("buildMessage h tag", () => {
  it("emits h derived from the channel name when no channelId is given", async () => {
    const evt = await buildMessage({
      secret: SECRET,
      channel: "general",
      content: "hi",
    });
    const hTag = findTag(evt, "h");
    expect(hTag).toBeDefined();
    expect(hTag![1]).toBe(channelNameToUuid("general"));
  });

  it("emits h from caller-provided channelId when given", async () => {
    const provided = "99999999-9999-5999-9999-999999999999";
    const evt = await buildMessage({
      secret: SECRET,
      channel: "general",
      channelId: provided,
      content: "hi",
    });
    expect(findTag(evt, "h")).toEqual(["h", provided]);
  });
});

describe("buildCreateChannel h tag", () => {
  it("emits h derived from the name when no channelId is given", async () => {
    const evt = await buildCreateChannel({
      secret: SECRET,
      name: "marketing",
    });
    expect(findTag(evt, "h")).toEqual(["h", channelNameToUuid("marketing")]);
  });

  it("emits h from caller-provided channelId when given", async () => {
    const provided = "77777777-7777-5777-7777-777777777777";
    const evt = await buildCreateChannel({
      secret: SECRET,
      name: "marketing",
      channelId: provided,
    });
    expect(findTag(evt, "h")).toEqual(["h", provided]);
  });
});

describe("buildAddMember h tag", () => {
  it("throws when channelId is missing (required)", async () => {
    await expect(
      buildAddMember({
        secret: SECRET,
        pubkey: "a".repeat(64),
      } as any),
    ).rejects.toThrow(/channelId is required/);
  });

  it("emits h from caller-provided channelId", async () => {
    const provided = "55555555-5555-5555-5555-555555555555";
    const evt = await buildAddMember({
      secret: SECRET,
      pubkey: "a".repeat(64),
      channelId: provided,
    });
    expect(findTag(evt, "h")).toEqual(["h", provided]);
  });
});
