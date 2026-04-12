<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fetchReviewGroups, savePhotoDecisions } from '../lib/api';
  import type { ReviewGroup, ReviewPhoto, AssetDetail, LlmImage, BatchSummary } from '../lib/api';
  import type { AssetState } from '../lib/stores';
  import PhotoGrid from './PhotoGrid.svelte';
  import Preview from './Preview.svelte';

  export const batches: BatchSummary[] = [];
  export const onRefresh: () => void = () => {};

  let allGroups: ReviewGroup[] = []; // includes approved ones for go-back
  let approvedSet = new Set<number>(); // indices of approved groups
  let currentIdx = 0;
  let loading = false;
  let totalGroups = 0;
  let tierCounts = { high: 0, standard: 0, review: 0 };
  let showHelp = false;
  let previewIdx = -1;

  $: pendingGroups = allGroups.filter((_, i) => !approvedSet.has(i));
  $: current = allGroups[currentIdx] ?? null;
  $: isApproved = approvedSet.has(currentIdx);
  $: progress = allGroups.length > 0 ? `${currentIdx + 1} / ${allGroups.length}` : '';
  $: pendingCount = allGroups.length - approvedSet.size;
  $: isSingletonBatch = current?.subgroupType === 'singleton-batch';

  // Convert ReviewPhoto[] to the shapes PhotoGrid and Preview expect
  $: gridAssets = current?.photos.map(toAssetDetail) ?? [];
  $: gridStates = buildStates(current);
  $: gridLlmMap = buildLlmMap(current);
  $: gridStarsMap = buildStarsMap(current);

  function toAssetDetail(p: ReviewPhoto): AssetDetail {
    return {
      id: p.id, filename: p.filename, date: p.date,
      rating: null, isFavorite: false, path: '',
      bytes: p.bytes, w: p.w || 4, h: p.h || 3,
    };
  }

  function buildStates(g: ReviewGroup | null): Record<string, AssetState> {
    if (!g) return {};
    const s: Record<string, AssetState> = {};
    for (const p of g.photos) s[p.id] = p.llmAction;
    return s;
  }

  function buildLlmMap(g: ReviewGroup | null): Record<string, LlmImage> {
    if (!g) return {};
    const m: Record<string, LlmImage> = {};
    for (const p of g.photos) {
      m[p.id] = {
        imageId: p.id, suggestedStars: p.stars, categories: [p.category],
        briefNote: p.note, llmKeepCull: p.llmAction, similaritySubgroupId: null,
      };
    }
    return m;
  }

  function buildStarsMap(g: ReviewGroup | null): Record<string, number> {
    if (!g) return {};
    const m: Record<string, number> = {};
    for (const p of g.photos) m[p.id] = p.stars;
    return m;
  }

  async function loadAll() {
    loading = true;
    const data = await fetchReviewGroups();
    allGroups = data.groups;
    totalGroups = data.total;
    tierCounts = data.tierCounts;
    approvedSet = new Set();
    currentIdx = 0;
    previewIdx = -1;
    loading = false;
  }

  function next() {
    if (currentIdx < allGroups.length - 1) { currentIdx++; previewIdx = -1; }
  }
  function prev() {
    if (currentIdx > 0) { currentIdx--; previewIdx = -1; }
  }
  function nextPending() {
    // Jump to next unapproved group
    for (let i = currentIdx + 1; i < allGroups.length; i++) {
      if (!approvedSet.has(i)) { currentIdx = i; previewIdx = -1; return; }
    }
  }

  function togglePhoto(idx: number) {
    if (!current || isApproved) return;
    const photo = current.photos[idx];
    photo.llmAction = photo.llmAction === 'keep' ? 'cull' : 'keep';
    allGroups = allGroups;
  }

  async function approveGroup() {
    if (!current || isApproved) return;
    const decisions = current.photos.map(p => ({
      assetId: p.id, state: p.llmAction, userStars: null,
    }));
    await savePhotoDecisions(decisions);
    approvedSet.add(currentIdx);
    approvedSet = approvedSet; // trigger reactivity
    nextPending();
  }

  async function keepAll() {
    if (!current || isApproved) return;
    for (const p of current.photos) p.llmAction = 'keep';
    allGroups = allGroups;
    await approveGroup();
  }

  async function cullAll() {
    if (!current || isApproved) return;
    for (const p of current.photos) p.llmAction = 'cull';
    allGroups = allGroups;
    await approveGroup();
  }

  function handleKey(e: KeyboardEvent) {
    if (showHelp) { if (e.key === 'Escape' || e.key === '?') showHelp = false; return; }
    if (previewIdx >= 0) {
      if (e.key === 'Escape' || e.key === ' ') { previewIdx = -1; e.preventDefault(); }
      else if ((e.key === 'ArrowRight' || e.key === 'l') && previewIdx < gridAssets.length - 1) previewIdx++;
      else if ((e.key === 'ArrowLeft' || e.key === 'h') && previewIdx > 0) previewIdx--;
      else if (e.key === 'k') { togglePreviewState('keep'); }
      else if (e.key === 'x' || e.key === 'f') { togglePreviewState('cull'); }
      return;
    }
    if (loading || !current) return;
    switch (e.key) {
      case 'a': case 'Enter': e.preventDefault(); approveGroup(); break;
      case 'c': case 'x': cullAll(); break;
      case 'k': keepAll(); break;
      case 'ArrowRight': case 'l': next(); break;
      case 'ArrowLeft': case 'h': prev(); break;
      case 'Backspace': e.preventDefault(); prev(); break;
      case '?': showHelp = true; break;
    }
  }

  function togglePreviewState(state: 'keep' | 'cull') {
    if (!current || previewIdx < 0 || isApproved) return;
    const photo = current.photos[previewIdx];
    photo.llmAction = photo.llmAction === state ? (state === 'keep' ? 'cull' : 'keep') : state;
    allGroups = allGroups;
  }

  function tierLabel(tier: string) {
    if (tier === 'high') return 'HIGH CONFIDENCE';
    if (tier === 'standard') return 'STANDARD';
    return 'REVIEW';
  }

  onMount(() => { window.addEventListener('keydown', handleKey); loadAll(); });
  onDestroy(() => { window.removeEventListener('keydown', handleKey); });
</script>

<div class="acr">
  <div class="acr-header">
    <h2>Auto-Cull Review</h2>
    <div class="acr-stats">
      {#if tierCounts.high > 0}<span class="acr-stat tier-high">{tierCounts.high} high confidence</span>{/if}
      {#if tierCounts.standard > 0}<span class="acr-stat tier-std">{tierCounts.standard} standard</span>{/if}
      <span class="acr-stat tier-rev">{tierCounts.review} review</span>
      <span class="acr-stat dim">{pendingCount} pending</span>
    </div>
    <div class="acr-actions">
      <button class="acr-btn" on:click={loadAll} disabled={loading}>Reload</button>
      <button class="acr-btn acr-help-btn" on:click={() => showHelp = !showHelp} title="Keyboard shortcuts (?)">?</button>
    </div>
  </div>

  {#if loading}
    <div class="acr-loading"><span class="spinner"></span> Loading...</div>
  {:else if !current}
    <div class="acr-empty">No groups to review. Run LLM on batches first.</div>
  {:else}
    <div class="acr-nav">
      <button on:click={prev} disabled={currentIdx === 0}>&larr;</button>
      <span class="acr-progress">{progress}</span>
      <button on:click={next} disabled={currentIdx >= allGroups.length - 1}>&rarr;</button>
    </div>

    <div class="acr-reason" class:singleton-reason={isSingletonBatch} class:approved-reason={isApproved}>
      <span class="acr-tier" class:tier-high={current.tier === 'high'} class:tier-std={current.tier === 'standard'} class:tier-rev={current.tier === 'review'}>
        {tierLabel(current.tier)}
      </span>
      {#if isApproved}<span class="acr-approved-badge">APPROVED</span>{/if}
      <span class="acr-sg-type">{current.subgroupType.replace('_', ' ')}</span>
      <span class="acr-sg-reason">{current.rationale}</span>
      <span class="acr-sg-meta">
        {current.photos.length} photos &middot;
        keep {current.photos.filter(p => p.llmAction === 'keep').length},
        cull {current.photos.filter(p => p.llmAction === 'cull').length}
      </span>
    </div>

    <div class="acr-grid" class:singleton-grid={isSingletonBatch} class:approved-grid={isApproved}>
      <PhotoGrid
        assets={gridAssets}
        states={gridStates}
        selectedIdx={-1}
        llmMap={gridLlmMap}
        effectiveStarsMap={gridStarsMap}
        autoCullMap={{}}
        onSelect={(i) => { previewIdx = i; }}
        onToggleState={togglePhoto}
      />
    </div>

    {#if isApproved}
      <div class="acr-decide acr-approved-bar">
        <span class="approved-text">Approved</span>
        <button class="acr-btn" on:click={prev}>&larr; Back</button>
        <button class="acr-btn" on:click={next}>Next &rarr;</button>
      </div>
    {:else}
      <div class="acr-decide">
        <button class="acr-btn acr-approve-btn" on:click={approveGroup}>Approve <kbd>A</kbd></button>
        <button class="acr-btn acr-keepall-btn" on:click={keepAll}>Keep All <kbd>K</kbd></button>
        {#if !isSingletonBatch}
          <button class="acr-btn acr-cullall-btn" on:click={cullAll}>Cull All <kbd>C</kbd></button>
        {/if}
      </div>
    {/if}

    {#if previewIdx >= 0}
      <Preview
        assets={gridAssets}
        selectedIdx={previewIdx}
        states={gridStates}
        llmMap={gridLlmMap}
        onSelect={(i) => { previewIdx = i; }}
        onClose={() => { previewIdx = -1; }}
        onMark={(state) => { togglePreviewState(state); }}
        onCycleState={() => { togglePhoto(previewIdx); }}
      />
    {/if}
  {/if}

  {#if showHelp}
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="help-overlay" on:click={() => showHelp = false} role="presentation">
      <div class="help-modal" on:click|stopPropagation on:keydown|stopPropagation role="dialog" aria-label="Keyboard shortcuts" tabindex="-1">
        <h3>Keyboard Shortcuts</h3>
        <div class="help-grid">
          <kbd>A</kbd> <span>Approve group (save keep/cull split)</span>
          <kbd>K</kbd> <span>Keep all photos in group</span>
          <kbd>C</kbd> <span>Cull all photos in group</span>
          <kbd class="wide">&larr; &rarr;</kbd> <span>Previous / next group</span>
          <kbd class="wide">Bksp</kbd> <span>Go back to previous group</span>
          <kbd>?</kbd> <span>Toggle this help</span>
          <kbd>Click</kbd> <span>Open preview / top of photo toggles state</span>
        </div>
        <button class="help-close" on:click={() => showHelp = false}>Close</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .acr { display: flex; flex-direction: column; height: 100%; background: #0e1014; }

  .acr-header { padding: 10px 16px; border-bottom: 1px solid #2a2e36; background: #111319; }
  .acr-header h2 { font-size: 15px; color: #f0a040; margin-bottom: 6px; }
  .acr-stats { display: flex; gap: 14px; font-size: 12px; color: #7a8294; margin-bottom: 8px; }
  .acr-stats .dim { color: #555; }
  .acr-stats .tier-high { color: #ff6d00; font-weight: 600; }
  .acr-stats .tier-std { color: #ffa726; }
  .acr-stats .tier-rev { color: #1565c0; }
  .acr-actions { display: flex; gap: 8px; }
  .acr-btn { padding: 5px 14px; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 500; background: #2a2e36; color: #ccc; }
  .acr-btn:hover { background: #3a3e46; }
  .acr-btn:disabled { opacity: 0.4; cursor: wait; }
  .acr-help-btn { font-size: 14px; font-weight: 700; width: 28px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: 50%; }

  .acr-loading, .acr-empty { display: flex; align-items: center; justify-content: center; flex: 1; color: #666; gap: 8px; }

  .acr-nav { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 6px; background: #12141a; border-bottom: 1px solid #2a2e36; }
  .acr-nav button { background: #2a2e36; border: none; color: #ccc; padding: 4px 14px; border-radius: 4px; cursor: pointer; font-size: 14px; }
  .acr-nav button:hover { background: #3a3e46; }
  .acr-nav button:disabled { opacity: 0.3; }
  .acr-progress { font-size: 13px; color: #7a8294; min-width: 80px; text-align: center; }

  .acr-reason { padding: 6px 14px; background: #1a1d24; border-bottom: 1px solid #2a2e36; font-size: 12px; color: #7a8294; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .acr-reason.singleton-reason { background: #2a1418; border-bottom-color: #4a2028; }
  .acr-reason.approved-reason { background: #0a1a0a; border-bottom-color: #1a3a1a; }

  .acr-tier { padding: 2px 8px; border-radius: 3px; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .acr-tier.tier-high { background: #ff6d00; color: white; }
  .acr-tier.tier-std { background: #ffa726; color: #1a1a1a; }
  .acr-tier.tier-rev { background: #1565c0; color: white; }
  .acr-approved-badge { background: #4caf50; color: white; padding: 2px 8px; border-radius: 3px; font-weight: 700; font-size: 10px; }

  .acr-sg-type { background: #2a2e36; padding: 2px 8px; border-radius: 3px; color: #ccc; font-weight: 500; text-transform: capitalize; }
  .singleton-reason .acr-sg-type { background: #e53935; color: white; }
  .acr-sg-reason { flex: 1; min-width: 150px; }
  .acr-sg-meta { color: #555; }

  .acr-grid { flex: 1; position: relative; min-height: 0; }
  .acr-grid.singleton-grid { background: #1a0a0a; }
  .acr-grid.approved-grid { opacity: 0.6; }

  .acr-decide { display: flex; gap: 12px; padding: 10px 16px; border-top: 1px solid #2a2e36; background: #111319; justify-content: center; align-items: center; }
  .acr-approved-bar { background: #0a1a0a; border-top-color: #1a3a1a; }
  .approved-text { color: #4caf50; font-weight: 600; font-size: 14px; margin-right: 12px; }
  .acr-approve-btn { background: #4caf50; color: white; font-size: 14px; padding: 8px 24px; }
  .acr-keepall-btn { background: #1565c0; color: white; font-size: 14px; padding: 8px 24px; }
  .acr-cullall-btn { background: #e53935; color: white; font-size: 14px; padding: 8px 24px; }
  .acr-decide kbd { display: inline-block; background: rgba(255,255,255,0.15); padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: inherit; margin-left: 6px; }

  .help-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; display: flex; align-items: center; justify-content: center; }
  .help-modal { background: #1a1d24; border: 1px solid #3a3e46; border-radius: 10px; padding: 20px 28px; min-width: 300px; }
  .help-modal h3 { color: #f0a040; margin: 0 0 14px 0; font-size: 15px; }
  .help-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; align-items: center; }
  .help-grid kbd { background: #2a2e36; color: #eee; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-family: monospace; text-align: center; min-width: 24px; display: inline-block; }
  .help-grid kbd.wide { min-width: 32px; }
  .help-grid span { color: #9aa0ac; font-size: 13px; }
  .help-close { margin-top: 16px; width: 100%; padding: 6px; background: #2a2e36; border: none; border-radius: 5px; color: #ccc; cursor: pointer; font-size: 12px; }
  .help-close:hover { background: #3a3e46; }

  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3); border-top-color: white; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
