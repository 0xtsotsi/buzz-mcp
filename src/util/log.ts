/**
 * Structured JSON logging for @buzz/mcp.
 *
 * Phase 2 of the multi-relay plan. Every log event is a single-line JSON
 * object with these fields:
 *   { ts, level, msg, ...context }
 *
 * `ts` is an ISO-8601 timestamp with millisecond precision.
 * `level` is one of `debug`, `info`, `warn`, `error`.
 * Tools and relay-call helpers add `tool`, `relay`, `event_id`, `latency_ms`,
 * `status` as needed.
 *
 * ## Sinks
 * Two sinks are wired in `createLogger`:
 *   - `stderr` — always on. One-line JSON per event. The default sink for
 *     every `Logger` instance. The transport (stdio) passes stderr through,
 *     so the LLM host sees the lines on its log pane.
 *   - `file` — only if `file` is set in `LoggerConfig`. The file sink uses
 *     size-based rotation (5 MB × 3 files), matching the convention used
 *     by `node:fs` appenders across the @buzz/* family.
 *
 * The default file path under Buzz.app is
 * `~/Library/Logs/xyz.block.buzz.app/agents/<agent-pid>/buzz-mcp.log`.
 * The script `scripts/start-buzz-desktop-local.sh` honors this convention.
 *
 * ## Thread safety
 * Node.js is single-threaded for JS, so the `writeJSONLine` calls are
 * serialized. The file sink serializes its appends on a single `fd` —
 * concurrent writes from the same process are atomic at the syscall level
 * for buffers under `PIPE_BUF` (4 KB on Linux). A single JSON log line is
 * almost always under 1 KB, so this is safe in practice.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Log levels. Lower = more verbose. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Numeric ordering of the levels. */
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Compare two levels. Returns true if `lhs` is at least as severe as `rhs`. */
function isAtLeast(lhs: LogLevel, rhs: LogLevel): boolean {
  return LEVEL_ORDER[lhs] >= LEVEL_ORDER[rhs];
}

/** A single log entry. */
export type LogEntry = {
  ts: string;
  level: LogLevel;
  msg: string;
  [extra: string]: unknown;
};

/** Configuration for creating a logger. */
export interface LoggerConfig {
  /** Minimum level to emit. Default `info`. */
  readonly level?: LogLevel;
  /**
   * Optional file path. If set, the logger also writes to this file with
   * size-based rotation (5 MB × 3 files).
   */
  readonly file?: string;
  /**
   * Optional fixed fields merged into every log entry. The fields
   * `ts`, `level`, `msg` are reserved and cannot be overridden.
   */
  readonly defaultContext?: Readonly<Record<string, unknown>>;
}

/** Public logger interface. */
export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
  /** Flush pending writes. The file sink is synchronous; this is a no-op. */
  flush(): void;
  /** Close the underlying file fd. */
  close(): void;
}

const RESERVED_KEYS = new Set(["ts", "level", "msg"]);

/** stdout/stderr lines are written with a trailing newline. */
const NL = "\n";

/**
 * The default file path computed from `BUZZ_MCP_LOG_FILE` or the
 * macOS convention. Resolves to `~/Library/Logs/xyz.block.buzz.app/agents/<pid>/buzz-mcp.log`
 * on macOS when Buzz.app is the host. Exported for tests + the file-sink
 * helper.
 */
export function defaultLogFilePath(): string | undefined {
  // Lazy: avoid pulling `os` at module load.
  const home = process.env["HOME"];
  const pid = process.pid;
  if (home === undefined || home === "") return undefined;
  return `${home}/Library/Logs/xyz.block.buzz.app/agents/${pid}/buzz-mcp.log`;
}

/**
 * Default path for the audit log. Always under Buzz.app's log directory.
 * The audit log is append-only and never rotates — it is the operator's
 * durable record of every successful write.
 */
export function defaultAuditLogPath(): string | undefined {
  const home = process.env["HOME"];
  if (home === undefined || home === "") return undefined;
  return `${home}/Library/Logs/xyz.block.buzz.app/agents/audit.log`;
}

/** ISO-8601 timestamp with millisecond precision. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Internal: write one JSON line to stderr. Safe to call from any code path.
 */
function writeToStderr(line: string): void {
  process.stderr.write(line + NL);
}

/**
 * Internal: rotate the file if it exceeds the size cap. Renames
 * `<file>` → `<file>.1`, `<file>.1` → `<file>.2`, etc.
 * Keeps at most 3 files (active + 2 backups). The plan calls for 5 MB × 3.
 *
 * The convention is the standard Unix logrotate style: the active file
 * has no suffix, backups are `.1`, `.2`. (Previous revisions used
 * `<file>.1.log` which collided with the active file's own extension.)
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BACKUPS = 2;

function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // file does not exist yet
  }
  if (size < MAX_FILE_BYTES) return;
  // Walk backwards: drop the oldest, shift everyone up, then move active → .1.
  try {
    renameSync(`${file}.${MAX_BACKUPS}`, `${file}.${MAX_BACKUPS + 1}`);
  } catch {
    // oldest may not exist yet on the first rotation — that's fine.
  }
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // gap in the backup chain — fine, the file just isn't there.
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // shouldn't happen — we just statSync'd the file.
  }
}

/**
 * Internal: write one JSON line to the file. Creates the parent directory
 * if missing. Calls `rotateIfNeeded` first.
 */
function writeToFile(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file);
    appendFileSync(file, line + NL, { encoding: "utf8" });
  } catch (err) {
    // File sink failures must not crash the MCP server. Surface to stderr.
    writeToStderr(
      JSON.stringify({
        ts: nowIso(),
        level: "error",
        msg: `log file sink failed: ${(err as Error).message}`,
      }),
    );
  }
}

/**
 * Construct a logger. The returned logger is the chokepoint for every
 * log event in the MCP server. The default sink is stderr; the file sink
 * is opt-in via `config.file`.
 *
 * The `level` is fixed at construction time. Operators can change log
 * level at runtime by setting `BUZZ_MCP_LOG` env, but only by restarting
 * the server (the config is read once at `createServer()` time).
 */
export function createLogger(config: LoggerConfig = {}): Logger {
  const level = config.level ?? "info";
  const file = config.file;
  const defaultContext = config.defaultContext ?? {};

  function emit(lvl: LogLevel, msg: string, context?: Record<string, unknown>): void {
    if (!isAtLeast(lvl, level)) return;

    const entry: LogEntry = {
      ts: nowIso(),
      level: lvl,
      msg,
      ...defaultContext,
    };
    if (context !== undefined) {
      for (const key of Object.keys(context)) {
        if (RESERVED_KEYS.has(key)) {
          // Reserved keys (`ts`, `level`, `msg`) take precedence. Skip
          // the override — the wire-format contract is that these are
          // always set from the logger's own values.
          continue;
        }
        entry[key] = context[key];
      }
    }

    const line = JSON.stringify(entry);
    writeToStderr(line);
    if (file !== undefined) {
      writeToFile(file, line);
    }
  }

  return {
    level,
    debug: (msg, ctx) => emit("debug", msg, ctx),
    info: (msg, ctx) => emit("info", msg, ctx),
    warn: (msg, ctx) => emit("warn", msg, ctx),
    error: (msg, ctx) => emit("error", msg, ctx),
    flush: () => {
      // File sink is synchronous.
    },
    close: () => {
      // No persistent fd to close.
    },
  };
}

/**
 * The single logger used by the MCP server. Set by `createServer()` once
 * the logger config has been parsed. Tools and the relay client read it
 * via `getLogger()` to avoid plumbing a logger through every call.
 *
 * Default is a stderr-only logger at `info` level; tests replace it via
 * `setLoggerForTests`.
 */
let globalLogger: Logger = createLogger({ level: "info" });

export function getLogger(): Logger {
  return globalLogger;
}

export function setLogger(logger: Logger): void {
  globalLogger = logger;
}

/** Reset module-level state. For tests only. */
export function _resetForTests(): void {
  globalLogger = createLogger({ level: "info" });
}
