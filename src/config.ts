/** Startup checks for config values, so mistakes show up as one clear log line instead of failing on every request. */

export type ParsedUrl = { ok: true; url: string } | { ok: false; error: string };

/** Check that `raw` is an http(s) base URL, and return it without a trailing slash or /api suffix. */
export function parseBlockyUrl(raw: string): ParsedUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: `"${raw}" is not a valid URL. Use something like http://192.168.1.2:4000` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `blocky URL must start with http:// or https:// (got ${parsed.protocol}//)` };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'blocky URL must not include a query string or #fragment' };
  }
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return { ok: true, url: `${parsed.origin}${path}` };
}

export interface NumberRule {
  name: string;
  fallback: number;
  min: number;
  max: number;
  /** 0 is allowed as an "off" value even though it is below `min` */
  allowZero?: boolean;
}

/** Read a numeric setting, falling back or clamping (with a warning) when it's missing, not a number, or out of range. */
export function readNumber(value: unknown, rule: NumberRule, warn: (message: string) => void): number {
  if (value === undefined || value === null || value === '') {
    return rule.fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    warn(`${rule.name} "${String(value)}" is not a number; using ${rule.fallback}.`);
    return rule.fallback;
  }
  if (rule.allowZero && n === 0) {
    return 0;
  }
  const clamped = Math.min(rule.max, Math.max(rule.min, n));
  if (clamped !== n) {
    warn(`${rule.name} ${n} is out of range (${rule.allowZero ? '0 or ' : ''}${rule.min}–${rule.max}); using ${clamped}.`);
  }
  return clamped;
}
