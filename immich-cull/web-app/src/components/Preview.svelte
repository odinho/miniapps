<script lang="ts">
  import { previewUrl, fullUrl, fmt } from '../lib/api';
  import type { AssetDetail, LlmImage } from '../lib/api';
  import type { AssetState } from '../lib/stores';

  export let assets: AssetDetail[] = [];
  export let selectedIdx: number = 0;
  export let states: Record<string, AssetState> = {};
  export let llmMap: Record<string, LlmImage> = {};
  export let keepSet: Set<string> = new Set();
  export let cullSet: Set<string> = new Set();
  export let onSelect: (idx: number) => void = () => {};
  export let onClose: () => void = () => {};

  $: asset = assets[selectedIdx];
  $: state = asset ? (states[asset.id] ?? (keepSet.has(asset.id) ? 'keep' : cullSet.has(asset.id) ? 'cull' : null)) : null;
  $: llm = asset ? llmMap[asset.id] : null;

  // Progressive loading: show preview immediately, swap to full when loaded
  let imgEl: HTMLImageElement;
  let currentFullUrl = '';

  $: if (asset) {
    currentFullUrl = fullUrl(asset.id);
    // Preload full-res
    const pre = new Image();
    const expectedId = asset.id;
    pre.onload = () => {
      if (imgEl && imgEl.dataset.assetId === expectedId) {
        imgEl.src = currentFullUrl;
      }
    };
    pre.src = currentFullUrl;
  }

  // Filmstrip thumb height based on available width
  $: stripH = 70;
</script>

<div class="preview-ov">
  <!-- Filmstrip -->
  <div class="pv-strip" style="height:{stripH + 6}px">
    {#each assets as a, i}
      {@const s = states[a.id] ?? (keepSet.has(a.id) ? 'keep' : cullSet.has(a.id) ? 'cull' : null)}
      <div
        class="pvt {i === selectedIdx ? 'active' : ''} {s || ''}"
        style="height:{stripH}px"
        on:click={() => onSelect(i)}
        role="button"
        tabindex="-1"
      >
        <img src={previewUrl(a.id)} loading="lazy" alt={a.filename} />
      </div>
    {/each}
  </div>

  <!-- Main image -->
  <div class="pv-main" on:click={onClose} role="button" tabindex="-1">
    {#if asset}
      <img
        bind:this={imgEl}
        data-asset-id={asset.id}
        src={previewUrl(asset.id)}
        alt={asset.filename}
        on:click|stopPropagation
      />

      {#if state}
        <div class="ptag {state}">{state.toUpperCase()}</div>
      {/if}

      <div class="pinfo {state ? 'pinfo-' + state : ''}">
        <strong>{asset.filename}</strong> &middot; {fmt(asset.bytes || 0)} &middot;
        {new Date(asset.date).toLocaleString('no')}
        {#if asset.rating && asset.rating > 0} &middot; {'★'.repeat(asset.rating)}{/if}
        {#if llm} &middot; {llm.briefNote}{/if}
      </div>
    {/if}
  </div>
</div>
