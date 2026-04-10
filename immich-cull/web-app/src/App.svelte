<script lang="ts">
  import { onMount, tick } from 'svelte';
  import PhotoGrid from './components/PhotoGrid.svelte';
  import Preview from './components/Preview.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import {
    fetchGroups, fetchGroup, fetchBatches, fetchBatch, fetchStats,
    decideGroup, undecideGroup, rankBatch, savePhotoDecisions, fetchPhotoDecisions, fmt,
    type GroupSummary, type GroupDetail, type BatchSummary, type BatchDetail,
    type LlmImage, type Stats,
  } from './lib/api';
  import {
    deriveLlmState, mergeStates, countStates, countAtLevel,
    findNextEffectiveLevel, computeEffectiveStars, computeSgStats,
    type AssetState,
  } from './lib/state';

  type AppMode = 'groups' | 'batches';

  let mode: AppMode = 'groups';
  let showPreview = false;
  let selectedIdx = 0;
  let helpOpen = false;
  let sidebarOpen = false;
  let loading = false;
  let keepLevel = 0; // 0 = LLM default, +N = keep N more per subgroup, -N = keep N fewer
  const models = [
    { id: 'gemini-2.5-flash-lite', label: '2.5-lite' },
    { id: 'gemini-3.1-flash-lite-preview', label: '3.1-lite' },
    { id: 'gemini-3-flash-preview', label: '3-flash' },
    { id: 'gemma4:e4b', label: 'gemma4' },
  ];

  let groups: GroupSummary[] = [];
  let groupIdx = -1;
  let groupDetail: GroupDetail | null = null;

  let batches: BatchSummary[] = [];
  let batchIdx = -1;
  let batchDetail: BatchDetail | null = null;

  // Layer 2: manual overrides (only explicit user clicks)
  let manualOverrides: Record<string, AssetState> = {};
  // Groups mode still uses a flat states map (no LLM layer)
  let groupStates: Record<string, AssetState> = {};
  let userStars: Record<string, number> = {};
  let stats: Stats | null = null;
  let undoStack: Array<{ mode: AppMode; idx: number; viewId: string; prevStates: Record<string, AssetState>; prevUserStars: Record<string, number>; prevSi: number; prevKeepLevel: number }> = [];

  $: currentAssets = mode === 'groups' ? (groupDetail?.assets ?? []) : (batchDetail?.assets ?? []);
  $: currentAssetIds = currentAssets.map(a => a.id);
  $: llmMap = buildLlmMap(batchDetail);
  $: allSubgroups = batchDetail?.llm?.similaritySubgroups ?? [];

  // Layer 1: LLM-derived state (pure reactive derivation)
  $: llmState = deriveLlmState(batchDetail?.llm ?? null, keepLevel);

  // Layer 3: effective state = manual overrides ?? llm state
  $: states = mode === 'groups'
    ? groupStates
    : mergeStates(currentAssetIds, llmState, manualOverrides);

  // Effective stars from pure function
  $: effectiveStarsMap = computeEffectiveStars(batchDetail?.llm ?? null, states, llmMap);

  // Selected asset info for InfoPanel
  $: selectedAsset = currentAssets[selectedIdx] ?? null;
  $: selectedLlm = selectedAsset ? llmMap[selectedAsset.id] ?? null : null;
  $: selectedSubgroup = selectedLlm?.similaritySubgroupId
    ? allSubgroups.find(sg => sg.subgroupId === selectedLlm!.similaritySubgroupId) ?? null
    : null;
  $: selectedCurrentState = selectedAsset ? (states[selectedAsset.id] ?? null) : null;
  $: selectedLlmPerImage = selectedAsset && selectedLlm ? (selectedLlm.llmKeepCull ?? null) : null;
  $: selectedUserStars = selectedAsset ? (userStars[selectedAsset.id] ?? selectedAsset.rating ?? 0) : 0;
  $: selectedEffectiveStars = selectedAsset ? (effectiveStarsMap[selectedAsset.id] ?? 0) : 0;
  $: selectedSgRank = (() => {
    if (!selectedAsset || !selectedSubgroup) return null;
    const idx = selectedSubgroup.imageIds.indexOf(selectedAsset.id);
    if (idx < 0) return null;
    const total = selectedSubgroup.imageIds.length;
    const cutoff = Math.max(1, Math.min(total, selectedSubgroup.recommendedKeepCount + keepLevel));
    return { rank: idx + 1, total, cutoff, keptAtDefault: selectedSubgroup.recommendedKeepCount };
  })();

  // Keep level stats (reactive, from pure functions)
  $: sgStats = (() => {
    const sg = computeSgStats(batchDetail?.llm ?? null, keepLevel);
    const c = countStates(currentAssetIds, states);
    return { ...sg, totalKept: c.kept, totalCulled: c.culled };
  })();

  function setStars(stars: number) {
    if (!selectedAsset) return;
    userStars[selectedAsset.id] = stars;
    userStars = userStars;
    savePhotoDecisions([{ assetId: selectedAsset.id, state: states[selectedAsset.id] ?? null, userStars: stars }]);
  }

  // Find next +/- levels that actually change the split (pure functions)
  $: levelLimits = (() => {
    const llm = batchDetail?.llm ?? null;
    const nextDown = findNextEffectiveLevel(llm, keepLevel, -1);
    const nextUp = findNextEffectiveLevel(llm, keepLevel, 1);
    return {
      canDecrease: nextDown !== null, nextDown: nextDown ?? keepLevel,
      canIncrease: nextUp !== null, nextUp: nextUp ?? keepLevel,
    };
  })();

  function buildLlmMap(bd: BatchDetail | null): Record<string, LlmImage> {
    const m: Record<string, LlmImage> = {};
    if (bd?.llm?.images) for (const img of bd.llm.images) m[img.imageId] = img;
    return m;
  }

  $: sidebarItems = mode === 'groups'
    ? groups.map((g, i) => ({
        idx: i, active: i === groupIdx, decided: g.decided,
        label: `${g.count} photos`,
        sub: `${g.timeSpanMinutes}min · ${fmt(g.totalBytes)}`,
        date: new Date(g.earliestDate),
      }))
    : batches.map((b, i) => ({
        idx: i, active: i === batchIdx, decided: b.viewStatus === 'reviewed' || b.viewStatus === 'skipped',
        label: `${b.count} photos${b.hasLlmResult ? ' ✓' : ''}`,
        sub: `${b.source} ${b.folderName || ''}`,
        date: new Date(b.dateRange.start),
      }));

  onMount(async () => {
    groups = await fetchGroups();
    stats = await fetchStats();
    const hash = location.hash.slice(1);
    if (hash.startsWith('batch/')) {
      mode = 'batches';
      batches = await fetchBatches();
      const id = hash.slice(6);
      const idx = batches.findIndex(b => b.id === id);
      if (idx >= 0) await selectBatch(idx);
    } else if (hash.startsWith('group/')) {
      const idx = parseInt(hash.slice(6));
      if (!isNaN(idx) && idx < groups.length) await selectGroup(idx);
    } else if (groups.length) {
      await selectGroup(0);
    }
  });

  async function loadSavedStars(assets: { id: string }[]) {
    const ids = assets.map(a => a.id);
    const saved = await fetchPhotoDecisions(ids);
    for (const [id, d] of Object.entries(saved)) {
      if (d.userStars != null) userStars[id] = d.userStars;
    }
    userStars = userStars;
    return saved;
  }

  async function selectGroup(idx: number) {
    groupIdx = idx; selectedIdx = 0; showPreview = false;
    loading = true;
    groupDetail = await fetchGroup(groups[idx].id);
    loading = false;
    // Groups mode: load saved states into groupStates (no LLM layer)
    const saved = await loadSavedStars(groupDetail?.assets ?? []);
    groupStates = {};
    for (const [id, d] of Object.entries(saved)) {
      if (d.state) groupStates[id] = d.state as AssetState;
    }
    for (const a of groupDetail?.assets ?? []) if (!(a.id in groupStates)) groupStates[a.id] = null;
    groups[idx].decided = (groupDetail as any)?.viewStatus != null;
    groups = groups;
    history.replaceState(null, '', `#group/${idx}`);
  }

  async function selectBatch(idx: number, opts: { freshLlm?: boolean; model?: string } = {}) {
    batchIdx = idx; selectedIdx = 0; showPreview = false; keepLevel = 0;
    if (!opts.model && !opts.freshLlm) activeView = 'manual';
    loading = true;
    batchDetail = await fetchBatch(batches[idx].id, opts.model);
    loading = false;

    // Clear manual overrides for the new batch
    manualOverrides = {};

    if (!opts.freshLlm) {
      // Load saved manual overrides from DB
      const saved = await loadSavedStars(batchDetail?.assets ?? []);
      for (const [id, d] of Object.entries(saved)) {
        if (d.state) manualOverrides[id] = d.state as AssetState;
      }
      manualOverrides = manualOverrides;
    }
    // freshLlm: just show LLM state, do NOT save to DB
    // Only "Approve & Next" saves decisions to DB

    history.replaceState(null, '', `#batch/${batches[idx].id}`);
  }

  /** Which view is active: 'manual' or a model ID */
  let activeView = 'manual';

  /** Switch to a model's cached result, or run it if not cached */
  let runningModel = '';
  async function switchOrRunModel(modelId: string) {
    if (!batches[batchIdx] || runningModel) return;
    const cachedModels = batchDetail?.llmModels ?? [];
    if (cachedModels.includes(modelId)) {
      // Switch to cached result (freshLlm to avoid stale DB overrides)
      await selectBatch(batchIdx, { freshLlm: true, model: modelId });
      activeView = modelId;
    } else {
      // Need to run it
      runningModel = modelId;
      try {
        const result = await rankBatch(batches[batchIdx].id, modelId);
        if (result.error) { alert('LLM error: ' + result.error); return; }
        batches[batchIdx].hasLlmResult = true; batches = batches;
        await selectBatch(batchIdx, { freshLlm: true, model: modelId });
        activeView = modelId;
      } finally {
        runningModel = '';
      }
    }
  }

  /** Switch back to user's saved decisions */
  async function showManual() {
    if (!batches[batchIdx]) return;
    activeView = 'manual';
    await selectBatch(batchIdx);
  }

  /** Cycle to the next model (Shift+R), including manual */
  function cycleModel() {
    const allViews = ['manual', ...models.map(m => m.id)];
    const currentIdx = allViews.indexOf(activeView);
    const nextIdx = (currentIdx + 1) % allViews.length;
    const next = allViews[nextIdx];
    if (next === 'manual') showManual();
    else switchOrRunModel(next);
  }

  function switchMode(m: AppMode) {
    mode = m; showPreview = false; selectedIdx = 0;
    if (m === 'batches' && !batches.length) fetchBatches().then(b => { batches = b; if (b.length) selectBatch(0); });
  }

  function onGridSelect(idx: number) {
    if (selectedIdx === idx) showPreview = true;
    else { selectedIdx = idx; showPreview = false; }
  }

  /** Set state for a photo — writes to the correct layer based on mode */
  function setPhotoState(id: string, state: AssetState) {
    if (mode === 'groups') {
      groupStates[id] = state;
      groupStates = groupStates;
    } else {
      manualOverrides[id] = state;
      manualOverrides = manualOverrides;
    }
    savePhotoDecisions([{ assetId: id, state, userStars: userStars[id] ?? null }]);
  }

  function mark(s: 'keep' | 'cull') {
    if (selectedIdx < 0) selectedIdx = 0;
    const a = currentAssets[selectedIdx]; if (!a) return;
    const newState = states[a.id] === s ? null : s;
    setPhotoState(a.id, newState);
    if (selectedIdx < currentAssets.length - 1) selectedIdx++;
  }

  function keepBestCullRest() {
    if (selectedIdx < 0) selectedIdx = 0;
    for (let i = 0; i < currentAssets.length; i++) {
      const s: AssetState = i === selectedIdx ? 'keep' : 'cull';
      if (mode === 'groups') groupStates[currentAssets[i].id] = s;
      else manualOverrides[currentAssets[i].id] = s;
    }
    if (mode === 'groups') groupStates = groupStates; else manualOverrides = manualOverrides;
    saveBatchDecisions();
  }

  function keepFirstN(n: number) {
    for (let i = 0; i < currentAssets.length; i++) {
      const s: AssetState = i < n ? 'keep' : 'cull';
      if (mode === 'groups') groupStates[currentAssets[i].id] = s;
      else manualOverrides[currentAssets[i].id] = s;
    }
    if (mode === 'groups') groupStates = groupStates; else manualOverrides = manualOverrides;
    saveBatchDecisions();
  }

  async function approve() {
    const assets = currentAssets;
    if (!assets.length) return;

    // Snapshot for undo
    const prevStates: Record<string, AssetState> = {};
    for (const a of assets) prevStates[a.id] = states[a.id];

    const undoIdx = mode === 'groups' ? groupIdx : batchIdx;
    const viewId = mode === 'groups' ? groups[groupIdx]?.id : batches[batchIdx]?.id;
    const prevUserStars: Record<string, number> = {};
    for (const a of assets) if (userStars[a.id] != null) prevUserStars[a.id] = userStars[a.id];
    undoStack = [...undoStack, { mode, idx: undoIdx, viewId: viewId ?? '', prevStates, prevUserStars, prevSi: selectedIdx, prevKeepLevel: keepLevel }];

    // Default unmarked photos to 'keep' via manual overrides
    for (const a of assets) {
      if (!states[a.id]) {
        if (mode === 'groups') groupStates[a.id] = 'keep';
        else manualOverrides[a.id] = 'keep';
      }
    }
    if (mode === 'groups') groupStates = groupStates; else manualOverrides = manualOverrides;

    // Save all photo decisions (re-read states after reactive update)
    await saveBatchDecisions();

    if (mode === 'groups' && groupDetail) {
      await decideGroup(groupDetail.id,
        assets.filter(a => states[a.id] === 'keep').map(a => a.id),
        assets.filter(a => states[a.id] === 'cull').map(a => a.id));
      groups[groupIdx].decided = true; groups = groups;
      stats = await fetchStats();
      nextUndecided();
    } else if (mode === 'batches' && batches[batchIdx]) {
      await fetch(`/api/view-status/${batches[batchIdx].id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewType: 'batch', status: 'reviewed' }),
      });
      (batches[batchIdx] as any).viewStatus = 'reviewed';
      batches = batches;
      stats = await fetchStats();
      nextUndecidedBatch();
    }
  }

  async function skip() {
    if (mode === 'groups' && groupDetail) {
      const prevStates: Record<string, AssetState> = {};
      for (const a of groupDetail.assets) prevStates[a.id] = states[a.id];
      const prevUserStars: Record<string, number> = {};
      for (const a of groupDetail.assets) if (userStars[a.id] != null) prevUserStars[a.id] = userStars[a.id];
      undoStack = [...undoStack, { mode: 'groups', idx: groupIdx, viewId: groupDetail.id, prevStates, prevUserStars, prevSi: selectedIdx, prevKeepLevel: keepLevel }];
      await decideGroup(groupDetail.id, [], [], true);
      groups[groupIdx].decided = true; groups = groups;
      stats = await fetchStats();
      nextUndecided();
    } else if (mode === 'batches' && batches[batchIdx]) {
      await fetch(`/api/view-status/${batches[batchIdx].id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewType: 'batch', status: 'skipped' }),
      });
      nextUndecidedBatch();
    }
  }

  async function undo() {
    if (!undoStack.length) return;
    const u = undoStack[undoStack.length - 1];
    undoStack = undoStack.slice(0, -1);
    // Restore local states and stars — clear all then reapply snapshot
    if (u.mode === 'groups') {
      for (const id of Object.keys(u.prevStates)) groupStates[id] = u.prevStates[id];
      groupStates = groupStates;
    } else {
      manualOverrides = { ...u.prevStates };
    }
    // Clear stars for all assets in the undone view, then restore from snapshot
    for (const id of Object.keys(u.prevStates)) delete userStars[id];
    for (const [id, s] of Object.entries(u.prevUserStars)) userStars[id] = s;
    userStars = userStars;
    // Restore on server
    const decisions = Object.entries(u.prevStates).map(([id, s]) => ({
      assetId: id, state: s, userStars: u.prevUserStars[id] ?? null
    }));
    await savePhotoDecisions(decisions);

    if (u.mode === 'groups') {
      await undecideGroup(u.viewId);
      groups[u.idx].decided = false; groups = groups;
      if (mode !== 'groups') switchMode('groups');
      await selectGroup(u.idx);
    } else {
      // Clear batch view status
      await fetch(`/api/view-status/${batches[u.idx]?.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewType: 'batch', status: null }),
      });
      if (batches[u.idx]) (batches[u.idx] as any).viewStatus = null;
      batches = batches;
      if (mode !== 'batches') switchMode('batches');
      await selectBatch(u.idx);
    }
    selectedIdx = u.prevSi;
    keepLevel = u.prevKeepLevel;
    stats = await fetchStats();
  }

  function nextUndecided() {
    for (let i = groupIdx + 1; i < groups.length; i++) if (!groups[i].decided) { selectGroup(i); return; }
    for (let i = 0; i < groupIdx; i++) if (!groups[i].decided) { selectGroup(i); return; }
  }

  const isBatchDecided = (b: any) => b.viewStatus === 'reviewed' || b.viewStatus === 'skipped';

  function nextUndecidedBatch() {
    for (let i = batchIdx + 1; i < batches.length; i++) if (!isBatchDecided(batches[i])) { selectBatch(i); return; }
    for (let i = 0; i < batchIdx; i++) if (!isBatchDecided(batches[i])) { selectBatch(i); return; }
  }

  function applyKeepLevel(level: number) {
    keepLevel = level;
    // Clear manual overrides — user is resetting to a computed level
    manualOverrides = {};
    // llmState + effectiveState recompute reactively from keepLevel
    saveBatchDecisions();
  }

  async function saveBatchDecisions() {
    if (!batchDetail) return;
    await tick(); // ensure $: reactive derivations (states) have run
    const decisions = batchDetail.assets.map(a => ({
      assetId: a.id, state: states[a.id] ?? 'keep', userStars: userStars[a.id] ?? null
    }));
    await savePhotoDecisions(decisions);
  }

  /** Re-run the currently viewed model (force fresh, invalidate cache) */
  async function rerunCurrentModel() {
    if (!batches[batchIdx] || runningModel || activeView === 'manual') return;
    const modelId = activeView;
    runningModel = modelId;
    try {
      await fetch(`/api/batches/${batches[batchIdx].id}/rank?model=${encodeURIComponent(modelId)}`, { method: 'DELETE' });
      const result = await rankBatch(batches[batchIdx].id, modelId);
      if (result.error) { alert('LLM error: ' + result.error); return; }
      batches[batchIdx].hasLlmResult = true; batches = batches;
      await selectBatch(batchIdx, { freshLlm: true, model: modelId });
      activeView = modelId;
    } finally {
      runningModel = '';
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (helpOpen) { if (e.key === 'Escape' || e.key === '?') helpOpen = false; return; }
    if (!currentAssets.length) return;
    const shift = e.shiftKey;
    switch (e.key) {
      case 'ArrowRight': case 'd': e.preventDefault(); if (selectedIdx < currentAssets.length - 1) selectedIdx++; break;
      case 'ArrowLeft': case 'g': e.preventDefault(); if (selectedIdx > 0) selectedIdx--; break;
      case 'ArrowDown': e.preventDefault();
        if (mode === 'groups' && groupIdx < groups.length - 1) selectGroup(groupIdx + 1);
        else if (mode === 'batches' && batchIdx < batches.length - 1) selectBatch(batchIdx + 1);
        break;
      case 'ArrowUp': e.preventDefault();
        if (mode === 'groups' && groupIdx > 0) selectGroup(groupIdx - 1);
        else if (mode === 'batches' && batchIdx > 0) selectBatch(batchIdx - 1);
        break;
      case 'Escape': showPreview = false; break;
      case ' ': e.preventDefault(); if (selectedIdx >= 0) showPreview = !showPreview; break;
      case 'k': case 'j': mark('keep'); break;
      case 'K': case 'J':
        for (const a of currentAssets) { if (mode === 'groups') groupStates[a.id] = 'keep'; else manualOverrides[a.id] = 'keep'; }
        if (mode === 'groups') groupStates = groupStates; else manualOverrides = manualOverrides;
        saveBatchDecisions();
        break;
      case 'x': case 'f': mark('cull'); break;
      case 'X': case 'F':
        for (const a of currentAssets) { if (mode === 'groups') groupStates[a.id] = 'cull'; else manualOverrides[a.id] = 'cull'; }
        if (mode === 'groups') groupStates = groupStates; else manualOverrides = manualOverrides;
        saveBatchDecisions();
        break;
      case 'b': case 'B': keepBestCullRest(); break;
      case 'a': case 'Enter': e.preventDefault(); approve(); break;
      case 's': if (!shift) skip(); break;
      case 'Backspace': e.preventDefault(); undo(); break;
      case '?': helpOpen = !helpOpen; break;
      case 'r': if (mode === 'batches' && !runningModel) rerunCurrentModel(); break;
      case 'R': if (mode === 'batches') cycleModel(); break;
      case '-': case '_': if (mode === 'batches' && levelLimits.canDecrease) applyKeepLevel(levelLimits.nextDown); break;
      case '=': case '+': if (mode === 'batches' && levelLimits.canIncrease) applyKeepLevel(levelLimits.nextUp); break;
      case '1': setStars(1); break; case '2': setStars(2); break; case '3': setStars(3); break;
      case '4': setStars(4); break; case '5': setStars(5); break; case '0': setStars(0); break;
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="app">
  <header class="header">
    <button class="hamburger" on:click={() => sidebarOpen = !sidebarOpen}>☰</button>
    <h1>immich-cull</h1>
    <div class="mode-toggle">
      <button class:active={mode === 'groups'} on:click={() => switchMode('groups')}>Groups</button>
      <button class:active={mode === 'batches'} on:click={() => switchMode('batches')}>LLM Batches</button>
    </div>
    <div class="stats">
      {#if stats}
        <span><strong>{stats.decided}</strong>/{stats.totalGroups}</span>
        <span class="good"><strong>{stats.photosToKeep}</strong> keep</span>
        <span class="bad"><strong>{stats.photosToCull}</strong> cull</span>
        <span class="good">save {fmt(stats.cullBytes)}</span>
        <span><strong>{stats.remaining}</strong> left</span>
      {/if}
    </div>
  </header>

  {#if sidebarOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="sidebar-backdrop" role="button" tabindex="-1" on:click={() => sidebarOpen = false}></div>
  {/if}
  <aside class="sidebar" class:open={sidebarOpen}>
    <div class="sidebar-list">
      {#each sidebarItems as item}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="gi" class:active={item.active} class:decided={item.decided}
             on:click={() => { sidebarOpen = false; mode === 'groups' ? selectGroup(item.idx) : selectBatch(item.idx); }} role="button" tabindex="-1">
          <div class="t">{item.label} · {item.date.toLocaleDateString('no', { day: 'numeric', month: 'short', year: '2-digit' })}</div>
          <div class="m">{item.sub}</div>
        </div>
      {/each}
    </div>
    <InfoPanel
      asset={selectedAsset}
      llm={selectedLlm}
      subgroup={selectedSubgroup}
      currentState={selectedCurrentState}
      llmPerImage={selectedLlmPerImage}
      sgRank={selectedSgRank}
      effectiveStars={selectedEffectiveStars}
      {keepLevel}
      userStars={selectedUserStars}
      onSetStars={setStars}
    />
  </aside>

  <div class="main">
    {#if loading}
      <div class="empty"><span class="spinner"></span> Loading...</div>
    {:else if currentAssets.length}
      <PhotoGrid assets={currentAssets} {states} {selectedIdx} {llmMap} {effectiveStarsMap} onSelect={onGridSelect}
        onToggleState={(i) => {
          const asset = currentAssets[i];
          if (!asset) return;
          const effective = states[asset.id] ?? null;
          setPhotoState(asset.id, effective === 'keep' ? 'cull' : 'keep');
        }} />
    {:else}
      <div class="empty">Select a group or batch</div>
    {/if}
  </div>

  <footer class="bar">
    <button class="bk" on:click={() => mark('keep')}>Keep</button>
    <button class="bc" on:click={() => mark('cull')}>Cull</button>
    <button class="bb" on:click={keepBestCullRest}>Best + Cull Rest</button>
    <button class="ba" on:click={approve}>Approve & Next</button>
    <button class="bs" on:click={skip}>Skip</button>
    {#if mode === 'batches' && batchDetail}
      {#if !batchDetail.llm && !runningModel}
        <button class="run-btn" on:click={() => switchOrRunModel(models[0].id)}>LLM: {models[0].label}</button>
      {:else}
        {#if batchDetail.llm}
          <div class="keep-level">
            <button class="kl-btn" disabled={!levelLimits.canDecrease} on:click={() => applyKeepLevel(levelLimits.nextDown)}>−</button>
            <span class="kl-label" title="Keep {sgStats.totalKept}, cull {sgStats.totalCulled}">
              {sgStats.totalKept}✓ {sgStats.totalCulled}✗
              <span class="kl-mode" class:kl-aggressive={sgStats.isAggressive}>
                {#if keepLevel > 1}keep more
                {:else if keepLevel === 1}generous
                {:else if keepLevel === 0}default
                {:else if !sgStats.isAggressive}trim
                {:else}cull more
                {/if}
              </span>
            </span>
            <button class="kl-btn" disabled={!levelLimits.canIncrease} on:click={() => applyKeepLevel(levelLimits.nextUp)}>+</button>
          </div>
        {/if}
        <div class="model-run">
          <button class="model-btn" class:current={activeView === 'manual'} class:cached={isBatchDecided(batches[batchIdx]) && activeView !== 'manual'}
            disabled={!!runningModel}
            on:click={showManual} title="Your saved decisions">
            manual
          </button>
          {#each models as m}
            {@const hasCached = (batchDetail.llmModels ?? []).includes(m.id)}
            {@const isRunning = runningModel === m.id}
            <button class="model-btn" class:current={activeView === m.id} class:cached={hasCached && activeView !== m.id}
              disabled={!!runningModel}
              on:click={() => switchOrRunModel(m.id)} title="{m.id}{hasCached ? ' (cached)' : ''}">
              {#if isRunning}<span class="spinner"></span>{:else}{m.label}{/if}
            </button>
          {/each}
        </div>
      {/if}
    {/if}
    <span class="spacer"></span>
    <span class="bmeta">{currentAssets.length} photos</span>
    <button class="bh" on:click={() => helpOpen = true}>?</button>
  </footer>
</div>

{#if showPreview && selectedIdx >= 0 && currentAssets.length}
  <Preview assets={currentAssets} {selectedIdx} {states} {llmMap}
    onSelect={(i) => selectedIdx = i}
    onClose={() => showPreview = false}
    onMark={(s) => mark(s)}
    onCycleState={() => {
      if (!selectedAsset) return;
      const cur = states[selectedAsset.id];
      let next: AssetState;
      if (!cur) next = 'keep';
      else if (cur === 'keep') next = 'cull';
      else next = null;
      setPhotoState(selectedAsset.id, next);
    }} />
{/if}

{#if helpOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
  <div class="help-bg" on:click={() => helpOpen = false} role="dialog">
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <div class="help-box" on:click|stopPropagation role="document">
      <h2>Keyboard Shortcuts</h2>
      <h3>Navigation</h3>
      <table><tbody>
        <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>Previous / next image</td></tr>
        <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Previous / next group/batch</td></tr>
        <tr><td><kbd>Space</kbd></td><td>Toggle preview</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Close preview</td></tr>
      </tbody></table>
      <h3>Actions</h3>
      <table><tbody>
        <tr><td><kbd>K</kbd></td><td>Keep image</td></tr>
        <tr><td><kbd>X</kbd></td><td>Cull image</td></tr>
        <tr><td><kbd>B</kbd></td><td>Keep selected, cull rest</td></tr>
        <tr><td><kbd>A</kbd> / <kbd>Enter</kbd></td><td>Approve & next</td></tr>
        <tr><td><kbd>S</kbd></td><td>Skip</td></tr>
      </tbody></table>
      <h3>LLM (Batch mode)</h3>
      <table><tbody>
        <tr><td><kbd>r</kbd></td><td>Re-run current model (force fresh)</td></tr>
        <tr><td><kbd>Shift+R</kbd></td><td>Cycle models (manual → 2.5 → 3.1 → ...)</td></tr>
        <tr><td><kbd>−</kbd> <kbd>+</kbd></td><td>Adjust keep level</td></tr>
        <tr><td><kbd>0</kbd>–<kbd>5</kbd></td><td>Set star rating</td></tr>
      </tbody></table>
      <h3>Bulk</h3>
      <table><tbody>
        <tr><td><kbd>Shift+K</kbd></td><td>Keep all</td></tr>
        <tr><td><kbd>Shift+X</kbd></td><td>Cull all</td></tr>
        <tr><td><kbd>Backspace</kbd></td><td>Undo</td></tr>
      </tbody></table>
      <p class="note">Undecided → <strong>keep</strong> on approve.</p>
    </div>
  </div>
{/if}

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(html, body) { height: 100%; overflow: hidden; }
  :global(body) { font: 13px/1.4 system-ui, sans-serif; color: #e0e4ea; background: #0e1014; }

  .app { display: grid; grid-template-columns: 200px minmax(0, 1fr); grid-template-rows: 34px minmax(0, 1fr) 40px; height: 100dvh; }
  .header { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid #2a2e36; background: #111319; }
  .header h1 { font-size: 14px; font-weight: 600; color: #f0a040; }
  .mode-toggle { display: flex; gap: 2px; }
  .mode-toggle button { padding: 2px 10px; border: 1px solid #2a2e36; border-radius: 4px; background: transparent; color: #7a8294; font-size: 12px; cursor: pointer; }
  .mode-toggle button.active { background: #f0a040; color: #1a1a1a; font-weight: 600; }
  .stats { margin-left: auto; font-size: 12px; color: #7a8294; display: flex; gap: 12px; }
  .stats strong { color: #e0e4ea; } .stats .good { color: #4caf50; } .stats .bad { color: #e53935; }

  .sidebar { grid-row: 2 / 4; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid #2a2e36; background: #12141a; font-size: 12px; }
  .sidebar-list { flex: 1; overflow-y: auto; min-height: 0; }
  .gi { padding: 5px 8px; cursor: pointer; border-bottom: 1px solid #1e2028; border-left: 3px solid transparent; }
  .gi:hover { background: #1c1f27; } .gi.active { background: #1f2330; border-left-color: #f0a040; } .gi.decided { opacity: .35; }
  .gi .t { font-weight: 500; } .gi .m { color: #666; font-size: 11px; }

  .main { min-width: 0; min-height: 0; overflow: hidden; position: relative; }
  .empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #666; }

  .bar { grid-column: 2; display: flex; gap: 10px; padding: 0 14px; border-top: 1px solid #2a2e36; background: rgba(17,19,25,.95); align-items: center; }
  .bar button { padding: 5px 14px; border: none; border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 500; }
  .bar button:hover { opacity: .85; }
  .bk { background: #4caf50; color: white; } .bc { background: #e53935; color: white; }
  .bb { background: #2196F3; color: white; } .ba { background: #f0a040; color: #1a1a1a; font-weight: 700; }
  .bs { background: #333; color: #aaa; } .bh { background: none; color: #7a8294; border: 1px solid #2a2e36 !important; padding: 3px 9px; font-size: 12px; }
  .run-btn { background: #7c4dff; color: white; }
  .spacer { flex: 1; } .bmeta { font-size: 11px; color: #7a8294; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3); border-top-color: white; border-radius: 50%; animation: spin .6s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .run-btn:disabled { opacity: .6; cursor: wait; }
  .model-run { display: flex; gap: 2px; }
  .model-btn { background: #2a2e36; border: none; color: #888; font-size: 10px; padding: 3px 8px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
  .model-btn:hover { background: #3a3e46; color: #ccc; }
  .model-btn.cached { background: #3a3520; color: #c9b458; }
  .model-btn.current { background: #2a4a2a; color: #8c8; }
  .keep-level { display: flex; align-items: center; gap: 2px; background: #1e2028; border-radius: 5px; padding: 2px; }
  .kl-btn { background: #333; border: none; color: #ddd; width: 26px; height: 26px; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .kl-btn:hover { background: #444; }
  .kl-btn:disabled { opacity: 0.3; cursor: default; }
  .kl-label { font-size: 12px; color: #ddd; padding: 0 6px; min-width: 50px; text-align: center; white-space: nowrap; font-weight: 600; }
  .kl-mode { font-size: 9px; color: #7a8294; font-weight: 400; display: block; margin-top: -2px; }
  .kl-mode.kl-aggressive { color: #e53935; }

  :global(.jgrid) { position: relative; width: 100%; height: 100%; overflow: hidden; }
  :global(.cell) { position: absolute; overflow: hidden; cursor: pointer; border: 3px solid transparent; transition: border-color .12s, opacity .12s; }
  :global(.cell:hover) { border-color: #555; }
  :global(.cell.keep) { border-color: #4caf50; }
  :global(.cell.cull) { border-color: rgba(229,57,53,.4); outline: none !important; }
  :global(.cell.cull > img) { opacity: .4; }
  :global(.cell.sel) { border-color: #f0a040 !important; box-shadow: 0 0 8px rgba(240,160,64,.5); }
  :global(.cell img) { width: 100%; height: 100%; object-fit: contain; display: block; background: #0b0d11; }
  :global(.lbl) { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,.8)); padding: 10px 5px 3px; font-size: 9px; color: #bbb; display: flex; justify-content: space-between; }
  :global(.bdg) { position: absolute; top: 3px; left: 3px; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; color: white; cursor: pointer; }
  :global(.bdg.kb) { background: #4caf50; } :global(.bdg.cb) { background: #e53935; }
  :global(.st) { position: absolute; top: 3px; right: 3px; font-size: 11px; color: #ffd700; text-shadow: 0 1px 2px #000; }
  :global(.llm-star) { position: absolute; top: 3px; left: 3px; font-size: 11px; color: #ffd700; text-shadow: 0 1px 2px #000; background: rgba(0,0,0,.6); padding: 1px 4px; border-radius: 3px; }
  :global(.llm-note) { position: absolute; bottom: 14px; left: 0; right: 0; text-align: center; font-size: 9px; color: #ddd; text-shadow: 0 1px 2px #000; }

  :global(.preview-ov) { position: fixed; top: 34px; left: 200px; right: 0; bottom: 40px; background: #090b0f; z-index: 50; display: flex; flex-direction: column; }
  :global(.pv-strip) { display: flex; gap: 3px; padding: 3px; overflow-x: auto; background: #111319; border-bottom: 1px solid #2a2e36; flex-shrink: 0; align-items: center; height: 76px; }
  :global(.pvt) { flex-shrink: 0; cursor: pointer; border: 2px solid transparent; border-radius: 3px; overflow: hidden; height: 66px; }
  :global(.pvt.active) { border-color: #f0a040 !important; }
  :global(.pvt.keep) { border-color: #4caf50; }
  :global(.pvt.cull) { border-color: rgba(229,57,53,.4); }
  :global(.pvt.cull img) { opacity: .4; }
  :global(.pvt img) { height: 100%; width: auto; display: block; }
  :global(.pv-main) { flex: 1; min-height: 0; position: relative; overflow: hidden; }
  :global(.pv-main img) { width: 100%; height: 100%; object-fit: contain; display: block; }
  :global(.pv-main .pinfo) { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,.8); padding: 4px 14px; border-radius: 5px; font-size: 12px; white-space: nowrap; }
  :global(.pinfo-keep) { background: rgba(76,175,80,.7) !important; }
  :global(.pinfo-cull) { background: rgba(229,57,53,.7) !important; }
  :global(.ptag) { position: absolute; top: 8px; left: 8px; font-size: 13px; font-weight: 700; padding: 2px 10px; border-radius: 4px; }
  :global(.ptag.keep) { background: #4caf50; color: white; } :global(.ptag.cull) { background: #e53935; color: white; }

  .help-bg { position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 200; display: flex; align-items: center; justify-content: center; }
  .help-box { background: #1a1d24; border: 1px solid #2a2e36; border-radius: 10px; padding: 20px 24px; width: min(420px, 90vw); }
  .help-box h2 { font-size: 16px; margin-bottom: 16px; color: #f0a040; }
  .help-box h3 { font-size: 11px; color: #7a8294; margin: 14px 0 4px; text-transform: uppercase; letter-spacing: .5px; }
  .help-box table { width: 100%; border-collapse: collapse; }
  .help-box td { padding: 3px 0; font-size: 13px; } .help-box td:first-child { width: 110px; white-space: nowrap; }
  :global(kbd) { display: inline-block; min-width: 20px; text-align: center; padding: 1px 6px; border: 1px solid #444; border-radius: 4px; background: #252830; color: #ddd; font: 11px/1.5 monospace; }
  .note { margin-top: 16px; font-size: 11px; color: #666; line-height: 1.6; }

  /* Hamburger — hidden on desktop */
  .hamburger { display: none; background: none; border: none; color: #7a8294; font-size: 20px; cursor: pointer; padding: 0 4px; }
  .sidebar-backdrop { display: none; }

  /* Mobile: sidebar as drawer overlay */
  @media (max-width: 768px) {
    .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: 34px minmax(0, 1fr) auto; }
    .hamburger { display: block; }
    .sidebar {
      position: fixed; top: 34px; left: -280px; bottom: 0; width: 280px;
      z-index: 100; transition: left .2s ease;
    }
    .sidebar.open { left: 0; }
    .sidebar-backdrop { display: block; position: fixed; inset: 0; top: 34px; background: rgba(0,0,0,.5); z-index: 99; }
    .bar { grid-column: 1; gap: 4px; padding: 4px 6px; flex-wrap: wrap; height: auto; min-height: 40px; }
    .bar button { padding: 4px 8px; font-size: 11px; }
    .keep-level { order: 10; } /* push ± to second row via wrap */
    .run-btn { order: 11; }
    .kl-btn { width: 32px; height: 32px; } /* bigger touch targets */
    .header { padding: 0 8px; gap: 6px; }
    .header h1 { font-size: 12px; }
    .stats { gap: 6px; font-size: 10px; }
    :global(.preview-ov) { left: 0 !important; }
    :global(.pv-strip) { height: 60px; }
    :global(.pvt) { height: 50px; }
    :global(.lbl) { display: none; }
    :global(.bdg) { display: none; }
    :global(.cell.sel .bdg) { display: block; font-size: 9px; } /* show on selected */
    :global(.llm-note) { display: none; }
    :global(.llm-star) { display: none; }
    :global(.cell.sel .llm-star) { display: block; } /* show stars on selected */
  }
</style>
