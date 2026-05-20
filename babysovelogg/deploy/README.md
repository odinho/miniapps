# Deployment

Self-hosted, multi-family. Shared SvelteKit code, per-family data + subdomain.

This directory holds the **generic** server-side pieces: a systemd template
unit and an nginx vhost template. The hetzner-specific provisioning (which
host, which families, which secrets) lives in `norsk_librehost/ansible/`.

## On-host layout

```
/srv/babysovelogg/
  code/                            # rsync target — build/, node_modules/, package.json
    build/index.js                 # SvelteKit adapter-node entry
  families/
    <family>/
      .env                         # ORIGIN, VAPID_*, owner babysovelogg:babysovelogg, 0640
      data.db                      # SQLite, schema migrated on startup
      app.sock                     # unix socket, 0660, group babysovelogg (www-data joins)
```

## Server prerequisites (one-time, by hand)

- `bun` at `/usr/local/bin/bun` (`curl -fsSL https://bun.sh/install | bash`, then move)
- `nginx`, `certbot`
- a `babysovelogg` system user with `www-data` added to its primary group
- a wildcard A/AAAA record for the chosen base domain pointing at the host

## What this directory provides

| File | Purpose |
|------|---------|
| `systemd/babysovelogg@.service` | template unit — `systemctl start babysovelogg@halldis` |
| `nginx/babysovelogg.conf.template` | Jinja-rendered per-family vhost (HTTP-only bootstrap → full HTTPS once cert exists) |

The systemd unit reads `ORIGIN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT` from `/srv/babysovelogg/families/%i/.env`, and sets
`SOCKET_PATH`/`DB_PATH` itself.

## Deploy flow

Local (replace `<server>` with the host that holds your instances):

```sh
bun run build
rsync -avz --delete --exclude=.git \
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

See `norsk_librehost/ansible/provision-babysovelogg.yml` — adding a family
is "append to the `families:` list and re-run the playbook".
