const BASE = "http://localhost:3200";

export async function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function get(path: string) {
  return fetch(`${BASE}${path}`);
}

export async function postEvents(events: Record<string, unknown>[]) {
  return post("/api/events", { events });
}

export async function postCsv(path: string, body: string) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body,
  });
}

export {
  getDb,
  resetDb,
  createBaby,
  setWakeUpTime,
  addCompletedSleep,
  addActiveSleep,
  addDiaper,
  addEvent,
  makeEvent,
  generateId,
  generateSleepId,
  generateDiaperId,
} from "../fixtures.js";
