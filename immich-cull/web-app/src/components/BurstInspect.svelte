<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fetchBurstGroups, thumbUrl, previewUrl, type BurstGroupRow } from '../lib/api';

  export let onGoToBatch: (batchId: string) => void = () => {};

  let groups: BurstGroupRow[] = [];
  let loading = true;
  let container: HTMLDivElement = undefined!;
  let scrollY = 0;
  let viewportH = 800;
  let hideReviewed = true;
  let hoverId: string | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;

  const ROW_H = 140;
  const SCROLL_KEY = 'burstInspect.scrollY';
  const HIDE_KEY = 'burstInspect.hideReviewed';

  $: visibleGroups = hideReviewed ? groups.filter((g) => !g.batchReviewed) : groups;
  $: totalH = visibleGroups.length * ROW_H;
  $: firstIdx = Math.max(0, Math.floor(scrollY / ROW_H) - 5);
  $: lastIdx = Math.min(visibleGroups.length, Math.ceil((scrollY + viewportH) / ROW_H) + 5);
  $: visible = visibleGroups.slice(firstIdx, lastIdx).map((g, i) => ({ g, idx: firstIdx + i }));

  onMount(async () => {
    // Restore prefs
    const savedHide = sessionStorage.getItem(HIDE_KEY);
    if (savedHide !== null) hideReviewed = savedHide === 'true';

    const r = await fetchBurstGroups();
    groups = r.groups;
    loading = false;

    requestAnimationFrame(() => {
      if (container) {
        viewportH = container.clientHeight;
        container.addEventListener('scroll', onScroll, { passive: true });
        const ro = new ResizeObserver(() => { viewportH = container.clientHeight; });
        ro.observe(container);
        // Restore scroll position
        const savedY = sessionStorage.getItem(SCROLL_KEY);
        if (savedY) {
          const y = parseInt(savedY, 10);
          container.scrollTop = y;
          scrollY = y;
        }
      }
    });
  });

  onDestroy(() => {
    if (container) sessionStorage.setItem(SCROLL_KEY, String(scrollY));
    if (hoverTimer) clearTimeout(hoverTimer);
  });

  $: {
    if (typeof window !== 'undefined') sessionStorage.setItem(HIDE_KEY, String(hideReviewed));
  }

  function onScroll() {
    scrollY = container?.scrollTop ?? 0;
    sessionStorage.setItem(SCROLL_KEY, String(scrollY));
  }

  function onThumbEnter(id: string) {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { hoverId = id; }, 120);
  }
  function onThumbLeave() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { hoverId = null; }, 80);
  }

  function fmtDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('no', { day: 'numeric', month: 'short', year: '2-digit' });
  }

  function onRowClick(batchId: string) {
    if (container) sessionStorage.setItem(SCROLL_KEY, String(scrollY));
    onGoToBatch(batchId);
  }
</script>

<div class="burst-inspect">
  <div class="bi-header">
    <h2>Burst Inspector</h2>
    {#if !loading}
      <span class="bi-stats">
        {visibleGroups.length} groups ·
        {visibleGroups.reduce((s, g) => s + g.autoCulledIds.length, 0)} auto-culled ·
        {visibleGroups.reduce((s, g) => s + g.keeperIds.length, 0)} kept
        {#if hideReviewed}<span class="bi-muted">({groups.length - visibleGroups.length} reviewed hidden)</span>{/if}
      </span>
      <label class="bi-toggle">
        <input type="checkbox" bind:checked={hideReviewed} />
        Hide already-reviewed batches
      </label>
    {/if}
  </div>

  {#if loading}
    <div class="bi-loading">Loading burst groups...</div>
  {:else}
    <div class="bi-scroll" bind:this={container}>
      <div class="bi-spacer" style="height:{totalH}px">
        {#each visible as {g, idx} (g.batchId + ':' + g.subgroupId)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div class="bi-row" style="top:{idx * ROW_H}px"
               on:click={() => onRowClick(g.batchId)} role="button" tabindex="-1"
               title={g.rationale || g.summary}>
            <div class="bi-meta">
              <div class="bi-date">{fmtDate(g.batchDate)} {#if g.batchReviewed}<span class="bi-reviewed">✓</span>{/if}</div>
              <div class="bi-type">{g.subgroupType}</div>
              <div class="bi-count">{g.keeperIds.length + g.recommendedCullIds.length + g.autoCulledIds.length} photos</div>
              {#if g.autoCulledIds.length > 0}<div class="bi-autoculled">{g.autoCulledIds.length} auto-culled</div>{/if}
              {#if g.recommendedCullIds.length > 0}<div class="bi-recc">{g.recommendedCullIds.length} llm-cull</div>{/if}
            </div>
            <div class="bi-photos">
              <div class="bi-section bi-keepers">
                {#each g.keeperIds as id}
                  <img src={thumbUrl(id)} alt="" loading="lazy" width="120" height="120"
                       class="bi-img bi-keeper-img"
                       on:mouseenter={() => onThumbEnter(id)}
                       on:mouseleave={onThumbLeave} />
                {/each}
              </div>
              {#if g.autoCulledIds.length > 0}
                <div class="bi-label bi-label-auto">AUTO-CULL</div>
                <div class="bi-section">
                  {#each g.autoCulledIds as id}
                    <img src={thumbUrl(id)} alt="" loading="lazy" width="80" height="80"
                         class="bi-img bi-auto-img"
                         on:mouseenter={() => onThumbEnter(id)}
                         on:mouseleave={onThumbLeave} />
                  {/each}
                </div>
              {/if}
              {#if g.recommendedCullIds.length > 0}
                <div class="bi-label bi-label-rec">LLM-CULL</div>
                <div class="bi-section">
                  {#each g.recommendedCullIds as id}
                    <img src={thumbUrl(id)} alt="" loading="lazy" width="80" height="80"
                         class="bi-img bi-rec-img"
                         on:mouseenter={() => onThumbEnter(id)}
                         on:mouseleave={onThumbLeave} />
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if hoverId}
    <div class="bi-hover-preview">
      <img src={previewUrl(hoverId)} alt="" />
    </div>
  {/if}
</div>

<style>
  .burst-inspect { display: flex; flex-direction: column; height: 100%; background: #0b0d11; position: relative; }
  .bi-header { padding: 10px 16px; border-bottom: 1px solid #1e2028; display: flex; align-items: baseline; gap: 16px; flex-shrink: 0; flex-wrap: wrap; }
  .bi-header h2 { font-size: 16px; color: #f0a040; margin: 0; }
  .bi-stats { color: #888; font-size: 12px; }
  .bi-muted { color: #555; margin-left: 6px; }
  .bi-toggle { font-size: 12px; color: #ccc; display: flex; align-items: center; gap: 5px; cursor: pointer; margin-left: auto; }
  .bi-loading { padding: 40px; text-align: center; color: #666; }
  .bi-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; }
  .bi-spacer { position: relative; }
  .bi-row { position: absolute; left: 0; right: 0; height: 140px; padding: 8px 12px; border-bottom: 1px solid #15171d; display: flex; gap: 12px; cursor: pointer; box-sizing: border-box; }
  .bi-row:hover { background: #13161c; }
  .bi-meta { flex-shrink: 0; width: 130px; display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: #888; padding-top: 4px; }
  .bi-date { color: #ddd; font-weight: 600; font-size: 12px; }
  .bi-reviewed { color: #66bb6a; margin-left: 4px; }
  .bi-type { color: #f0a040; text-transform: uppercase; font-size: 9px; letter-spacing: .5px; }
  .bi-count { color: #aaa; }
  .bi-autoculled { color: #ff9800; font-weight: 600; }
  .bi-recc { color: #e53935; }
  .bi-photos { flex: 1; display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; }
  .bi-section { display: flex; gap: 3px; flex-shrink: 0; }
  .bi-label { font-size: 8px; letter-spacing: .5px; font-weight: 700; writing-mode: vertical-rl; transform: rotate(180deg); padding: 2px; flex-shrink: 0; }
  .bi-label-auto { color: #ff9800; }
  .bi-label-rec { color: #e53935; }
  .bi-img { object-fit: cover; background: #1a1d24; border-radius: 3px; }
  .bi-keeper-img { height: 120px; width: 120px; border: 2px solid #4caf50; }
  .bi-auto-img { height: 80px; width: 80px; border: 2px solid #ff9800; opacity: 0.75; }
  .bi-rec-img { height: 80px; width: 80px; border: 2px solid rgba(229,57,53,.5); opacity: 0.55; }
  .bi-hover-preview { position: fixed; top: 50px; right: 20px; width: 400px; height: 400px; background: rgba(0,0,0,.85); border: 1px solid #444; border-radius: 6px; z-index: 1000; pointer-events: none; box-shadow: 0 4px 20px rgba(0,0,0,.6); }
  .bi-hover-preview img { width: 100%; height: 100%; object-fit: contain; }
</style>
