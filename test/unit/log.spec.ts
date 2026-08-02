/**
 * Unit tests for `src/util/log.ts` — the structured JSON logger.
 *
 * Phase 2 of the multi-relay plan. These tests focus on:
 *   - Level filtering (debug < info < warn < error).
 *   - Reserved-key protection (caller can't override ts/level/msg).
 *   - Default-context merging.
 *   - File sink rotation (size-based, 5 MB × 3).
 */
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  defaultAuditLogPath,
  defaultLogFilePath,
  _resetForTests as resetLogger,
  setLogger,
} from "../../src/util/log.js";

describe("createLogger — level filtering", () => {
  let stderr: string[];
  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr.push(typeof s === "string" ? s : (s as Buffer).toString());
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetLogger();
  });

  it("default level is info: debug is filtered out", () => {
    const log = createLogger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(stderr).toHaveLength(3);
    expect(stderr[0]).toContain(`"level":"info"`);
    expect(stderr[1]).toContain(`"level":"warn"`);
    expect(stderr[2]).toContain(`"level":"error"`);
  });

  it("level=debug lets everything through", () => {
    const log = createLogger({ level: "debug" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(stderr).toHaveLength(4);
  });

  it("level=error only emits error", () => {
    const log = createLogger({ level: "error" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(`"level":"error"`);
  });
});

describe("createLogger — entry shape", () => {
  let stderr: string[];
  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr.push(typeof s === "string" ? s : (s as Buffer).toString());
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetLogger();
  });

  it("emits a single-line JSON object", () => {
    const log = createLogger();
    log.info("hello", { tool: "buzz_post_message" });
    expect(stderr).toHaveLength(1);
    // The line includes a trailing newline; strip it before shape checks.
    const line = stderr[0]!.replace(/\n$/, "");
    expect(line).toMatch(/^[{].*[}]$/);
    expect(line).not.toContain("\n");
  });

  it("includes ts, level, msg, and the extra context", () => {
    const log = createLogger();
    log.info("hi", { tool: "buzz_post_message", event_id: "a".repeat(64) });
    const entry = JSON.parse(stderr[0]!);
    expect(entry).toMatchObject({
      level: "info",
      msg: "hi",
      tool: "buzz_post_message",
      event_id: "a".repeat(64),
    });
    expect(typeof entry.ts).toBe("string");
    // ISO-8601 to the millisecond.
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("defaultContext is merged into every entry", () => {
    const log = createLogger({ defaultContext: { server: "test", version: "0.0.0" } });
    log.info("hi");
    const entry = JSON.parse(stderr[0]!);
    expect(entry.server).toBe("test");
    expect(entry.version).toBe("0.0.0");
  });

  it("reserved keys (ts, level, msg) cannot be overridden by caller", () => {
    const log = createLogger();
    log.info("hi", { ts: "fake", level: "fake", msg: "fake" });
    const entry = JSON.parse(stderr[0]!);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hi");
    expect(entry.ts).not.toBe("fake");
  });
});

describe("createLogger — file sink", () => {
  let dir: string;
  let stderr: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "buzz-mcp-log-"));
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr.push(typeof s === "string" ? s : (s as Buffer).toString());
      return true;
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    resetLogger();
  });

  it("writes to the file when file is set", () => {
    const file = join(dir, "test.log");
    const log = createLogger({ file });
    log.info("hello");
    log.info("world");
    const content = readFileSync(file, "utf8");
    expect(content).toContain(`"msg":"hello"`);
    expect(content).toContain(`"msg":"world"`);
    expect(content.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
  });

  it("rotates when the file exceeds 5 MB", () => {
    const file = join(dir, "rot.log");
    // Pre-fill the file past the 5 MB threshold.
    const chunk = "x".repeat(1024); // 1 KB
    const big = chunk.repeat(5500); // 5.5 MB
    appendFileSync(file, big);

    const log = createLogger({ file });
    log.info("after-rotate");

    const files = readdirSync(dir).filter((n) => n.startsWith("rot"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    // The new "after-rotate" entry should be in the active file.
    const active = readFileSync(file, "utf8");
    expect(active).toContain("after-rotate");
  });

  it("creates the parent directory if missing", () => {
    const file = join(dir, "deep", "nested", "log.txt");
    const log = createLogger({ file });
    log.info("hello");
    expect(statSync(file).isFile()).toBe(true);
  });

  it("does not crash if the file is unwritable", () => {
    // Force a write failure by passing a path under a regular file.
    const blocker = join(dir, "blocker");
    appendFileSync(blocker, "i am a file, not a directory");
    const file = join(blocker, "child.log"); // can't create a child of a file
    const log = createLogger({ file });
    expect(() => log.info("hello")).not.toThrow();
    // The fallback error message must show up on stderr.
    expect(stderr.some((s) => s.includes("log file sink failed"))).toBe(true);
  });
});

describe("defaultLogFilePath / defaultAuditLogPath", () => {
  it("defaultLogFilePath returns a path under HOME when HOME is set", () => {
    const original = process.env["HOME"];
    process.env["HOME"] = "/tmp/test-home";
    try {
      const p = defaultLogFilePath();
      expect(p).toMatch(/^\/tmp\/test-home\/Library\/Logs/);
    } finally {
      if (original === undefined) delete process.env["HOME"];
      else process.env["HOME"] = original;
    }
  });

  it("defaultLogFilePath returns undefined when HOME is unset", () => {
    const original = process.env["HOME"];
    delete process.env["HOME"];
    try {
      expect(defaultLogFilePath()).toBeUndefined();
    } finally {
      if (original !== undefined) process.env["HOME"] = original;
    }
  });

  it("defaultAuditLogPath returns the operator-facing audit path", () => {
    const original = process.env["HOME"];
    process.env["HOME"] = "/tmp/test-home";
    try {
      const p = defaultAuditLogPath();
      expect(p).toBe("/tmp/test-home/Library/Logs/xyz.block.buzz.app/agents/audit.log");
    } finally {
      if (original === undefined) delete process.env["HOME"];
      else process.env["HOME"] = original;
    }
  });
});

describe("setLogger / getLogger", () => {
  beforeEach(() => {
    resetLogger();
  });
  it("setLogger swaps the module-global logger", () => {
    const log = createLogger({ level: "info" });
    setLogger(log);
    expect(log).toBeDefined();
  });
});
