<script lang="ts">
  import { previewUrl } from '../lib/api';

  export let summary: Record<number, { count: number; samples: Array<{ id: string; filename: string }> }> = {};
  export let totalKept: number = 0;

  $: starLevels = Object.keys(summary)
    .map(Number)
    .filter(s => s > 0)
    .toSorted((a, b) => b - a);
</script>

<div class="sr">
  <div class="sr-header">
    <h2>Star Ratings (LLM-derived, mapped to Immich scale)</h2>
    <p class="sr-total">{totalKept} kept photos total</p>
  </div>

  {#each starLevels as star}
    {@const level = summary[star]}
    <div class="sr-level">
      <div class="sr-level-header">
        <span class="sr-stars">{'★'.repeat(star)}</span>
        <span class="sr-count">{level.count} photos ({(level.count / totalKept * 100).toFixed(1)}%)</span>
      </div>
      <div class="sr-grid">
        {#each level.samples as sample (sample.id)}
          <div class="sr-thumb">
            <img src={previewUrl(sample.id)} alt={sample.filename} loading="lazy" />
            <div class="sr-fname">{sample.filename}</div>
          </div>
        {/each}
        {#if level.count > level.samples.length}
          <div class="sr-more">+{level.count - level.samples.length} more</div>
        {/if}
      </div>
    </div>
  {/each}

  {#if summary[0]}
    <div class="sr-level sr-zero">
      <div class="sr-level-header">
        <span class="sr-stars">No stars</span>
        <span class="sr-count">{summary[0].count} photos ({(summary[0].count / totalKept * 100).toFixed(1)}%)</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .sr { padding: 16px; overflow-y: auto; height: 100%; }
  .sr-header { margin-bottom: 16px; }
  .sr-header h2 { font-size: 16px; color: #f0a040; margin-bottom: 4px; }
  .sr-total { font-size: 12px; color: #7a8294; }

  .sr-level { margin-bottom: 20px; }
  .sr-level-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; padding: 6px 0; border-bottom: 1px solid #2a2e36; }
  .sr-stars { font-size: 18px; color: #ffd700; }
  .sr-count { font-size: 13px; color: #7a8294; }

  .sr-grid { display: flex; gap: 6px; flex-wrap: wrap; }
  .sr-thumb { width: 120px; height: 90px; position: relative; border-radius: 4px; overflow: hidden; border: 2px solid #2a2e36; }
  .sr-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .sr-fname { position: absolute; bottom: 0; left: 0; right: 0; font-size: 8px; color: #ccc; background: rgba(0,0,0,0.7); padding: 2px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sr-more { width: 120px; height: 90px; display: flex; align-items: center; justify-content: center; background: #1a1d24; border-radius: 4px; color: #666; font-size: 12px; }

  .sr-zero { opacity: 0.5; }
</style>
