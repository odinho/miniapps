<script lang="ts">
	import type { BabyState } from '$lib/stores/app.svelte.js';
	import type { OverlapSuggestion } from '$lib/engine/overlap.js';
	import { formatTime } from '$lib/utils.js';

	interface Props {
		suggestion: OverlapSuggestion;
		babies: BabyState[];
		/** Log the (synced-tagged) sleep for the nudged baby. */
		onAccept: (s: OverlapSuggestion) => void;
		/** Dismiss this suggestion for the current window. */
		onDismiss: (s: OverlapSuggestion) => void;
	}
	let { suggestion, babies, onAccept, onDismiss }: Props = $props();

	const name = $derived(babies.find((b) => b.baby?.id === suggestion.babyId)?.baby?.name ?? 'barnet');
	const earlier = $derived(suggestion.deltaMin < 0);
	const absMin = $derived(Math.abs(suggestion.deltaMin));
	const what = $derived(suggestion.kind === 'bedtime' ? 'leggetid' : 'lur');
</script>

<div class="overlap-card" data-testid="overlap-card">
	<p class="overlap-text">
		💡 Legg <strong>{name}</strong> {what === 'leggetid' ? 'til' : 'ned'} ca. kl. {formatTime(suggestion.to)}
		<span class="overlap-sub">
			(~{absMin} min {earlier ? 'tidlegare' : 'seinare'}) for ~{suggestion.projectedOverlapMin} min felles søvn
		</span>
	</p>
	<div class="overlap-actions">
		<button class="btn btn-primary" data-testid="overlap-accept" onclick={() => onAccept(suggestion)}>
			Gjer det
		</button>
		<button class="btn btn-ghost" data-testid="overlap-dismiss" onclick={() => onDismiss(suggestion)}>
			Ikkje no
		</button>
	</div>
</div>

<style>
	.overlap-card {
		background: var(--lavender-light, #efeaff);
		border: 1px solid var(--lavender, #b9a7e6);
		border-radius: 16px;
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.overlap-text {
		margin: 0;
		font-size: 0.95rem;
	}
	.overlap-sub {
		display: block;
		font-size: 0.8rem;
		color: var(--text-light);
		margin-top: 2px;
	}
	.overlap-actions {
		display: flex;
		gap: 8px;
	}
	.overlap-actions .btn {
		flex: 1;
	}
</style>
