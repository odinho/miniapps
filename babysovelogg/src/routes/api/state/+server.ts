import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { getState } from "$lib/server/state.js";

export const GET: RequestHandler = () => {
  return json(getState());
};
