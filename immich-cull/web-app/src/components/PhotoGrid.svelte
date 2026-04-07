<script lang="ts">
  import { onMount } from 'svelte';
  import { justifiedLayout, type Rect } from '../lib/layout';
  import { previewUrl, fmt } from '../lib/api';
  import type { AssetDetail, LlmImage } from '../lib/api';
  import type { AssetState } from '../lib/stores';

  export let assets: AssetDetail[] = [];
  export let states: Record<string, AssetState> = {};
  export let selectedIdx: number = -1;
  export let llmMap: Record<string, LlmImage> = {};
  export let keepSet: Set<string> = new Set();
  export let cullSet: Set<string> = new Set();
  export let onSelect: (idx: number) => void = () => {};

  let container: HTMLDivElement;
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
</script>

<div class="jgrid" bind:this={container}>
  {#each assets as asset, i (asset.id)}
    {@const r = rects[i] || { x: 0, y: 0, w: 100, h: 100 }}
    {@const llm = llmMap[asset.id]}
    {@const sg = llm?.similaritySubgroupId}
    {@const isKeep = states[asset.id] === 'keep' || keepSet.has(asset.id)}
    {@const isCull = states[asset.id] === 'cull' || cullSet.has(asset.id)}
    {@const isSel = i === selectedIdx}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="cell"
      class:keep={isKeep}
      class:cull={isCull}
      class:sel={isSel}
      style="left:{r.x}px;top:{r.y}px;width:{r.w}px;height:{r.h}px;{sg ? 'outline:2px dashed rgba(240,160,64,.4);outline-offset:-2px' : ''}"
      on:click={() => onSelect(i)}
      role="button"
      tabindex="-1"
    >
      <img src={previewUrl(asset.id)} loading="lazy" alt={asset.filename} />

      {#if llm && llm.suggestedStars > 0}
        <div class="llm-star">
          {'★'.repeat(llm.suggestedStars)}
        </div>
        {#if llm.briefNote}
          <div class="llm-note">{llm.briefNote}</div>
        {/if}
      {/if}

      {#if isKeep}
        <div class="bdg kb">KEEP</div>
      {:else if isCull}
        <div class="bdg cb">CULL</div>
      {/if}

      {#if asset.rating && asset.rating > 0}
        <div class="st">{'★'.repeat(asset.rating)}</div>
      {/if}

      <div class="lbl">
        <span>{asset.filename}</span>
        <span>{fmt(asset.bytes || 0)}</span>
      </div>
    </div>
  {/each}
</div>
