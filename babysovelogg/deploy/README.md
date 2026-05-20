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
| `systemd/babysovelogg@.service` | template unit — `systemctl start babysovelogg@halldis` |
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

## Deploy flow

Local (replace `<server>` with the host that holds your instances):

```sh
bun run build
rsync -avz --delete --delay-updates --exclude=.git \
    build/ node_modules/ package.json \
    <server>:/srv/babysovelogg/code/
ssh <server> 'sudo systemctl restart "babysovelogg@*.service"'
```

Roll out to one family first to sanity-check before fanning out:

```sh
ssh <server> 'sudo systemctl restart babysovelogg@halldis.service'
# ...check halldis-<suffix>.<base-domain> in a browser...
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
