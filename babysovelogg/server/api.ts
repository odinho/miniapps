import { IncomingMessage, ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { appendEvent, getEvents } from './events.js';
import { applyEvent } from './projections.js';
import { calculateAgeMonths, predictNextNap, recommendBedtime } from '../src/engine/schedule.js';
import { getTodayStats } from '../src/engine/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.env.NODE_ENV === 'production' ? __dirname : path.join(__dirname, '..', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function serveStatic(res: ServerResponse, filePath: string) {
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function getState() {
  const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
  if (!baby) return { baby: null, activeSleep: null, todaySleeps: [], stats: null, prediction: null };
  
  const activeSleep = db.prepare(
    'SELECT * FROM sleep_log WHERE baby_id = ? AND end_time IS NULL AND deleted = 0 ORDER BY id DESC LIMIT 1'
  ).get(baby.id) as any;
  
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todaySleeps = db.prepare(
    'SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC'
  ).all(baby.id, todayStart.toISOString()) as any[];
  
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentSleeps = db.prepare(
    'SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC'
  ).all(baby.id, weekAgo) as any[];
  
  const ageMonths = calculateAgeMonths(baby.birthdate);
  const stats = getTodayStats(todaySleeps.map((s: any) => ({ start_time: s.start_time, end_time: s.end_time, type: s.type })));
  
  let prediction = null;
  if (!activeSleep) {
    const lastCompleted = todaySleeps.find((s: any) => s.end_time);
    if (lastCompleted) {
      prediction = {
        nextNap: predictNextNap(lastCompleted.end_time, ageMonths, recentSleeps.map((s: any) => ({ start_time: s.start_time, end_time: s.end_time, type: s.type }))),
        bedtime: recommendBedtime(todaySleeps.map((s: any) => ({ start_time: s.start_time, end_time: s.end_time, type: s.type })), ageMonths),
      };
    }
  }
  
  return { baby, activeSleep, todaySleeps, stats, prediction, ageMonths };
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const method = req.method || 'GET';
  
  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  
  // API routes
  if (url.pathname === '/api/state' && method === 'GET') {
    return json(res, getState());
  }
  
  if (url.pathname === '/api/events' && method === 'GET') {
    const since = url.searchParams.get('since');
    return json(res, getEvents(since ? parseInt(since) : undefined));
  }
  
  if (url.pathname === '/api/events' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const results = [];
    for (const evt of body.events || [body]) {
      const event = appendEvent(evt.type, evt.payload, evt.clientId);
      applyEvent(event);
      results.push(event);
    }
    return json(res, { events: results, state: getState() });
  }
  
  if (url.pathname === '/api/sleeps' && method === 'GET') {
    const baby = db.prepare('SELECT * FROM baby ORDER BY id DESC LIMIT 1').get() as any;
    if (!baby) return json(res, []);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const limit = url.searchParams.get('limit') || '50';
    let sql = 'SELECT * FROM sleep_log WHERE baby_id = ? AND deleted = 0';
    const params: any[] = [baby.id];
    if (from) { sql += ' AND start_time >= ?'; params.push(from); }
    if (to) { sql += ' AND start_time <= ?'; params.push(to); }
    sql += ' ORDER BY start_time DESC LIMIT ?';
    params.push(parseInt(limit));
    return json(res, db.prepare(sql).all(...params));
  }
  
  // Static files
  let filePath: string;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    filePath = path.join(distDir, 'index.html');
  } else {
    filePath = path.join(distDir, url.pathname);
  }
  
  return serveStatic(res, filePath);
}
