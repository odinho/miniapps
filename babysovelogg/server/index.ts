import { createServer } from "http";
import { handleRequest } from "./api.js";
import { closeDb } from "./db.js";

const PORT = parseInt(process.env.PORT || "3200");

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`🍼 Babysovelogg running on http://localhost:${PORT}`);
});

// Graceful shutdown: close DB cleanly before exit
function shutdown(signal: string) {
  console.log(`\n[${signal}] Shutting down...`);
  server.close(() => {
    closeDb();
    console.log("Database closed. Bye!");
    process.exit(0);
  });
  // Force exit after 5s if connections don't drain (SSE clients keep connections open)
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
