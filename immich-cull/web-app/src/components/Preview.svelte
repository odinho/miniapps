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

  $: asset = assets[selectedIdx];
  $: manualState = asset ? states[asset.id] : null;
  $: llmState = asset ? (keepSet.has(asset.id) ? 'keep' : cullSet.has(asset.id) ? 'cull' : null) : null;
  $: displayState = manualState ?? llmState;
  $: llm = asset ? llmMap[asset.id] : null;

  let imgEl: HTMLImageElement;

  $: if (asset) {
    const url = fullUrl(asset.id);
    const expectedId = asset.id;
    const pre = new Image();
    pre.onload = () => {
      if (imgEl && imgEl.dataset.assetId === expectedId) imgEl.src = url;
    };
    pre.src = url;
  }
</script>

<div class="preview-ov">
  <!-- Filmstrip -->
  <div class="pv-strip">
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

  <!-- Main image only — info is in the sidebar -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div class="pv-main" on:click={onClose}>
    {#if asset}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
      <img
        bind:this={imgEl}
        data-asset-id={asset.id}
        src={previewUrl(asset.id)}
        alt={asset.filename}
        on:click|stopPropagation
      />

      {#if displayState}
        <div class="ptag {displayState}">{displayState.toUpperCase()}</div>
      {/if}

      <div class="pinfo" class:pinfo-keep={displayState === 'keep'} class:pinfo-cull={displayState === 'cull'}>
        <strong>{asset.filename}</strong> · {fmt(asset.bytes || 0)} ·
        {new Date(asset.date).toLocaleString('no')}
        {#if llm} · {llm.briefNote}{/if}
      </div>
    {/if}
  </div>
</div>
