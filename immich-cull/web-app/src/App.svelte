<script lang="ts">
  import { onMount, tick } from 'svelte';
  import PhotoGrid from './components/PhotoGrid.svelte';
  import Preview from './components/Preview.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import AutoCullReview from './components/AutoCullReview.svelte';
  import StarsReview from './components/StarsReview.svelte';
  import BurstInspect from './components/BurstInspect.svelte';
  import {
    fetchBatches, fetchBatch, fetchStats,
    rankBatch, savePhotoDecisions, fetchPhotoDecisions, fmt,
    autoApproveBatches, revertAutoApprovals, fetchCullComparisons, stagedCull, approveConfidentBatches, burstAutoCull, revertBurstAutoCull,
    type BatchSummary, type BatchDetail,
    type LlmImage, type Stats, type AutoCullClassification, type CullComparison,
  } from './lib/api';
  import {
    deriveLlmState, mergeStates, countStates, countAtLevel,
    findNextEffectiveLevel, computeEffectiveStars, computeSgStats,
    type AssetState,
  } from './lib/state';

  type AppMode = 'batches' | 'review' | 'stars' | 'burst';

  let mode: AppMode = 'batches';
  let starsSummary: Record<number, { count: number; samples: Array<{ id: string; filename: string }> }> = {};
  let starsTotalKept = 0;
  let showPreview = false;
  let selectedIdx = 0;
  let helpOpen = false;
  let sidebarOpen = false;
  let sidebarLimit = 100;
  let sidebarShowDone = false;
  let loading = false;
  let keepLevel = 0; // 0 = LLM default, +N = keep N more per subgroup, -N = keep N fewer
  const models = [
    { id: 'gemini-3.1-flash-lite-preview', label: '3.1-lite' },
    { id: 'gemini-2.5-flash-lite', label: '2.5-lite' },
    { id: 'gemini-3-flash-preview', label: '3-flash' },
    { id: 'gemma4:e4b', label: 'gemma4' },
  ];

  let batches: BatchSummary[] = [];
  let batchIdx = -1;
  let batchDetail: BatchDetail | null = null;

  // Layer 2: manual overrides (only explicit user clicks)
  let manualOverrides: Record<string, AssetState> = {};
  let userStars: Record<string, number> = {};
  let stats: Stats | null = null;
  let undoStack: Array<{ mode: AppMode; idx: number; viewId: string; prevStates: Record<string, AssetState>; prevUserStars: Record<string, number>; prevSi: number; prevKeepLevel: number }> = [];

  $: allAssets = batchDetail?.assets ?? [];
  // Collapse burst-auto-culled photos: hide losers, track counts on winners
  $: collapsedCountMap = (() => {
    const m: Record<string, number> = {};
    // Put badge on the first keeper as it appears in the grid (chronological order)
    const assetOrder = new Map((batchDetail?.assets ?? []).map((a, i) => [a.id, i]));
    for (const g of batchDetail?.collapsedGroups ?? []) {
      if (g.winnerIds.length > 0) {
        const firstInGrid = g.winnerIds.toSorted((a, b) => (assetOrder.get(a) ?? 999) - (assetOrder.get(b) ?? 999))[0];
        m[firstInGrid] = (m[firstInGrid] ?? 0) + g.losers.length;
      }
    }
    return m;
  })();
  $: burstCulledIds = new Set((batchDetail?.collapsedGroups ?? []).flatMap(g => g.losers));
  let showBurstCulled = false;
  $: currentAssets = showBurstCulled ? allAssets : allAssets.filter(a => !burstCulledIds.has(a.id));
  $: currentAssetIds = currentAssets.map(a => a.id);
  $: llmMap = buildLlmMap(batchDetail);
  $: allSubgroups = batchDetail?.llm?.similaritySubgroups ?? [];

  // Layer 1: LLM-derived state (pure reactive derivation)
  $: llmState = deriveLlmState(batchDetail?.llm ?? null, keepLevel);

  // Layer 2.5: consensus overrides LLM for undecided photos in manual mode
  $: consensusOverrides = (() => {
    const m: Record<string, AssetState> = {};
    if (activeView !== 'manual') return m;
    const pa = batchDetail?.photoAgreement;
    if (!pa) return m;
    for (const p of pa) {
      if (p.consensus === 'keep' || p.consensus === 'cull') m[p.assetId] = p.consensus;
    }
    return m;
  })();

  // Layer 3: effective state = manual overrides ?? consensus ?? llm state
  $: states = mergeStates(currentAssetIds, llmState, manualOverrides, consensusOverrides);

  // Effective stars: user overrides win over LLM-computed stars
  $: effectiveStarsMap = (() => {
    const llmStars = computeEffectiveStars(batchDetail?.llm ?? null, states, llmMap);
    // User star overrides (including explicit 0) take priority
    for (const [id, s] of Object.entries(userStars)) {
      if (s != null) llmStars[id] = s;
    }
    return llmStars;
  })();

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

  // Auto-cull classification per photo
  $: autoCullMap = buildAutoCullMap(batchDetail);
  function buildAutoCullMap(bd: BatchDetail | null): Record<string, AutoCullClassification> {
    const m: Record<string, AutoCullClassification> = {};
    if (bd?.autoCull?.classifications) {
      for (const c of bd.autoCull.classifications) m[c.assetId] = c;
    }
    return m;
  }

  $: agreementMap = buildAgreementMap(batchDetail, manualOverrides);
  function buildAgreementMap(bd: BatchDetail | null, overrides: Record<string, AssetState>): Record<string, { consensus: 'keep' | 'cull' | 'disagree'; unanimous: boolean }> {
    const m: Record<string, { consensus: 'keep' | 'cull' | 'disagree'; unanimous: boolean }> = {};
    if (bd?.photoAgreement) {
      for (const p of bd.photoAgreement) {
        // Hide agreement info when user has manually overridden
        if (!overrides[p.assetId]) m[p.assetId] = { consensus: p.consensus, unanimous: p.unanimous };
      }
    }
    return m;
  }


  $: confidentUnreviewed = batches.filter(
    b => b.agreement?.tier === 'full-agreement' && b.viewStatus !== 'reviewed' && b.viewStatus !== 'skipped'
  ).length;

  async function bulkApproveConfident() {
    const preview = await approveConfidentBatches(true);
    if (!preview.batchCount) { alert('No confident batches to approve.'); return; }
    if (!confirm(`Approve ${preview.batchCount} batches where all models agree?\n\n${preview.totalKept} photos kept, ${preview.totalCulled} photos culled`)) return;
    const result = await approveConfidentBatches(false);
    if (result.ok) {
      const data = await fetchBatches();
      batches = data.batches;
      stats = await fetchStats();
    }
  }

  async function runStagedCull() {
    const allBatchIds = batches.filter(b => b.hasLlmResult && b.viewStatus !== 'reviewed').map(b => b.id);
    if (!allBatchIds.length) return;
    const result = await stagedCull(allBatchIds, 'safe');
    if (result.ok) {
      const total = result.results.reduce((s, r) => s + r.autoCulled, 0);
      const review = result.results.reduce((s, r) => s + r.forReview, 0);
      console.log(`Staged cull: ${total} auto-culled, ${review} for review`);
      await loadBatches();
      stats = await fetchStats();
      if (batchIdx >= 0) await selectBatch(batchIdx);
    }
  }

  async function revertAllAutoApprovals() {
    const result = await revertAutoApprovals();
    if (result.ok) {
      await loadBatches();
      stats = await fetchStats();
      if (batchIdx >= 0) await selectBatch(batchIdx);
    }
  }

  // --- Sidebar view model: single source of truth for what's visible ---
  interface SidebarItem {
    idx: number;
    active: boolean;
    decided: boolean;
    visible: boolean;
    label: string;
    sub: string;
    date: Date;
    hasLlm: boolean;
    keeps: number;
    culls: number;
    agreement: BatchSummary['agreement'];
  }
  let recentDoneIdxs: number[] = []; // most recently approved (by approval order)

  async function loadBatches() {
    const data = await fetchBatches();
    batches = data.batches;
    // Initialize recent done from DB (convert batch IDs to indices)
    const dbRecent = data.recentlyReviewed;
    if (dbRecent.length && !recentDoneIdxs.length) {
      recentDoneIdxs = dbRecent
        .map(id => batches.findIndex(b => b.id === id))
        .filter(i => i >= 0);
    }
  }

  $: sidebarAllItems = batches.map((b, i) => ({
    idx: i, active: i === batchIdx,
    decided: b.viewStatus === 'reviewed' || b.viewStatus === 'skipped',
    label: `${b.count} photos`,
    sub: `${b.source}${b.folderName ? ' ' + b.folderName : ''}`,
    date: new Date(b.dateRange.start),
    hasLlm: b.hasLlmResult, keeps: b.keeps, culls: b.culls,
    agreement: b.agreement,
    visible: false,
  })).map(item => ({
    ...item,
    visible: !item.decided || recentDoneIdxs.includes(item.idx) || sidebarShowDone,
  })) as SidebarItem[];

  $: sidebarVisible = sidebarAllItems.filter(i => i.visible).slice(0, sidebarLimit);
  $: sidebarDecidedCount = sidebarAllItems.filter(i => i.decided).length;
  $: sidebarHasMore = sidebarAllItems.filter(i => i.visible).length > sidebarLimit;

  async function handleHash() {
    const hash = location.hash.slice(1);
    if (hash.startsWith('batch/')) {
      const id = hash.slice(6);
      if (!batches.length) await loadBatches();
      const idx = batches.findIndex(b => b.id === id);
      if (idx >= 0 && (mode !== 'batches' || batchIdx !== idx)) {
        mode = 'batches';
        await selectBatch(idx);
      }
    } else if (hash === 'burst' && mode !== 'burst') {
      mode = 'burst';
    } else if (hash === 'review' && mode !== 'review') {
      await switchMode('review');
    } else if (hash === 'stars' && mode !== 'stars') {
      await switchMode('stars');
    }
  }

  onMount(async () => {
    stats = await fetchStats();
    window.addEventListener('popstate', handleHash);
    const hash = location.hash.slice(1);
    if (hash.startsWith('batch/')) {
      mode = 'batches';
      await loadBatches();
      const id = hash.slice(6);
      const idx = batches.findIndex(b => b.id === id);
      if (idx >= 0) await selectBatch(idx);
    } else if (hash === 'review') {
      await switchMode('review');
    } else if (hash === 'stars') {
      await switchMode('stars');
    } else if (hash === 'burst') {
      await switchMode('burst');
    } else {
      await loadBatches();
      if (batches.length) await selectBatch(0);
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
  let runningModel = ''; // which model is running
  let runningBatchIdx = -1; // which batch it's running on
  let switching = false;
  async function switchOrRunModel(modelId: string) {
    if (!batches[batchIdx] || switching) return;
    // Allow running on a different batch even if another is in-flight
    if (runningModel && runningBatchIdx === batchIdx) return;
    const savedIdx = batchIdx;
    const cachedModels = batchDetail?.llmModels ?? [];
    if (cachedModels.includes(modelId)) {
      switching = true;
      try {
        await selectBatch(savedIdx, { freshLlm: true, model: modelId });
        if (batchIdx === savedIdx) activeView = modelId;
      } finally {
        switching = false;
      }
    } else {
      runningModel = modelId;
      runningBatchIdx = savedIdx;
      try {
        const batchId = batches[savedIdx].id;
        const result = await rankBatch(batchId, modelId);
        if (result.error) { console.error('LLM error:', result.error); return; }
        batches[savedIdx].hasLlmResult = true; batches = batches;
        if (batchIdx === savedIdx) {
          await selectBatch(savedIdx, { freshLlm: true, model: modelId });
          activeView = modelId;
        }
      } finally {
        if (runningBatchIdx === savedIdx) { runningModel = ''; runningBatchIdx = -1; }
      }
    }
  }

  /** Switch back to user's saved decisions */
  async function showManual() {
    if (!batches[batchIdx] || switching) return;
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

  async function switchMode(m: AppMode) {
    mode = m; showPreview = false; selectedIdx = 0;
    if (m === 'review') location.hash = 'review';
    else if (m === 'stars') location.hash = 'stars';
    else if (m === 'burst') location.hash = 'burst';
    if (m === 'batches' && !batches.length) loadBatches().then(() => { if (batches.length) selectBatch(0); });
    if (m === 'review' && !batches.length) await loadBatches();
    if (m === 'stars') {
      const resp = await fetch('/api/stars/summary');
      const data = await resp.json();
      starsSummary = data.summary ?? {};
      starsTotalKept = data.totalKept ?? 0;
    }
  }

  function onGridSelect(idx: number) {
    if (selectedIdx === idx) showPreview = true;
    else { selectedIdx = idx; showPreview = false; }
  }

  function setPhotoState(id: string, state: AssetState) {
    manualOverrides[id] = state;
    manualOverrides = manualOverrides;
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
      manualOverrides[currentAssets[i].id] = i === selectedIdx ? 'keep' : 'cull';
    }
    manualOverrides = manualOverrides;
    saveBatchDecisions();
  }

  function keepFirstN(n: number) {
    for (let i = 0; i < currentAssets.length; i++) {
      manualOverrides[currentAssets[i].id] = i < n ? 'keep' : 'cull';
    }
    manualOverrides = manualOverrides;
    saveBatchDecisions();
  }

  async function approve() {
    const assets = currentAssets;
    if (!assets.length) return;

    // Snapshot for undo
    const prevStates: Record<string, AssetState> = {};
    for (const a of assets) prevStates[a.id] = states[a.id];

    const undoIdx = batchIdx;
    const viewId = batches[batchIdx]?.id;
    const prevUserStars: Record<string, number> = {};
    for (const a of assets) if (userStars[a.id] != null) prevUserStars[a.id] = userStars[a.id];
    undoStack = [...undoStack, { mode, idx: undoIdx, viewId: viewId ?? '', prevStates, prevUserStars, prevSi: selectedIdx, prevKeepLevel: keepLevel }];

    // Default unmarked photos to 'keep' via manual overrides
    for (const a of assets) {
      if (!states[a.id]) manualOverrides[a.id] = 'keep';
    }
    manualOverrides = manualOverrides;

    // Save all photo decisions (re-read states after reactive update)
    await saveBatchDecisions();

    if (batches[batchIdx]) {
      await fetch(`/api/view-status/${batches[batchIdx].id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewType: 'batch', status: 'reviewed' }),
      });
      (batches[batchIdx] as any).viewStatus = 'reviewed';
      // Track as recently done (keep last 3)
      recentDoneIdxs = [batchIdx, ...recentDoneIdxs.filter(i => i !== batchIdx)].slice(0, 3);
      batches = batches;
      stats = await fetchStats();
      nextUndecidedBatch();
    }
  }

  async function skip() {
    if (batches[batchIdx]) {
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
    manualOverrides = { ...u.prevStates };
    // Clear stars for all assets in the undone view, then restore from snapshot
    for (const id of Object.keys(u.prevStates)) delete userStars[id];
    for (const [id, s] of Object.entries(u.prevUserStars)) userStars[id] = s;
    userStars = userStars;
    // Restore on server
    const decisions = Object.entries(u.prevStates).map(([id, s]) => ({
      assetId: id, state: s, userStars: u.prevUserStars[id] ?? null
    }));
    await savePhotoDecisions(decisions);

    // Clear batch view status
    await fetch(`/api/view-status/${batches[u.idx]?.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewType: 'batch', status: null }),
    });
    if (batches[u.idx]) (batches[u.idx] as any).viewStatus = null;
    batches = batches;
    if (mode !== 'batches') switchMode('batches');
    await selectBatch(u.idx);
    selectedIdx = u.prevSi;
    keepLevel = u.prevKeepLevel;
    stats = await fetchStats();
  }

  const isBatchDecided = (b: any) => b.viewStatus === 'reviewed' || b.viewStatus === 'skipped';

  function nextUndecidedBatch() {
    // Jump to next undecided visible batch
    const curPos = sidebarVisible.findIndex(i => i.idx === batchIdx);
    for (let j = curPos + 1; j < sidebarVisible.length; j++) {
      if (!sidebarVisible[j].decided) { selectBatch(sidebarVisible[j].idx); return; }
    }
    for (let j = 0; j < curPos; j++) {
      if (!sidebarVisible[j].decided) { selectBatch(sidebarVisible[j].idx); return; }
    }
  }

  function nextVisibleBatch(dir: 1 | -1) {
    const curPos = sidebarVisible.findIndex(i => i.idx === batchIdx);
    const next = curPos + dir;
    if (next >= 0 && next < sidebarVisible.length) {
      selectBatch(sidebarVisible[next].idx);
    }
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
    // Only save explicit user stars. LLM stars are mapped at writeback time
    // via mapLlmStarsToWriteback (shift-1: LLM 0-2→0, 3→1★, 4→2★, 5→3★)
    const decisions = batchDetail.assets
      .filter(a => !burstCulledIds.has(a.id) || showBurstCulled) // skip hidden burst-auto-culled
      .map(a => {
        const explicit = userStars[a.id];
        return {
          assetId: a.id,
          state: states[a.id] ?? 'keep',
          userStars: explicit ?? null,
          starSource: explicit != null ? 'user' : undefined,
        };
      });
    await savePhotoDecisions(decisions);
  }

  /** Re-run the currently viewed model (force fresh, invalidate cache) */
  async function rerunCurrentModel() {
    if (!batches[batchIdx] || activeView === 'manual') return;
    if (runningModel && runningBatchIdx === batchIdx) return;
    const savedIdx = batchIdx;
    const modelId = activeView;
    const batchId = batches[savedIdx].id;
    runningModel = modelId;
    runningBatchIdx = savedIdx;
    try {
      await fetch(`/api/batches/${batchId}/rank?model=${encodeURIComponent(modelId)}`, { method: 'DELETE' });
      const result = await rankBatch(batchId, modelId);
      if (result.error) { console.error('LLM error:', result.error); return; }
      batches[savedIdx].hasLlmResult = true; batches = batches;
      if (batchIdx === savedIdx) {
        await selectBatch(savedIdx, { freshLlm: true, model: modelId });
        activeView = modelId;
      }
    } finally {
      if (runningBatchIdx === savedIdx) { runningModel = ''; runningBatchIdx = -1; }
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (mode === 'review' || mode === 'stars' || mode === 'burst') return; // these modes handle their own keys
    if (helpOpen) { if (e.key === 'Escape' || e.key === '?') helpOpen = false; return; }
    if (!currentAssets.length) return;
    const shift = e.shiftKey;
    switch (e.key) {
      case 'ArrowRight': case 'd': e.preventDefault(); if (selectedIdx < currentAssets.length - 1) selectedIdx++; break;
      case 'ArrowLeft': case 'g': e.preventDefault(); if (selectedIdx > 0) selectedIdx--; break;
      case 'ArrowDown': e.preventDefault(); nextVisibleBatch(1); break;
      case 'ArrowUp': e.preventDefault(); nextVisibleBatch(-1); break;
      case 'Escape': showPreview = false; break;
      case ' ': e.preventDefault(); if (selectedIdx >= 0) showPreview = !showPreview; break;
      case 'k': case 'j': mark('keep'); break;
      case 'K': case 'J':
        for (const a of currentAssets) manualOverrides[a.id] = 'keep';
        manualOverrides = manualOverrides;
        saveBatchDecisions();
        break;
      case 'x': case 'f': mark('cull'); break;
      case 'X': case 'F':
        for (const a of currentAssets) manualOverrides[a.id] = 'cull';
        manualOverrides = manualOverrides;
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
      <button class:active={mode === 'batches'} on:click={() => switchMode('batches')}>Batches</button>
      <button class:active={mode === 'review'} on:click={() => switchMode('review')}>Auto Review</button>
      <button class:active={mode === 'burst'} on:click={() => switchMode('burst')}>Burst Inspect</button>
      <button class:active={mode === 'stars'} on:click={() => switchMode('stars')}>Stars</button>
    </div>
    <div class="stats">
      {#if stats}
        <span class="good"><strong>{stats.photosToKeep}</strong> keep</span>
        <span class="bad"><strong>{stats.photosToCull}</strong> cull</span>
        <span class="good">save {fmt(stats.cullBytes)}</span>
      {/if}
    </div>
  </header>

  {#if sidebarOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="sidebar-backdrop" role="button" tabindex="-1" on:click={() => sidebarOpen = false}></div>
  {/if}
  <aside class="sidebar" class:open={sidebarOpen} class:hidden={mode === 'review' || mode === 'stars' || mode === 'burst'}>
    <div class="sidebar-list">
      <div class="burst-controls">
        <button class="burst-btn" on:click={async () => {
          const preview = await burstAutoCull(true);
          if (!preview.totalAutoCulled) { alert('No burst duplicates found. Run LLM scoring first.'); return; }
          if (!confirm(`Auto-cull ${preview.totalAutoCulled} burst/duplicate photos from ${preview.burstGroups + preview.immichGroups} groups?\n\n${preview.burstPhotos} from LLM bursts, ${preview.immichPhotos} from Immich duplicates`)) return;
          await burstAutoCull(false);
          await loadBatches();
          if (batchIdx >= 0) await selectBatch(batchIdx);
          stats = await fetchStats();
        }}>Burst Auto-Cull</button>
        <button class="burst-btn burst-undo" on:click={async () => {
          const r = await revertBurstAutoCull();
          alert(`Reverted ${r.reverted} burst auto-cull decisions.`);
          await loadBatches();
          if (batchIdx >= 0) await selectBatch(batchIdx);
          stats = await fetchStats();
        }}>Undo</button>
      </div>
      {#if sidebarDecidedCount > 3}
        <button class="si-more si-done-toggle" on:click={() => sidebarShowDone = !sidebarShowDone}>
          {sidebarShowDone ? 'Hide' : 'Show all'} {sidebarDecidedCount} done
        </button>
      {/if}
      {#each sidebarVisible as item (item.idx)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="gi" class:active={item.active} class:decided={item.decided}
             on:click={() => { sidebarOpen = false; selectBatch(item.idx); }} role="button" tabindex="-1">
          <div class="t">
            {item.label} · {item.date.toLocaleDateString('no', { day: 'numeric', month: 'short', year: '2-digit' })}
          </div>
          <div class="m">
            {item.sub}{#if item.hasLlm}
              · {#if item.keeps || item.culls}<span class="si-keep">{item.keeps}✓</span> <span class="si-cull">{item.culls}✗</span>{/if}
              <span class="si-llm">llm</span>
              {#if item.agreement?.tier === 'full-agreement'}
                <span class="si-agree">✓{item.agreement.modelCount}m</span>
              {:else if item.agreement?.tier === 'partial-agreement'}
                <span class="si-partial">{item.agreement.disagreements}?</span>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
      {#if sidebarHasMore}
        <button class="si-more" on:click={() => sidebarLimit += 100}>Show more</button>
      {/if}
    </div>
    <InfoPanel
      asset={selectedAsset}
      assetPath={selectedAsset?.path ?? ''}
      llm={selectedLlm}
      subgroup={selectedSubgroup}
      currentState={selectedCurrentState}
      llmPerImage={selectedLlmPerImage}
      sgRank={selectedSgRank}
      effectiveStars={selectedEffectiveStars}
      {keepLevel}
      userStars={selectedUserStars}
      userStarsExplicit={selectedAsset ? userStars[selectedAsset.id] != null : false}
      onSetStars={setStars}
    />
  </aside>

  <div class="main">
    {#if mode === 'review'}
      <AutoCullReview onNavigateBatch={async (id) => {
        mode = 'batches';
        if (!batches.length) await loadBatches();
        const idx = batches.findIndex(b => b.id === id);
        if (idx >= 0) await selectBatch(idx);
      }} />
    {:else if mode === 'stars'}
      <StarsReview summary={starsSummary} totalKept={starsTotalKept} />
    {:else if mode === 'burst'}
      <BurstInspect onGoToBatch={async (id) => {
        // Push current burst URL onto history so back returns here
        history.pushState(null, '', `#burst`);
        mode = 'batches';
        if (!batches.length) await loadBatches();
        const idx = batches.findIndex(b => b.id === id);
        if (idx >= 0) await selectBatch(idx);
      }} />
    {:else if loading}
      <div class="empty"><span class="spinner"></span> Loading...</div>
    {:else if currentAssets.length}
      <PhotoGrid assets={currentAssets} {states} {selectedIdx} {llmMap} {effectiveStarsMap} {autoCullMap} {agreementMap} {collapsedCountMap}
        confirmedIds={new Set(Object.keys(manualOverrides).filter(id => manualOverrides[id]))}
        userStarsMap={userStars}
        onToggleCollapsed={() => { showBurstCulled = !showBurstCulled; }}
        onSelect={onGridSelect}
        onToggleState={(i) => {
          const asset = currentAssets[i];
          if (!asset) return;
          const effective = states[asset.id] ?? null;
          setPhotoState(asset.id, effective === 'keep' ? 'cull' : 'keep');
        }} />
    {:else}
      <div class="empty">Select a batch</div>
    {/if}
  </div>

  <footer class="bar" class:hidden={mode === 'review' || mode === 'stars' || mode === 'burst'}>
    <button class="bk" on:click={() => mark('keep')}>Keep</button>
    <button class="bc" on:click={() => mark('cull')}>Cull</button>
    <button class="bb" on:click={keepBestCullRest}>Best + Cull Rest</button>
    <button class="ba" on:click={approve}>Approve & Next</button>
    <button class="bs" on:click={skip}>Skip</button>
    {#if mode === 'batches' && batchDetail}
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
            {@const isRunning = runningModel === m.id && runningBatchIdx === batchIdx}
            <button class="model-btn" class:current={activeView === m.id} class:cached={hasCached && activeView !== m.id}
              disabled={runningBatchIdx === batchIdx && !!runningModel}
              on:click={() => switchOrRunModel(m.id)} title="{m.id}{hasCached ? ' (cached)' : ''}">
              {#if isRunning}<span class="spinner"></span>{:else}{m.label}{/if}
            </button>
          {/each}
      </div>
    {/if}
    {#if mode === 'batches' && confidentUnreviewed > 0}
      <button class="bcf" on:click={bulkApproveConfident}
        title="Auto-approve {confidentUnreviewed} batches where all models agree">
        Approve {confidentUnreviewed} confident
      </button>
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
        <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Previous / next batch</td></tr>
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
  .sidebar.hidden, .bar.hidden { display: none; }
  .sidebar.hidden + .main { grid-column: 1 / -1; }
  .sidebar-list { flex: 1; overflow-y: auto; min-height: 0; }
  .gi { padding: 5px 8px; cursor: pointer; border-bottom: 1px solid #1e2028; border-left: 3px solid transparent; }
  .gi:hover { background: #1c1f27; } .gi.active { background: #1f2330; border-left-color: #f0a040; }
  .gi.decided { opacity: .5; border-left-color: #66bb6a; }
  .gi.decided.active { opacity: 1; border-left-color: #a5d6a7; background: rgba(76,175,80,.15); }
  .gi .t { font-weight: 500; } .gi .m { color: #666; font-size: 11px; }
  .burst-controls { display: flex; gap: 4px; padding: 4px 6px; border-bottom: 1px solid #1e2028; }
  .burst-btn { flex: 1; padding: 4px 6px; background: #1c2030; border: 1px solid #2a3040; border-radius: 3px; color: #8090b0; font-size: 10px; cursor: pointer; }
  .burst-btn:hover { background: #252a3a; color: #b0c0e0; }
  .burst-undo { flex: 0; color: #666; }
  .si-more { display: block; width: 100%; padding: 6px 8px; background: none; border: none; border-bottom: 1px solid #1e2028; color: #f0a040; font-size: 11px; cursor: pointer; text-align: left; }
  .si-more:hover { background: #1c1f27; }
  .si-done-toggle { position: sticky; top: 0; z-index: 1; background: #0e1014; font-weight: 600; }
  .si-keep { color: #4caf50; } .si-cull { color: #e53935; }
  .si-llm { color: #f0a040; font-size: 10px; font-weight: 600; }
  .si-agree { color: #4caf50; font-size: 10px; font-weight: 600; }
  .si-partial { color: #ff9800; font-size: 10px; font-weight: 600; }

  .main { min-width: 0; min-height: 0; overflow: hidden; position: relative; }
  .empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #666; }

  .bar { grid-column: 2; display: flex; gap: 10px; padding: 0 14px; border-top: 1px solid #2a2e36; background: rgba(17,19,25,.95); align-items: center; }
  .bar button { padding: 5px 14px; border: none; border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 500; }
  .bar button:hover { opacity: .85; }
  .bk { background: #4caf50; color: white; } .bc { background: #e53935; color: white; }
  .bb { background: #2196F3; color: white; } .ba { background: #f0a040; color: #1a1a1a; font-weight: 700; }
  .bcf { background: #2e7d32; color: white; font-weight: 600; font-size: 11px; }
  .bs { background: #333; color: #aaa; } .bh { background: none; color: #7a8294; border: 1px solid #2a2e36 !important; padding: 3px 9px; font-size: 12px; }
  .spacer { flex: 1; } .bmeta { font-size: 11px; color: #7a8294; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3); border-top-color: white; border-radius: 50%; animation: spin .6s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
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
  :global(.collapsed-badge) { position: absolute; top: 50%; right: 0; transform: translateY(-50%); background: #fff; color: #1a1a1a; font-size: 10px; font-weight: 700; padding: 2px 4px; z-index: 5; cursor: pointer; }
  /* Subgroup rope: connector between adjacent group members, rendered in grid container */
  :global(.sg-rope) { position: absolute; background: #fff; pointer-events: none; z-index: 4; }
  :global(.toggle-zone) { position: absolute; top: 0; left: 0; right: 0; height: 20%; min-height: 24px; cursor: pointer; z-index: 2; }
  :global(.bdg) { position: absolute; top: 3px; left: 3px; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; color: white; pointer-events: none; }
  :global(.bdg.kb) { background: #4caf50; opacity: 0.75; }
  :global(.bdg.cb) { background: #e53935; opacity: 0.75; }
  :global(.bdg.kb.confirmed) { opacity: 1; }
  :global(.bdg.cb.confirmed) { opacity: 1; }
  :global(.bdg.acb-hi) { background: #bf360c; font-size: 8px; } :global(.bdg.acb) { background: #e65100; font-size: 8px; }
  :global(.bdg.agreed) { opacity: 1; }
  :global(.bdg.has-dispute) { display: flex; align-items: stretch; padding: 0; border-radius: 3px; overflow: hidden; }
  :global(.bdg.has-dispute > .bdg-state) { padding: 1px 4px; }
  :global(.bdg.has-dispute > .bdg-dispute) { background: #ff9800; color: #1a1a1a; font-weight: 900; padding: 1px 4px; }
  :global(.st) { position: absolute; top: 22px; right: 3px; font-size: 11px; color: #ffd700; text-shadow: 0 1px 2px #000; z-index: 1; }
  :global(.llm-star) { position: absolute; top: 3px; right: 3px; font-size: 11px; color: #ffd700; text-shadow: 0 1px 2px #000; background: rgba(0,0,0,.6); padding: 1px 4px; border-radius: 3px; z-index: 1; }
  :global(.user-star) { position: absolute; top: 3px; right: 3px; font-size: 11px; color: #1a1a1a; text-shadow: none; background: #ffd700; padding: 1px 4px; border-radius: 3px; z-index: 1; font-weight: 700; }
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
    .kl-btn { width: 32px; height: 32px; } /* bigger touch targets */
    .header { padding: 0 8px; gap: 6px; }
    .header h1 { font-size: 12px; }
    .stats { gap: 6px; font-size: 10px; }
    :global(.preview-ov) { left: 0 !important; }
    :global(.pv-strip) { height: 60px; }
    :global(.pvt) { height: 50px; }
    :global(.lbl) { display: none; }
    :global(.bdg) { display: none; }
    :global(.cell.sel .bdg) { display: block; font-size: 9px; }
    :global(.toggle-zone) { height: 30%; } /* bigger touch target on mobile */
    :global(.llm-note) { display: none; }
    :global(.llm-star), :global(.user-star) { display: none; }
    :global(.cell.sel .llm-star), :global(.cell.sel .user-star) { display: block; }
  }
</style>
