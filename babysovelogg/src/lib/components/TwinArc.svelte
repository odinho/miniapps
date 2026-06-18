<script lang="ts">
	// Concentric twin arc: two babies on ONE shared time domain. Baby A is the
	// outer lane (full chrome — endpoints, now-line, bands, blobs); baby B is a
	// thinner inner lane showing only its track + sleep bubbles + night wakings.
	// Both lanes share the SAME ArcConfig so their segments line up radially
	// (12:00 is at the same angle on both rings). Distinguishing the two babies
	// by RADIUS — not by recolouring — keeps the familiar nap=peach/night=moon
	// semantics and avoids the per-child colour-swap bug class.
	//
	// Composition (the bug-prone geometry) is reused from composeArc; only the
	// markup differs from Arc.svelte. See svelte-ui-docs → arc-internals.md.
	import { composeArc, DEFAULT_ARC_GEOMETRY, type ArcGeometry } from '$lib/arc-scene.js';
	import { fracToPoint, timeToArcFractionRaw, type ArcConfig } from '$lib/arc-utils.js';
	import type { ArcProps } from '$lib/arc-props.js';

	interface Props {
		a: ArcProps;
		b: ArcProps;
		/** Shared (union) time domain both lanes render against. */
		config: ArcConfig;
		nowMs: number;
		nameA?: string;
		nameB?: string;
	}
	let { a, b, config, nowMs, nameA = '', nameB = '' }: Props = $props();

	const OUTER: ArcGeometry = DEFAULT_ARC_GEOMETRY;
	const INNER: ArcGeometry = { size: 320, cx: 160, cy: 160, r: 99, trackWidth: 9 };
	const G = OUTER;

	const now = $derived(new Date(nowMs));

	// Outer lane: the full single-baby scene, but on the shared config.
	const outer = $derived(composeArc({ ...a, now, config, geometry: OUTER }));
	// Inner lane: same shared config, smaller geometry. We render only a subset.
	const inner = $derived(composeArc({ ...b, now, config, geometry: INNER }));

	// One shared "now" radius line crossing BOTH rings (not two markers).
	const nowFracRaw = $derived(timeToArcFractionRaw(now, config));
	const nowVisible = $derived(nowFracRaw >= 0 && nowFracRaw <= 1);
	const nowFrac = $derived(Math.max(0, Math.min(1, nowFracRaw)));
	const nowOuterPt = $derived(fracToPoint(nowFrac, G.cx, G.cy, OUTER.r + OUTER.trackWidth / 2 + 3));
	const nowInnerPt = $derived(fracToPoint(nowFrac, G.cx, G.cy, INNER.r - INNER.trackWidth / 2 - 3));

	const trackStrokeOuter = $derived(a.isNightMode ? 'rgba(120, 110, 170, 0.3)' : 'var(--lavender-dark)');

	function colorVar(c: 'moon' | 'peach'): string {
		return c === 'moon' ? 'var(--moon)' : 'var(--peach-dark)';
	}
</script>

<div class="twin-arc" data-testid="twin-arc">
	<svg viewBox="0 0 {G.size} {G.size}" width="100%" class="sleep-arc" role="img" aria-label="Tvillingboge: {nameA} (ytre ring) og {nameB} (indre ring)">
		<defs>
			<filter id="twin-arc-glow" x="-50%" y="-50%" width="200%" height="200%">
				<feGaussianBlur stdDeviation="4" result="glow" />
				<feMerge>
					<feMergeNode in="glow" />
					<feMergeNode in="SourceGraphic" />
				</feMerge>
			</filter>
		</defs>

		<!-- Background tracks: outer (baby A) + faint inner (baby B) -->
		<path d={outer.trackD} fill="none" stroke={trackStrokeOuter} stroke-width={OUTER.trackWidth} stroke-linecap="round" />
		<path d={inner.trackD} fill="none" stroke="var(--cream-dark)" stroke-width={INNER.trackWidth} stroke-linecap="round" opacity="0.7" />

		<!-- Shared now-line crossing both rings -->
		{#if nowVisible}
			<line x1={nowOuterPt.x} y1={nowOuterPt.y} x2={nowInnerPt.x} y2={nowInnerPt.y} stroke="var(--sun)" stroke-width="3" stroke-linecap="round" />
		{/if}

		<!-- Outer (baby A): planned track + bands + blobs (full chrome) -->
		{#if outer.plannedTrack.visible}
			<path d={outer.plannedTrack.d} fill="none" stroke={colorVar(outer.plannedTrack.color)} stroke-width={OUTER.trackWidth + 2} stroke-linecap="round" stroke-dasharray="6 4" opacity="0.35" />
		{/if}
		{#if outer.activeWakeBand.visible}
			<path d={outer.activeWakeBand.d} fill="none" stroke={colorVar(outer.activeWakeBand.color)} stroke-width={OUTER.trackWidth * 2.4} stroke-linecap="round" opacity="0.3" />
		{/if}
		{#each outer.confidenceBands as band}
			{#if band.visible}
				<path d={band.d} fill="none" stroke={colorVar(band.color)} stroke-width={OUTER.trackWidth * 2.4} stroke-linecap="round" opacity="0.3" />
			{/if}
		{/each}

		<!-- Inner (baby B) bubbles -->
		{#each inner.bubbles as bub}
			{#if bub.dot}
				<circle cx={bub.dot.cx} cy={bub.dot.cy} r={bub.dot.r} fill={colorVar(bub.color)} opacity={bub.opacity} filter={bub.glow ? 'url(#twin-arc-glow)' : null} class={bub.pulse ? 'arc-active-pulse' : ''} />
			{:else}
				<path d={bub.d} fill="none" stroke={colorVar(bub.color)} stroke-width={bub.strokeWidth} stroke-linecap="round" opacity={bub.opacity} stroke-dasharray={bub.dashArray} filter={bub.glow ? 'url(#twin-arc-glow)' : null} class={bub.pulse ? 'arc-active-pulse' : ''} />
			{/if}
		{/each}
		<!-- Inner night wakings -->
		{#each inner.nightWakingOverlays as ov (ov.domainId)}
			<path d={ov.d} fill="none" stroke="rgba(192, 57, 43, 0.95)" stroke-width={INNER.trackWidth - 1} stroke-linecap="round" opacity={ov.active ? 1 : 0.9} class:arc-active-pulse={ov.active} />
		{/each}
		<!-- Inner active-sleep endpoint halo: composeArc suppresses a very-short
			 active bubble that hugs an endpoint into a halo, so without this the
			 baby-B active state would silently vanish on the inner lane. -->
		{#if inner.start.activeHalo}
			<circle cx={inner.start.pt.x} cy={inner.start.pt.y} r="13" fill="none" stroke={colorVar(inner.start.activeHalo.color)} stroke-width="2.5" opacity="0.85" class="arc-endpoint-halo arc-active-pulse" />
		{/if}
		{#if inner.end.activeHalo}
			<circle cx={inner.end.pt.x} cy={inner.end.pt.y} r="13" fill="none" stroke={colorVar(inner.end.activeHalo.color)} stroke-width="2.5" opacity="0.85" class="arc-endpoint-halo arc-active-pulse" />
		{/if}

		<!-- Outer (baby A) bubbles -->
		{#each outer.bubbles as bub}
			{#if bub.dot}
				<circle cx={bub.dot.cx} cy={bub.dot.cy} r={bub.dot.r} fill={colorVar(bub.color)} opacity={bub.opacity} filter={bub.glow ? 'url(#twin-arc-glow)' : null} class={bub.pulse ? 'arc-active-pulse' : ''} />
			{:else}
				<path d={bub.d} fill="none" stroke={colorVar(bub.color)} stroke-width={bub.strokeWidth} stroke-linecap="round" opacity={bub.opacity} stroke-dasharray={bub.dashArray} filter={bub.glow ? 'url(#twin-arc-glow)' : null} class={bub.pulse ? 'arc-active-pulse' : ''} />
			{/if}
		{/each}
		<!-- Outer night wakings -->
		{#each outer.nightWakingOverlays as ov (ov.domainId)}
			<path d={ov.d} fill="none" stroke="rgba(192, 57, 43, 0.95)" stroke-width={OUTER.trackWidth - 2} stroke-linecap="round" opacity={ov.active ? 1 : 0.9} class:arc-active-pulse={ov.active} />
		{/each}

		<!-- Outer skipped blob -->
		{#if outer.skippedBlob?.visible}
			<path d={outer.skippedBlob.d} fill="none" stroke="var(--peach-dark)" stroke-width={OUTER.trackWidth + 2} stroke-linecap="round" stroke-dasharray="3 5" opacity="0.35" />
		{/if}

		<!-- Endpoints (shared domain → one sun/moon pair, drawn last) -->
		<g class="arc-endpoint-icon">
			{#if outer.start.activeHalo}
				<circle cx={outer.start.pt.x} cy={outer.start.pt.y} r="20" fill="none" stroke={colorVar(outer.start.activeHalo.color)} stroke-width="2.5" opacity="0.85" class="arc-endpoint-halo arc-active-pulse" />
			{/if}
			<circle cx={outer.start.pt.x} cy={outer.start.pt.y} r="16" fill={outer.start.glow} />
			<text x={outer.start.pt.x} y={outer.start.pt.y + 1} font-size="18" text-anchor="middle" dominant-baseline="middle">{outer.start.icon}</text>
		</g>
		<g class="arc-endpoint-icon">
			{#if outer.end.activeHalo}
				<circle cx={outer.end.pt.x} cy={outer.end.pt.y} r="20" fill="none" stroke={colorVar(outer.end.activeHalo.color)} stroke-width="2.5" opacity="0.85" class="arc-endpoint-halo arc-active-pulse" />
			{/if}
			<circle cx={outer.end.pt.x} cy={outer.end.pt.y} r="16" fill={outer.end.glow} />
			<text x={outer.end.pt.x} y={outer.end.pt.y + 1} font-size="18" text-anchor="middle" dominant-baseline="middle">{outer.end.icon}</text>
		</g>
	</svg>

	<div class="twin-legend" data-testid="twin-legend">
		<span class="twin-legend-item"><span class="twin-ring twin-ring-outer" aria-hidden="true"></span>{nameA} <span class="twin-ring-label">(ytre)</span></span>
		<span class="twin-legend-item"><span class="twin-ring twin-ring-inner" aria-hidden="true"></span>{nameB} <span class="twin-ring-label">(indre)</span></span>
	</div>
</div>

<style>
	.twin-arc {
		position: relative;
		width: 100%;
		max-width: 300px;
		margin: 0 auto;
	}
	.twin-legend {
		display: flex;
		justify-content: center;
		gap: 16px;
		margin-top: -8px;
		font-size: 0.85rem;
		color: var(--text);
	}
	.twin-legend-item {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.twin-ring {
		display: inline-block;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid var(--text-light);
	}
	.twin-ring-outer {
		border-width: 3px;
		border-color: var(--text);
	}
	.twin-ring-inner {
		width: 8px;
		height: 8px;
	}
	.twin-ring-label {
		color: var(--text-light);
		font-size: 0.75rem;
	}
</style>
