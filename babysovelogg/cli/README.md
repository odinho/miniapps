# baby CLI

Command-line interface for the babysovelogg sleep tracker. Designed for both
humans and AI agents. Reads and writes go through the event-sourced database
directly — the web server does not need to be running.

## Setup

From the project directory:

```bash
pnpm baby                # via package script
tsx cli/baby.ts          # directly

# Optional: shell alias for convenience
alias baby='tsx /path/to/babysovelogg/cli/baby.ts'
```

## Quick reference

```bash
baby                    # quick status + what you can do
baby status             # full status with predictions
baby <command> --help   # detailed options for a command
baby --help             # all commands
baby <command> --json   # JSON output (for scripts/AI)
```

## Common examples

```bash
# Status and history
baby                              # what's happening now?
baby status                       # full details + predictions
baby sleeps                       # last 7 days of sleeps
baby sleeps --days 30             # last month
baby stats                        # 7-day averages

# Daily flow
baby up --at 07:30                # baby woke up at 07:30
baby nap                          # start nap now
baby nap --at 14:30               # nap started at 14:30
baby nap --at -5m                 # started 5 min ago
baby up                           # baby woke up now
baby up --mood happy --method self  # woke up happy, fell asleep on own
baby bed --at 19:30               # night sleep at 19:30

# The "up" command is smart:
#   - If napping: ends the nap
#   - If night sleeping: ends sleep + logs day start
#   - If already awake: logs day start (morning wake-up)

# Pausing (baby stirs mid-nap)
baby pause                        # pause now
baby resume --at 14:55            # resumed at 14:55

# Potty/Diaper (adapts to baby's potty_mode setting)
baby potty --type pee             # pee on potty
baby potty --type poo --at 14:00  # poo at 14:00
baby potty --type nothing         # sat on potty, nothing happened
baby diaper --type wet            # wet diaper (works in any mode)

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
- **diaper_log** — diaper/potty log (time, type, amount, note)
- **day_start** — daily wake-up anchor times
- **baby** — baby profile
- **events** — raw event log (append-only)

Active rows have `deleted=0`. Times are ISO 8601 strings.
