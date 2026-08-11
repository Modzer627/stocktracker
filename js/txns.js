import { dbAll, dbAllByIndex, metaGet, metaSet } from './db.js';

export async function itemHistory(itemId, limit = 100) {
  const rows = await dbAllByIndex('txns', 'itemId', itemId);
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, limit);
}

export async function allTxnsDesc() {
  const rows = await dbAll('txns');
  rows.sort((a, b) => b.ts - a.ts);
  return rows;
}

const MAX_RECENT_JOBS = 10;

export function recentJobs() {
  return metaGet('recentJobs', []);
}

export async function pushJob(name) {
  const job = (name || '').trim();
  if (!job) return;
  const jobs = await recentJobs();
  const next = [job, ...jobs.filter(j => j.toLowerCase() !== job.toLowerCase())].slice(0, MAX_RECENT_JOBS);
  await metaSet('recentJobs', next);
}
