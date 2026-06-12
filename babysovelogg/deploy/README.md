# Deployment — multi-family

Self-hosted, multi-family. Shared SvelteKit code, per-family data + subdomain.

> For a single-family setup, see [`docs/deployment.md`](../docs/deployment.md).
> This directory is the multi-family layout: one host, many families, each on
> its own subdomain with its own SQLite database.

This directory holds the **generic** server-side pieces: a systemd template
unit and an nginx vhost template. Both are host-agnostic — they assume the
filesystem layout below but make no other assumptions about the host. The
"which host, which families, which secrets" part is intentionally left out;
manage that with whatever provisioning tool you prefer (ansible is the
natural fit — see [Provisioning](#provisioning) below).

## On-host layout

```
/srv/babysovelogg/
  code/                            # rsync target — build/, node_modules/, package.json
    build/index.js                 # SvelteKit adapter-node entry
  families/
    <family>/
      .env                         # ORIGIN, HOST, PORT, VAPID_*, DB_PATH; mode 0600
      data.db                      # SQLite, schema migrated on startup
```

The app listens on TCP `127.0.0.1:$PORT` per family (a port reserved in the
provisioning config). Bun rejects adapter-node's unix-socket listen path
(`Cannot specify both hostname and unix`) and its socket-activation path
silently fails to serve, so TCP is the path that actually works.

## Server prerequisites (one-time, by hand)

- `bun` at `/usr/local/bin/bun` (`curl -fsSL https://bun.sh/install | bash`, then move)
- `nginx`, `certbot`
- a `babysovelogg` system user (no group membership games — nginx just proxies to localhost)
- a wildcard A/AAAA record for the chosen base domain pointing at the host

## What this directory provides

| File | Purpose |
|------|---------|
| `systemd/babysovelogg@.service` | template unit — `systemctl start babysovelogg@<family>` |
| `nginx/babysovelogg.conf.template` | per-family vhost (HTTP-only bootstrap → full HTTPS once cert exists). Uses Jinja-style `{{family}}`, `{{host}}`, `{{port}}`, `{{tls_ready}}` placeholders. |

The systemd unit reads everything (`ORIGIN`, `HOST`, `PORT`, `DB_PATH`,
`VAPID_*`) from `/srv/babysovelogg/families/%i/.env` — provisioning owns
that file end-to-end.

## Provisioning

The bits that are *not* in this repo, because they're operator-specific:

- Creating `/srv/babysovelogg/{code,families/<family>}` with the right ownership
- Rendering `nginx/babysovelogg.conf.template` per family and dropping it into `/etc/nginx/conf.d/`
- Writing each family's `.env` with `ORIGIN` and VAPID keys
- Running `certbot --nginx` (or your preferred ACME client) to swap the
  bootstrap vhost to TLS
- Enabling `babysovelogg@<family>.service`

An ansible playbook is the natural way to wire these up: keep a `families:`
list in your inventory (each entry has at minimum a name, a subdomain slug,
and a port), render the nginx template per entry, populate `.env` from a
(private) vars file, and enable the systemd instance. The templates here
are designed for exactly that shape — the placeholders are standard
Jinja2, so an ansible `template:` task drops in unchanged. Equivalent
NixOS modules, Chef cookbooks, or hand-written shell all work; the
templates don't care.

## Operating with `manage.sh`

`deploy/manage.sh` is the day-to-day entry point — one command for shipping
code, restarting/inspecting a baby, and onboarding a new family. It's generic
and env-driven, so it runs from any operator machine (your laptop, openclaw,
CI). Concrete host config lives in `local/deploy.env` (gitignored), which the
script auto-sources:

```sh
# local/deploy.env — fill in with your own host/domain/paths (gitignored)
SERVER=user@host                                 # ssh target that holds the instances
SSH_AUTH_SOCK=/run/user/1000/keyring/.ssh        # your ssh agent socket
ANSIBLE_DIR=/path/to/provisioning-repo/ansible   # private repo: families list + VAPID secrets
BASE_DOMAIN=example.com                          # *.example.com -> the host (wildcard DNS)
VAPID_SUBJECT=mailto:you@example.com
```

Commands:

| Command | What it does |
|---------|--------------|
| `manage.sh deploy [family…]` | `bun run build`, rsync code, restart families (default: **all**), warm each up |
| `manage.sh add <name>` | onboard a family: pick the next port + an unguessable slug, mint a VAPID keypair, patch the ansible `families`/`family_secrets` lists, run the playbook (dir + `.env` + systemd + cert + nginx), verify |
| `manage.sh list` / `status [family]` | families on the host / their systemd activity |
| `manage.sh restart <family\|all>` | restart instance(s) and warm up |
| `manage.sh logs <family> [args…]` | `journalctl -u babysovelogg@<family>` (extra args pass through, e.g. `-f -n100`) |
| `manage.sh inspect <family>` | pull the family DB into `local/imports/` and run `scripts/inspect-db.ts` |
| `manage.sh rebuild <family>` | replay events / rebuild projections (`POST /api/admin/rebuild`) |
| `manage.sh backup [family\|all]` | rsync family data dir(s) into `local/backups/` |

Typical flows:

```sh
# ship new code to every baby
deploy/manage.sh deploy

# roll out to one baby first, eyeball it, then the rest
deploy/manage.sh deploy <family>    # ...check the URL it prints...
deploy/manage.sh deploy             # fan out to all

# onboard a new baby end-to-end (needs ANSIBLE_DIR set)
deploy/manage.sh add <name>         # prints https://<name>-<slug>.<base-domain>
# then commit the vars change in the provisioning repo (the script reminds you how)

# peek at a baby's data without touching the server's live DB
deploy/manage.sh inspect <family>
```

`add` requires the private provisioning repo (`ANSIBLE_DIR`) because the
families list and VAPID secrets live there — that repo is the trust boundary
(no vault). `deploy`, `restart`, `logs`, `inspect`, `rebuild`, and `backup`
need only SSH access to `SERVER`.

The sections below document what `deploy` and the provisioning step do under
the hood — read them if you're setting up a fresh host or debugging the script.

## Deploy flow

Local (replace `<server>` with the host that holds your instances):

```sh
bun run build
rsync -avz --delete --delay-updates --chown=babysovelogg:babysovelogg \
    build node_modules package.json \
    <server>:/srv/babysovelogg/code/
ssh <server> 'sudo systemctl restart "babysovelogg@*.service"'
```

Two things to notice in that rsync:
- **No trailing slash** on `build` or `node_modules` — without the slash
  rsync preserves the source directory name, so you end up with
  `/srv/babysovelogg/code/build/index.js` (what the unit expects). With
  trailing slashes the *contents* are copied and the layout is wrong.
- **`--chown=babysovelogg:babysovelogg`** — rsync as root over SSH preserves
  UID/GID, which would otherwise be your local user's (UID 1000 = some
  unrelated account on the server).

Roll out to one family first to sanity-check before fanning out:

```sh
ssh <server> 'sudo systemctl restart babysovelogg@<family>.service'
# ...check <family>-<suffix>.<base-domain> in a browser...
ssh <server> 'sudo systemctl restart "babysovelogg@*.service"'
```

This is safe because the app never reads on-disk files other than its
SQLite DB (per-family, isolated) and the SvelteKit build output (shared,
just rsync'd). Migrations are inline in `src/lib/server/db.ts` and run
per-instance against each family's own DB at startup.

## Backups

```sh
rsync -a --delete root@<server>:/srv/babysovelogg/families/ ~/backups/babysovelogg/
```

## Onboarding / removing families

With ansible (or equivalent), "add a family" is a one-line change:

1. Append the new family entry (name, host, VAPID keys) to your inventory's `families:` list.
2. Re-run the playbook — it should render the new vhost, write `.env`, request a cert, and enable the systemd instance.
3. Reload nginx.

By hand: create `/srv/babysovelogg/families/<family>/` with a populated
`.env`, drop a rendered nginx vhost into `/etc/nginx/conf.d/`, run
`certbot --nginx -d <host>`, and `systemctl enable --now babysovelogg@<family>`.
