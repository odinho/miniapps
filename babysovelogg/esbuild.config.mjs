import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes("--watch");
const outdir = resolve(__dirname, "dist");

function copyPublic() {
  const publicDir = resolve(__dirname, "public");
  if (existsSync(publicDir)) {
    mkdirSync(outdir, { recursive: true });
    cpSync(publicDir, outdir, { recursive: true });
  }
}

async function main() {
  copyPublic();

  // Build service worker
  await esbuild.build({
    entryPoints: ["src/sw/service-worker.ts"],
    bundle: true,
    outfile: "dist/sw.js",
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: !isWatch,
  });

  // Build client bundle
  const ctx = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    outfile: "dist/bundle.js",
    format: "esm",
    platform: "browser",
    target: "es2020",
    sourcemap: true,
    minify: !isWatch,
  });

  // Build server bundle
  await esbuild.build({
    entryPoints: ["server/index.ts"],
    bundle: true,
    outfile: "dist/server.js",
    format: "esm",
    platform: "node",
    target: "node20",
    minify: false,
    external: ["better-sqlite3"],
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
  });

  if (isWatch) {
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log("Build complete.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
