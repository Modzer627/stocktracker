// Minimal chart kit (no libraries) — the budget app only needs meters.
/** Inline progress meter (budget vs spent, goal progress). */
export function meter(value, max) {
  const pct = max > 0 ? Math.min(100, Math.max(2, (value / max) * 100)) : 0;
  return `<div class="meter"><div style="width:${pct}%"></div></div>`;
}
