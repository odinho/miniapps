/** Reactive state for immich-cull */
import { writable, derived } from 'svelte/store';
import type { GroupSummary, GroupDetail, BatchSummary, BatchDetail, Stats } from './api';

export type AppMode = 'groups' | 'batches';
export type ViewMode = 'grid' | 'preview';
export type AssetState = 'keep' | 'cull' | null;

export const appMode = writable<AppMode>('groups');
export const viewMode = writable<ViewMode>('grid');

// Groups mode
export const groups = writable<GroupSummary[]>([]);
export const currentGroupIdx = writable(-1);
export const groupDetail = writable<GroupDetail | null>(null);

// Batches mode
export const batches = writable<BatchSummary[]>([]);
export const currentBatchIdx = writable(-1);
export const batchDetail = writable<BatchDetail | null>(null);

// Shared
export const selectedAssetIdx = writable(-1);
export const showPreview = writable(false);
export const stats = writable<Stats | null>(null);

// Per-asset keep/cull state (persists across group switches)
export const assetStates = writable<Record<string, AssetState>>({});

export function getAssetState(states: Record<string, AssetState>, id: string): AssetState {
  return states[id] ?? null;
}

export function setAssetState(id: string, state: AssetState) {
  assetStates.update(s => ({ ...s, [id]: state }));
}

export function toggleAssetState(id: string, state: 'keep' | 'cull') {
  assetStates.update(s => ({
    ...s,
    [id]: s[id] === state ? null : state,
  }));
}
