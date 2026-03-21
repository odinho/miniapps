const CLIENT_ID_KEY = "babysovelogg_client_id";

// Custom epoch: 2026-01-01T00:00:00Z
const EPOCH = new Date("2026-01-01T00:00:00Z").getTime();

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base36Time(): string {
  const seconds = Math.floor((Date.now() - EPOCH) / 1000);
  // Use absolute value in case we're before the epoch (testing)
  return Math.abs(seconds).toString(36);
}

function randomBase62(len: number): string {
  let result = "";
  const arr = new Uint8Array(len);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < len; i++) {
    result += BASE62[arr[i] % 62];
  }
  return result;
}

/** Generate a short sortable ID with the given prefix. */
export function generatePrefixedId(prefix: string): string {
  return `${prefix}_${base36Time()}${randomBase62(6)}`;
}

/** Generate a sleep domain ID. */
export function generateSleepId(): string {
  return generatePrefixedId("slp");
}

/** Generate a diaper domain ID. */
export function generateDiaperId(): string {
  return generatePrefixedId("dip");
}

/** Generate a generic event ID (used for clientEventId). */
export function generateId(): string {
  return generatePrefixedId("evt");
}

export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = generatePrefixedId("cli");
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}
