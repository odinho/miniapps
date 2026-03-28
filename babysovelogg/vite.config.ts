import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

function gitVersion(): string {
	try {
		const mainCount = execSync('git rev-list --count main', { encoding: 'utf-8' }).trim();
		const branchCount = execSync('git rev-list --count main..HEAD', { encoding: 'utf-8' }).trim();
		return `1.${mainCount}.${branchCount}`;
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
