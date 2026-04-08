<script lang="ts">
  import { fmt } from '../lib/api';
  import type { AssetDetail, LlmImage, LlmSubgroup } from '../lib/api';
  import type { AssetState } from '../lib/stores';

  export let asset: AssetDetail | null = null;
  export let llm: LlmImage | null = null;
  export let subgroup: LlmSubgroup | null = null;
  export let currentState: AssetState = null;
  export let llmPerImage: 'keep' | 'cull' | null = null;
  export let sgRank: { rank: number; total: number; cutoff: number; keptAtDefault: number } | null = null;
  export let effectiveStars: number = 0;
  export let keepLevel: number = 0;
  export let userStars: number = 0;
  export let onSetStars: (stars: number) => void = () => {};
</script>

{#if asset}
  <div class="info-panel">
    <div class="ip-header">Selected Photo</div>
    <div class="ip-filename">{asset.filename}</div>
    <div class="ip-meta">{fmt(asset.bytes || 0)} · {new Date(asset.date).toLocaleString('no')}</div>

    <!-- Current state badge -->
    {#if currentState}
      <div class="ip-state" class:keep={currentState === 'keep'} class:cull={currentState === 'cull'}>
        {currentState.toUpperCase()}
      </div>
    {/if}

    <!-- User star rating -->
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

    {#if llm}
      <div class="ip-section">LLM Assessment</div>
      {#if effectiveStars > 0}
        <div class="ip-eff-stars">{'★'.repeat(effectiveStars)} effective</div>
      {/if}
      <div class="ip-stars">
        {'★'.repeat(llm.suggestedStars)}{'☆'.repeat(Math.max(0, 5 - llm.suggestedStars))}
        <span class="ip-star-label">
          {#if llm.suggestedStars === 0}extra/filler
          {:else if llm.suggestedStars === 1}good
          {:else if llm.suggestedStars === 2}strong
          {:else if llm.suggestedStars === 3}excellent
          {:else if llm.suggestedStars === 4}exceptional
          {:else}gallery-worthy{/if}
          {#if subgroup && effectiveStars !== llm.suggestedStars}
            <span class="ip-raw-note">(raw — {effectiveStars > 0 ? 'primary keeper' : 'not primary'})</span>
          {/if}
        </span>
      </div>
      <div class="ip-note">{llm.briefNote}</div>
      {#if llm.categories?.length}
        <div class="ip-cats">{llm.categories.join(', ')}</div>
      {/if}
      {#if llmPerImage}
        <div class="ip-llm-rec" class:keep={llmPerImage === 'keep'} class:cull={llmPerImage === 'cull'}>
          LLM says {llmPerImage}
        </div>
      {/if}
    {/if}

    {#if subgroup}
      <div class="ip-section">Similarity Group</div>
      <div class="ip-sg-type">{subgroup.subgroupType} · {subgroup.imageIds.length} photos</div>
      {#if subgroup.rationale}
        <div class="ip-sg-reason">{subgroup.rationale}</div>
      {/if}
      {#if sgRank}
        <div class="ip-sg-rank">
          <span class="ip-rank-pos">#{sgRank.rank}</span> of {sgRank.total}
          {#if sgRank.rank <= sgRank.cutoff}
            <span class="ip-rank-kept">· kept</span>
          {:else}
            <span class="ip-rank-culled">· culled</span>
          {/if}
        </div>
        <div class="ip-sg-cutoff">
          Keeping top {sgRank.cutoff}{#if keepLevel !== 0}
            <span class="ip-sg-adj">({keepLevel > 0 ? '+' : ''}{keepLevel} from default {sgRank.keptAtDefault})</span>
          {/if}
        </div>
      {/if}
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
  .ip-state { font-weight: 600; font-size: 12px; padding: 2px 8px; border-radius: 3px; display: inline-block; margin-bottom: 6px; }
  .ip-state.keep { background: rgba(76,175,80,.2); color: #4caf50; }
  .ip-state.cull { background: rgba(229,57,53,.2); color: #e53935; }
  .ip-section { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: #7a8294; margin: 8px 0 3px; padding-top: 6px; border-top: 1px solid #1e2028; }
  .ip-stars { font-size: 14px; color: #ffd700; }
  .ip-star-label { font-size: 10px; color: #7a8294; margin-left: 2px; }
  .ip-note { color: #ccc; margin: 2px 0; font-style: italic; }
  .ip-cats { color: #7a8294; font-size: 10px; }
  .ip-eff-stars { font-size: 16px; color: #ffd700; margin-bottom: 2px; }
  .ip-raw-note { color: #555; font-size: 9px; }
  .ip-llm-rec { font-size: 10px; margin-top: 3px; color: #7a8294; }
  .ip-llm-rec.keep { color: #81c784; }
  .ip-llm-rec.cull { color: #ef9a9a; }
  .ip-sg-type { color: #f0a040; }
  .ip-sg-reason { color: #aaa; margin: 2px 0; line-height: 1.3; }
  .ip-sg-rank { color: #ddd; font-weight: 500; margin-top: 3px; }
  .ip-rank-pos { font-weight: 700; color: #fff; }
  .ip-rank-kept { color: #4caf50; }
  .ip-rank-culled { color: #e53935; }
  .ip-sg-cutoff { color: #7a8294; font-size: 10px; margin-top: 2px; }
  .ip-sg-adj { color: #f0a040; }
</style>
