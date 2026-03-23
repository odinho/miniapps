# baby CLI

Command-line interface for the babysovelogg sleep tracker. Designed to be used
by both humans and AI agents. Reads and writes go through the event-sourced
database directly — the web server does not need to be running.

## Setup

From the project directory:

```bash
pnpm baby status        # via package script
tsx cli/baby.ts status  # directly

# Optional: shell alias for convenience
alias baby='tsx /path/to/babysovelogg/cli/baby.ts'
```

## Quick reference

```bash
baby                    # current status (default command)
baby --help             # full command list
baby <command> --help   # detailed options for a command
baby <command> --json   # JSON output (for scripts/AI)
```

## Common examples

```bash
# Status and history
baby                              # what's happening now?
baby sleeps                       # last 7 days of sleeps
baby sleeps --days 30             # last month
baby stats                        # 7-day averages

# Recording sleep
baby start-nap                    # start nap now
baby start-nap --at 14:30         # nap started at 14:30
baby start-nap --at -5m           # started 5 min ago
baby end                          # end sleep now
baby end --at 15:15 --mood happy  # ended at 15:15, woke up happy
baby start-night --at 19:30       # night sleep at 19:30

# Pausing (baby stirs mid-nap)
baby pause                        # pause now
baby resume --at 14:55            # resumed at 14:55

# Morning
baby wake --at 07:30              # log wake-up (anchors predictions)

# Diapers
baby diaper --type wet            # wet diaper now
baby diaper --type dirty --at 14:00 --note "After feeding"

# Ad-hoc queries
baby query "SELECT count(*) as total FROM sleep_log WHERE deleted=0"
baby query "SELECT date, wake_time FROM day_start ORDER BY date DESC LIMIT 7"
```

## Time formats

The `--at` flag accepts:

| Format      | Example            | Meaning                |
| ----------- | ------------------ | ---------------------- |
| `HH:MM`     | `14:30`            | Today at 14:30         |
| ISO 8601    | `2026-03-23T14:30` | Specific date and time |
| `-Nm`       | `-10m`             | 10 minutes ago         |
| `-Nh`       | `-1h`              | 1 hour ago             |
| _(omitted)_ |                    | Now                    |

## JSON output

Add `--json` to any command for machine-readable output. Useful for piping
to `jq` or for AI agents that want structured data.

```bash
baby --json | jq '.activeSleep'
baby sleeps --json | jq '.[0]'
```

## Database tables

For the `query` command, these tables are available (all read-only via CLI):

- **sleep_log** — sleep sessions (start_time, end_time, type, mood, method, notes, ...)
- **sleep_pauses** — pause/resume within a sleep
- **diaper_log** — diaper changes (time, type, amount, note)
- **day_start** — daily wake-up anchor times
- **baby** — baby profile
- **events** — raw event log (append-only)

Active rows have `deleted=0`. Times are ISO 8601 strings.
