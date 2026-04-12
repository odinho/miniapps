<script lang="ts">
  import { previewUrl, fetchCullComparisons, savePhotoDecisions, stagedCull, fetchBatches } from '../lib/api';
  import type { CullComparison, BatchSummary } from '../lib/api';

  export let batches: BatchSummary[] = [];
  export let onRefresh: () => void = () => {};

  let comparisons: CullComparison[] = [];
  let currentIdx = 0;
  let loading = false;
  let loadedBatches = 0;
  let totalAutoCull = 0;
  let totalReview = 0;

  $: current = comparisons[currentIdx] ?? null;
  $: progress = comparisons.length > 0 ? `${currentIdx + 1} / ${comparisons.length}` : 'loading...';

  async function loadAll() {
    loading = true;
    comparisons = [];
    loadedBatches = 0;
    const withLlm = batches.filter(b => b.hasLlmResult);
    totalAutoCull = withLlm.reduce((s, b) => s + (b.autoCullStats?.autoCullHigh ?? 0) + (b.autoCullStats?.autoCull ?? 0), 0);
    totalReview = withLlm.reduce((s, b) => s + (b.autoCullStats?.review ?? 0), 0);

    const fetchAll = withLlm.map(async (b) => {
      const data = await fetchCullComparisons(b.id);
      loadedBatches++;
      return data.comparisons ?? [];
    });
    const allResults = await Promise.all(fetchAll);
    comparisons = allResults.flat();
    currentIdx = 0;
    loading = false;
  }

  function next() { if (currentIdx < comparisons.length - 1) currentIdx++; }
  function prev() { if (currentIdx > 0) currentIdx--; }

  async function keep(id: string) {
    await savePhotoDecisions([{ assetId: id, state: 'keep', userStars: null }]);
    next();
  }

  async function confirmCull(id: string) {
    await savePhotoDecisions([{ assetId: id, state: 'cull', userStars: null }]);
    next();
  }

  async function autoApproveAllSafe() {
    const ids = batches.filter(b => b.hasLlmResult && b.viewStatus !== 'reviewed').map(b => b.id);
    if (!ids.length) return;
    loading = true;
    await stagedCull(ids, 'safe');
    onRefresh();
    loading = false;
  }

  // Load on mount
  loadAll();
</script>

<div class="acr">
  <div class="acr-header">
    <h2>Auto-Cull Review</h2>
    <div class="acr-stats">
      <span class="acr-stat ac-high">{totalAutoCull} auto-cull candidates</span>
      <span class="acr-stat ac-review">{totalReview} for review</span>
      <span class="acr-stat">{comparisons.length} comparisons loaded</span>
    </div>
    <div class="acr-actions">
      <button class="acr-btn acr-safe" on:click={autoApproveAllSafe} disabled={loading}>
        Auto-approve safe culls
      </button>
      <button class="acr-btn" on:click={loadAll} disabled={loading}>Reload</button>
    </div>
  </div>

  {#if loading}
    <div class="acr-loading">
      <span class="spinner"></span> Loading comparisons ({loadedBatches} batches)...
    </div>
  {:else if !current}
    <div class="acr-empty">No cull comparisons to review. Run LLM on batches first.</div>
  {:else}
    <div class="acr-nav">
      <button on:click={prev} disabled={currentIdx === 0}>← Prev</button>
      <span class="acr-progress">{progress}</span>
      <button on:click={next} disabled={currentIdx >= comparisons.length - 1}>Next →</button>
    </div>

    <div class="acr-reason">
      <span class="acr-sg-type">{current.subgroupType}</span>
      <span class="acr-sg-reason">{current.subgroupReason}</span>
      <span class="acr-sg-meta">{current.subgroupSize} photos, rank {current.rank + 1}</span>
    </div>

    <div class="acr-pair">
      <div class="acr-card acr-keeper-card">
        <div class="acr-label">KEEPER</div>
        {#each current.keepers as keeper (keeper.id)}
          <img src={previewUrl(keeper.id)} alt={keeper.filename} />
          <div class="acr-info">
            <span class="acr-stars">{'★'.repeat(keeper.stars)}</span>
            <span class="acr-note">{keeper.note}</span>
          </div>
        {/each}
      </div>

      <div class="acr-card acr-cull-card">
        <div class="acr-label">WOULD CULL</div>
        <img src={previewUrl(current.cullId)} alt={current.cullFilename} />
        <div class="acr-info">
          <span class="acr-stars">{'★'.repeat(current.cullStars)}</span>
          <span class="acr-note">{current.cullNote}</span>
          <span class="acr-cat">{current.cullCategory}</span>
        </div>
      </div>
    </div>

    <div class="acr-decide">
      <button class="acr-btn acr-keep-btn" on:click={() => current && keep(current.cullId)}>Keep This Photo</button>
      <button class="acr-btn acr-cull-btn" on:click={() => current && confirmCull(current.cullId)}>Confirm Cull</button>
    </div>
  {/if}
</div>

<style>
  .acr { display: flex; flex-direction: column; height: 100%; background: #0e1014; }

  .acr-header { padding: 10px 16px; border-bottom: 1px solid #2a2e36; background: #111319; }
  .acr-header h2 { font-size: 15px; color: #f0a040; margin-bottom: 6px; }
  .acr-stats { display: flex; gap: 14px; font-size: 12px; color: #7a8294; margin-bottom: 8px; }
  .ac-high { color: #e65100; font-weight: 600; }
  .ac-review { color: #1565c0; }
  .acr-actions { display: flex; gap: 8px; }
  .acr-btn { padding: 5px 14px; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 500; background: #2a2e36; color: #ccc; }
  .acr-btn:hover { background: #3a3e46; }
  .acr-btn:disabled { opacity: 0.4; cursor: wait; }
  .acr-safe { background: #e65100; color: white; }
  .acr-safe:hover { background: #bf360c; }

  .acr-loading, .acr-empty { display: flex; align-items: center; justify-content: center; flex: 1; color: #666; gap: 8px; }

  .acr-nav { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 8px; background: #12141a; border-bottom: 1px solid #2a2e36; }
  .acr-nav button { background: #2a2e36; border: none; color: #ccc; padding: 4px 14px; border-radius: 4px; cursor: pointer; }
  .acr-nav button:hover { background: #3a3e46; }
  .acr-nav button:disabled { opacity: 0.3; }
  .acr-progress { font-size: 13px; color: #7a8294; min-width: 80px; text-align: center; }

  .acr-reason { padding: 6px 14px; background: #1a1d24; border-bottom: 1px solid #2a2e36; font-size: 12px; color: #7a8294; display: flex; gap: 10px; align-items: center; }
  .acr-sg-type { background: #2a2e36; padding: 2px 8px; border-radius: 3px; color: #ccc; font-weight: 500; }
  .acr-sg-reason { flex: 1; }
  .acr-sg-meta { color: #555; }

  .acr-pair { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; min-height: 0; }
  .acr-card { display: flex; flex-direction: column; min-height: 0; position: relative; border-radius: 6px; overflow: hidden; }
  .acr-card img { flex: 1; min-height: 0; object-fit: contain; background: #090b0f; }
  .acr-label { position: absolute; top: 8px; left: 8px; z-index: 1; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 3px; }
  .acr-keeper-card .acr-label { background: #4caf50; color: white; }
  .acr-cull-card .acr-label { background: #e65100; color: white; }
  .acr-info { padding: 6px 8px; background: rgba(0,0,0,0.8); font-size: 11px; color: #ccc; display: flex; gap: 8px; align-items: center; }
  .acr-stars { color: #ffd700; }
  .acr-note { flex: 1; }
  .acr-cat { color: #7a8294; }

  .acr-decide { display: flex; gap: 12px; padding: 12px 16px; border-top: 1px solid #2a2e36; background: #111319; justify-content: center; }
  .acr-keep-btn { background: #4caf50; color: white; font-size: 14px; padding: 8px 28px; }
  .acr-cull-btn { background: #e53935; color: white; font-size: 14px; padding: 8px 28px; }

  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3); border-top-color: white; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
