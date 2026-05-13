import { db } from "./db.js";

export type NapBudgetMode = "first-contact" | "established";

export interface NapBudgetState {
  mode: NapBudgetMode;
  enteredAt: string;
}

export function getNapBudgetState(babyId: number): NapBudgetState | null {
  const row = db
    .prepare("SELECT mode, entered_at FROM nap_budget_state WHERE baby_id = ?")
    .get(babyId) as { mode: string; entered_at: string } | undefined;
  if (!row) return null;
  if (row.mode !== "first-contact" && row.mode !== "established") return null;
  return { mode: row.mode, enteredAt: row.entered_at };
}

export function setNapBudgetState(babyId: number, state: NapBudgetState): void {
  db.prepare(
    `INSERT INTO nap_budget_state (baby_id, mode, entered_at)
     VALUES (?, ?, ?)
     ON CONFLICT(baby_id) DO UPDATE SET
       mode = excluded.mode,
       entered_at = excluded.entered_at`,
  ).run(babyId, state.mode, state.enteredAt);
}
