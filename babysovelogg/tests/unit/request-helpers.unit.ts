import { describe, it, expect } from "bun:test";
import { parseIntParam, safeJson } from "$lib/server/request-helpers.js";

function url(qs: string): URL {
	return new URL(`http://x.test/${qs}`);
}

describe("parseIntParam", () => {
	it("returns the parsed number for a clean positive integer", () => {
		expect(parseIntParam(url("?n=42"), "n")).toBe(42);
	});

	it("returns default when the param is missing", () => {
		expect(parseIntParam(url("?other=1"), "n", { default: 50 })).toBe(50);
	});

	it("returns default when the param is empty", () => {
		expect(parseIntParam(url("?n="), "n", { default: 7 })).toBe(7);
	});

	it("returns default for non-numeric input", () => {
		expect(parseIntParam(url("?n=foo"), "n", { default: 10 })).toBe(10);
	});

	it("returns default for NaN-like float input", () => {
		expect(parseIntParam(url("?n=1.5"), "n", { default: 10 })).toBe(10);
	});

	it("returns default for negative input when min defaults to 0", () => {
		expect(parseIntParam(url("?n=-3"), "n", { default: 10 })).toBe(10);
	});

	it("respects an explicit min", () => {
		expect(parseIntParam(url("?n=4"), "n", { min: 5, default: 5 })).toBe(5);
		expect(parseIntParam(url("?n=6"), "n", { min: 5, default: 5 })).toBe(6);
	});

	it("clamps to max", () => {
		expect(parseIntParam(url("?n=9999"), "n", { max: 100 })).toBe(100);
	});

	it("returns undefined when no default and missing", () => {
		expect(parseIntParam(url(""), "n")).toBeUndefined();
	});
});

function req(body: string): Request {
	return new Request("http://x.test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
}

describe("safeJson", () => {
	it("parses valid JSON", async () => {
		const r = await safeJson<{ a: number }>(req('{"a":1}'));
		expect(r).toEqual({ a: 1 });
	});

	it("returns null on invalid JSON", async () => {
		expect(await safeJson(req("{not json"))).toBeNull();
	});

	it("returns null on empty body", async () => {
		expect(await safeJson(req(""))).toBeNull();
	});
});
