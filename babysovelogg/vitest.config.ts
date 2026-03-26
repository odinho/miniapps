import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/unit/**/*.unit.ts", "tests/integration/**/*.test.ts"],
	},
});
