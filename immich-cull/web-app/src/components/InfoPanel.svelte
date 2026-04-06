<script lang="ts">
  import { fmt } from '../lib/api';
  import type { AssetDetail, LlmImage, LlmSubgroup } from '../lib/api';
  import type { AssetState } from '../lib/stores';

  export let asset: AssetDetail | null = null;
  export let llm: LlmImage | null = null;
  export let subgroup: LlmSubgroup | null = null;
  export let manualState: AssetState = null;
  export let llmState: string | null = null;
  export let userStars: number = 0;
  export let onSetStars: (stars: number) => void = () => {};
</script>

{#if asset}
  <div class="info-panel">
    <div class="ip-header">Selected Photo</div>
    <div class="ip-filename">{asset.filename}</div>
    <div class="ip-meta">{fmt(asset.bytes || 0)} · {new Date(asset.date).toLocaleString('no')}</div>

    <div class="ip-stars-row">
      {#each [1,2,3,4,5] as s}
        <button
          class="ip-star-btn"
          class:active={userStars >= s}
          on:click={() => onSetStars(userStars === s ? 0 : s)}
          title="{s} stars"
        >★</button>
      {/each}
      {#if userStars > 0}
        <span class="ip-stars-label">{userStars}★</span>
      {/if}
    </div>

    {#if manualState}
      <div class="ip-state" class:keep={manualState === 'keep'} class:cull={manualState === 'cull'}>
        You: {manualState.toUpperCase()}
      </div>
    {/if}

    {#if llm}
      <div class="ip-section">LLM Assessment</div>
      <div class="ip-stars">
        {'★'.repeat(llm.suggestedStars)}{'☆'.repeat(3 - llm.suggestedStars)}
        <span class="ip-star-label">
          {#if llm.suggestedStars === 0}unremarkable
          {:else if llm.suggestedStars === 1}good
          {:else if llm.suggestedStars === 2}share-worthy
          {:else}highlight{/if}
        </span>
      </div>
      <div class="ip-note">{llm.briefNote}</div>
      {#if llm.categories?.length}
        <div class="ip-cats">{llm.categories.join(', ')}</div>
      {/if}
      {#if llmState}
        <div class="ip-llm-verdict" class:keep={llmState === 'keep'} class:cull={llmState === 'cull'}>
          LLM: {llmState.toUpperCase()}
        </div>
      {/if}
    {/if}

    {#if subgroup}
      <div class="ip-section">Similarity Group</div>
      <div class="ip-sg-type">{subgroup.subgroupType} · {subgroup.imageIds.length} photos</div>
      <div class="ip-sg-reason">{subgroup.rationale}</div>
      <div class="ip-sg-keep">Keep {subgroup.recommendedKeepCount} / {subgroup.imageIds.length}</div>
    {/if}
  </div>
{/if}

<style>
  .info-panel { padding: 10px 8px; font-size: 11px; background: #0e1014; }
  .ip-header { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #555; padding: 4px 8px; margin: 0 -8px 8px; background: #181a20; border-bottom: 1px solid #2a2e36; border-top: 1px solid #2a2e36; }
  .ip-filename { font-weight: 600; font-size: 12px; margin-bottom: 2px; word-break: break-all; }
  .ip-meta { color: #7a8294; margin-bottom: 6px; }
  .ip-stars-row { display: flex; align-items: center; gap: 1px; margin-bottom: 6px; }
  .ip-star-btn { background: none; border: none; color: #444; font-size: 18px; cursor: pointer; padding: 0 1px; line-height: 1; }
  .ip-star-btn:hover { color: #ffd700; }
  .ip-star-btn.active { color: #ffd700; }
  .ip-stars-label { font-size: 10px; color: #7a8294; margin-left: 4px; }
  .ip-state { font-weight: 600; font-size: 12px; padding: 2px 6px; border-radius: 3px; display: inline-block; margin-bottom: 4px; }
  .ip-state.keep { background: rgba(76,175,80,.15); color: #4caf50; }
  .ip-state.cull { background: rgba(229,57,53,.15); color: #e53935; }
  .ip-section { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: #7a8294; margin: 8px 0 3px; padding-top: 6px; border-top: 1px solid #1e2028; }
  .ip-stars { font-size: 14px; color: #ffd700; }
  .ip-star-label { font-size: 10px; color: #7a8294; margin-left: 2px; }
  .ip-note { color: #ccc; margin: 2px 0; font-style: italic; }
  .ip-cats { color: #7a8294; font-size: 10px; }
  .ip-llm-verdict { font-weight: 500; font-size: 11px; margin-top: 4px; }
  .ip-llm-verdict.keep { color: #4caf50; }
  .ip-llm-verdict.cull { color: #e53935; }
  .ip-sg-type { color: #f0a040; }
  .ip-sg-reason { color: #aaa; margin: 2px 0; line-height: 1.3; }
  .ip-sg-keep { color: #ccc; font-weight: 500; }
</style>
