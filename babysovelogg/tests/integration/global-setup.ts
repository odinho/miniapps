import { spawn, type ChildProcess } from "child_process";

const PORT = 3200;
let server: ChildProcess | null = null;

async function waitForServer(port: number, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/api/state`);
      if (res.ok || res.status === 404) return; // 404 = no baby, but server is up
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start on port ${port} within ${timeout}ms`);
}

export async function setup() {
  // Reuse existing server if running
  try {
    const res = await fetch(`http://localhost:${PORT}/api/state`);
    if (res.ok || res.status === 404) return;
  } catch {
    // not running, start it
  }

  server = spawn("node", ["dist/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: "pipe",
  });

  server.on("error", (err) => {
    console.error("Failed to start server:", err);
  });

  await waitForServer(PORT);
}

export async function teardown() {
  server?.kill();
}
