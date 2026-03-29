import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/unit/**/*.unit.ts", "tests/integration/**/*.test.ts"],
		alias: {
			"$lib": new URL("./src/lib", import.meta.url).pathname,
			"bun:sqlite": new URL("./tests/compat/bun-sqlite.ts", import.meta.url).pathname,
		},
	},
});
