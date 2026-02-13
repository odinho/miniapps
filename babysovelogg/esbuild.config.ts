import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const isWatch = process.argv.includes("--watch");

const outdir = resolve("dist");

// Copy public/ to dist/
function copyPublic() {
  const publicDir = resolve("public");
  if (existsSync(publicDir)) {
    mkdirSync(outdir, { recursive: true });
    cpSync(publicDir, outdir, { recursive: true });
  }
}

async function main() {
  copyPublic();

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
