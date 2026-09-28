import { afterEach, describe, expect, it, vi } from "vitest";
import { ImmichFaceFetcher } from "./immich-face-fetcher.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body));

/** Fake Immich: two named people + one unnamed cluster, person p1 spans two search pages. */
function fakeImmich() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/people")) {
      return json({
        people: [
          { id: "p1", name: "Halldis" },
          { id: "p2", name: " Mia " },
          { id: "p3", name: "" },
        ],
        hasNextPage: false,
      });
    }
    const { personIds, page } = JSON.parse(String(init?.body));
    const pages: Record<
      string,
      Array<{ items: Array<{ id: string }>; nextPage: string | null }>
    > = {
      p1: [
        { items: [{ id: "a1" }, { id: "a2" }], nextPage: "2" },
        { items: [{ id: "a3" }], nextPage: null },
      ],
      p2: [{ items: [{ id: "a2" }], nextPage: null }],
      p3: [{ items: [{ id: "a4" }], nextPage: null }],
    };
    return json({ assets: pages[personIds[0]][page - 1] });
  });
}

describe("ImmichFaceFetcher", () => {
  it("maps assets to named people across pages, dropping unnamed clusters", async () => {
    vi.stubGlobal("fetch", fakeImmich());
    const fetcher = new ImmichFaceFetcher("http://immich", "key");

    const people = await fetcher.fetchPeopleForAssets(["a1", "a2", "a3", "a4", "a5"]);

    expect(people.get("a1")).toEqual(["name:Halldis"]);
    expect(people.get("a2")).toEqual(["name:Halldis", "name:Mia"]);
    expect(people.get("a3")).toEqual(["name:Halldis"]);
    expect(people.get("a4")).toEqual([]);
    expect(people.get("a5")).toEqual([]);
  });

  it("builds the index once for concurrent callers", async () => {
    const fetchMock = fakeImmich();
    vi.stubGlobal("fetch", fetchMock);
    const fetcher = new ImmichFaceFetcher("http://immich", "key");

    await Promise.all([
      fetcher.fetchPeopleForAssets(["a1"]),
      fetcher.fetchPeopleForAssets(["a2"]),
      fetcher.fetchPeopleForAssets(["a3"]),
    ]);

    // 1 people list + 2 pages for p1 + 1 for p2 (unnamed p3 is never searched)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns empty lists on failure and retries next call", async () => {
    const good = fakeImmich();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockImplementation(good);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = new ImmichFaceFetcher("http://immich", "key");

    expect((await fetcher.fetchPeopleForAssets(["a1"])).get("a1")).toEqual([]);
    expect((await fetcher.fetchPeopleForAssets(["a1"])).get("a1")).toEqual(["name:Halldis"]);
  });
});
