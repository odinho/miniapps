<script lang="ts">
  import { onMount } from 'svelte';
  import { justifiedLayout, type Rect } from '../lib/layout';
  import { previewUrl, fmt } from '../lib/api';
  import type { AssetDetail, LlmImage, AutoCullClassification } from '../lib/api';
  import type { AssetState } from '../lib/stores';

  export let assets: AssetDetail[] = [];
  export let states: Record<string, AssetState> = {};
  export let selectedIdx: number = -1;
  export let llmMap: Record<string, LlmImage> = {};
  export let effectiveStarsMap: Record<string, number> = {};
  export let autoCullMap: Record<string, AutoCullClassification> = {};
  export let agreementMap: Record<string, { consensus: 'keep' | 'cull' | 'disagree'; unanimous: boolean }> = {};
  export let collapsedCountMap: Record<string, number> = {};
  export let confirmedIds: Set<string> = new Set();
  export let userStarsMap: Record<string, number | undefined> = {};
  export let onSelect: (idx: number) => void = () => {};
  export let onToggleState: (idx: number) => void = () => {};
  export let onToggleCollapsed: () => void = () => {};

  let container: HTMLDivElement = undefined!; // bind:this
  let rects: Rect[] = [];

  function computeLayout() {
    if (!container || !assets.length) return;
    rects = justifiedLayout(assets, container.clientWidth, container.clientHeight, 4);
  }

  onMount(() => {
    computeLayout();
    const ro = new ResizeObserver(() => computeLayout());
    ro.observe(container);
    return () => ro.disconnect();
  });

  $: if (assets) computeLayout();

  // Compute subgroup connectors between adjacent cells in the same subgroup
  interface Connector { x: number; y: number; w: number; h: number }
  $: connectors = (() => {
    const result: Connector[] = [];
    for (let i = 1; i < assets.length; i++) {
      const sg = llmMap[assets[i]?.id]?.similaritySubgroupId;
      const prevSg = llmMap[assets[i-1]?.id]?.similaritySubgroupId;
      if (!sg || sg !== prevSg) continue;
      const prev = rects[i-1];
      const cur = rects[i];
      if (!prev || !cur) continue;

      const sameRow = Math.abs(prev.y - cur.y) < prev.h * 0.3;
      const badgeH = 16; // matches .collapsed-badge height (~10px font + 2*2px padding)
      const edgeIntrude = 5; // border(3) + 2px into photo

      if (sameRow) {
        const gap = cur.x - (prev.x + prev.w);
        const midY = (Math.max(prev.y, cur.y) + Math.min(prev.y + prev.h, cur.y + cur.h)) / 2;
        if (gap > 1) {
          // Gap exists: fill only the gap
          result.push({ x: prev.x + prev.w, y: midY - badgeH / 2, w: gap, h: badgeH });
        } else {
          // No gap (touching): intrude over border + 2px into each photo
          result.push({ x: prev.x + prev.w - edgeIntrude, y: midY - badgeH / 2, w: edgeIntrude * 2, h: badgeH });
        }
      } else {
        // Cross-row: tab on right edge of prev + left edge of cur
        // Right edge of prev, vertically centered
        result.push({ x: prev.x + prev.w - edgeIntrude, y: prev.y + (prev.h - badgeH) / 2, w: edgeIntrude, h: badgeH });
        // Left edge of cur, vertically centered
        result.push({ x: cur.x, y: cur.y + (cur.h - badgeH) / 2, w: edgeIntrude, h: badgeH });
      }
    }
    return result;
  })();
</script>

<div class="jgrid" bind:this={container}>
  {#each assets as asset, i (asset.id)}
    {@const r = rects[i] || { x: 0, y: 0, w: 100, h: 100 }}
    {@const llm = llmMap[asset.id]}
    {@const sg = llm?.similaritySubgroupId}
    {@const effectiveState = states[asset.id]}
    {@const isKeep = effectiveState === 'keep'}
    {@const isCull = effectiveState === 'cull'}
    {@const isSel = i === selectedIdx}
    {@const effStars = effectiveStarsMap[asset.id] ?? 0}
    {@const isConfirmed = confirmedIds.has(asset.id)}
    {@const agreement = agreementMap[asset.id]}
    {@const collapsed = collapsedCountMap[asset.id] ?? 0}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="cell"
      class:keep={isKeep}
      class:cull={isCull}
      class:sel={isSel}
      style="left:{r.x}px;top:{r.y}px;width:{r.w}px;height:{r.h}px"
      on:click={() => onSelect(i)}
      role="button"
      tabindex="-1"
    >
      <img src={previewUrl(asset.id)} loading="lazy" alt={asset.filename} />

      {#if effStars > 0}
        <div class={userStarsMap[asset.id] != null ? 'user-star' : 'llm-star'}>
          {'★'.repeat(effStars)}
        </div>
      {/if}
      {#if llm?.briefNote}
        <div class="llm-note">{llm.briefNote}</div>
      {/if}

      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="toggle-zone" role="button" tabindex="-1" on:click|stopPropagation={() => onToggleState(i)}>
        {#if isKeep}
          {@const unanimous = agreement?.consensus === 'keep' && agreement.unanimous}
          {@const disputed = agreement?.consensus === 'disagree'}
          <div class="bdg kb" class:confirmed={isConfirmed} class:agreed={unanimous} class:has-dispute={disputed}>
            {#if disputed}<span class="bdg-state">KEEP?</span><span class="bdg-dispute">?!</span>{:else}{isConfirmed ? 'KEEP' : unanimous ? 'KEEP \u2713\u2713' : 'KEEP?'}{/if}
          </div>
        {:else if isCull}
          {@const unanimous = agreement?.consensus === 'cull' && agreement.unanimous}
          {@const disputed = agreement?.consensus === 'disagree'}
          <div class="bdg cb" class:confirmed={isConfirmed} class:agreed={unanimous} class:has-dispute={disputed}>
            {#if disputed}<span class="bdg-state">CULL?</span><span class="bdg-dispute">?!</span>{:else}{isConfirmed ? 'CULL' : unanimous ? 'CULL \u2713\u2713' : 'CULL?'}{/if}
          </div>
        {:else if autoCullMap[asset.id]?.tier === 'auto-cull-high'}
          <div class="bdg acb-hi">AUTO</div>
        {:else if autoCullMap[asset.id]?.tier === 'auto-cull'}
          <div class="bdg acb">AUTO</div>
        {/if}
      </div>

      {#if asset.rating && asset.rating > 0}
        <div class="st">{'★'.repeat(asset.rating)}</div>
      {/if}

      {#if collapsed > 0}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="collapsed-badge" role="button" tabindex="-1" on:click|stopPropagation={() => onToggleCollapsed()}>+{collapsed}</div>
      {/if}

      <div class="lbl">
        <span>{asset.filename}</span>
        <span>{fmt(asset.bytes || 0)}</span>
      </div>
    </div>
  {/each}
  {#each connectors as c}
    <div class="sg-rope" style="left:{c.x}px;top:{c.y}px;width:{c.w}px;height:{c.h}px"></div>
  {/each}
</div>
