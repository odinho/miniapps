import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { getBabyState, getFamilyState } from "$lib/server/state.js";

export const GET: RequestHandler = ({ url }) => {
  const nowParam = url.searchParams.get("now");
  const now = nowParam ? Number(nowParam) : undefined;
  // `?baby=<id>` returns just that child's slice for per-baby detail surfaces.
  // Without it, the default is the whole-family snapshot. `?now=` is
  // family-wide so both babies share the clock for deterministic tests.
  const babyParam = url.searchParams.get("baby");
  if (babyParam != null && babyParam !== "") {
    const id = Number(babyParam);
    if (!Number.isFinite(id)) return json({ error: "invalid_baby" }, { status: 400 });
    const slice = getBabyState(id, now);
    if (!slice) return json({ error: "baby_not_found" }, { status: 404 });
    return json(slice);
  }
  return json(getFamilyState(now));
};
