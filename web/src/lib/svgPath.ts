/**
 * Minimal, defensive SVG path parser.
 *
 * We do not use the DOM (SVGPathElement.getTotalLength) because the reveal
 * animation needs per-point positions to drive the pen head, and because the
 * three.js renderer must work identically in a worker-free canvas pipeline.
 *
 * Supported commands: M m L l H h V v C c S s Q q T t A a Z z.
 * Curves are flattened into polylines with a fixed sample count, which is
 * plenty for a 400x400 viewBox rendered at 1024px.
 */

export type Point = [number, number];

export interface Polyline {
  points: Point[];
  /** Total arc length of the flattened polyline. */
  length: number;
  closed: boolean;
}

const ARG_COUNT: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

const COMMAND_RE = /[MmLlHhVvCcSsQqTtAaZz]/;
const NUMBER_RE = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/;

interface Cmd {
  cmd: string;
  args: number[];
}

function tokenize(d: string): Cmd[] {
  const out: Cmd[] = [];
  let current: string | null = null;
  let args: number[] = [];
  let i = 0;

  const flush = () => {
    if (current !== null) out.push({ cmd: current, args });
    args = [];
  };

  while (i < d.length) {
    const ch = d[i]!;
    if (COMMAND_RE.test(ch)) {
      flush();
      current = ch;
      i += 1;
      if (ch === 'Z' || ch === 'z') {
        flush();
        current = null;
      }
      continue;
    }
    if (ch === ' ' || ch === ',' || ch === '\n' || ch === '\r' || ch === '\t') {
      i += 1;
      continue;
    }
    const m = NUMBER_RE.exec(d.slice(i));
    if (!m || m[0] === '') {
      // Unparseable byte: skip it rather than throwing. The server already
      // rejected illegal characters; this is belt-and-braces for the client.
      i += 1;
      continue;
    }
    args.push(Number(m[0]));
    i += m[0].length;
  }
  flush();
  return out;
}

/** Expand implicit repeated arguments: "M0 0 10 10" is M then L. */
function expand(cmds: Cmd[]): Cmd[] {
  const out: Cmd[] = [];
  for (const { cmd, args } of cmds) {
    const upper = cmd.toUpperCase();
    const k = ARG_COUNT[upper] ?? 0;
    if (k === 0) {
      out.push({ cmd, args: [] });
      continue;
    }
    let first = true;
    for (let i = 0; i + k <= args.length; i += k) {
      let c = cmd;
      if (!first) {
        if (cmd === 'M') c = 'L';
        else if (cmd === 'm') c = 'l';
      }
      out.push({ cmd: c, args: args.slice(i, i + k) });
      first = false;
    }
  }
  return out;
}

function measure(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

function cubicPoints(
  p0: Point,
  c1: Point,
  c2: Point,
  p1: Point,
  steps: number,
): Point[] {
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const e = t * t * t;
    out.push([
      a * p0[0] + b * c1[0] + c * c2[0] + e * p1[0],
      a * p0[1] + b * c1[1] + c * c2[1] + e * p1[1],
    ]);
  }
  return out;
}

function quadPoints(p0: Point, c: Point, p1: Point, steps: number): Point[] {
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt;
    const b = 2 * mt * t;
    const c2 = t * t;
    out.push([a * p0[0] + b * c[0] + c2 * p1[0], a * p0[1] + b * c[1] + c2 * p1[1]]);
  }
  return out;
}

/** Endpoint -> centre parameterisation, per the SVG spec appendix. */
function arcPoints(
  p0: Point,
  rxIn: number,
  ryIn: number,
  xRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Point,
  steps: number,
): Point[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [p1];

  const phi = (xRotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (p0[0] - p1[0]) / 2;
  const dy2 = (p0[1] - p1[1]) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  if (num < 0) num = 0;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(den === 0 ? 0 : num / den);
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);

  const cx = cosPhi * cxp - sinPhi * cyp + (p0[0] + p1[0]) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0[1] + p1[1]) / 2;

  const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  let dTheta = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - theta1;
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = theta1 + dTheta * (i / steps);
    out.push([
      cosPhi * rx * Math.cos(t) - sinPhi * ry * Math.sin(t) + cx,
      sinPhi * rx * Math.cos(t) + cosPhi * ry * Math.sin(t) + cy,
    ]);
  }
  return out;
}

export function parsePathToPolylines(d: string, steps = 14): Polyline[] {
  const cmds = expand(tokenize(d));
  const polylines: Polyline[] = [];

  let cur: Point = [0, 0];
  let subStart: Point = [0, 0];
  let pts: Point[] = [];
  let prevCubicCtrl: Point | null = null;
  let prevQuadCtrl: Point | null = null;

  const finish = (closed: boolean) => {
    if (pts.length >= 2) {
      polylines.push({ points: pts, length: measure(pts), closed });
    }
    pts = [];
  };

  for (const { cmd, args } of cmds) {
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;

    switch (upper) {
      case 'M': {
        finish(false);
        const x = args[0] ?? 0;
        const y = args[1] ?? 0;
        cur = rel ? [cur[0] + x, cur[1] + y] : [x, y];
        subStart = cur;
        pts = [cur];
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'L': {
        const x = args[0] ?? 0;
        const y = args[1] ?? 0;
        cur = rel ? [cur[0] + x, cur[1] + y] : [x, y];
        if (pts.length === 0) pts = [cur];
        else pts.push(cur);
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'H': {
        const x = args[0] ?? 0;
        cur = [rel ? cur[0] + x : x, cur[1]];
        if (pts.length === 0) pts = [cur];
        else pts.push(cur);
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'V': {
        const y = args[0] ?? 0;
        cur = [cur[0], rel ? cur[1] + y : y];
        if (pts.length === 0) pts = [cur];
        else pts.push(cur);
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      case 'C': {
        const [a, b, c, dd, e, f] = args as number[];
        const c1: Point = rel ? [cur[0] + (a ?? 0), cur[1] + (b ?? 0)] : [a ?? 0, b ?? 0];
        const c2: Point = rel ? [cur[0] + (c ?? 0), cur[1] + (dd ?? 0)] : [c ?? 0, dd ?? 0];
        const end: Point = rel ? [cur[0] + (e ?? 0), cur[1] + (f ?? 0)] : [e ?? 0, f ?? 0];
        if (pts.length === 0) pts = [cur];
        pts.push(...cubicPoints(cur, c1, c2, end, steps));
        prevCubicCtrl = c2;
        prevQuadCtrl = null;
        cur = end;
        break;
      }
      case 'S': {
        const [a, b, c, dd] = args as number[];
        const c1: Point = prevCubicCtrl
          ? [2 * cur[0] - prevCubicCtrl[0], 2 * cur[1] - prevCubicCtrl[1]]
          : cur;
        const c2: Point = rel ? [cur[0] + (a ?? 0), cur[1] + (b ?? 0)] : [a ?? 0, b ?? 0];
        const end: Point = rel ? [cur[0] + (c ?? 0), cur[1] + (dd ?? 0)] : [c ?? 0, dd ?? 0];
        if (pts.length === 0) pts = [cur];
        pts.push(...cubicPoints(cur, c1, c2, end, steps));
        prevCubicCtrl = c2;
        prevQuadCtrl = null;
        cur = end;
        break;
      }
      case 'Q': {
        const [a, b, c, dd] = args as number[];
        const ctrl: Point = rel ? [cur[0] + (a ?? 0), cur[1] + (b ?? 0)] : [a ?? 0, b ?? 0];
        const end: Point = rel ? [cur[0] + (c ?? 0), cur[1] + (dd ?? 0)] : [c ?? 0, dd ?? 0];
        if (pts.length === 0) pts = [cur];
        pts.push(...quadPoints(cur, ctrl, end, steps));
        prevQuadCtrl = ctrl;
        prevCubicCtrl = null;
        cur = end;
        break;
      }
      case 'T': {
        const [a, b] = args as number[];
        const ctrl: Point = prevQuadCtrl
          ? [2 * cur[0] - prevQuadCtrl[0], 2 * cur[1] - prevQuadCtrl[1]]
          : cur;
        const end: Point = rel ? [cur[0] + (a ?? 0), cur[1] + (b ?? 0)] : [a ?? 0, b ?? 0];
        if (pts.length === 0) pts = [cur];
        pts.push(...quadPoints(cur, ctrl, end, steps));
        prevQuadCtrl = ctrl;
        prevCubicCtrl = null;
        cur = end;
        break;
      }
      case 'A': {
        const [rx, ry, rot, la, sw, x, y] = args as number[];
        const end: Point = rel ? [cur[0] + (x ?? 0), cur[1] + (y ?? 0)] : [x ?? 0, y ?? 0];
        if (pts.length === 0) pts = [cur];
        pts.push(
          ...arcPoints(
            cur,
            rx ?? 0,
            ry ?? 0,
            rot ?? 0,
            (la ?? 0) !== 0,
            (sw ?? 0) !== 0,
            end,
            Math.max(steps, 20),
          ),
        );
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        cur = end;
        break;
      }
      case 'Z': {
        if (pts.length > 0) {
          pts.push(subStart);
          finish(true);
        }
        cur = subStart;
        prevCubicCtrl = null;
        prevQuadCtrl = null;
        break;
      }
      default:
        break;
    }
  }
  finish(false);
  return polylines;
}

/** Position at `dist` along a polyline, clamped to its ends. */
export function pointAtLength(poly: Polyline, dist: number): Point {
  const pts = poly.points;
  if (pts.length === 0) return [0, 0];
  if (pts.length === 1) return pts[0]!;
  if (dist <= 0) return pts[0]!;
  if (dist >= poly.length) return pts[pts.length - 1]!;

  let travelled = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (travelled + seg >= dist) {
      const t = seg === 0 ? 0 : (dist - travelled) / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    travelled += seg;
  }
  return pts[pts.length - 1]!;
}

/** A single parsed stroke, ready to draw. */
export interface Stroke {
  d: string;
  stroke: string;
  fill: string;
  width: number;
  polylines: Polyline[];
  /** Sum of polyline lengths. */
  length: number;
}

export function buildStrokes(
  paths: Array<{ d: string; stroke: string; fill: string; width: number }>,
): Stroke[] {
  return paths.map((p) => {
    const polylines = parsePathToPolylines(p.d);
    const length = polylines.reduce((sum, pl) => sum + pl.length, 0);
    return { ...p, polylines, length };
  });
}