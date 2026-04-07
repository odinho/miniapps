<script lang="ts">
  import { onMount } from 'svelte';
  import PhotoGrid from './components/PhotoGrid.svelte';
  import Preview from './components/Preview.svelte';
  import InfoPanel from './components/InfoPanel.svelte';
  import {
    fetchGroups, fetchGroup, fetchBatches, fetchBatch, fetchStats,
    decideGroup, undecideGroup, rankBatch, savePhotoDecisions, fetchPhotoDecisions, fmt,
    type GroupSummary, type GroupDetail, type BatchSummary, type BatchDetail,
    type LlmImage, type Stats,
  } from './lib/api';

  type AppMode = 'groups' | 'batches';
  type AssetState = 'keep' | 'cull' | null;

  let mode: AppMode = 'groups';
  let showPreview = false;
  let selectedIdx = 0;
  let helpOpen = false;
  let sidebarOpen = false;
  let loading = false;
  let llmRunning = false;

  let groups: GroupSummary[] = [];
  let groupIdx = -1;
  let groupDetail: GroupDetail | null = null;

  let batches: BatchSummary[] = [];
  let batchIdx = -1;
  let batchDetail: BatchDetail | null = null;

  let states: Record<string, AssetState> = {};
  let userStars: Record<string, number> = {};
  let stats: Stats | null = null;
  let undoStack: Array<{ mode: AppMode; idx: number; prevStates: Record<string, AssetState>; prevSi: number }> = [];

  $: currentAssets = mode === 'groups' ? (groupDetail?.assets ?? []) : (batchDetail?.assets ?? []);
  $: llmMap = buildLlmMap(batchDetail);
  $: keepSet = new Set(batchDetail?.llm?.similaritySubgroups?.flatMap(sg => sg.recommendedKeepIds) ?? []);
  $: cullSet = new Set(batchDetail?.llm?.similaritySubgroups?.flatMap(sg => sg.cullIds) ?? []);
  $: allSubgroups = batchDetail?.llm?.similaritySubgroups ?? [];

  // Selected asset info for InfoPanel
  $: selectedAsset = currentAssets[selectedIdx] ?? null;
  $: selectedLlm = selectedAsset ? llmMap[selectedAsset.id] ?? null : null;
  $: selectedSubgroup = selectedLlm?.similaritySubgroupId
    ? allSubgroups.find(sg => sg.subgroupId === selectedLlm!.similaritySubgroupId) ?? null
    : null;
  $: selectedManualState = selectedAsset ? (states[selectedAsset.id] ?? null) : null;
  $: selectedLlmState = selectedAsset ? (keepSet.has(selectedAsset.id) ? 'keep' : cullSet.has(selectedAsset.id) ? 'cull' : null) : null;
  $: selectedUserStars = selectedAsset ? (userStars[selectedAsset.id] ?? selectedAsset.rating ?? 0) : 0;

  function setStars(stars: number) {
    if (!selectedAsset) return;
    userStars[selectedAsset.id] = stars;
    userStars = userStars;
    savePhotoDecisions([{ assetId: selectedAsset.id, state: states[selectedAsset.id] ?? null, userStars: stars }]);
  }

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

  async function loadPhotoStates(assets: { id: string }[]) {
    const ids = assets.map(a => a.id);
    const saved = await fetchPhotoDecisions(ids);
    for (const [id, d] of Object.entries(saved)) {
      if (d.state) states[id] = d.state as AssetState;
      if (d.userStars != null) userStars[id] = d.userStars;
    }
    for (const a of assets) if (!(a.id in states)) states[a.id] = null;
    states = states;
    userStars = userStars;
  }

  async function selectGroup(idx: number) {
    groupIdx = idx; selectedIdx = 0; showPreview = false;
    loading = true;
    groupDetail = await fetchGroup(`group-${idx}`);
    loading = false;
    await loadPhotoStates(groupDetail?.assets ?? []);
    // Check if this group has been reviewed (from viewStatus)
    groups[idx].decided = (groupDetail as any)?.viewStatus != null;
    groups = groups;
    history.replaceState(null, '', `#group/${idx}`);
  }

  async function selectBatch(idx: number) {
    batchIdx = idx; selectedIdx = 0; showPreview = false;
    loading = true;
    batchDetail = await fetchBatch(batches[idx].id);
    loading = false;
    await loadPhotoStates(batchDetail?.assets ?? []);

    // Pre-populate from LLM suggestions if no manual decision exists
    if (batchDetail?.llm?.similaritySubgroups) {
      for (const sg of batchDetail.llm.similaritySubgroups) {
        for (const id of sg.recommendedKeepIds) {
          if (!states[id]) states[id] = 'keep';
        }
        for (const id of sg.cullIds) {
          if (!states[id]) states[id] = 'cull';
        }
      }
      states = states;
    }

    history.replaceState(null, '', `#batch/${batches[idx].id}`);
  }

  function switchMode(m: AppMode) {
    mode = m; showPreview = false; selectedIdx = 0;
    if (m === 'batches' && !batches.length) fetchBatches().then(b => { batches = b; if (b.length) selectBatch(0); });
  }

  function onGridSelect(idx: number) {
    if (selectedIdx === idx) showPreview = true;
    else { selectedIdx = idx; showPreview = false; }
  }

  function mark(s: 'keep' | 'cull') {
    if (selectedIdx < 0) selectedIdx = 0;
    const a = currentAssets[selectedIdx]; if (!a) return;
    const newState = states[a.id] === s ? null : s;
    states[a.id] = newState;
    states = states;
    savePhotoDecisions([{ assetId: a.id, state: newState, userStars: userStars[a.id] ?? null }]);
    if (selectedIdx < currentAssets.length - 1) selectedIdx++;
  }

  function keepBestCullRest() {
    if (selectedIdx < 0) selectedIdx = 0;
    const decisions: Array<{ assetId: string; state: string | null; userStars: number | null }> = [];
    for (let i = 0; i < currentAssets.length; i++) {
      const s = i === selectedIdx ? 'keep' : 'cull';
      states[currentAssets[i].id] = s;
      decisions.push({ assetId: currentAssets[i].id, state: s, userStars: userStars[currentAssets[i].id] ?? null });
    }
    states = states;
    savePhotoDecisions(decisions);
  }

  function keepFirstN(n: number) {
    const decisions: Array<{ assetId: string; state: string | null; userStars: number | null }> = [];
    for (let i = 0; i < currentAssets.length; i++) {
      const s = i < n ? 'keep' : 'cull';
      states[currentAssets[i].id] = s;
      decisions.push({ assetId: currentAssets[i].id, state: s, userStars: userStars[currentAssets[i].id] ?? null });
    }
    states = states;
    savePhotoDecisions(decisions);
  }

  async function approve() {
    const assets = currentAssets;
    if (!assets.length) return;

    // Snapshot for undo
    const prevStates: Record<string, AssetState> = {};
    for (const a of assets) prevStates[a.id] = states[a.id];

    const undoIdx = mode === 'groups' ? groupIdx : batchIdx;
    undoStack = [...undoStack, { mode, idx: undoIdx, prevStates, prevSi: selectedIdx }];

    // Default unmarked photos to 'keep'
    for (const a of assets) if (!states[a.id]) states[a.id] = 'keep';
    states = states;

    // Save all photo decisions
    const decisions = assets.map(a => ({
      assetId: a.id, state: states[a.id], userStars: userStars[a.id] ?? null
    }));
    await savePhotoDecisions(decisions);

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
      nextUndecidedBatch();
    }
  }

  async function skip() {
    if (mode === 'groups' && groupDetail) {
      const prevStates: Record<string, AssetState> = {};
      for (const a of groupDetail.assets) prevStates[a.id] = states[a.id];
      undoStack = [...undoStack, { mode: 'groups', idx: groupIdx, prevStates, prevSi: selectedIdx }];
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
    // Restore local states
    for (const [id, s] of Object.entries(u.prevStates)) states[id] = s;
    states = states;
    // Restore on server
    const decisions = Object.entries(u.prevStates).map(([id, s]) => ({
      assetId: id, state: s, userStars: userStars[id] ?? null
    }));
    await savePhotoDecisions(decisions);

    if (u.mode === 'groups') {
      await undecideGroup(`group-${u.idx}`);
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
    stats = await fetchStats();
  }

  function nextUndecided() {
    for (let i = groupIdx + 1; i < groups.length; i++) if (!groups[i].decided) { selectGroup(i); return; }
    for (let i = 0; i < groupIdx; i++) if (!groups[i].decided) { selectGroup(i); return; }
  }

  function nextUndecidedBatch() {
    // Move to next batch (for now just go forward)
    if (batchIdx < batches.length - 1) selectBatch(batchIdx + 1);
  }

  async function runLlm() {
    if (!batches[batchIdx] || llmRunning) return;
    llmRunning = true;
    try {
      const result = await rankBatch(batches[batchIdx].id);
      if (result.error) { alert('LLM error: ' + result.error); return; }
      batches[batchIdx].hasLlmResult = true; batches = batches;
      await selectBatch(batchIdx);
    } finally {
      llmRunning = false;
    }
  }

  async function rerunLlm() {
    if (!batches[batchIdx] || llmRunning) return;
    llmRunning = true;
    try {
      await fetch(`/api/batches/${batches[batchIdx].id}/rank`, { method: 'DELETE' });
      const result = await rankBatch(batches[batchIdx].id);
      if (result.error) { alert('LLM error: ' + result.error); return; }
      batches[batchIdx].hasLlmResult = true; batches = batches;
      await selectBatch(batchIdx);
    } finally {
      llmRunning = false;
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
        for (const a of currentAssets) states[a.id] = 'keep'; states = states;
        savePhotoDecisions(currentAssets.map(a => ({ assetId: a.id, state: 'keep', userStars: userStars[a.id] ?? null })));
        break;
      case 'x': case 'f': mark('cull'); break;
      case 'X': case 'F':
        for (const a of currentAssets) states[a.id] = 'cull'; states = states;
        savePhotoDecisions(currentAssets.map(a => ({ assetId: a.id, state: 'cull', userStars: userStars[a.id] ?? null })));
        break;
      case 'b': case 'B': keepBestCullRest(); break;
      case 'a': case 'Enter': e.preventDefault(); approve(); break;
      case 's': if (!shift) skip(); break;
      case 'Backspace': e.preventDefault(); undo(); break;
      case '?': helpOpen = !helpOpen; break;
      case '1': keepFirstN(1); break; case '2': keepFirstN(2); break; case '3': keepFirstN(3); break;
      case '4': keepFirstN(4); break; case '5': keepFirstN(5); break;
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

  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  {#if sidebarOpen}
    <div class="sidebar-backdrop" on:click={() => sidebarOpen = false}></div>
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
      manualState={selectedManualState}
      llmState={selectedLlmState}
      userStars={selectedUserStars}
      onSetStars={setStars}
    />
  </aside>

  <div class="main">
    {#if loading}
      <div class="empty"><span class="spinner"></span> Loading...</div>
    {:else if currentAssets.length}
      <PhotoGrid assets={currentAssets} {states} {selectedIdx} {llmMap} {keepSet} {cullSet} onSelect={onGridSelect} />
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
      {#if llmRunning}
        <button class="run-btn" disabled><span class="spinner"></span> Running...</button>
      {:else if !batchDetail.llm}
        <button class="run-btn" on:click={runLlm}>Run LLM</button>
      {:else}
        <button class="run-btn" on:click={rerunLlm} style="background:#555">Re-run LLM</button>
      {/if}
    {/if}
    <span class="spacer"></span>
    <span class="bmeta">{currentAssets.length} photos</span>
    <button class="bh" on:click={() => helpOpen = true}>?</button>
  </footer>
</div>

{#if showPreview && selectedIdx >= 0 && currentAssets.length}
  <Preview assets={currentAssets} {selectedIdx} {states} {llmMap} {keepSet} {cullSet}
    subgroups={allSubgroups}
    onSelect={(i) => selectedIdx = i} onClose={() => showPreview = false} />
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
      <h3>Bulk</h3>
      <table><tbody>
        <tr><td><kbd>Shift+K</kbd></td><td>Keep all</td></tr>
        <tr><td><kbd>Shift+X</kbd></td><td>Cull all</td></tr>
        <tr><td><kbd>1</kbd>–<kbd>5</kbd></td><td>Keep first N</td></tr>
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

  :global(.jgrid) { position: relative; width: 100%; height: 100%; overflow: hidden; }
  :global(.cell) { position: absolute; overflow: hidden; cursor: pointer; border: 3px solid transparent; transition: border-color .12s, opacity .12s; }
  :global(.cell:hover) { border-color: #555; }
  :global(.cell.keep) { border-color: #4caf50; }
  :global(.cell.cull) { border-color: rgba(229,57,53,.4); outline: none !important; }
  :global(.cell.cull > img) { opacity: .4; }
  :global(.cell.sel) { border-color: #f0a040 !important; box-shadow: 0 0 8px rgba(240,160,64,.5); }
  :global(.cell img) { width: 100%; height: 100%; object-fit: contain; display: block; background: #0b0d11; }
  :global(.lbl) { position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(transparent, rgba(0,0,0,.8)); padding: 10px 5px 3px; font-size: 9px; color: #bbb; display: flex; justify-content: space-between; }
  :global(.bdg) { position: absolute; top: 3px; left: 3px; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; color: white; }
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
    .app { grid-template-columns: minmax(0, 1fr); }
    .hamburger { display: block; }
    .sidebar {
      position: fixed; top: 34px; left: -280px; bottom: 0; width: 280px;
      z-index: 100; transition: left .2s ease;
    }
    .sidebar.open { left: 0; }
    .sidebar-backdrop { display: block; position: fixed; inset: 0; top: 34px; background: rgba(0,0,0,.5); z-index: 99; }
    .bar { grid-column: 1; gap: 6px; padding: 0 8px; }
    .bar button { padding: 5px 10px; font-size: 12px; }
    .header { padding: 0 8px; gap: 6px; }
    .header h1 { font-size: 12px; }
    .stats { gap: 6px; font-size: 10px; }
    :global(.preview-ov) { left: 0 !important; }
    :global(.pv-strip) { height: 60px; }
    :global(.pvt) { height: 50px; }
    :global(.lbl) { display: none; }
    :global(.bdg) { display: none; }
    :global(.llm-note) { display: none; }
    :global(.llm-star) { display: none; }
  }
</style>
