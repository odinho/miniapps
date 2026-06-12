import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { setupHarness, post, put, get, del, db, createBaby } from "./harness.js";

setupHarness();

// Set VAPID keys once for the suite so the vapid-key endpoint returns something.
// These are test-only keys — do not use in production.
const TEST_VAPID = {
  publicKey: "BK1HVyT8rQDbub9wlA7fGiPbq2wwQRBxOwszVITIpct9aeE4-uCvFd3oNCJ-EolgP9SOjHBVr82ggA4GXxo03dI",
  privateKey: "7y16pWZyoAKG2xnuWb79dUHfqRFGxDHseQTVNiboAME",
};

let origPub: string | undefined;
let origPriv: string | undefined;
let origSubject: string | undefined;

beforeAll(() => {
  origPub = process.env.VAPID_PUBLIC_KEY;
  origPriv = process.env.VAPID_PRIVATE_KEY;
  origSubject = process.env.VAPID_SUBJECT;
  process.env.VAPID_PUBLIC_KEY = TEST_VAPID.publicKey;
  process.env.VAPID_PRIVATE_KEY = TEST_VAPID.privateKey;
  process.env.VAPID_SUBJECT = "mailto:test@example.com";
});

afterAll(() => {
  if (origPub === undefined) delete process.env.VAPID_PUBLIC_KEY;
  else process.env.VAPID_PUBLIC_KEY = origPub;
  if (origPriv === undefined) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = origPriv;
  if (origSubject === undefined) delete process.env.VAPID_SUBJECT;
  else process.env.VAPID_SUBJECT = origSubject;
});

function makeSubscription(endpoint: string) {
  return {
    endpoint,
    keys: {
      p256dh: "BExampleP256dhKeyBase64UrlEncodedForTestingPurposesOnlyNotReal",
      auth: "ExampleAuthKeyForTest",
    },
  };
}

describe("GET /api/notifications/vapid-key", () => {
  it("returns the public key", async () => {
    const res = await get("/api/notifications/vapid-key");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publicKey).toBe(TEST_VAPID.publicKey);
  });
});

describe("POST /api/notifications/subscribe", () => {
  it("rejects when no baby exists", async () => {
    const res = await post("/api/notifications/subscribe", {
      subscription: makeSubscription("https://fcm.googleapis.com/a"),
    });
    expect(res.status).toBe(400);
  });

  it("stores a subscription keyed to the baby", async () => {
    const babyId = createBaby();
    const endpoint = "https://fcm.googleapis.com/b";
    const res = await post("/api/notifications/subscribe", {
      subscription: makeSubscription(endpoint),
      userAgent: "test-agent",
    });
    expect(res.status).toBe(200);

    const rows = db
      .prepare("SELECT * FROM notification_subscriptions WHERE baby_id = ?")
      .all(babyId) as Array<{ endpoint: string; user_agent: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(endpoint);
    expect(rows[0].user_agent).toBe("test-agent");
  });

  it("upserts on conflict (same endpoint)", async () => {
    createBaby();
    const endpoint = "https://fcm.googleapis.com/c";
    await post("/api/notifications/subscribe", { subscription: makeSubscription(endpoint) });
    await post("/api/notifications/subscribe", { subscription: makeSubscription(endpoint) });

    const rows = db.prepare("SELECT * FROM notification_subscriptions").all();
    expect(rows).toHaveLength(1);
  });

  it("rejects invalid body", async () => {
    createBaby();
    const res = await post("/api/notifications/subscribe", { subscription: { endpoint: "x" } });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/notifications/subscribe", () => {
  it("removes a subscription by endpoint", async () => {
    createBaby();
    const endpoint = "https://fcm.googleapis.com/d";
    await post("/api/notifications/subscribe", { subscription: makeSubscription(endpoint) });

    const res = await del("/api/notifications/subscribe", { endpoint });
    expect(res.status).toBe(200);

    const rows = db.prepare("SELECT * FROM notification_subscriptions").all();
    expect(rows).toHaveLength(0);
  });

  it("returns ok even if endpoint not registered", async () => {
    createBaby();
    const res = await del("/api/notifications/subscribe", {
      endpoint: "https://fcm.googleapis.com/never-was",
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/notifications/preferences", () => {
  it("returns default prefs when none set", async () => {
    createBaby();
    const res = await get("/api/notifications/preferences");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prefs.rescue_wake).toBe(true);
    expect(body.prefs.nap_ending_soon).toBe(true);
    expect(body.prefs.nap_overtime).toBe(true);
    expect(body.prefs.bedtime_approaching).toBe(true);
    expect(body.prefs.nap_overdue).toBe(false);
    expect(body.kinds).toContain("rescue_wake");
  });

  it("returns 400 with no baby", async () => {
    const res = await get("/api/notifications/preferences");
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/notifications/preferences", () => {
  it("updates prefs", async () => {
    createBaby();
    const res = await put("/api/notifications/preferences", {
      nap_overdue: true,
      rescue_wake: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prefs.nap_overdue).toBe(true);
    expect(body.prefs.rescue_wake).toBe(false);
    expect(body.prefs.nap_ending_soon).toBe(true); // unchanged
  });

  it("ignores unknown keys", async () => {
    createBaby();
    const res = await put("/api/notifications/preferences", {
      not_a_real_kind: true,
      nap_ending_soon: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prefs.nap_ending_soon).toBe(false);
    expect(body.prefs).not.toHaveProperty("not_a_real_kind");
  });

  it("persists across requests", async () => {
    createBaby();
    await put("/api/notifications/preferences", { nap_overdue: true });
    const res = await get("/api/notifications/preferences");
    const body = await res.json();
    expect(body.prefs.nap_overdue).toBe(true);
  });

  it("are per-baby when scoped with ?baby=", async () => {
    const ada = createBaby("Ada");
    const bo = createBaby("Bo");

    await put(`/api/notifications/preferences?baby=${ada}`, { nap_overdue: true });
    const adaPrefs = await (await get(`/api/notifications/preferences?baby=${ada}`)).json();
    const boPrefs = await (await get(`/api/notifications/preferences?baby=${bo}`)).json();

    expect({ ada: adaPrefs.prefs.nap_overdue, bo: boPrefs.prefs.nap_overdue }).toEqual({
      ada: true,
      bo: false,
    });
  });
});
