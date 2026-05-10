<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { justifiedLayout, type Rect } from '../lib/layout';

  type VariantResult = {
    variant: string;
    bestPicks: number[];
    ranking: number[];
    reason: string;
    elapsed: number;
    matchesUser: boolean | null;
    matchesLlm: boolean;
    tokensIn: number;
    tokensOut: number;
  };

  type GroupInfo = {
    batchId: string;
    subgroupId: string;
    type: string;
    assetIds: string[];
    filenames: string[];
    llmKeepIds: string[];
    llmRanking: string[];
    userKeepIds: string[];
    userCullIds: string[];
  };

  type GroupResult = { group: GroupInfo; variants: VariantResult[] };

  type Grade = {
    severity?: number | null;   // 0=fine/equivalent, 1=slightly off, 2=sad, 3=very sad
    keepBias?: number | null;   // -1=too few, 0=right, 1=too many
    note?: string;
    updatedAt?: string;
    inheritedFrom?: string;     // source experiment id if grade was carried over from another run
  };

  const SEVERITY_LABELS = ['perfect', 'fine', 'meh', 'sad', '😢'];
  const SEVERITY_TITLES = [
    'Perfect — I would have picked this myself',
    'Fine — acceptable alternative, no regret',
    'Meh — noticeable but minor regression',
    'Sad — a real regression vs ideal',
    'Very sad — painful miss',
  ];
  const BIAS_LABELS = ['too few', 'right', 'too many'];

  // A "pick bundle" is all variants in a group that chose the same set of photos.
  // We grade the PICK (group + sorted indices), not each variant. Multiple variants
  // that happened to pick identically share one grade.
  type PickBundle = {
    pickKey: string;          // sorted-joined indices, e.g. "1" or "0,2"
    bestPicks: number[];      // canonical sorted indices
    variants: VariantResult[];
  };

  let experiments: Array<{ id: string; archived?: boolean }> = [];
  let selectedId = '';
  let results: GroupResult[] = [];
  let grades: Record<string, Grade> = {};
  let groupIdx = 0;
  let activePickIdx = 0;
  let blindMode = true;
  let helpOpen = false;
  let loading = false;
  let previewIdx: number | null = null;

  // Cache of {id → {w, h}} for aspect-correct layout
  let assetDims: Record<string, { w: number; h: number }> = {};
  let gridContainer: HTMLDivElement = undefined!;
  let gridRects: Rect[] = [];
  let gridHeight = 0;

  $: currentGroup = results[groupIdx] ?? null;
  $: groupKey = currentGroup ? `${currentGroup.group.batchId}::${currentGroup.group.subgroupId}` : '';
  $: pickBundles = currentGroup ? computePickBundles(currentGroup) : [];
  $: activeBundle = pickBundles[activePickIdx] ?? null;

  let resizeObserver: ResizeObserver | null = null;
  let bundleRefs: Array<HTMLDivElement | null> = [];

  $: if (activePickIdx >= 0 && bundleRefs[activePickIdx]) {
    tick().then(() => {
      bundleRefs[activePickIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  // --- Helpers ---
  function groupKeyOf(g: GroupResult): string {
    return `${g.group.batchId}::${g.group.subgroupId}`;
  }
  function pickKeyOf(bestPicks: number[]): string {
    return bestPicks.toSorted((a, b) => a - b).join(',');
  }
  function gradeKey(gKey: string, pickKey: string): string {
    return `${gKey}::picks=${pickKey}`;
  }
  // A reserved "pick key" that means "this whole group is excluded from the test set".
  const EXCLUDED_KEY = '__excluded__';
  function isExcluded(gKey: string): boolean {
    return !!grades[gradeKey(gKey, EXCLUDED_KEY)];
  }
  function toggleExcludeCurrent() {
    if (!currentGroup) return;
    const key = gradeKey(groupKey, EXCLUDED_KEY);
    if (grades[key]) {
      const { [key]: _removed, ...rest } = grades;
      grades = rest;
      fetch(`/api/experiments/${selectedId}/grade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, severity: null, keepBias: null, note: '' }),
      }).then(() =>
        fetch(`/api/experiments/${selectedId}/grades`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grades }),
        }),
      );
    } else {
      grades = { ...grades, [key]: { severity: null, keepBias: null, note: 'excluded', updatedAt: new Date().toISOString() } };
      fetch(`/api/experiments/${selectedId}/grade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, severity: null, keepBias: null, note: 'excluded' }),
      });
    }
  }
  // A variant is "gradable" only if it actually produced a pick — errors and empty picks don't.
  function isGradable(v: VariantResult): boolean {
    if (v.reason.startsWith('ERROR') || v.reason.startsWith('PARSE')) return false;
    if (v.bestPicks.length === 0) return false;
    return true;
  }
  function computePickBundles(g: GroupResult): PickBundle[] {
    const byKey = new Map<string, PickBundle>();
    for (const v of g.variants) {
      if (!isGradable(v)) continue;
      const key = pickKeyOf(v.bestPicks);
      let bundle = byKey.get(key);
      if (!bundle) {
        const sorted = v.bestPicks.toSorted((x, y) => x - y);
        bundle = { pickKey: key, bestPicks: sorted, variants: [] };
        byKey.set(key, bundle);
      }
      bundle.variants.push(v);
    }
    return [...byKey.values()];
  }
  function hasSeverity(gKey: string, pickKey: string): boolean {
    const g = grades[gradeKey(gKey, pickKey)];
    return g?.severity !== null && g?.severity !== undefined;
  }
  function ungradedBundlesOf(g: GroupResult): PickBundle[] {
    const k = groupKeyOf(g);
    if (isExcluded(k)) return [];
    return computePickBundles(g).filter((b) => !hasSeverity(k, b.pickKey));
  }

  function copyPrevGrade() {
    if (!activeBundle) return;
    let best: Grade | null = null;
    for (const b of pickBundles) {
      if (b.pickKey === activeBundle.pickKey) continue;
      const gr = grades[gradeKey(groupKey, b.pickKey)];
      if (!gr || gr.severity === null || gr.severity === undefined) continue;
      if (!best || (gr.updatedAt ?? '') > (best.updatedAt ?? '')) best = gr;
    }
    if (best) {
      setGrade(activeBundle.pickKey, {
        severity: best.severity,
        keepBias: best.keepBias,
        note: best.note,
      });
    }
  }

  // Migrate old variant-keyed grades to pick-keyed grades.
  // Old key: `${groupKey}::${variantName}`; new key: `${groupKey}::picks=${sortedIndices}`.
  // Returns migrated grades, or null if no migration needed.
  function migrateGradesToPickBased(
    exp: { results: GroupResult[] },
    old: Record<string, Grade>,
  ): Record<string, Grade> | null {
    const next: Record<string, Grade> = {};
    let changed = false;

    // Pass 1: keep any entries that are already pick-based.
    for (const [k, v] of Object.entries(old)) {
      if (k.includes('::picks=')) next[k] = v;
      else changed = true; // we'll migrate it below
    }
    if (!changed) return null;

    // Pass 2: migrate variant-based entries by looking up each variant's picks.
    for (const g of exp.results) {
      const gk = groupKeyOf(g);
      for (const v of g.variants) {
        const oldKey = `${gk}::${v.variant}`;
        const oldGrade = old[oldKey];
        if (!oldGrade) continue;
        if (!isGradable(v)) continue;
        const newKey = gradeKey(gk, pickKeyOf(v.bestPicks));
        const existing = next[newKey];
        if (!existing || (existing.updatedAt ?? '') < (oldGrade.updatedAt ?? '')) {
          next[newKey] = oldGrade;
        }
      }
    }
    return next;
  }

  onMount(async () => {
    const qs = new URLSearchParams(location.hash.replace(/^#experiment/, '').replace(/^\?/, ''));
    const id = qs.get('id');
    const list = await fetch('/api/experiments').then((r) => r.json());
    experiments = list.experiments;
    if (id && experiments.find((e) => e.id === id)) {
      await loadExperiment(id);
    } else if (experiments.length) {
      await loadExperiment(experiments[0].id);
    }
    resizeObserver = new ResizeObserver(() => computeLayout());
    if (gridContainer) resizeObserver.observe(gridContainer);
  });

  onDestroy(() => resizeObserver?.disconnect());

  // One-shot notice shown after load if grades were carried over from other experiments.
  let inheritedNotice: { count: number; sources: string[] } | null = null;

  async function persistAllGrades(id: string, next: Record<string, Grade>): Promise<void> {
    await fetch(`/api/experiments/${id}/grades`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grades: next }),
    });
  }

  // Collect every grade-key this experiment could meaningfully store: one per pick bundle,
  // plus the per-group EXCLUDED_KEY. Anything outside this set would be stale and is ignored.
  function localGradeKeys(xs: GroupResult[]): Set<string> {
    const keys = new Set<string>();
    for (const g of xs) {
      const gk = groupKeyOf(g);
      for (const v of g.variants) {
        if (!isGradable(v)) continue;
        keys.add(gradeKey(gk, pickKeyOf(v.bestPicks)));
      }
      keys.add(gradeKey(gk, EXCLUDED_KEY));
    }
    return keys;
  }

  // Cross-experiment inheritance: pick-bundles with the same (group, picks) key as a
  // graded bundle in any other experiment inherit that grade. The user graded the PICK,
  // not the model, so the judgment transfers regardless of which run produced the picks.
  async function inheritCrossExperimentGrades(
    id: string,
    currentGrades: Record<string, Grade>,
    xs: GroupResult[],
  ): Promise<{ next: Record<string, Grade>; count: number; sources: Set<string> }> {
    const relevantKeys = localGradeKeys(xs);
    let all: Record<string, { grade: Grade; sourceExperiment: string }>;
    try {
      const resp = await fetch('/api/grades/all').then((r) => r.json());
      all = resp.grades ?? {};
    } catch (err) {
      console.warn('Grade inheritance: /api/grades/all unavailable, skipping:', err);
      return { next: currentGrades, count: 0, sources: new Set() };
    }

    const patch: Record<string, Grade> = {};
    const sources = new Set<string>();
    for (const [key, entry] of Object.entries(all)) {
      if (!relevantKeys.has(key)) continue;
      if (entry.sourceExperiment === id) continue;
      if (currentGrades[key]) continue;
      patch[key] = { ...entry.grade, inheritedFrom: entry.sourceExperiment };
      sources.add(entry.sourceExperiment);
    }
    const count = Object.keys(patch).length;
    if (count === 0) return { next: currentGrades, count: 0, sources };
    return { next: { ...currentGrades, ...patch }, count, sources };
  }

  async function loadExperiment(id: string) {
    loading = true;
    selectedId = id;
    inheritedNotice = null;

    const data = await fetch(`/api/experiments/${id}`).then((r) => r.json());
    results = data.experiment.results ?? [];
    const rawGrades: Record<string, Grade> = data.grades ?? {};

    // 1. Back-compat migration of legacy variant-keyed grades.
    const migrated = migrateGradesToPickBased({ results }, rawGrades);
    let next: Record<string, Grade> = migrated ?? rawGrades;
    if (migrated) await persistAllGrades(id, migrated);

    // 2. Pull in any prior grades for the same (group, picks) from other experiments.
    const inherited = await inheritCrossExperimentGrades(id, next, results as GroupResult[]);
    if (inherited.count > 0) {
      next = inherited.next;
      await persistAllGrades(id, next);
      inheritedNotice = { count: inherited.count, sources: [...inherited.sources].toSorted() };
    }

    grades = next;
    groupIdx = findFirstUngradedGroup();
    activePickIdx = 0;
    loading = false;
    history.replaceState(null, '', `#experiment?id=${id}`);
    await fetchDimsForCurrentGroup();
  }

  async function fetchDimsForCurrentGroup() {
    if (!currentGroup) return;
    const ids = currentGroup.group.assetIds.filter((id) => !assetDims[id]);
    if (!ids.length) return;
    const q = new URLSearchParams({ ids: ids.join(',') });
    const resp = await fetch(`/api/assets/details?${q}`).then((r) => r.json());
    const next: Record<string, { w: number; h: number }> = { ...assetDims };
    for (const a of resp.assets) next[a.id] = { w: a.w || 1, h: a.h || 1 };
    assetDims = next;
  }

  // refetch on group change
  $: if (groupIdx >= 0 && results.length) fetchDimsForCurrentGroup();

  function computeLayout() {
    if (!gridContainer || !photos.length) { gridRects = []; gridHeight = 0; return; }
    const items = photos.map((p) => assetDims[p.id] ?? { w: 1, h: 1 });
    const containerW = gridContainer.clientWidth;
    // Budget: roughly 40% of viewport height for the photo grid,
    // capped so a handful of photos don't each become huge.
    const budget = Math.max(240, Math.min(window.innerHeight * 0.42, 520));
    gridRects = justifiedLayout(items, containerW, budget, 6);
    gridHeight = gridRects.length
      ? Math.max(...gridRects.map((r) => r.y + r.h))
      : 0;
  }

  // recompute when photos or dims change
  $: if (photos && assetDims) {
    tick().then(computeLayout);
  }

  function findFirstUngradedGroup(): number {
    for (let i = 0; i < results.length; i++) {
      if (ungradedBundlesOf(results[i]).length > 0) return i;
    }
    return 0;
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  async function setGrade(pickKey: string, patch: Partial<Grade>) {
    const key = gradeKey(groupKey, pickKey);
    // User edit removes the "inherited" marker — it's now a grade in this experiment.
    const prior = grades[key] ?? {};
    const { inheritedFrom: _drop, ...priorWithoutInherit } = prior;
    grades = { ...grades, [key]: { ...priorWithoutInherit, ...patch } };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const g = grades[key];
      await fetch(`/api/experiments/${selectedId}/grade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          severity: g.severity,
          keepBias: g.keepBias,
          note: g.note,
        }),
      });
    }, 250);
  }

  function nextGroup() {
    if (groupIdx < results.length - 1) { groupIdx++; activePickIdx = 0; }
  }
  function prevGroup() {
    if (groupIdx > 0) { groupIdx--; activePickIdx = 0; }
  }
  // Skip groups where every pick bundle already has a severity (including inherited).
  // Stops at the next group with at least one ungraded bundle.
  function nextUngradedGroup() {
    for (let i = groupIdx + 1; i < results.length; i++) {
      if (ungradedBundlesOf(results[i]).length > 0) { groupIdx = i; activePickIdx = 0; return; }
    }
  }
  function prevUngradedGroup() {
    for (let i = groupIdx - 1; i >= 0; i--) {
      if (ungradedBundlesOf(results[i]).length > 0) { groupIdx = i; activePickIdx = 0; return; }
    }
  }
  function cyclePick(dir: 1 | -1) {
    if (!pickBundles.length) return;
    activePickIdx = (activePickIdx + dir + pickBundles.length) % pickBundles.length;
  }

  $: photos = (() => {
    if (!currentGroup) return [] as Array<{ id: string; filename: string; userKept: boolean; allPicks: string[] }>;
    const g = currentGroup;
    const userKeepSet = new Set(g.group.userKeepIds);
    return g.group.assetIds.map((id, i) => {
      const picks: string[] = [];
      for (const v of g.variants) if (v.bestPicks.includes(i)) picks.push(v.variant);
      return {
        id,
        filename: g.group.filenames?.[i] ?? '',
        userKept: userKeepSet.has(id),
        allPicks: picks,
      };
    });
  })();

  $: activePicksSet = activeBundle ? new Set(activeBundle.bestPicks) : new Set<number>();

  // Progress for the current group: graded picks / total unique picks
  $: currentProgress = currentGroup
    ? {
        gradable: pickBundles.length,
        graded: pickBundles.filter((b) => hasSeverity(groupKey, b.pickKey)).length,
      }
    : { gradable: 0, graded: 0 };

  // All variant names present in the experiment
  $: variantNames = (() => {
    const names = new Set<string>();
    for (const g of results) for (const v of g.variants) names.add(v.variant);
    return [...names];
  })();

  // Per-variant summary: each variant inherits the grade of its bundle's pick.
  // Excluded groups contribute nothing to the totals.
  $: summary = (() => {
    type Row = {
      gradable: number;
      graded: number;
      sev: number[];
      bias: number[];
      f1: number[];
      keepCounts: number[];
    };
    const s: Record<string, Row> = {};
    for (const v of variantNames) {
      s[v] = { gradable: 0, graded: 0, sev: [], bias: [], f1: [], keepCounts: [] };
    }
    let excludedGroups = 0;
    for (const g of results) {
      const k = groupKeyOf(g);
      if (isExcluded(k)) { excludedGroups++; continue; }
      const userKeeps = g.group.userKeepIds ?? [];
      const userCulls = g.group.userCullIds ?? [];
      const userKeepSet = new Set(userKeeps);
      const userCullSet = new Set(userCulls);
      for (const v of g.variants) {
        if (!isGradable(v)) continue;
        s[v.variant].gradable++;
        s[v.variant].keepCounts.push(v.bestPicks.length);
        const pk = pickKeyOf(v.bestPicks);
        const gr = grades[gradeKey(k, pk)];
        if (gr?.severity !== null && gr?.severity !== undefined) {
          s[v.variant].graded++;
          s[v.variant].sev.push(gr.severity);
        }
        if (gr?.keepBias !== null && gr?.keepBias !== undefined) {
          s[v.variant].bias.push(gr.keepBias);
        }
        // F1 against user keeps — picks on user-undecided photos don't count
        if (userKeeps.length > 0) {
          const picked = v.bestPicks.map((i) => g.group.assetIds[i]).filter(Boolean);
          const tp = picked.filter((id) => userKeepSet.has(id)).length;
          const fp = picked.filter((id) => userCullSet.has(id)).length;
          const p = tp + fp > 0 ? tp / (tp + fp) : 0;
          const r = tp / userKeeps.length;
          const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
          s[v.variant].f1.push(f1);
        }
      }
    }
    return { perVariant: s, excludedGroups };
  })();

  function avg(xs: number[]): string {
    if (!xs.length) return '-';
    return (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  }

  function handleKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;

    if (e.key === '?') { helpOpen = !helpOpen; e.preventDefault(); return; }
    if (helpOpen && e.key === 'Escape') { helpOpen = false; return; }
    if (helpOpen) return;

    // Preview overlay: Esc or v closes, arrows navigate within group
    if (previewIdx !== null) {
      if (e.key === 'Escape' || e.key === 'v') { previewIdx = null; e.preventDefault(); return; }
      if (e.key === 'ArrowRight' || e.key === 'l') {
        previewIdx = Math.min(photos.length - 1, previewIdx + 1); e.preventDefault(); return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'h') {
        previewIdx = Math.max(0, previewIdx - 1); e.preventDefault(); return;
      }
      return;
    }

    if (!activeBundle) return;
    const activeGrade = (grades[gradeKey(groupKey, activeBundle.pickKey)] ?? {}) as Grade;

    if ((e.key === 'ArrowRight' || e.key === 'N') && e.shiftKey) { nextUngradedGroup(); e.preventDefault(); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'P') && e.shiftKey) { prevUngradedGroup(); e.preventDefault(); return; }
    if (e.key === 'n' || e.key === 'ArrowRight' || e.key === ' ') { nextGroup(); e.preventDefault(); return; }
    if (e.key === 'p' || e.key === 'ArrowLeft') { prevGroup(); e.preventDefault(); return; }

    if (e.key === 'ArrowDown' || e.key === 'j') { cyclePick(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp' || e.key === 'k') { cyclePick(-1); e.preventDefault(); return; }

    if (e.key === '0' || e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
      const s = parseInt(e.key, 10);
      const cur = activeGrade.severity;
      setGrade(activeBundle.pickKey, { severity: cur === s ? null : s });
      e.preventDefault();
      return;
    }
    if (e.key === ',') {
      const cur = activeGrade.keepBias;
      setGrade(activeBundle.pickKey, { keepBias: cur === -1 ? null : -1 });
      e.preventDefault();
      return;
    }
    if (e.key === '.') {
      const cur = activeGrade.keepBias;
      setGrade(activeBundle.pickKey, { keepBias: cur === 0 ? null : 0 });
      e.preventDefault();
      return;
    }
    if (e.key === '/') {
      const cur = activeGrade.keepBias;
      setGrade(activeBundle.pickKey, { keepBias: cur === 1 ? null : 1 });
      e.preventDefault();
      return;
    }

    if (e.key === '=') { copyPrevGrade(); cyclePick(1); e.preventDefault(); return; }

    if (e.key === 'v') {
      if (previewIdx !== null) {
        previewIdx = null;
      } else {
        const target = activeBundle.bestPicks[0] ?? 0;
        if (target < photos.length) previewIdx = target;
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'r') { blindMode = !blindMode; e.preventDefault(); return; }

    // Exclude this group from the test set (bad data: ephemeral screenshots, etc.)
    if (e.key === 'x') { toggleExcludeCurrent(); e.preventDefault(); return; }
  }
</script>

<svelte:window on:keydown={handleKey} />

<div class="grader">
  <div class="top-bar">
    <select class="exp-picker" bind:value={selectedId} on:change={(e) => loadExperiment((e.target as HTMLSelectElement).value)}>
      {#each experiments.filter((e) => !e.archived) as e}
        <option value={e.id}>{e.id}</option>
      {/each}
      {#if experiments.some((e) => e.archived)}
        <option disabled>──────── archived ────────</option>
        {#each experiments.filter((e) => e.archived) as e}
          <option value={e.id}>(archived) {e.id}</option>
        {/each}
      {/if}
    </select>
    <button on:click={prevGroup} disabled={groupIdx === 0} title="prev (p)">◀</button>
    <span class="nav-idx">{groupIdx + 1}/{results.length}</span>
    <button on:click={nextGroup} disabled={groupIdx >= results.length - 1} title="next (n/space)">▶</button>
    {#if currentGroup}
      {@const excluded = isExcluded(groupKey)}
      <span class="subgroup-label" class:excluded>{currentGroup.group.subgroupId}</span>
      <span class="top-meta">{currentGroup.group.assetIds.length}p · {currentGroup.group.type}</span>
      <span class="batch-id">{currentGroup.group.batchId}</span>
      {#if excluded}
        <span class="excluded-badge" title="Group excluded from test set (x to re-include)">EXCLUDED</span>
      {:else}
        <span class="progress">{currentProgress.graded}/{currentProgress.gradable} graded</span>
      {/if}
      <button class="exclude-btn" on:click={toggleExcludeCurrent} title="Exclude/include this group (x)">{excluded ? 'include' : 'exclude'}</button>
      {#if !blindMode}
        {@const userKeepCount = currentGroup.group.userKeepIds.length}
        {@const userCullCount = currentGroup.group.userCullIds.length}
        {@const total = currentGroup.group.assetIds.length}
        {#if userKeepCount + userCullCount > 10}
          <span class="user-keep" title="user kept / user culled / total in group">
            user <b>{userKeepCount}k / {userCullCount}c</b> of {total}
          </span>
        {:else}
          <span class="user-keep">U:{#each currentGroup.group.userKeepIds as id}<span class="idx-badge">{currentGroup.group.assetIds.indexOf(id)}</span>{/each}</span>
        {/if}
      {:else}
        <span class="hidden-note">user hidden · <kbd>r</kbd></span>
      {/if}
    {/if}
    <label class="blind-toggle" title="Hide user's picks while grading (r to toggle)">
      <input type="checkbox" bind:checked={blindMode} />
      blind
    </label>
    <button class="help-btn" on:click={() => helpOpen = !helpOpen} title="Show help (?)">?</button>
  </div>

  {#if inheritedNotice}
    <div class="inherited-banner">
      <span>↩</span>
      Inherited <b>{inheritedNotice.count}</b> grade{inheritedNotice.count === 1 ? '' : 's'}
      from prior experiment{inheritedNotice.sources.length === 1 ? '' : 's'}:
      {#each inheritedNotice.sources as src, i}
        <code>{src}</code>{i < inheritedNotice.sources.length - 1 ? ', ' : ''}
      {/each}
      · Same (group, pick) key — edit any row to take ownership in this experiment.
      <button type="button" class="dismiss" on:click={() => inheritedNotice = null}>dismiss</button>
    </div>
  {/if}

  {#if loading}
    <div class="empty">Loading...</div>
  {:else if !currentGroup}
    <div class="empty">No experiment loaded.</div>
  {:else}
    {@const g = currentGroup}
    <div class="pinned-top">
    <div class="photo-grid" bind:this={gridContainer} style="height: {gridHeight}px">
      {#each photos as a, i (a.id)}
        {@const rect = gridRects[i]}
        {@const isActivePick = activePicksSet.has(i)}
        <div class="photo"
          role="button"
          tabindex="0"
          class:user-kept={!blindMode && a.userKept}
          class:active-pick={isActivePick}
          style={rect ? `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px` : 'display:none'}
          title={a.filename + ' — click to preview'}
          on:click={() => previewIdx = i}
          on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { previewIdx = i; e.preventDefault(); } }}
        >
          <img src="/api/preview?id={encodeURIComponent(a.id)}&size=preview" alt="photo {i}" loading="lazy" />
          <div class="idx">{i}</div>
          <div class="fname">{a.filename}</div>
          <div class="badges">
            {#if !blindMode && a.userKept}<span class="bdg user" title="User kept">U</span>{/if}
            {#if isActivePick}<span class="bdg active-var">★ pick</span>{/if}
          </div>
        </div>
      {/each}
    </div>
    </div>

    <div class="scroll-area">
    {#if isExcluded(groupKey)}
      <div class="excluded-notice">
        This group is excluded from the test set. Any grades below are preserved but won't be counted.
        Press <kbd>x</kbd> to include again.
      </div>
    {/if}
    <div class="variants" class:dimmed={isExcluded(groupKey)}>
      {#each pickBundles as b, bi}
        {@const grade = grades[gradeKey(groupKey, b.pickKey)] ?? {}}
        {@const isActive = bi === activePickIdx}
        {@const picksStr = b.bestPicks.length > 12
          ? b.bestPicks.slice(0, 12).join(',') + `,…(+${b.bestPicks.length - 12})`
          : b.bestPicks.join(',')}
        {@const matchesUser = !blindMode && b.variants.some((v) => v.matchesUser === true)}
        {@const totalPhotos = currentGroup?.group.assetIds.length ?? 0}
        {@const userKeepSet = new Set(currentGroup?.group.userKeepIds ?? [])}
        {@const userCullSet = new Set(currentGroup?.group.userCullIds ?? [])}
        {@const pickAssetIds = b.bestPicks.map((i) => currentGroup?.group.assetIds[i]).filter(Boolean) as string[]}
        {@const tp = pickAssetIds.filter((id) => userKeepSet.has(id)).length}
        {@const fp = pickAssetIds.filter((id) => userCullSet.has(id)).length}
        {@const fn = (currentGroup?.group.userKeepIds.length ?? 0) - tp}
        {@const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0}
        {@const recall = (currentGroup?.group.userKeepIds.length ?? 0) > 0 ? tp / currentGroup!.group.userKeepIds.length : 0}
        {@const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0}
        <div
          role="button"
          tabindex="0"
          class="variant pick-bundle"
          class:active={isActive}
          class:graded={grade.severity !== null && grade.severity !== undefined}
          class:inherited-grade={!!grade.inheritedFrom}
          bind:this={bundleRefs[bi]}
          on:click={() => activePickIdx = bi}
          on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { activePickIdx = bi; e.preventDefault(); } }}
        >
          <div class="vhead">
            <span class="vidx">{bi + 1}</span>
            <span class="keep-count">{b.bestPicks.length}/{totalPhotos} kept</span>
            <span class="pick">[{picksStr}]</span>
            <span class="variant-chips">
              {#each b.variants as v}
                <span class="chip" title="{v.variant} · {v.elapsed.toFixed(1)}s">{v.variant}</span>
              {/each}
            </span>
            {#if grade.inheritedFrom}
              <span class="inherited" title="Grade carried over from {grade.inheritedFrom} — edit to take ownership in this experiment.">
                ↩ from {grade.inheritedFrom}
              </span>
            {/if}
            {#if !blindMode && (currentGroup?.group.userKeepIds.length ?? 0) > 0}
              <span class="metrics" title="against user's keep set — precision={precision.toFixed(2)} recall={recall.toFixed(2)}">
                F1 <b>{f1.toFixed(2)}</b> · tp{tp} fp{fp} fn{fn}
              </span>
            {/if}
          </div>
          <div class="reasons">
            {#each b.variants as v}
              <div class="variant-reason"><span class="reason-label">{v.variant}:</span> {v.reason}</div>
            {/each}
          </div>

          <div class="ctrls" role="presentation" on:click|stopPropagation on:keydown|stopPropagation>
            <div class="ctrl">
              <span class="ctrl-label">severity</span>
              {#each [0, 1, 2, 3, 4] as s}
                <button
                  type="button"
                  class="pill sev sev-{s}"
                  class:on={grade.severity === s}
                  on:click={() => setGrade(b.pickKey, { severity: grade.severity === s ? null : s })}
                  title={SEVERITY_TITLES[s]}
                >{s} {SEVERITY_LABELS[s]}</button>
              {/each}
            </div>
            <div class="ctrl">
              <span class="ctrl-label">keep</span>
              {#each [-1, 0, 1] as bias}
                <button
                  type="button"
                  class="pill bias"
                  class:on={grade.keepBias === bias}
                  on:click={() => setGrade(b.pickKey, { keepBias: grade.keepBias === bias ? null : bias })}
                >{BIAS_LABELS[bias + 1]}</button>
              {/each}
            </div>
            <input
              type="text"
              class="note"
              placeholder="note — Esc/Enter to escape"
              value={grade.note ?? ''}
              on:input={(e) => setGrade(b.pickKey, { note: (e.target as HTMLInputElement).value })}
              on:keydown={(e) => {
                if (e.key === 'Escape' || e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                  e.preventDefault();
                }
              }}
            />
          </div>
        </div>
      {/each}

      {#if g.variants.some((v) => !isGradable(v))}
        <div class="errored-list">
          Errored/empty:
          {#each g.variants.filter((v) => !isGradable(v)) as v}
            <span class="chip chip-bad" title={v.reason}>{v.variant}</span>
          {/each}
        </div>
      {/if}
    </div>

    <div class="roll-up">
      <h4>Across experiment ({results.length - summary.excludedGroups} scored · {summary.excludedGroups} excluded)</h4>
      <table>
        <thead><tr><th>variant</th><th>graded</th><th>avg sev</th><th>avg bias</th><th>avg F1 (vs user)</th><th>avg keep count</th></tr></thead>
        <tbody>
          {#each variantNames as v}
            <tr>
              <td>{v}</td>
              <td>{summary.perVariant[v]?.graded ?? 0} / {summary.perVariant[v]?.gradable ?? 0}</td>
              <td>{avg(summary.perVariant[v]?.sev ?? [])}</td>
              <td>{avg(summary.perVariant[v]?.bias ?? [])}</td>
              <td>{avg(summary.perVariant[v]?.f1 ?? [])}</td>
              <td>{avg(summary.perVariant[v]?.keepCounts ?? [])}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    </div>
  {/if}

  {#if previewIdx !== null && photos[previewIdx]}
    {@const p = photos[previewIdx]}
    <div class="lightbox" role="presentation" on:click={() => previewIdx = null} on:keydown={() => {}}>
      <div class="lightbox-info">
        <span class="idx-big">{previewIdx}</span>
        <span>{p.filename}</span>
        {#if !blindMode && p.userKept}<span class="tag">user kept</span>{/if}
        {#if activePicksSet.has(previewIdx)}<span class="tag orange">active pick</span>{/if}
        <span class="hint">Esc close · ←/→ navigate</span>
      </div>
      <div class="lightbox-img-wrap" role="presentation" on:click|stopPropagation on:keydown|stopPropagation>
        <img
          class="lightbox-img"
          src="/api/preview?id={encodeURIComponent(p.id)}&size=preview"
          alt="photo {previewIdx}"
          on:error={(e) => console.error('lightbox image load failed', (e.target as HTMLImageElement).src)}
        />
      </div>
    </div>
  {/if}

  {#if helpOpen}
    <div class="help-backdrop" role="presentation" on:click={() => helpOpen = false} on:keydown={() => {}}>
      <div class="help-modal" role="dialog" tabindex="-1" aria-label="Help" on:click|stopPropagation on:keydown|stopPropagation>
        <h3>Grading help</h3>
        <p>
          For each subgroup (a set of near-duplicate photos), the models pick the photo(s) they think are the best.
          Grading is keyed on the <em>pick</em>, not the model — so when several models picked identically,
          they're bundled into one row and share a single grade. You're judging the choice, not the model.
        </p>
        <h4>Dimensions</h4>
        <ul>
          <li><strong>Severity</strong> — how do you feel about this pick?
            <ul>
              <li><code>0 perfect</code> — I'd have picked this myself</li>
              <li><code>1 fine</code> — acceptable alternative, no regret</li>
              <li><code>2 meh</code> — noticeable but minor regression</li>
              <li><code>3 sad</code> — a real regression vs ideal</li>
              <li><code>4 😢</code> — painful miss (e.g. kept a blink, culled the hero)</li>
            </ul>
          </li>
          <li><strong>Keep count</strong> — did it keep too few / right / too many? Independent of whether the pick itself was wrong.</li>
        </ul>
        <h4>Keyboard</h4>
        <table class="kbd-table">
          <thead><tr><th>key</th><th>action</th></tr></thead>
          <tbody>
            <tr><td><kbd>n</kbd> / <kbd>space</kbd> / <kbd>→</kbd></td><td>next group</td></tr>
            <tr><td><kbd>p</kbd> / <kbd>←</kbd></td><td>prev group</td></tr>
            <tr><td><kbd>Shift</kbd>+<kbd>→</kbd> / <kbd>Shift</kbd>+<kbd>N</kbd></td><td>next group with <strong>ungraded</strong> bundles (skip inherited-only)</td></tr>
            <tr><td><kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>Shift</kbd>+<kbd>P</kbd></td><td>previous ungraded group</td></tr>
            <tr><td><kbd>↑</kbd> / <kbd>↓</kbd> / <kbd>j</kbd> <kbd>k</kbd></td><td>cycle active pick bundle</td></tr>
            <tr><td><kbd>0</kbd> <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></td><td>severity for active pick: 0=perfect → 4=very sad (press again to clear)</td></tr>
            <tr><td><kbd>,</kbd></td><td>keep: too few</td></tr>
            <tr><td><kbd>.</kbd></td><td>keep: right</td></tr>
            <tr><td><kbd>/</kbd></td><td>keep: too many</td></tr>
            <tr><td><kbd>=</kbd></td><td>copy grade from most-recently-graded sibling pick, then advance</td></tr>
            <tr><td><kbd>v</kbd></td><td>toggle preview of active pick's first photo</td></tr>
            <tr><td><kbd>r</kbd></td><td>toggle blind mode (hide user's picks)</td></tr>
            <tr><td><kbd>x</kbd></td><td>exclude/include this group (for bad data like ephemeral screenshots)</td></tr>
            <tr><td><kbd>?</kbd> / <kbd>Esc</kbd></td><td>toggle this help</td></tr>
          </tbody>
        </table>
        <p class="small">Grades auto-save. Close with <kbd>Esc</kbd> or click outside.</p>
      </div>
    </div>
  {/if}
</div>

<style>
  .grader {
    padding: 8px 12px;
    color: #e0e0e0;
    background: #1e1e1e;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .pinned-top { flex: 0 0 auto; }
  .scroll-area { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding-right: 4px; }
  .top-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; font-size: 12px; flex-wrap: nowrap; overflow-x: auto; white-space: nowrap; }
  .top-bar .exp-picker { background: #2a2a2a; color: #fff; border: 1px solid #444; padding: 3px 6px; font-size: 12px; max-width: 200px; }
  .top-bar button { background: #333; color: #fff; border: 1px solid #555; padding: 3px 10px; cursor: pointer; font-size: 12px; border-radius: 3px; }
  .top-bar button:disabled { opacity: 0.4; cursor: not-allowed; }
  .nav-idx { font-family: monospace; color: #ccc; min-width: 48px; text-align: center; }
  .top-meta { color: #aaa; }
  .progress { color: #f0a040; font-weight: 500; }
  .user-keep { display: inline-flex; align-items: center; gap: 3px; color: #aaa; }
  .user-keep b { color: #6d9e6d; font-weight: 600; margin: 0 2px; }
  .hidden-note { color: #666; font-style: italic; font-size: 11px; }
  .hidden-note kbd { background: #333; border: 1px solid #555; padding: 0 4px; border-radius: 2px; font-family: monospace; color: #f0a040; }
  .blind-toggle { display: flex; gap: 3px; align-items: center; cursor: pointer; color: #888; }
  .help-btn { margin-left: auto; padding: 3px 10px !important; font-weight: bold; }
  .subgroup-label { background: #333; padding: 2px 8px; border-radius: 3px; font-family: monospace; color: #f0a040; }
  .subgroup-label.excluded { color: #666; text-decoration: line-through; }
  .excluded-badge { background: #552222; color: #ff9999; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; letter-spacing: 0.5px; }
  .exclude-btn { background: #333 !important; color: #aaa !important; border: 1px solid #555 !important; font-size: 11px !important; padding: 2px 8px !important; }
  .exclude-btn:hover { background: #444 !important; color: #fff !important; }
  .batch-id { color: #666; font-family: monospace; font-size: 11px; }
  .idx-badge { background: #3e6d3e; color: #fff; padding: 1px 6px; border-radius: 3px; font-family: monospace; font-size: 11px; }

  .photo-grid { position: relative; width: 100%; margin-bottom: 16px; }
  .photo { position: absolute; border: 3px solid transparent; border-radius: 4px; overflow: hidden; background: #2a2a2a; transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s; cursor: zoom-in; }
  .photo:focus { outline: none; }
  .reason { font-size: 12px; color: #999; margin-bottom: 10px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .photo.user-kept { border-color: #3e6d3e; }
  .photo.active-pick { border-color: #f0a040; transform: scale(1.02); box-shadow: 0 0 12px rgba(240, 160, 64, 0.5); }
  .photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .idx { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,0.75); color: #fff; padding: 2px 8px; border-radius: 3px; font-weight: bold; font-family: monospace; }
  .fname { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,0.65); color: #bbb; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-family: monospace; max-width: 65%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badges { position: absolute; bottom: 4px; left: 4px; right: 4px; display: flex; flex-wrap: wrap; gap: 3px; }
  .bdg { padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; }
  .bdg.user { background: #3e6d3e; color: #fff; }
  .bdg.active-var { background: #f0a040; color: #1e1e1e; }

  .variants { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
  .variant {
    border: 2px solid #333; border-radius: 4px; padding: 10px 12px;
    background: #242424; color: inherit; text-align: left; cursor: pointer;
    transition: border-color 0.1s, background 0.1s;
    font: inherit;
  }
  .variant:hover { background: #2a2a2a; }
  .variant.active {
    border-color: #f0a040;
    background: #2a2a24;
    box-shadow: 0 0 0 1px #f0a04066;
  }
  .variant.bad { opacity: 0.5; }
  .variant.graded { background: #242e24; }
  .variant.graded.active { background: #2a342a; }
  .vhead { display: flex; gap: 10px; align-items: center; font-size: 14px; margin-bottom: 4px; flex-wrap: wrap; }
  .variant-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
  .variant-chips .chip { background: #333; color: #bbb; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-family: monospace; }
  .reasons { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .variant-reason { font-size: 12px; color: #999; line-height: 1.45; }
  .reason-label { color: #f0a040; font-family: monospace; font-size: 11px; }
  .errored-list { padding: 8px 10px; color: #888; font-size: 11px; border-top: 1px dashed #333; margin-top: 8px; }
  .errored-list .chip-bad { background: #3a1f1f; color: #a06868; padding: 1px 6px; border-radius: 8px; font-family: monospace; font-size: 10px; margin-left: 4px; }
  .vidx { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; background: #444; border-radius: 50%; font-size: 11px; font-weight: bold; color: #ccc; }
  .variant.active .vidx { background: #f0a040; color: #1e1e1e; }
  .pick { font-family: monospace; color: #888; font-size: 12px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
  .keep-count { background: #2a3f2a; color: #a8d5a8; padding: 1px 8px; border-radius: 3px; font-family: monospace; font-size: 12px; font-weight: 500; }
  .metrics { font-size: 11px; color: #888; font-family: monospace; margin-left: 4px; }
  .metrics b { color: #e0a040; }
  .inherited { font-size: 10px; color: #9fb5d4; background: #1f2a3a; padding: 1px 6px; border-radius: 3px; font-family: monospace; font-style: italic; border: 1px solid #2a4060; }
  .inherited-banner {
    margin: 0 0 8px; padding: 8px 12px;
    background: #1f2a3a; border: 1px solid #2a4060; border-radius: 4px;
    color: #c9d7ea; font-size: 12px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  }
  .inherited-banner b { color: #e0a040; }
  .inherited-banner code { background: #121820; color: #9fb5d4; padding: 1px 6px; border-radius: 3px; font-family: monospace; font-size: 11px; }
  .inherited-banner .dismiss { margin-left: auto; background: transparent; border: 1px solid #2a4060; color: #9fb5d4; padding: 2px 10px; border-radius: 3px; cursor: pointer; font-size: 11px; }
  .inherited-banner .dismiss:hover { background: #2a4060; color: #fff; }
  .variant.graded.inherited-grade { background: #232a34; border-color: #3a527a; }
  .variant.graded.inherited-grade.active { background: #2a3550; border-color: #5a7db0; }
  .umatch { font-size: 12px; color: #888; }
  .umatch.ok { color: #6d9e6d; }
  .umatch.off { color: #c08040; }
  .elapsed { margin-left: auto; color: #666; font-size: 11px; font-family: monospace; }

  .ctrls { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .ctrl { display: flex; gap: 4px; align-items: center; }
  .ctrl-label { font-size: 11px; color: #777; text-transform: uppercase; margin-right: 4px; letter-spacing: 0.5px; }
  .pill {
    background: #333; color: #bbb; border: 1px solid #4a4a4a;
    padding: 5px 12px; border-radius: 14px; cursor: pointer; font-size: 12px;
    transition: all 0.12s;
  }
  .pill:hover { background: #3d3d3d; color: #fff; }
  /* Strong selected states, distinct per dimension */
  .pill.sev.on { color: #fff; font-weight: bold; border-width: 2px; padding: 4px 11px; }
  .pill.sev-0.on { background: #1a4a6a; border-color: #5cb0ff; }  /* perfect: blue */
  .pill.sev-1.on { background: #2a5a2a; border-color: #4caf50; }  /* fine: green */
  .pill.sev-2.on { background: #665520; border-color: #c9a830; }  /* meh: yellow */
  .pill.sev-3.on { background: #8a4a1f; border-color: #e07c2a; }  /* sad: orange */
  .pill.sev-4.on { background: #7a2a2a; border-color: #d04040; }  /* 😢: red */
  .pill.bias.on { background: #2a4e7a; border-color: #5590cc; color: #fff; font-weight: bold; border-width: 2px; padding: 4px 11px; }
  .note { background: #1a1a1a; color: #ddd; border: 1px solid #444; padding: 5px 10px; min-width: 180px; flex: 1; font-size: 12px; border-radius: 3px; }
  .note:focus { outline: 1px solid #f0a040; }

  .roll-up { margin-top: 24px; padding-top: 12px; border-top: 1px solid #333; }
  .roll-up h4 { margin: 0 0 8px; font-size: 13px; color: #aaa; font-weight: 500; }
  .roll-up table { border-collapse: collapse; }
  .roll-up th, .roll-up td { padding: 4px 14px; text-align: left; border-bottom: 1px solid #2a2a2a; font-size: 12px; }
  .roll-up th { color: #888; font-weight: 500; }
  .empty { text-align: center; padding: 40px; color: #888; }
  .excluded-notice { background: #3a2222; color: #e8b4b4; padding: 8px 14px; border: 1px solid #552222; border-radius: 4px; margin-bottom: 10px; font-size: 13px; }
  .excluded-notice kbd { background: #2a2a2a; border: 1px solid #555; padding: 0 6px; border-radius: 2px; color: #f0a040; font-family: monospace; }
  .variants.dimmed { opacity: 0.5; }

  /* Lightbox */
  .lightbox {
    position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 900;
    display: flex; align-items: center; justify-content: center; cursor: zoom-out;
  }
  .lightbox-img { max-width: 95vw; max-height: 90vh; object-fit: contain; cursor: default; }
  .lightbox-info {
    position: absolute; top: 16px; left: 16px; right: 16px;
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    color: #e0e0e0; font-size: 13px;
    background: rgba(0,0,0,0.5); padding: 8px 14px; border-radius: 4px;
  }
  .lightbox-info .idx-big { background: #f0a040; color: #1e1e1e; padding: 2px 10px; border-radius: 3px; font-weight: bold; font-family: monospace; }
  .lightbox-info .tag { background: #3e6d3e; padding: 2px 8px; border-radius: 3px; font-size: 11px; }
  .lightbox-info .tag.orange { background: #f0a040; color: #1e1e1e; }
  .lightbox-info .hint { margin-left: auto; color: #888; font-size: 11px; }

  /* Help modal */
  .help-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 1000; }
  .help-modal { background: #222; border: 1px solid #555; border-radius: 8px; max-width: 640px; max-height: 80vh; overflow-y: auto; padding: 20px 28px; color: #e0e0e0; }
  .help-modal h3 { margin: 0 0 10px; color: #f0a040; }
  .help-modal h4 { margin: 14px 0 6px; color: #ccc; font-size: 14px; }
  .help-modal p { font-size: 13px; line-height: 1.5; color: #bbb; }
  .help-modal ul { margin: 6px 0 0 16px; font-size: 13px; color: #bbb; }
  .help-modal ul ul { margin-top: 4px; }
  .help-modal li { margin: 3px 0; }
  .help-modal kbd {
    display: inline-block; background: #333; border: 1px solid #555; border-bottom-width: 2px;
    padding: 0 6px; border-radius: 3px; font-family: monospace; font-size: 11px; color: #f0a040;
    margin: 0 1px;
  }
  .help-modal code { background: #333; padding: 1px 5px; border-radius: 2px; font-size: 12px; color: #f0a040; }
  .help-modal .kbd-table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  .help-modal .kbd-table th, .help-modal .kbd-table td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #333; font-size: 12px; }
  .help-modal .kbd-table th { color: #888; font-weight: 500; }
  .help-modal .small { font-size: 11px; color: #888; margin-top: 10px; }
</style>
