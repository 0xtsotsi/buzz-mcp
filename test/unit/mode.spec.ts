/**
 * Unit tests for `src/util/mode.ts` — the Phase 1 mode gate.
 *
 * The gate is the single chokepoint for `read-only` / `mutate-with-confirm`
 * / `mutate` behavior. Every write tool funnels through it before signing
 * or posting. These tests verify the four outcomes (allow, read-only,
 * pending-confirm, dry-run) and the standalone `gateToMcpBody` helper.
 */
import { describe, expect, it, vi } from "vitest";
import { gateToMcpBody, gateWrite } from "../../src/util/mode.js";

const unsigned = {
  kind: 9,
  tags: [
    ["client", "buzz-mcp"],
    ["h", "general"],
  ],
  content: "hi",
  created_at: 1_700_000_000,
};

describe("gateWrite — read-only mode", () => {
  it("rejects at dispatch with a clear message", () => {
    const result = gateWrite({ mode: "read-only" });
    expect(result.kind).toBe("read-only");
    if (result.kind !== "read-only") return;
    expect(result.message).toMatch(/read-only mode/);
  });

  it("rejects even when dryRun is true (read-only wins)", () => {
    const result = gateWrite({ mode: "read-only", dryRun: true, unsigned });
    expect(result.kind).toBe("read-only");
  });
});

describe("gateWrite — dryRun", () => {
  it("returns the unsigned event without signing", () => {
    const result = gateWrite({ mode: "mutate", dryRun: true, unsigned });
    expect(result.kind).toBe("dry-run");
    if (result.kind !== "dry-run") return;
    expect(result.unsigned).toEqual(unsigned);
  });

  it("requires the unsigned payload when dryRun is true", () => {
    expect(() => gateWrite({ mode: "mutate", dryRun: true })).toThrow(/dryRun=true requires/);
  });

  it("'mutate-with-confirm' + dryRun=true returns dry-run (dryRun wins)", () => {
    const result = gateWrite({
      mode: "mutate-with-confirm",
      dryRun: true,
      unsigned,
    });
    expect(result.kind).toBe("dry-run");
  });
});

describe("gateWrite — mutate-with-confirm", () => {
  it("returns pending-confirm when confirm is not set", () => {
    const warn = vi.fn();
    const result = gateWrite({
      mode: "mutate-with-confirm",
      unsigned,
      preview: "post_message channel=general",
      warn,
    });
    expect(result.kind).toBe("pending-confirm");
    if (result.kind !== "pending-confirm") return;
    expect(result.unsigned).toEqual(unsigned);
    expect(result.message).toMatch(/Re-call with confirm: true/);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("post_message channel=general");
  });

  it("allows the write when confirm=true is set", () => {
    const result = gateWrite({
      mode: "mutate-with-confirm",
      confirm: true,
      unsigned,
    });
    expect(result.kind).toBe("allow");
  });

  it("requires the unsigned payload when mode is mutate-with-confirm", () => {
    expect(() => gateWrite({ mode: "mutate-with-confirm" })).toThrow(
      /mutate-with-confirm mode requires/,
    );
  });
});

describe("gateWrite — mutate mode", () => {
  it("allows unconditionally", () => {
    const result = gateWrite({ mode: "mutate" });
    expect(result.kind).toBe("allow");
  });

  it("does not require the unsigned payload", () => {
    // Even with no unsigned, mutate mode is fine.
    const result = gateWrite({ mode: "mutate", dryRun: false });
    expect(result.kind).toBe("allow");
  });
});

describe("gateToMcpBody", () => {
  it("formats pending-confirm with the unsigned event", () => {
    const body = JSON.parse(
      gateToMcpBody(
        {
          kind: "pending-confirm",
          unsigned,
          message: "Re-call with confirm: true",
        },
        { channel: "general" },
      ),
    );
    expect(body.status).toBe("pending-confirm");
    expect(body.message).toBe("Re-call with confirm: true");
    expect(body.unsigned_event).toEqual(unsigned);
    expect(body.channel).toBe("general");
  });

  it("formats dry-run with the unsigned event", () => {
    const body = JSON.parse(gateToMcpBody({ kind: "dry-run", unsigned }, { channel: "general" }));
    expect(body.status).toBe("dry-run");
    expect(body.unsigned_event).toEqual(unsigned);
    expect(body.channel).toBe("general");
  });

  it("formats read-only as an error envelope", () => {
    const body = JSON.parse(
      gateToMcpBody({
        kind: "read-only",
        message: "MCP is in read-only mode",
      }),
    );
    expect(body.error).toBe("MCP is in read-only mode");
  });
});
