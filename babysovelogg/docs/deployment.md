# Deployment

## Build

```bash
bun run build
```

SvelteKit compiles the app with `adapter-node` into `build/index.js`. Static assets are in `build/client/`.

## Run

```bash
PORT=3200 node build/index.js
```

The server handles both the API and static file serving. SQLite database (`db.sqlite`) is created in the working directory on first request.

## systemd Service

Create `/etc/systemd/system/babysovelogg.service`:

```ini
[Unit]
Description=Babysovelogg
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/babysovelogg
ExecStart=/usr/bin/node build/index.js
User=openclaw
Restart=always
RestartSec=5
Environment=PORT=3200
Environment=ORIGIN=https://sove.example.com

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now babysovelogg
```

**Note:** SvelteKit adapter-node requires `ORIGIN` to be set in production for CSRF protection.

## nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name sove.example.com;

    ssl_certificate /etc/letsencrypt/live/sove.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sove.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_buffering off;
        proxy_cache off;
    }
}
```

Key points:
- `proxy_buffering off` is required for SSE to work
- `X-Forwarded-Proto` is needed for SvelteKit's CSRF check
- No auth — designed for trusted networks or behind VPN

## Database

SQLite file (`db.sqlite`) in the working directory. Uses DELETE journal mode — all data is in the single `.sqlite` file, no `-wal`/`-shm` files.

**Backups:** Copy `db.sqlite` while the server is stopped, or use `sqlite3 db.sqlite '.backup backup.db'` while running.

**Rebuild:** POST to `/api/admin/rebuild` to replay all events and rebuild materialized views. Useful after schema changes or data corruption.

## Architecture Constraints

**Single-process only.** SSE broadcast uses an in-memory client set (`broadcast.ts`). All connected clients must be in the same process. Do not run under clustering, PM2 multi-instance, or multiple containers. One process per family — if you need multiple families, run separate processes with separate databases.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DB_PATH` | `./db.sqlite` | SQLite database file path |
| `ORIGIN` | — | Required in production for CSRF (e.g. `https://sove.example.com`) |
