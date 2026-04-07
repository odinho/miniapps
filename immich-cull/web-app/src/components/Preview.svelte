<script lang="ts">
  import { previewUrl, fullUrl, fmt } from '../lib/api';
  import type { AssetDetail, LlmImage, LlmSubgroup } from '../lib/api';
  import type { AssetState } from '../lib/stores';

  export let assets: AssetDetail[] = [];
  export let selectedIdx: number = 0;
  export let states: Record<string, AssetState> = {};
  export let llmMap: Record<string, LlmImage> = {};
  export let keepSet: Set<string> = new Set();
  export let cullSet: Set<string> = new Set();
  export let subgroups: LlmSubgroup[] = [];
  export let onSelect: (idx: number) => void = () => {};
  export let onClose: () => void = () => {};
  export let onMark: (state: 'keep' | 'cull') => void = () => {};
  export let onCycleState: () => void = () => {};

  $: asset = assets[selectedIdx];
  $: manualState = asset ? states[asset.id] : null;
  $: llmState = asset ? (keepSet.has(asset.id) ? 'keep' : cullSet.has(asset.id) ? 'cull' : null) : null;
  $: displayState = manualState ?? llmState;
  $: llm = asset ? llmMap[asset.id] : null;

  let imgEl: HTMLImageElement;
  let stripEl: HTMLDivElement;

  $: if (stripEl && selectedIdx >= 0) {
    const thumb = stripEl.children[selectedIdx] as HTMLElement;
    if (thumb) thumb.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  $: if (asset) {
    const url = fullUrl(asset.id);
    const expectedId = asset.id;
    const pre = new Image();
    pre.onload = () => {
      if (imgEl && imgEl.dataset.assetId === expectedId) imgEl.src = url;
    };
    pre.src = url;
  }

  // Swipe detection
  let touchStartX = 0;
  let touchStartY = 0;
  let swiping = false;

  function onTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    swiping = false;
  }

  function onTouchEnd(e: TouchEvent) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Only count horizontal swipes (not vertical scroll)
    if (absDx > 60 && absDx > absDy * 1.5) {
      swiping = true;
      if (dx > 0) {
        // Swipe right = KEEP
        onMark('keep');
      } else {
        // Swipe left = CULL
        onMark('cull');
      }
    }
  }

  function handleMainClick(e: MouseEvent) {
    if (swiping) { swiping = false; return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.3 && selectedIdx > 0) onSelect(selectedIdx - 1);
    else if (x > 0.7 && selectedIdx < assets.length - 1) onSelect(selectedIdx + 1);
    else onClose();
  }
</script>

<div class="preview-ov">
  <!-- Filmstrip -->
  <div class="pv-strip" bind:this={stripEl}>
    {#each assets as a, i}
      {@const ms = states[a.id]}
      {@const ls = keepSet.has(a.id) ? 'keep' : cullSet.has(a.id) ? 'cull' : null}
      {@const ds = ms ?? ls}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="pvt"
        class:active={i === selectedIdx}
        class:keep={ds === 'keep'}
        class:cull={ds === 'cull'}
        on:click={() => onSelect(i)}
        role="button"
        tabindex="-1"
      >
        <img src={previewUrl(a.id)} loading="lazy" alt={a.filename} />
      </div>
    {/each}
  </div>

  <!-- Main image -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div class="pv-main"
    on:click={handleMainClick}
    on:touchstart={onTouchStart}
    on:touchend={onTouchEnd}
  >
    {#if asset}
      <img
        bind:this={imgEl}
        data-asset-id={asset.id}
        src={previewUrl(asset.id)}
        alt={asset.filename}
      />

      {#if displayState}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
        <div class="ptag {displayState}" on:click|stopPropagation={onCycleState}>
          {displayState.toUpperCase()}
        </div>
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
        <div class="ptag none" on:click|stopPropagation={onCycleState}>
          TAP TO MARK
        </div>
      {/if}

      <div class="pinfo" class:pinfo-keep={displayState === 'keep'} class:pinfo-cull={displayState === 'cull'}>
        <strong>{asset.filename}</strong> · {fmt(asset.bytes || 0)} ·
        {new Date(asset.date).toLocaleString('no')}
        {#if llm} · {llm.briefNote}{/if}
      </div>

      <!-- Swipe hints (mobile only) -->
      <div class="swipe-hint left">← cull</div>
      <div class="swipe-hint right">keep →</div>
    {/if}
  </div>
</div>

<style>
  .swipe-hint {
    position: absolute; top: 50%; transform: translateY(-50%);
    font-size: 11px; color: rgba(255,255,255,.15); pointer-events: none;
    display: none;
  }
  .swipe-hint.left { left: 8px; }
  .swipe-hint.right { right: 8px; }

  @media (max-width: 768px) {
    .swipe-hint { display: block; }
  }

  :global(.ptag.none) {
    background: rgba(255,255,255,.15); color: #aaa; cursor: pointer;
  }
</style>
