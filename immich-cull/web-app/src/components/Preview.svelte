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

  // Swipe with visual drag
  let touchStartX = 0;
  let touchStartY = 0;
  let dragX = 0;
  let dragging = false;
  let swiping = false;
  let swipeResult: 'keep' | 'cull' | null = null;

  function onTouchStart(e: TouchEvent) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    dragX = 0;
    dragging = false;
    swiping = false;
    swipeResult = null;
  }

  function onTouchMove(e: TouchEvent) {
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    // Only drag horizontally if more horizontal than vertical
    if (Math.abs(dx) > 15 && Math.abs(dx) > Math.abs(dy)) {
      dragging = true;
      dragX = dx;
      e.preventDefault(); // prevent scroll while dragging
    }
  }

  let animatingOut = false;

  function onTouchEnd(e: TouchEvent) {
    if (dragging && Math.abs(dragX) > 80) {
      swiping = true;
      const result: 'keep' | 'cull' = dragX > 0 ? 'keep' : 'cull';
      // Fly off screen
      animatingOut = true;
      dragX = dragX > 0 ? window.innerWidth : -window.innerWidth;
      setTimeout(() => {
        // Apply the action
        onMark(result);
        // Reset instantly (no transition) so next image appears clean
        animatingOut = false;
        dragX = 0;
        dragging = false;
        swipeResult = null;
        // Force a tick so the reset happens without transition
        requestAnimationFrame(() => { dragX = 0; });
      }, 250);
    } else {
      dragX = 0;
      dragging = false;
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
    on:touchmove={onTouchMove}
    on:touchend={onTouchEnd}
  >
    {#if asset}
      <div class="pv-drag-wrapper" style="transform:translateX({dragX}px) rotate({dragX * 0.03}deg);{animatingOut ? 'transition:transform .25s ease-in' : dragging ? '' : dragX === 0 ? '' : 'transition:transform .15s ease-out'}">
        <img
          bind:this={imgEl}
          data-asset-id={asset.id}
          src={previewUrl(asset.id)}
          alt={asset.filename}
        />
        {#if dragging && Math.abs(dragX) > 30}
          <div class="swipe-overlay" class:keep-overlay={dragX > 0} class:cull-overlay={dragX < 0}>
            {dragX > 0 ? 'KEEP' : 'CULL'}
          </div>
        {/if}
      </div>

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

  .pv-drag-wrapper {
    width: 100%; height: 100%; position: relative;
  }
  .pv-drag-wrapper img {
    width: 100%; height: 100%; object-fit: contain; display: block;
  }

  .swipe-overlay {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 48px; font-weight: 900; letter-spacing: 4px;
    pointer-events: none; border-radius: 12px;
  }
  .keep-overlay { background: rgba(76,175,80,.25); color: #4caf50; border: 4px solid #4caf50; }
  .cull-overlay { background: rgba(229,57,53,.25); color: #e53935; border: 4px solid #e53935; }
</style>
