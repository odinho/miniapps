import db from './db.js';
import type { NapperEvent } from './events.js';

export function applyEvent(event: NapperEvent): void {
  const { type, payload } = event;
  
  switch (type) {
    case 'baby.created':
      db.prepare(
        `INSERT INTO baby (name, birthdate, created_at) VALUES (?, ?, datetime('now'))`
      ).run(payload.name, payload.birthdate);
      break;
      
    case 'baby.updated': {
      const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
      if (!baby) break;
      if (payload.name !== undefined)
        db.prepare('UPDATE baby SET name = ? WHERE id = ?').run(payload.name, baby.id);
      if (payload.birthdate !== undefined)
        db.prepare('UPDATE baby SET birthdate = ? WHERE id = ?').run(payload.birthdate, baby.id);
      break;
    }
    
    case 'sleep.started':
      db.prepare(
        'INSERT INTO sleep_log (baby_id, start_time, type) VALUES (?, ?, ?)'
      ).run(payload.babyId, payload.startTime, payload.type || 'nap');
      break;
      
    case 'sleep.ended': {
      db.prepare(
        'UPDATE sleep_log SET end_time = ? WHERE id = ?'
      ).run(payload.endTime, payload.sleepId);
      break;
    }
    
    case 'sleep.updated': {
      const sets: string[] = [];
      const vals: any[] = [];
      if (payload.startTime !== undefined) { sets.push('start_time = ?'); vals.push(payload.startTime); }
      if (payload.endTime !== undefined) { sets.push('end_time = ?'); vals.push(payload.endTime); }
      if (payload.type !== undefined) { sets.push('type = ?'); vals.push(payload.type); }
      if (payload.notes !== undefined) { sets.push('notes = ?'); vals.push(payload.notes); }
      if (sets.length > 0) {
        vals.push(payload.sleepId);
        db.prepare(`UPDATE sleep_log SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      break;
    }
    
    case 'sleep.manual':
      db.prepare(
        'INSERT INTO sleep_log (baby_id, start_time, end_time, type) VALUES (?, ?, ?, ?)'
      ).run(payload.babyId, payload.startTime, payload.endTime, payload.type || 'nap');
      break;
      
    case 'sleep.deleted':
      db.prepare('UPDATE sleep_log SET deleted = 1 WHERE id = ?').run(payload.sleepId);
      break;

    case 'diaper.logged':
      db.prepare(
        'INSERT INTO diaper_log (baby_id, time, type, amount, note) VALUES (?, ?, ?, ?, ?)'
      ).run(payload.babyId, payload.time, payload.type, payload.amount ?? null, payload.note ?? null);
      break;

    case 'diaper.deleted':
      db.prepare('UPDATE diaper_log SET deleted = 1 WHERE id = ?').run(payload.diaperId);
      break;
  }
}

export function rebuildAll(): void {
  db.prepare('DELETE FROM diaper_log').run();
  db.prepare('DELETE FROM sleep_log').run();
  db.prepare('DELETE FROM baby').run();
  const events = db.prepare('SELECT * FROM events ORDER BY id ASC').all() as any[];
  for (const row of events) {
    applyEvent({ ...row, payload: JSON.parse(row.payload) });
  }
}
