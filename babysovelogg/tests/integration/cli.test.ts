import { test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, type ExecFileSyncOptions } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

const PROJECT_ROOT = join(import.meta.dirname, "../..");
const CLI_PATH = join(PROJECT_ROOT, "cli/baby.ts");

// Fixed mock time — all tests run at a deterministic point in time.
// Saturday 2026-03-15 at 12:00 UTC. Testa is ~9 months old (born 2025-06-12).
const T = "2026-03-15T12:00:00Z";

function at(offset: string): string {
  const base = new Date(T).getTime();
  const m = offset.match(/^([+-]?\d+)(m|h)$/);
  if (!m) throw new Error(`bad offset: ${offset}`);
  const n = parseInt(m[1]);
  const ms = m[2] === "h" ? n * 3600_000 : n * 60_000;
  return new Date(base + ms).toISOString();
}

let tmpDir: string;
let dbPath: string;

function seedDb() {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, payload TEXT NOT NULL,
      client_id TEXT NOT NULL, client_event_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      schema_version INTEGER, correlation_id TEXT,
      caused_by_event_id INTEGER, domain_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_client_dedup
      ON events(client_id, client_event_id);
    CREATE INDEX IF NOT EXISTS idx_events_domain_id
      ON events(domain_id) WHERE domain_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS baby (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, birthdate TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      custom_nap_count INTEGER, potty_mode INTEGER DEFAULT 0,
      created_by_event_id INTEGER, updated_by_event_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS sleep_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      start_time TEXT NOT NULL, end_time TEXT,
      type TEXT NOT NULL DEFAULT 'nap', notes TEXT, mood TEXT,
      method TEXT, fall_asleep_time TEXT, woke_by TEXT, wake_notes TEXT,
      deleted INTEGER NOT NULL DEFAULT 0, domain_id TEXT NOT NULL,
      created_by_event_id INTEGER, updated_by_event_id INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sleep_log_domain_id ON sleep_log(domain_id);

    CREATE TABLE IF NOT EXISTS diaper_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      time TEXT NOT NULL, type TEXT NOT NULL, amount TEXT, note TEXT,
      deleted INTEGER NOT NULL DEFAULT 0, domain_id TEXT NOT NULL,
      created_by_event_id INTEGER, updated_by_event_id INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_diaper_log_domain_id ON diaper_log(domain_id);

    CREATE TABLE IF NOT EXISTS sleep_pauses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sleep_id INTEGER NOT NULL REFERENCES sleep_log(id),
      pause_time TEXT NOT NULL, resume_time TEXT,
      created_by_event_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS day_start (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      date TEXT NOT NULL, wake_time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by_event_id INTEGER,
      UNIQUE(baby_id, date)
    );
  `);
  db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run("Testa", "2025-06-12");
  db.close();
}

/** Run the CLI with a fixed MOCK_TIME. */
function cli(
  args: string[],
  opts?: { expectFail?: boolean; mockTime?: string },
): { stdout: string; stderr: string; exitCode: number } {
  const execOpts: ExecFileSyncOptions = {
    cwd: tmpDir,
    env: {
      ...process.env,
      MOCK_TIME: opts?.mockTime ?? T,
    },
    timeout: 15_000,
  };
  try {
    const stdout = execFileSync("bun", [CLI_PATH, ...args], execOpts);
    return { stdout: stdout.toString(), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    if (!opts?.expectFail) {
      const stderr = e.stderr?.toString() ?? "";
      const stdout = e.stdout?.toString() ?? "";
      throw new Error(
        `CLI failed unexpectedly (exit ${e.status}):\nstdout: ${stdout}\nstderr: ${stderr}`,
        { cause: err },
      );
    }
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "baby-cli-test-"));
  dbPath = join(tmpDir, "db.sqlite");
  seedDb();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Help ──

test("--help prints usage", () => {
  const { stdout } = cli(["--help"]);
  expect(stdout).toContain("babysovelogg CLI");
  expect(stdout).toContain("COMMANDS");
  expect(stdout).toContain("nap");
  expect(stdout).toContain("bed");
  expect(stdout).toContain("up");
});

test("nap --help prints nap-specific help", () => {
  const { stdout } = cli(["nap", "--help"]);
  expect(stdout).toContain("baby nap");
  expect(stdout).toContain("--at");
});

// ── Default command (no args) ──

test("default command shows baby name and status", () => {
  const { stdout } = cli([]);
  expect(stdout).toContain("Testa");
  expect(stdout).toContain("Awake");
});

// ── Nap lifecycle: nap → up ──

test("nap → up lifecycle", () => {
  // Start nap at 12:00
  const nap = cli(["nap", "--json"]);
  const napData = JSON.parse(nap.stdout);
  expect(napData.ok).toBe(true);
  expect(napData.type).toBe("nap");

  // Status at 12:30 should show sleeping
  const status = cli(["--json"], { mockTime: at("+30m") });
  const statusData = JSON.parse(status.stdout);
  expect(statusData.activeSleep).not.toBeNull();
  expect(statusData.activeSleep.type).toBe("nap");

  // Wake up at 12:45
  const up = cli(["up", "--json"], { mockTime: at("+45m") });
  const upData = JSON.parse(up.stdout);
  expect(upData.ok).toBe(true);
  expect(upData.endedSleep.type).toBe("nap");
  expect(upData.endedSleep.durationMinutes).toBe(45);
});

test("nap while already sleeping fails", () => {
  cli(["nap"]);
  const { exitCode, stderr } = cli(["nap"], { expectFail: true, mockTime: at("+5m") });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Already sleeping");
});

// ── Bed lifecycle: bed → up (night sleep with day start) ──

test("bed → up lifecycle logs day start", () => {
  // Bedtime at 19:00
  const bed = cli(["bed", "--json"], { mockTime: at("+7h") });
  const bedData = JSON.parse(bed.stdout);
  expect(bedData.ok).toBe(true);
  expect(bedData.type).toBe("night");

  // Wake up next morning at 07:00 (+19h from noon)
  const up = cli(["up", "--json"], { mockTime: at("+19h") });
  const upData = JSON.parse(up.stdout);
  expect(upData.ok).toBe(true);
  expect(upData.endedSleep.type).toBe("night");
  expect(upData.loggedDayStart).toBe(true);
});

// ── Pause / Resume ──

test("pause and resume during nap", () => {
  cli(["nap"]);

  const pause = cli(["pause", "--json"], { mockTime: at("+20m") });
  expect(JSON.parse(pause.stdout).ok).toBe(true);

  const resume = cli(["resume", "--json"], { mockTime: at("+25m") });
  expect(JSON.parse(resume.stdout).ok).toBe(true);

  const up = cli(["up", "--json"], { mockTime: at("+50m") });
  const upData = JSON.parse(up.stdout);
  expect(upData.ok).toBe(true);
  // 50 min total - 5 min paused = 45 min sleep
  expect(upData.endedSleep.durationMinutes).toBe(50);
});

test("pause without active sleep fails", () => {
  const { exitCode, stderr } = cli(["pause"], { expectFail: true });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("No active sleep");
});

test("resume without paused sleep fails", () => {
  cli(["nap"]);
  const { exitCode, stderr } = cli(["resume"], { expectFail: true, mockTime: at("+5m") });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("not paused");
});

// ── Up without active sleep (manual day start) ──

test("up without active sleep logs day start only", () => {
  const up = cli(["up", "--json"]);
  const data = JSON.parse(up.stdout);
  expect(data.ok).toBe(true);
  expect(data.endedSleep).toBeNull();
  expect(data.loggedDayStart).toBe(true);
});

// ── Potty / Diaper ──

test("diaper --type wet logs diaper", () => {
  const { stdout } = cli(["diaper", "--type", "wet", "--json"]);
  const data = JSON.parse(stdout);
  expect(data.ok).toBe(true);
  expect(data.type).toBe("wet");
});

test("potty without --type fails", () => {
  const { exitCode, stderr } = cli(["potty"], { expectFail: true });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("--type is required");
});

// ── Sleeps ──

test("sleeps --json returns array after nap lifecycle", () => {
  cli(["nap"]);
  cli(["up"], { mockTime: at("+40m") });

  const { stdout } = cli(["sleeps", "--json"], { mockTime: at("+45m") });
  const data = JSON.parse(stdout);
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThanOrEqual(1);
  expect(data[0].type).toBe("nap");
});

// ── Stats ──

test("stats runs without error", () => {
  const { stdout } = cli(["stats"]);
  expect(stdout).toContain("Statistics");
});

// ── Query ──

test("query runs SELECT", () => {
  const { stdout } = cli(["query", "SELECT name, birthdate FROM baby"]);
  expect(stdout).toContain("Testa");
  expect(stdout).toContain("2025-06-12");
});

test("query --json returns array", () => {
  const { stdout } = cli(["query", "SELECT name FROM baby", "--json"]);
  const data = JSON.parse(stdout);
  expect(data).toEqual([{ name: "Testa" }]);
});

test("query rejects non-SELECT statements", () => {
  const { exitCode, stderr } = cli(["query", "DELETE FROM baby"], { expectFail: true });
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Only SELECT");
});

// ── Unknown command ──

test("unknown command fails with help", () => {
  const { exitCode, stderr, stdout } = cli(["bogus"], { expectFail: true });
  expect(exitCode).not.toBe(0);
  const output = stderr + stdout;
  expect(output).toContain("Unknown command");
});

// ── --at flag with time formats ──

test("nap --at with ISO datetime format", () => {
  const { stdout } = cli(["nap", "--at", "2026-03-15T09:30:00", "--json"]);
  const data = JSON.parse(stdout);
  expect(data.ok).toBe(true);
  expect(data.startTime).toBeDefined();
  // Verify it parsed to the right time (not "now")
  expect(new Date(data.startTime).getUTCHours()).toBeLessThan(12);
});

test("nap --at with relative time format", () => {
  // MOCK_TIME is 12:00 UTC; --at -10m → 11:50 UTC
  const { stdout: napOut } = cli(["nap", "--at", "-10m", "--json"]);
  const napData = JSON.parse(napOut);
  expect(napData.ok).toBe(true);
  expect(napData.startTime).toContain("11:50");

  // End nap at 12:00 (the mock time)
  const { stdout } = cli(["up", "--json"]);
  const upData = JSON.parse(stdout);
  expect(upData.ok).toBe(true);
  expect(upData.endedSleep.durationMinutes).toBe(10);
});

// ── Up with metadata ──

test("up with mood and method", () => {
  cli(["nap"]);
  const { stdout } = cli(["up", "--mood", "normal", "--method", "rocking", "--json"], {
    mockTime: at("+30m"),
  });
  const data = JSON.parse(stdout);
  expect(data.ok).toBe(true);
});
