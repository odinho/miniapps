import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { getState } from "$lib/server/state.js";

export const GET: RequestHandler = ({ url }) => {
  const nowParam = url.searchParams.get("now");
  const now = nowParam ? Number(nowParam) : undefined;
  return json(getState(now));
};
