# Deployment

## Build

```bash
npm run build
```

This runs esbuild to bundle the client TypeScript into `dist/bundle.js` and compiles the server to `dist/server.js`. Static assets from `public/` are copied to `dist/`.

## Run

```bash
PORT=3200 node dist/server.js
```

The server serves both the API and static files. SQLite database (`napper.db`) is created in the working directory.

## systemd Service

Create `/etc/systemd/system/babysovelogg.service`:

```ini
[Unit]
Description=Babysovelogg
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/babysovelogg
ExecStart=/usr/bin/node dist/server.js
User=openclaw
Restart=always
RestartSec=5
Environment=PORT=3200

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now babysovelogg
```

## nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name napper.example.com;

    ssl_certificate /etc/letsencrypt/live/napper.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/napper.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE support
        proxy_buffering off;
        proxy_cache off;
    }
}
```

Key points:
- `proxy_buffering off` is required for SSE to work
- No auth — designed for trusted networks or behind VPN

## Database

SQLite file (`napper.db`) in the working directory. WAL mode enabled for concurrent reads.

**WAL safety:** The server checkpoints the WAL after every write and on shutdown
(SIGTERM/SIGINT). This ensures the main `.db` file always has all data. The `-wal`
and `-shm` files may still exist but the `.db` file is self-sufficient after checkpoint.

**Backups:** The safest method is `sqlite3 napper.db '.backup backup.db'`. If copying
files directly, **you must copy all three files** (`.db`, `.db-wal`, `.db-shm`) together
— copying only `.db` while the WAL has uncheckpointed data will lose that data.

**Deploy safety:** The systemd service should use `KillSignal=SIGTERM` (default) so
the server gets a clean shutdown and checkpoints the database. Never delete `-wal`/`-shm`
files while the server is running.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3200` | Server port |
| `NODE_ENV` | — | Set to `production` to serve static from same dir as server.js |
