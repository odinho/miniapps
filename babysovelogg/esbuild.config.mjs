import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
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

/** Replace /bundle.js in index.html with the hashed filename. */
function injectBundleHash() {
  const files = readdirSync(outdir);
  const bundleFile = files.find((f) => f.match(/^bundle-[A-Z0-9]+\.js$/i));
  if (!bundleFile) return;

  const indexPath = resolve(outdir, "index.html");
  if (!existsSync(indexPath)) return;
  let html = readFileSync(indexPath, "utf8");
  html = html.replace(/\/bundle\.js/, `/${bundleFile}`);
  writeFileSync(indexPath, html);

  // Also update service worker shell assets
  const swPath = resolve(outdir, "sw.js");
  if (existsSync(swPath)) {
    let sw = readFileSync(swPath, "utf8");
    sw = sw.replace(/\/bundle\.js/, `/${bundleFile}`);
    writeFileSync(swPath, sw);
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

  if (isWatch) {
    // In watch mode, use stable filename for simpler dev experience
    const ctx = await esbuild.context({
      entryPoints: ["src/main.ts"],
      bundle: true,
      outfile: "dist/bundle.js",
      format: "esm",
      platform: "browser",
      target: "es2020",
      sourcemap: true,
      minify: false,
    });
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    // Production: content-hashed filename for cache busting
    await esbuild.build({
      entryPoints: ["src/main.ts"],
      bundle: true,
      outdir: "dist",
      entryNames: "bundle-[hash]",
      format: "esm",
      platform: "browser",
      target: "es2020",
      sourcemap: true,
      minify: true,
    });
    injectBundleHash();
    console.log("Build complete.");
  }

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
