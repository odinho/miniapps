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
  $: state = asset ? (states[asset.id] ?? (keepSet.has(asset.id) ? 'keep' : cullSet.has(asset.id) ? 'cull' : null)) : null;
  $: llm = asset ? llmMap[asset.id] : null;
  $: subgroup = llm?.similaritySubgroupId
    ? subgroups.find(sg => sg.subgroupId === llm!.similaritySubgroupId)
    : null;

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
      {@const s = states[a.id] ?? (keepSet.has(a.id) ? 'keep' : cullSet.has(a.id) ? 'cull' : null)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="pvt"
        class:active={i === selectedIdx}
        class:keep={s === 'keep'}
        class:cull={s === 'cull'}
        on:click={() => onSelect(i)}
        role="button"
        tabindex="-1"
      >
        <img src={previewUrl(a.id)} loading="lazy" alt={a.filename} />
      </div>
    {/each}
  </div>

  <!-- Main image + info panel -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <div class="pv-body">
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

        {#if state}
          <div class="ptag {state}">{state.toUpperCase()}</div>
        {/if}
      {/if}
    </div>

    <!-- Info panel on the right -->
    {#if asset}
      <div class="pv-info-panel">
        <div class="pv-filename">{asset.filename}</div>
        <div class="pv-meta">
          {fmt(asset.bytes || 0)} · {new Date(asset.date).toLocaleString('no')}
        </div>

        {#if asset.rating && asset.rating > 0}
          <div class="pv-rating">Existing: {'★'.repeat(asset.rating)}{'☆'.repeat(5 - asset.rating)}</div>
        {/if}

        {#if llm}
          <div class="pv-section-header">LLM Assessment</div>
          <div class="pv-llm-stars">
            {'★'.repeat(llm.suggestedStars)}{'☆'.repeat(3 - llm.suggestedStars)}
            <span class="pv-star-label">
              {#if llm.suggestedStars === 0}unremarkable
              {:else if llm.suggestedStars === 1}good
              {:else if llm.suggestedStars === 2}share-worthy
              {:else}highlight{/if}
            </span>
          </div>
          <div class="pv-llm-note">{llm.briefNote}</div>
          {#if llm.categories?.length}
            <div class="pv-llm-cats">{llm.categories.join(', ')}</div>
          {/if}
        {/if}

        {#if subgroup}
          <div class="pv-section-header">Similarity Group</div>
          <div class="pv-sg-type">{subgroup.subgroupType} · {subgroup.imageIds.length} photos</div>
          <div class="pv-sg-rationale">{subgroup.rationale}</div>
          <div class="pv-sg-verdict">
            Keep {subgroup.recommendedKeepCount} / {subgroup.imageIds.length}
          </div>
        {/if}

        {#if state}
          <div class="pv-state {state}">{state.toUpperCase()}</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .pv-body { flex: 1; min-height: 0; display: flex; }
  .pv-main { flex: 1; min-height: 0; position: relative; overflow: hidden; cursor: pointer; }

  .pv-info-panel {
    width: 220px; flex-shrink: 0; padding: 12px;
    background: #12141a; border-left: 1px solid #2a2e36;
    overflow-y: auto; font-size: 12px;
  }
  .pv-filename { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
  .pv-meta { color: #7a8294; margin-bottom: 8px; }
  .pv-rating { color: #ffd700; margin-bottom: 8px; }
  .pv-section-header {
    font-size: 10px; text-transform: uppercase; letter-spacing: .5px;
    color: #7a8294; margin: 12px 0 4px; padding-top: 8px;
    border-top: 1px solid #2a2e36;
  }
  .pv-llm-stars { font-size: 16px; color: #ffd700; }
  .pv-star-label { font-size: 11px; color: #7a8294; margin-left: 4px; }
  .pv-llm-note { color: #ccc; margin: 4px 0; font-style: italic; }
  .pv-llm-cats { color: #7a8294; font-size: 11px; }
  .pv-sg-type { color: #f0a040; font-size: 11px; }
  .pv-sg-rationale { color: #aaa; margin: 4px 0; line-height: 1.4; }
  .pv-sg-verdict { color: #ccc; font-weight: 500; }
  .pv-state { margin-top: 12px; font-weight: 700; font-size: 14px; padding: 4px 8px; border-radius: 4px; text-align: center; }
  .pv-state.keep { background: rgba(76,175,80,.2); color: #4caf50; }
  .pv-state.cull { background: rgba(229,57,53,.2); color: #e53935; }
</style>
