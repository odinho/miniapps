#!/usr/bin/env bun
/**
 * Finds new Firefox bug screenshots from phone sync, copies + resizes them
 * into the next babysovelogg-bugsN folder.
 *
 * Usage: bun scripts/sync-bug-screenshots.ts [--dry-run]
 *
 * State: stores last processed filename in local/last-bug-screenshot.txt
 */

import { readdir, readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename } from "node:path";

const SYNC_DIR =
	"/run/user/1000/gvfs/smb-share:server=syn.local,share=sync/Bilete/odin-flip6/Screenshots";
const PROJECT_DIR = "/home/odin/Kode/miniapps/babysovelogg";
const MARKER_FILE = join(PROJECT_DIR, "local", "last-bug-screenshot.txt");
const DRY_RUN = process.argv.includes("--dry-run");

async function getLastProcessed(): Promise<string> {
	if (existsSync(MARKER_FILE)) {
		return (await readFile(MARKER_FILE, "utf-8")).trim();
	}
	// Bootstrap from existing bugs folders
	const entries = await readdir(PROJECT_DIR);
	const bugsFolders = entries
		.filter((e) => e.startsWith("babysovelogg-bugs"))
		.sort();
	if (bugsFolders.length === 0) return "";
	const latest = bugsFolders[bugsFolders.length - 1];
	const files = await readdir(join(PROJECT_DIR, latest));
	const sorted = files
		.filter((f) => f.startsWith("Screenshot_"))
		.map((f) => f.replace(".resized.jpg", ".jpg"))
		.sort();
	return sorted.length > 0 ? sorted[sorted.length - 1] : "";
}

function getNextBugsFolder(): string {
	let n = 1;
	while (existsSync(join(PROJECT_DIR, `babysovelogg-bugs${n}`))) n++;
	return `babysovelogg-bugs${n}`;
}

async function listNewScreenshots(lastProcessed: string): Promise<string[]> {
	if (!existsSync(SYNC_DIR)) {
		console.error(`ERROR: Sync directory not mounted: ${SYNC_DIR}`);
		process.exit(1);
	}
	const all = await readdir(SYNC_DIR);
	const firefox2026 = all
		.filter((f) => f.startsWith("Screenshot_2026") && f.includes("Firefox") && f.endsWith(".jpg"))
		.sort();

	if (!lastProcessed) return firefox2026;
	return firefox2026.filter((f) => f > lastProcessed);
}

async function main() {
	const lastProcessed = await getLastProcessed();
	console.error(`Last processed: ${lastProcessed || "(none)"}`);

	const newFiles = await listNewScreenshots(lastProcessed);
	if (newFiles.length === 0) {
		console.error("No new screenshots found.");
		// Output empty JSON for the skill to handle
		console.log(JSON.stringify({ folder: null, files: [] }));
		process.exit(0);
	}

	console.error(`Found ${newFiles.length} new screenshot(s)`);

	if (DRY_RUN) {
		console.error("Dry run — would process:");
		for (const f of newFiles) console.error(`  ${f}`);
		console.log(JSON.stringify({ folder: null, files: newFiles, dryRun: true }));
		process.exit(0);
	}

	const folder = getNextBugsFolder();
	const outDir = join(PROJECT_DIR, folder);
	await mkdir(outDir, { recursive: true });

	const processed: string[] = [];
	for (const f of newFiles) {
		const src = join(SYNC_DIR, f);
		const outName = f.replace(".jpg", ".resized.jpg");
		const dest = join(outDir, outName);

		// Resize to 50% using ImageMagick
		try {
			execSync(`convert "${src}" -resize 50% "${dest}"`, { stdio: "pipe" });
			processed.push(outName);
			console.error(`  ✓ ${outName}`);
		} catch (err) {
			console.error(`  ✗ Failed to process ${f}: ${err}`);
		}
	}

	// Update marker to the last original filename
	const lastNew = newFiles[newFiles.length - 1];
	await writeFile(MARKER_FILE, lastNew, "utf-8");

	console.log(
		JSON.stringify({
			folder,
			files: processed,
			path: outDir,
		})
	);
}

main();
