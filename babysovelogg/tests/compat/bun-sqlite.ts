// Vitest compatibility shim: maps bun:sqlite → better-sqlite3 for Node.js
// The production app and CLI use bun:sqlite directly (bun runtime).
// Vitest runs under Node.js, so this shim bridges the gap.
import Database from "better-sqlite3";
export { Database };
