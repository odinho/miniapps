<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchBurstGroups, thumbUrl, type BurstGroupRow } from '../lib/api';

  export let onGoToBatch: (batchId: string) => void = () => {};

  let groups: BurstGroupRow[] = [];
  let loading = true;
  let container: HTMLDivElement = undefined!;
  let scrollY = 0;
  let viewportH = 800;

  const ROW_H = 140; // height of each subgroup row in px

  onMount(async () => {
    const r = await fetchBurstGroups();
    groups = r.groups;
    loading = false;
    // Wait for DOM update, then measure viewport
    requestAnimationFrame(() => {
      if (container) {
        viewportH = container.clientHeight;
        container.addEventListener('scroll', onScroll, { passive: true });
        const ro = new ResizeObserver(() => { viewportH = container.clientHeight; });
        ro.observe(container);
      }
    });
  });

  function onScroll() {
    scrollY = container?.scrollTop ?? 0;
  }

  // Virtualize: only render rows within viewport + buffer
  $: firstIdx = Math.max(0, Math.floor(scrollY / ROW_H) - 5);
  $: lastIdx = Math.min(groups.length, Math.ceil((scrollY + viewportH) / ROW_H) + 5);
  $: visible = groups.slice(firstIdx, lastIdx).map((g, i) => ({ g, idx: firstIdx + i }));
  $: totalH = groups.length * ROW_H;

  function fmtDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('no', { day: 'numeric', month: 'short', year: '2-digit' });
  }
</script>

<div class="burst-inspect">
  <div class="bi-header">
    <h2>Burst Inspector</h2>
    {#if !loading}
      <span class="bi-stats">
        {groups.length} groups ·
        {groups.reduce((s, g) => s + g.autoCulledIds.length, 0)} auto-culled ·
        {groups.reduce((s, g) => s + g.keeperIds.length, 0)} kept
      </span>
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
               on:click={() => onGoToBatch(g.batchId)} role="button" tabindex="-1"
               title={g.rationale || g.summary}>
            <div class="bi-meta">
              <div class="bi-date">{fmtDate(g.batchDate)}</div>
              <div class="bi-type">{g.subgroupType}</div>
              <div class="bi-count">{g.keeperIds.length + g.loserIds.length} photos</div>
              <div class="bi-autoculled">{g.autoCulledIds.length} auto-culled</div>
            </div>
            <div class="bi-photos">
              <div class="bi-keepers">
                {#each g.keeperIds as id}
                  <img src={thumbUrl(id)} alt="" loading="lazy" class="bi-keeper-img" />
                {/each}
              </div>
              {#if g.loserIds.length > 0}
                <div class="bi-sep"></div>
                <div class="bi-losers">
                  {#each g.loserIds as id}
                    {@const isAuto = g.autoCulledIds.includes(id)}
                    <img src={thumbUrl(id)} alt="" loading="lazy"
                         class="bi-loser-img" class:bi-auto={isAuto} />
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .burst-inspect { display: flex; flex-direction: column; height: 100%; background: #0b0d11; }
  .bi-header { padding: 10px 16px; border-bottom: 1px solid #1e2028; display: flex; align-items: baseline; gap: 16px; flex-shrink: 0; }
  .bi-header h2 { font-size: 16px; color: #f0a040; margin: 0; }
  .bi-stats { color: #888; font-size: 12px; }
  .bi-loading { padding: 40px; text-align: center; color: #666; }
  .bi-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; }
  .bi-spacer { position: relative; }
  .bi-row { position: absolute; left: 0; right: 0; height: 140px; padding: 8px 12px; border-bottom: 1px solid #15171d; display: flex; gap: 12px; cursor: pointer; box-sizing: border-box; }
  .bi-row:hover { background: #13161c; }
  .bi-meta { flex-shrink: 0; width: 120px; display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: #888; padding-top: 4px; }
  .bi-date { color: #ddd; font-weight: 600; font-size: 12px; }
  .bi-type { color: #f0a040; text-transform: uppercase; font-size: 9px; letter-spacing: .5px; }
  .bi-count { color: #aaa; }
  .bi-autoculled { color: #ff9800; font-weight: 600; }
  .bi-photos { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
  .bi-keepers { display: flex; gap: 4px; flex-shrink: 0; }
  .bi-keeper-img { height: 120px; width: auto; max-width: 180px; object-fit: cover; border: 2px solid #4caf50; border-radius: 3px; }
  .bi-sep { width: 1px; height: 100px; background: #2a2e36; margin: 0 6px; flex-shrink: 0; }
  .bi-losers { display: flex; gap: 3px; flex-shrink: 1; min-width: 0; overflow: hidden; }
  .bi-loser-img { height: 80px; width: auto; max-width: 120px; object-fit: cover; border: 1px solid rgba(229,57,53,.4); border-radius: 2px; opacity: 0.55; }
  .bi-loser-img.bi-auto { border-color: #ff9800; opacity: 0.7; }
</style>
