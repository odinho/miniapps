<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { previewUrl } from '../lib/api';
  import type { CullComparison } from '../lib/api';

  export let comparisons: CullComparison[] = [];
  export let onKeep: (assetId: string) => void = () => {};
  export let onConfirmCull: (assetId: string) => void = () => {};

  let currentIdx = 0;
  let showHelp = false;

  $: current = comparisons[currentIdx] ?? null;
  $: progress = comparisons.length > 0 ? `${currentIdx + 1} / ${comparisons.length}` : '0 / 0';

  function next() {
    if (currentIdx < comparisons.length - 1) currentIdx++;
  }
  function prev() {
    if (currentIdx > 0) currentIdx--;
  }
  function keep() {
    if (current) { onKeep(current.cullId); next(); }
  }
  function confirmCull() {
    if (current) { onConfirmCull(current.cullId); next(); }
  }

  function handleKey(e: KeyboardEvent) {
    if (!current) return;
    switch (e.key) {
      case 'c': case 'd': confirmCull(); break;
      case 'k': case 's': keep(); break;
      case 'ArrowRight': case 'l': next(); break;
      case 'ArrowLeft': case 'h': prev(); break;
      case '?': showHelp = !showHelp; break;
    }
  }

  onMount(() => { window.addEventListener('keydown', handleKey); });
  onDestroy(() => { window.removeEventListener('keydown', handleKey); });
</script>

<div class="cr">
  <div class="cr-header">
    <span class="cr-title">Cull Review</span>
    <span class="cr-progress">{progress}</span>
    <button class="cr-nav" on:click={prev} disabled={currentIdx === 0}>Prev</button>
    <button class="cr-nav" on:click={next} disabled={currentIdx >= comparisons.length - 1}>Next</button>
    <button class="cr-nav cr-help-btn" on:click={() => showHelp = !showHelp} title="Keyboard shortcuts (?)">?</button>
  </div>

  {#if current}
    <div class="cr-reason">
      <span class="cr-sg-type">{current.subgroupType}</span>
      <span class="cr-sg-reason">{current.subgroupReason}</span>
      <span class="cr-sg-meta">{current.subgroupSize} photos, rank {current.rank + 1}</span>
    </div>

    <div class="cr-pair">
      <div class="cr-card cr-keeper">
        <div class="cr-label">KEEPER</div>
        {#each current.keepers as keeper (keeper.id)}
          <img src={previewUrl(keeper.id)} alt={keeper.filename} />
          <div class="cr-info">
            <span class="cr-stars">{'★'.repeat(keeper.stars)}</span>
            <span class="cr-note">{keeper.note}</span>
          </div>
        {/each}
      </div>

      <div class="cr-card cr-cull">
        <div class="cr-label">WOULD CULL</div>
        <img src={previewUrl(current.cullId)} alt={current.cullFilename} />
        <div class="cr-info">
          <span class="cr-stars">{'★'.repeat(current.cullStars)}</span>
          <span class="cr-note">{current.cullNote}</span>
          <span class="cr-cat">{current.cullCategory}</span>
        </div>
      </div>
    </div>

    <div class="cr-actions">
      <button class="cr-btn cr-keep" on:click={keep}>Keep This Photo <kbd>K</kbd></button>
      <button class="cr-btn cr-confirm" on:click={confirmCull}>Confirm Cull <kbd>C</kbd></button>
    </div>
  {:else}
    <div class="cr-empty">No culls to review</div>
  {/if}

  {#if showHelp}
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="help-overlay" on:click={() => showHelp = false} role="presentation">
      <div class="help-modal" on:click|stopPropagation on:keydown|stopPropagation role="dialog" aria-label="Keyboard shortcuts" tabindex="-1">
        <h3>Keyboard Shortcuts</h3>
        <div class="help-grid">
          <kbd>C</kbd> <span>Confirm cull</span>
          <kbd>D</kbd> <span>Confirm cull (alt)</span>
          <kbd>K</kbd> <span>Keep this photo</span>
          <kbd>S</kbd> <span>Keep this photo (alt)</span>
          <kbd class="wide">&larr;</kbd> <span>Previous comparison</span>
          <kbd class="wide">&rarr;</kbd> <span>Next comparison</span>
          <kbd>H</kbd> <span>Previous (vim)</span>
          <kbd>L</kbd> <span>Next (vim)</span>
          <kbd>?</kbd> <span>Toggle this help</span>
        </div>
        <button class="help-close" on:click={() => showHelp = false}>Close</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .cr { display: flex; flex-direction: column; height: 100%; background: #0e1014; }
  .cr-header { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid #2a2e36; background: #111319; }
  .cr-title { font-weight: 600; color: #f0a040; font-size: 14px; }
  .cr-progress { color: #7a8294; font-size: 12px; margin-left: auto; }
  .cr-nav { background: #2a2e36; border: none; color: #ccc; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .cr-nav:hover { background: #3a3e46; }
  .cr-nav:disabled { opacity: 0.3; cursor: default; }

  .cr-reason { padding: 6px 14px; background: #1a1d24; border-bottom: 1px solid #2a2e36; font-size: 12px; color: #7a8294; display: flex; gap: 10px; align-items: center; }
  .cr-sg-type { background: #2a2e36; padding: 2px 8px; border-radius: 3px; color: #ccc; font-weight: 500; }
  .cr-sg-reason { flex: 1; }
  .cr-sg-meta { color: #555; }

  .cr-pair { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; min-height: 0; }
  .cr-card { display: flex; flex-direction: column; min-height: 0; position: relative; border-radius: 6px; overflow: hidden; }
  .cr-card img { flex: 1; min-height: 0; object-fit: contain; background: #090b0f; }
  .cr-label { position: absolute; top: 8px; left: 8px; z-index: 1; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 3px; }
  .cr-keeper .cr-label { background: #4caf50; color: white; }
  .cr-cull .cr-label { background: #e65100; color: white; }
  .cr-info { padding: 6px 8px; background: rgba(0,0,0,0.8); font-size: 11px; color: #ccc; display: flex; gap: 8px; align-items: center; }
  .cr-stars { color: #ffd700; }
  .cr-note { flex: 1; }
  .cr-cat { color: #7a8294; }

  .cr-actions { display: flex; gap: 10px; padding: 10px 14px; border-top: 1px solid #2a2e36; background: #111319; justify-content: center; }
  .cr-btn { padding: 8px 24px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .cr-keep { background: #4caf50; color: white; }
  .cr-confirm { background: #e53935; color: white; }
  .cr-btn:hover { opacity: 0.85; }
  .cr-actions kbd { display: inline-block; background: rgba(255,255,255,0.15); padding: 1px 5px; border-radius: 3px; font-size: 11px; font-family: inherit; margin-left: 6px; }

  .cr-help-btn { font-size: 14px; font-weight: 700; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; padding: 0; }

  .cr-empty { display: flex; align-items: center; justify-content: center; flex: 1; color: #666; }

  .help-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; display: flex; align-items: center; justify-content: center; }
  .help-modal { background: #1a1d24; border: 1px solid #3a3e46; border-radius: 10px; padding: 20px 28px; min-width: 300px; }
  .help-modal h3 { color: #f0a040; margin: 0 0 14px 0; font-size: 15px; }
  .help-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; align-items: center; }
  .help-grid kbd { background: #2a2e36; color: #eee; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-family: monospace; text-align: center; min-width: 24px; display: inline-block; }
  .help-grid kbd.wide { min-width: 32px; }
  .help-grid span { color: #9aa0ac; font-size: 13px; }
  .help-close { margin-top: 16px; width: 100%; padding: 6px; background: #2a2e36; border: none; border-radius: 5px; color: #ccc; cursor: pointer; font-size: 12px; }
  .help-close:hover { background: #3a3e46; }
</style>
