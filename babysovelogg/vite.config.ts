import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function gitVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
		const major = pkg.version?.split('.')[0] ?? '1';
		const mainCount = execSync('git rev-list --count main', { encoding: 'utf-8' }).trim();
		const branchCount = execSync('git rev-list --count main..HEAD', { encoding: 'utf-8' }).trim();
		return `${major}.${mainCount}.${branchCount}`;
	} catch {
		return '1.0.0';
	}
}

export default defineConfig({
	plugins: [sveltekit()],
	define: {
		__APP_VERSION__: JSON.stringify(gitVersion()),
	},
	server: {
		port: 3200,
	},
});
