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
  export let agreementMap: Record<string, 'keep' | 'cull' | 'disagree'> = {};
  export let confirmedIds: Set<string> = new Set();
  export let userStarsMap: Record<string, number | undefined> = {};
  export let onSelect: (idx: number) => void = () => {};
  export let onToggleState: (idx: number) => void = () => {};

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
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="cell"
      class:keep={isKeep}
      class:cull={isCull}
      class:sel={isSel}
      class:confident-keep={agreement === 'keep'}
      class:confident-cull={agreement === 'cull'}
      class:disputed={agreement === 'disagree'}
      style="left:{r.x}px;top:{r.y}px;width:{r.w}px;height:{r.h}px;{sg ? 'outline:2px dashed rgba(240,160,64,.4);outline-offset:-2px' : ''}"
      on:click={() => onSelect(i)}
      role="button"
      tabindex="-1"
    >
      <img src={previewUrl(asset.id)} loading="lazy" alt={asset.filename} />

      {#if agreement === 'keep'}
        <div class="confidence-bar keep-bar">CONFIDENT KEEP</div>
      {:else if agreement === 'cull'}
        <div class="confidence-bar cull-bar">CONFIDENT CULL</div>
      {:else if agreement === 'disagree'}
        <div class="dispute-badge">?!</div>
      {/if}

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
          <div class="bdg kb" class:confirmed={isConfirmed}>{isConfirmed ? 'KEEP' : 'KEEP?'}</div>
        {:else if isCull}
          <div class="bdg cb" class:confirmed={isConfirmed}>{isConfirmed ? 'CULL' : 'CULL?'}</div>
        {:else if autoCullMap[asset.id]?.tier === 'auto-cull-high'}
          <div class="bdg acb-hi">AUTO</div>
        {:else if autoCullMap[asset.id]?.tier === 'auto-cull'}
          <div class="bdg acb">AUTO</div>
        {/if}
      </div>

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
