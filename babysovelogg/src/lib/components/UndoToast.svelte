<script lang="ts">
	// The single undo/correction toast (folded from two duplicate render blocks
	// in +page.svelte). Carries an optional list of one-tap "corrections":
	// `revert` chips (undo just one child of a bulk action) and `additive` chips
	// (e.g. the co-sleep "+ Bo vakna òg" — a NEW action), styled distinctly so an
	// additive action never reads like the "Angre" undo next to it.
	type ToastEvent = { type: string; payload: Record<string, unknown> };
	export type ToastCorrection = { label: string; events: ToastEvent[]; kind?: 'additive' | 'revert' };

	interface Props {
		message: string;
		corrections?: ToastCorrection[];
		onCorrection: (events: ToastEvent[]) => void;
		onUndo: () => void;
	}
	let { message, corrections, onCorrection, onUndo }: Props = $props();
</script>

<div class="undo-toast" data-testid="undo-toast">
	<span>{message}</span>
	{#if corrections}
		{#each corrections as c}
			<button
				class="btn {c.kind === 'additive' ? 'btn-additive' : 'btn-ghost'}"
				data-testid={c.kind === 'additive' ? 'toast-additive' : 'toast-correction'}
				onclick={() => onCorrection(c.events)}
			>{c.label}</button>
		{/each}
	{/if}
	<button class="btn btn-ghost" data-testid="toast-undo" onclick={onUndo}>Angre</button>
</div>
