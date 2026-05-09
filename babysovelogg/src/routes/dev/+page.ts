import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';

export const ssr = false;

export const load = () => {
	if (!dev) error(404);
};
