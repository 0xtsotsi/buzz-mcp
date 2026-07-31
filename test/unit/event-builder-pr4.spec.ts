/**
 * Unit tests for the 5 PR-#4 event builders added to src/relay/event-builder.ts:
 *   - buildCreateChannel   (kind 9007)
 *   - buildAddMember       (kind 9000)
 *   - buildJob             (kind 43001)
 *   - buildWorkflowApproval (kind 46030 approve / 46031 deny)
 *   - buildThreadSummary   (kind 39005)
 */
import { describe, it, expect } from "vitest";
import { getPublicKey } from "../../src/relay/signer.js";
import {
  buildAddMember,
  buildCreateChannel,
  buildJob,
  buildThreadSummary,
  buildWorkflowApproval,
} from "../../src/relay/event-builder.js";

const SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const PUBKEY = getPublicKey(SECRET);

function findTag(event: { tags: string[][] }, name: string): string[] | undefined {
  return event.tags.find((t) => t[0] === name);
}

describe("buildCreateChannel", () => {
  it("returns a kind:9007 event with name + visibility + client tags", async () => {
    const evt = await buildCreateChannel({
      secret: SECRET,
      name: "general",
    });
    expect(evt.kind).toBe(9007);
    expect(evt.pubkey).toBe(PUBKEY);
    expect(evt.id).toMatch(/^[0-9a-f]{64}$/);
    expect(evt.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(findTag(evt, "name")).toEqual(["name", "general"]);
    expect(findTag(evt, "visibility")).toEqual(["visibility", "public"]);
    expect(findTag(evt, "client")).toEqual(["client", "buzz-mcp"]);
  });

  it("honours visibility=private and emits the about tag when description provided", async () => {
    const evt = await buildCreateChannel({
      secret: SECRET,
      name: "secret",
      visibility: "private",
      description: "hello",
    });
    expect(findTag(evt, "visibility")).toEqual(["visibility", "private"]);
    expect(findTag(evt, "about")).toEqual(["about", "hello"]);
  });
});

describe("buildAddMember", () => {
  it("returns a kind:9000 event with a p-tag and no role tag by default", async () => {
    const member = "1".repeat(64);
    const evt = await buildAddMember({ secret: SECRET, pubkey: member });
    expect(evt.kind).toBe(9000);
    expect(findTag(evt, "p")).toEqual(["p", member]);
    expect(findTag(evt, "role")).toBeUndefined();
  });

  it("emits a role tag when role is provided", async () => {
    const evt = await buildAddMember({
      secret: SECRET,
      pubkey: "2".repeat(64),
      role: "admin",
    });
    expect(findTag(evt, "role")).toEqual(["role", "admin"]);
  });
});

describe("buildJob", () => {
  it("returns a kind:43001 event with title + summary tags and the description in content", async () => {
    const evt = await buildJob({
      secret: SECRET,
      title: "ship feature X",
      description: "long text",
    });
    expect(evt.kind).toBe(43001);
    expect(findTag(evt, "title")).toEqual(["title", "ship feature X"]);
    expect(findTag(evt, "summary")).toEqual(["summary", "long text"]);
    expect(evt.content).toBe("long text");
    expect(findTag(evt, "amount")).toBeUndefined();
    expect(findTag(evt, "due")).toBeUndefined();
  });

  it("emits amount + due tags when provided", async () => {
    const evt = await buildJob({
      secret: SECRET,
      title: "t",
      description: "d",
      budget: 5000,
      dueAt: "2026-12-31T00:00:00Z",
    });
    expect(findTag(evt, "amount")).toEqual(["amount", "5000"]);
    expect(findTag(evt, "due")).toEqual(["due", "2026-12-31T00:00:00Z"]);
  });
});

describe("buildWorkflowApproval", () => {
  it("emits kind 46030 (grant) for decision=approve", async () => {
    const evt = await buildWorkflowApproval({
      secret: SECRET,
      workflowId: "3".repeat(64),
      decision: "approve",
    });
    expect(evt.kind).toBe(46030);
    expect(findTag(evt, "e")).toEqual(["e", "3".repeat(64)]);
  });

  it("emits kind 46031 (deny) for decision=reject", async () => {
    const evt = await buildWorkflowApproval({
      secret: SECRET,
      workflowId: "4".repeat(64),
      decision: "reject",
      comment: "no",
    });
    expect(evt.kind).toBe(46031);
    expect(findTag(evt, "comment")).toEqual(["comment", "no"]);
    expect(evt.content).toBe("no");
  });
});

describe("buildThreadSummary", () => {
  it("returns a kind:39005 event with a root e-tag and the summary as content", async () => {
    const root = "5".repeat(64);
    const evt = await buildThreadSummary({
      secret: SECRET,
      rootEventId: root,
      summary: "TL;DR",
    });
    expect(evt.kind).toBe(39005);
    expect(findTag(evt, "e")).toEqual(["e", root, "", "root"]);
    expect(evt.content).toBe("TL;DR");
  });
});