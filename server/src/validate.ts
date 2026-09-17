import type { DrawPath, DrawPayload } from '@bpd/shared';
import { PATH_COMMANDS } from '@bpd/shared';

export type ParseOutcome =
  | { ok: true; drawing: DrawPayload; repaired: boolean; repairs: string[] }
  | { ok: false; reason: string };

const VIEWBOX = 400;

/** Every character legal anywhere in an SVG path body. */
const PATH_BODY = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
/** Commands whose numeric arguments are all coordinates (so clamping is safe). */
const COORD_ONLY = new Set(['M', 'm', 'L', 'l', 'C', 'c', 'Q', 'q']);

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Recover the path data from an entry whose key is malformed.
 *
 * Models reliably typo the key itself — `"d: "`, `" d"`, `"path"`, `"data"` —
 * while getting the value perfectly right. Dropping the entry would silently
 * delete a real stroke from the drawing, so look for a plausible key first.
 */
const PATH_KEY_CANDIDATES = ['d', 'd:', 'd: ', 'path', 'pathData', 'data', 'svg', 'points'];

function recoverPathData(entry: Record<string, unknown>): string | null {
  // Exact match first.
  if (typeof entry.d === 'string') return entry.d;
  // Then a normalised key match.
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value !== 'string') continue;
    const normalised = key.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (PATH_KEY_CANDIDATES.includes(normalised)) return value;
  }
  // Last resort: any string value that looks like path data.
  for (const value of Object.values(entry)) {
    if (typeof value === 'string' && /^[Mm][\s\d.,-]/.test(value.trim())) return value;
  }
  return null;
}

/**
 * Strip markdown code fences. Models leak these constantly even when told not to.
 * Handles ```json, ```JSON, bare ```, and a trailing fence with trailing prose.
 */
export function stripFences(text: string): { text: string; stripped: boolean } {
  const trimmed = text.trim();
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```\s*$/;
  const m = trimmed.match(fence);
  if (m?.[1] !== undefined) return { text: m[1].trim(), stripped: true };
  // Unterminated fence (truncated stream).
  const open = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*)$/);
  if (open?.[1] !== undefined) return { text: open[1].trim(), stripped: true };
  return { text: trimmed, stripped: false };
}

/**
 * Find the outermost balanced JSON object in a string.
 * Scans with a depth counter that is string- and escape-aware, so braces inside
 * string literals (and escaped quotes) never fool it.
 */
export function findOutermostObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** True when `d` starts with one of the valid SVG path commands. */
export function hasValidStart(d: string): boolean {
  const first = d.trim()[0];
  return first !== undefined && (PATH_COMMANDS as readonly string[]).includes(first);
}

/**
 * Validate a single path's `d` attribute.
 * Returns null when acceptable, otherwise a human-readable rejection reason.
 */
export function validatePathData(d: string): string | null {
  const t = d.trim();
  if (!t) return 'empty path data';
  if (!hasValidStart(t)) {
    return `path data must start with one of ${PATH_COMMANDS.join(', ')} (got "${t.slice(0, 12)}")`;
  }
  if (!PATH_BODY.test(t)) {
    const bad = [...t].find((c) => !/[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]/.test(c));
    return `illegal character ${JSON.stringify(bad)} in path data`;
  }
  // A command letter must be followed by at least one number (except Z/z).
  const commands = t.match(/[MmLlHhVvCcSsQqTtAaZz]/g) ?? [];
  const numbers = t.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const closers = (t.match(/[Zz]/g) ?? []).length;
  if (numbers.length === 0 && closers === 0) return 'path data has no coordinates';
  if (commands.length === 0) return 'path data has no commands';
  return null;
}

/**
 * Clamp coordinates into the viewBox.
 * Only safe for coordinate-only commands; relative commands are deltas, so their
 * legal range is [-VIEWBOX, VIEWBOX].
 */
function clampCoords(d: string, repairs: string[]): string {
  const out: string[] = [];
  let clamped = 0;
  // Walk command segments, clamping numbers per-segment based on the command case.
  const segments = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) ?? [];
  for (const seg of segments) {
    const cmd = seg[0]!;
    if (!COORD_ONLY.has(cmd)) {
      out.push(seg);
      continue;
    }
    const isRelative = cmd === cmd.toLowerCase();
    const lo = isRelative ? -VIEWBOX : 0;
    const hi = VIEWBOX;
    const rewritten = seg.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (num) => {
      const v = Number(num);
      if (!Number.isFinite(v)) return num;
      if (v < lo) {
        clamped++;
        return String(lo);
      }
      if (v > hi) {
        clamped++;
        return String(hi);
      }
      return num;
    });
    out.push(rewritten);
  }
  if (clamped > 0) repairs.push(`clamped ${clamped} coordinate(s) into the 0 0 400 400 viewBox`);
  return out.join(' ');
}

function normaliseColour(value: unknown, fallback: string): { value: string; fixed: boolean } {
  if (typeof value !== 'string') return { value: fallback, fixed: true };
  const v = value.trim();
  if (v.toLowerCase() === 'none') return { value: 'none', fixed: false };
  if (HEX.test(v)) return { value: v, fixed: false };
  // Named colours and rgb() are legal SVG but not what we asked for; accept and flag.
  if (/^[a-z]{3,20}$/i.test(v)) return { value: v, fixed: true };
  return { value: fallback, fixed: true };
}

/**
 * Parse a model's raw content into a validated drawing.
 *
 * Repairs (recorded, not fatal): code fences, prose around the object, missing
 * fields, bad colours, out-of-viewBox coordinates, and a minority of unusable
 * paths. Fatal (triggers the retry, then a forfeit): no JSON object, no `paths`
 * array, or fewer than 3 usable paths after filtering.
 */
export function parseDrawing(raw: string): ParseOutcome {
  const repairs: string[] = [];
  if (!raw || !raw.trim()) return { ok: false, reason: 'empty content' };

  const { text, stripped } = stripFences(raw);
  if (stripped) repairs.push('stripped markdown code fence');

  const objectText = findOutermostObject(text);
  if (!objectText) return { ok: false, reason: 'no JSON object found in content' };
  if (objectText !== text) repairs.push('extracted outermost JSON object from surrounding text');

  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch (e) {
    return { ok: false, reason: `JSON.parse failed: ${(e as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'top-level JSON value is not an object' };
  }

  const obj = parsed as Record<string, unknown>;
  const rawPaths = obj.paths;
  if (!Array.isArray(rawPaths)) return { ok: false, reason: 'missing "paths" array' };
  if (rawPaths.length === 0) return { ok: false, reason: '"paths" array is empty' };
  if (rawPaths.length > 40) repairs.push(`model returned ${rawPaths.length} paths, kept the first 40`);

  const paths: DrawPath[] = [];
  const rejected: string[] = [];

  for (const entry of rawPaths.slice(0, 40)) {
    if (typeof entry !== 'object' || entry === null) {
      rejected.push('non-object path entry');
      continue;
    }
    const p = entry as Record<string, unknown>;
    const dRaw = recoverPathData(p) ?? '';
    if (typeof p.d !== 'string' && dRaw) {
      repairs.push('recovered path data from a malformed key (e.g. "d: ")');
    }
    const problem = validatePathData(dRaw);
    if (problem) {
      rejected.push(problem);
      continue;
    }
    const d = clampCoords(dRaw.trim(), repairs);
    const stroke = normaliseColour(p.stroke, '#e8e8f0');
    if (stroke.fixed) repairs.push('replaced an unusable stroke colour');
    const fill = normaliseColour(p.fill, 'none');
    if (fill.fixed) repairs.push('replaced an unusable fill colour');
    let width = typeof p.width === 'number' ? p.width : Number(p.width);
    if (!Number.isFinite(width) || width <= 0) {
      width = 3;
      repairs.push('defaulted a missing stroke width to 3');
    }
    width = Math.min(24, Math.max(0.5, width));
    paths.push({ d, stroke: stroke.value, fill: fill.value, width });
  }

  if (rejected.length > 0) {
    repairs.push(`dropped ${rejected.length} unusable path(s): ${rejected[0]}`);
  }
  if (paths.length < 3) {
    return {
      ok: false,
      reason: `only ${paths.length} usable path(s) after validation (need at least 3)${
        rejected.length ? `; first problem: ${rejected[0]}` : ''
      }`,
    };
  }

  let label = typeof obj.label === 'string' ? obj.label.trim() : '';
  if (!label) {
    label = 'untitled';
    repairs.push('model omitted the label');
  }
  label = label.slice(0, 60);

  return { ok: true, drawing: { paths, label }, repaired: repairs.length > 0, repairs };
}