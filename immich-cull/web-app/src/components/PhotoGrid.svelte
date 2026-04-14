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
    {@const collapsed = collapsedCountMap[asset.id] ?? 0}
    {@const prevSg = i > 0 ? llmMap[assets[i-1]?.id]?.similaritySubgroupId : null}
    {@const sgCont = sg && sg === prevSg}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="cell"
      class:keep={isKeep}
      class:cull={isCull}
      class:sel={isSel}
      class:sg-cont={sgCont}
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
        <div class="collapsed-badge">+{collapsed}</div>
      {/if}

      <div class="lbl">
        <span>{asset.filename}</span>
        <span>{fmt(asset.bytes || 0)}</span>
      </div>
    </div>
  {/each}
</div>
