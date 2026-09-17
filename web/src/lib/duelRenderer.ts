import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Stroke } from './svgPath.js';
import { pointAtLength } from './svgPath.js';

const VIEWBOX = 400;
const TEX = 1024;
const SCALE = TEX / VIEWBOX;

export interface DuelSceneOptions {
  /** Accent colour for the pen head and glow, as a CSS hex string. */
  accent: string;
  /** Tilt in radians; the two seats tilt in opposite directions. */
  tiltY: number;
  /** Reveal duration in seconds for a fully-populated drawing. */
  duration?: number;
}

interface DrawState {
  strokeIndex: number;
  segIndex: number;
  /** Index of the point the current segment starts at. */
  segT: number;
  /**
   * Distance already travelled INTO the current segment.
   * Without this, a segment longer than one frame's travel would restart from
   * its beginning every frame and the reveal would stall forever.
   */
  segOffset: number;
}

/**
 * How long the reveal should take for a drawing with `pathCount` paths.
 *
 * A fixed duration made a 40-path cityscape flash past in the same 3.4s as a
 * 12-path cat, which is a waste after waiting a minute for a reasoning model to
 * finish. Denser drawings get a little longer, within bounds that stay snappy.
 */
export function revealSeconds(pathCount: number): number {
  return Math.min(7, Math.max(2.6, 2.1 + pathCount * 0.11));
}

/**
 * One seat of the duel: a paper plane carrying the model's drawing as a
 * canvas texture, tilted slightly in 3D with a soft shadow behind it.
 *
 * The drawing reveals itself stroke by stroke. We draw incrementally into the
 * canvas (append-only) rather than repainting every frame, so 40 paths cost
 * about as much as 3.
 */
export class DuelScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private paper: THREE.Mesh;
  private shadow: THREE.Mesh;
  private texture: THREE.CanvasTexture;
  private shadowTexture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private shadowCanvas: HTMLCanvasElement;
  private shadowCtx: CanvasRenderingContext2D;

  private penGroup: THREE.Group;
  private penCore: THREE.Mesh;
  private penHalo: THREE.Sprite;

  private strokes: Stroke[] = [];
  private totalLength = 0;
  private cumulative: number[] = [];
  private state: DrawState = { strokeIndex: 0, segIndex: 0, segT: 0, segOffset: 0 };
  private progress = 0;
  private playing = false;
  private duration: number;
  private prefersReduced = false;
  private clock = new THREE.Clock();
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private shadowDirty = true;
  private paperDirty = true;

  /** Fires with 0..1 as the drawing reveals. */
  onProgress: ((p: number) => void) | null = null;
  /** Fires once when the reveal completes. */
  onComplete: (() => void) | null = null;

  constructor(
    private container: HTMLElement,
    private opts: DuelSceneOptions,
  ) {
    this.duration = opts.duration ?? 3.4;

    this.canvas = document.createElement('canvas');
    this.canvas.width = TEX;
    this.canvas.height = TEX;
    this.ctx = this.canvas.getContext('2d')!;

    this.shadowCanvas = document.createElement('canvas');
    this.shadowCanvas.width = TEX / 2;
    this.shadowCanvas.height = TEX / 2;
    this.shadowCtx = this.shadowCanvas.getContext('2d')!;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // Lets the canvas be read back (filmstrip snapshots, audits) after a frame.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    // Straight-on default view.
    this.camera.position.set(0, 0, 4.35);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.4;
    this.controls.maxDistance = 7;
    this.controls.minPolarAngle = Math.PI / 2 - 0.6;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.6;
    this.controls.minAzimuthAngle = -0.8;
    this.controls.maxAzimuthAngle = 0.8;
    this.controls.target.set(0, 0, 0);

    // ---- Paper ----------------------------------------------------------
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    const paperGeo = new THREE.PlaneGeometry(2, 2);
    const paperMat = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    this.paper = new THREE.Mesh(paperGeo, paperMat);
    this.paper.rotation.y = opts.tiltY;
    this.paper.rotation.x = -0.045;
    this.scene.add(this.paper);

    // ---- Soft shadow ----------------------------------------------------
    this.shadowTexture = new THREE.CanvasTexture(this.shadowCanvas);
    const shadowGeo = new THREE.PlaneGeometry(2.06, 2.06);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.shadowTexture,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      toneMapped: false,
    });
    this.shadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadow.rotation.copy(this.paper.rotation);
    this.shadow.position.set(
      Math.sin(opts.tiltY) * 0.12 + 0.03,
      -0.05,
      -0.06,
    );
    this.scene.add(this.shadow);

    // ---- Pen head -------------------------------------------------------
    this.penGroup = new THREE.Group();
    this.penCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.017, 16, 16),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(opts.accent), toneMapped: false }),
    );
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = 128;
    haloCanvas.height = 128;
    const hctx = haloCanvas.getContext('2d')!;
    const grad = hctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, opts.accent);
    grad.addColorStop(0.25, `${opts.accent}aa`);
    grad.addColorStop(1, `${opts.accent}00`);
    hctx.fillStyle = grad;
    hctx.fillRect(0, 0, 128, 128);
    const haloTexture = new THREE.CanvasTexture(haloCanvas);
    haloTexture.colorSpace = THREE.SRGBColorSpace;
    this.penHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: haloTexture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.penHalo.scale.setScalar(0.16);
    this.penGroup.add(this.penHalo);
    this.penGroup.add(this.penCore);
    this.penGroup.position.set(0, 0, 0.012);
    this.penGroup.visible = false;
    this.scene.add(this.penGroup);

    this.paintPaper();
    this.paintShadow();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.prefersReduced = reduced;
    if (reduced) this.duration = 0.35;

    this.loop();
  }

  /** Draw the blank sheet: warm paper, hairline frame, faint plotter grid. */
  private paintPaper(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, TEX, TEX);

    ctx.fillStyle = '#f5f3ec';
    ctx.fillRect(0, 0, TEX, TEX);

    // Faint 20-unit plotter grid.
    ctx.strokeStyle = 'rgba(28, 30, 38, 0.055)';
    ctx.lineWidth = 1;
    for (let u = 20; u < VIEWBOX; u += 20) {
      const p = Math.round(u * SCALE) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, TEX);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(TEX, p);
      ctx.stroke();
    }

    // Hairline frame at the viewBox edge.
    ctx.strokeStyle = 'rgba(28, 30, 38, 0.22)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, TEX - 2, TEX - 2);

    this.texture.needsUpdate = true;
  }

  private paintShadow(): void {
    const ctx = this.shadowCtx;
    const w = this.shadowCanvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = 'rgba(6, 8, 14, 0.85)';
    ctx.fillRect(0, 0, w, w);
    this.shadowTexture.needsUpdate = true;
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Load a drawing and reset the reveal to zero.
   *
   * `duration` overrides the reveal length for this drawing; it is ignored when
   * the user has asked for reduced motion.
   */
  setDrawing(strokes: Stroke[], duration?: number): void {
    if (duration !== undefined && !this.prefersReduced) this.duration = duration;
    this.strokes = strokes;
    this.cumulative = [];
    let acc = 0;
    for (const s of strokes) {
      acc += s.length;
      this.cumulative.push(acc);
    }
    this.totalLength = acc;
    this.state = { strokeIndex: 0, segIndex: 0, segT: 0, segOffset: 0 };
    this.progress = 0;
    this.playing = false;
    this.penGroup.visible = false;
    this.paintPaper();
    this.onProgress?.(0);
  }

  /** Begin the stroke-order reveal. */
  play(): void {
    if (this.totalLength <= 0) {
      this.onComplete?.();
      return;
    }
    this.playing = true;
    this.penGroup.visible = true;
    this.clock.getDelta();
  }

  /** Jump to the finished drawing. */
  finish(): void {
    if (this.totalLength <= 0) return;
    this.playing = false;
    this.penGroup.visible = false;
    this.paintPaper();
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(SCALE, SCALE);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of this.strokes) this.paintStrokeFull(ctx, stroke);
    ctx.restore();
    this.texture.needsUpdate = true;
    this.progress = 1;
    this.state = { strokeIndex: this.strokes.length, segIndex: 0, segT: 0, segOffset: 0 };
    this.onProgress?.(1);
  }

  private paintStrokeFull(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
    for (const poly of stroke.polylines) {
      if (poly.points.length < 2) continue;
      ctx.beginPath();
      const first = poly.points[0]!;
      ctx.moveTo(first[0], first[1]);
      for (let i = 1; i < poly.points.length; i++) {
        const p = poly.points[i]!;
        ctx.lineTo(p[0], p[1]);
      }
      if (poly.closed) ctx.closePath();
      if (stroke.fill && stroke.fill !== 'none') {
        ctx.fillStyle = stroke.fill;
        ctx.fill();
      }
      if (stroke.stroke && stroke.stroke !== 'none') {
        ctx.strokeStyle = stroke.stroke;
        ctx.lineWidth = stroke.width;
        ctx.stroke();
      }
    }
  }

  /**
   * Advance the reveal by `distance` viewBox units, painting only new segments.
   * Returns true when something was painted.
   */
  private advance(distance: number): boolean {
    if (distance <= 0) return false;
    const ctx = this.ctx;
    let remaining = distance;
    let painted = false;

    ctx.save();
    ctx.scale(SCALE, SCALE);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    while (remaining > 0 && this.state.strokeIndex < this.strokes.length) {
      const stroke = this.strokes[this.state.strokeIndex]!;

      // Fill a shape the moment we start drawing it, so the fill is not
      // floating on top of an already-complete outline.
      if (this.state.segIndex === 0 && this.state.segT === 0) {
        for (const poly of stroke.polylines) {
          if (poly.points.length < 3 || !poly.closed) continue;
          if (!stroke.fill || stroke.fill === 'none') continue;
          ctx.beginPath();
          const first = poly.points[0]!;
          ctx.moveTo(first[0], first[1]);
          for (let i = 1; i < poly.points.length; i++) {
            const p = poly.points[i]!;
            ctx.lineTo(p[0], p[1]);
          }
          ctx.closePath();
          ctx.fillStyle = stroke.fill;
          ctx.fill();
          painted = true;
        }
      }

      const poly = stroke.polylines[this.state.segIndex];
      if (!poly || poly.points.length < 2) {
        this.state.segIndex += 1;
        this.state.segT = 0;
        this.state.segOffset = 0;
        if (this.state.segIndex >= stroke.polylines.length) {
          this.state.strokeIndex += 1;
          this.state.segIndex = 0;
        }
        continue;
      }

      const a = poly.points[this.state.segT]!;
      const b = poly.points[this.state.segT + 1]!;
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const segRemaining = segLen - this.state.segOffset;

      if (segRemaining <= remaining) {
        // Finish this segment: draw only the part not yet painted.
        const t0 = segLen === 0 ? 0 : this.state.segOffset / segLen;
        const sx = a[0] + (b[0] - a[0]) * t0;
        const sy = a[1] + (b[1] - a[1]) * t0;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(b[0], b[1]);
        if (stroke.stroke && stroke.stroke !== 'none') {
          ctx.strokeStyle = stroke.stroke;
          ctx.lineWidth = stroke.width;
          ctx.stroke();
          painted = true;
        }
        remaining -= segRemaining;
        this.state.segT += 1;
        this.state.segOffset = 0;
        if (this.state.segT >= poly.points.length - 1) {
          this.state.segIndex += 1;
          this.state.segT = 0;
          if (this.state.segIndex >= stroke.polylines.length) {
            this.state.strokeIndex += 1;
            this.state.segIndex = 0;
          }
        }
      } else {
        // Partial: advance within the segment and remember how far we got.
        const from = this.state.segOffset;
        const to = this.state.segOffset + remaining;
        const t0 = segLen === 0 ? 0 : from / segLen;
        const t1 = segLen === 0 ? 0 : to / segLen;
        const sx = a[0] + (b[0] - a[0]) * t0;
        const sy = a[1] + (b[1] - a[1]) * t0;
        const mx = a[0] + (b[0] - a[0]) * t1;
        const my = a[1] + (b[1] - a[1]) * t1;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(mx, my);
        if (stroke.stroke && stroke.stroke !== 'none') {
          ctx.strokeStyle = stroke.stroke;
          ctx.lineWidth = stroke.width;
          ctx.stroke();
          painted = true;
        }
        this.state.segOffset = to;
        remaining = 0;
      }
    }

    ctx.restore();
    return painted;
  }

  /** Where the pen currently is, in viewBox units. */
  private penPosition(): [number, number] | null {
    const stroke = this.strokes[this.state.strokeIndex];
    if (!stroke) return null;
    const poly = stroke.polylines[this.state.segIndex];
    if (!poly) return null;
    let travelled = 0;
    for (let i = 0; i < this.state.segT; i++) {
      const a = poly.points[i];
      const b = poly.points[i + 1];
      if (!a || !b) break;
      travelled += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    travelled += this.state.segOffset;
    return pointAtLength(poly, travelled);
  }

  private updatePen(): void {
    if (!this.penGroup.visible) return;
    const pos = this.penPosition();
    if (!pos) {
      this.penGroup.visible = false;
      return;
    }
    // viewBox (0..400, y down) -> plane local (-1..1, y up)
    const x = (pos[0] / VIEWBOX) * 2 - 1;
    const y = -((pos[1] / VIEWBOX) * 2 - 1);
    this.penGroup.position.set(x, y, 0.014);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.playing && this.totalLength > 0) {
      const unitsPerSecond = this.totalLength / this.duration;
      const painted = this.advance(unitsPerSecond * dt);
      if (painted) {
        this.texture.needsUpdate = true;
        this.shadowDirty = true;
      }
      const done = this.cumulative[this.state.strokeIndex - 1] ?? 0;
      const partial =
        this.state.strokeIndex < this.strokes.length
          ? this.currentPartial()
          : 0;
      this.progress = Math.min(1, (done + partial) / this.totalLength);
      this.onProgress?.(this.progress);
      this.updatePen();

      if (this.state.strokeIndex >= this.strokes.length) {
        this.playing = false;
        this.penGroup.visible = false;
        this.progress = 1;
        this.onProgress?.(1);
        this.onComplete?.();
      }
    }

    if (this.shadowDirty) {
      this.shadowDirty = false;
      this.updateShadow();
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private currentPartial(): number {
    const stroke = this.strokes[this.state.strokeIndex];
    if (!stroke) return 0;
    let travelled = 0;
    for (let i = 0; i < this.state.segIndex; i++) {
      travelled += stroke.polylines[i]?.length ?? 0;
    }
    const poly = stroke.polylines[this.state.segIndex];
    if (poly) {
      for (let i = 0; i < this.state.segT; i++) {
        const a = poly.points[i];
        const b = poly.points[i + 1];
        if (!a || !b) break;
        travelled += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      travelled += this.state.segOffset;
    }
    return travelled;
  }

  /** Blurred, offset copy of the sheet gives the plane a soft cast shadow. */
  private updateShadow(): void {
    const ctx = this.shadowCtx;
    const w = this.shadowCanvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, w);
    ctx.save();
    ctx.filter = 'blur(7px)';
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.canvas, 0, 0, w, w);
    ctx.restore();
    // Tint the copy dark so it reads as a shadow, not a duplicate.
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = 'rgba(8, 10, 16, 0.95)';
    ctx.fillRect(0, 0, w, w);
    ctx.globalCompositeOperation = 'source-over';
    this.shadowTexture.needsUpdate = true;
  }

  /** A static PNG of the finished drawing, for the filmstrip. */
  snapshot(): string {
    const out = document.createElement('canvas');
    out.width = 256;
    out.height = 256;
    const octx = out.getContext('2d')!;
    octx.fillStyle = '#f5f3ec';
    octx.fillRect(0, 0, 256, 256);
    octx.drawImage(this.canvas, 0, 0, 256, 256);
    return out.toDataURL('image/png');
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.texture.dispose();
    this.shadowTexture.dispose();
    (this.paper.material as THREE.Material).dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.paper.geometry.dispose();
    this.shadow.geometry.dispose();
    this.penCore.geometry.dispose();
    (this.penCore.material as THREE.Material).dispose();
    (this.penHalo.material as THREE.Material).dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

/** Render a finished drawing to a small static PNG without a WebGL context. */
export function renderThumbnail(strokes: Stroke[], size = 128): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f5f3ec';
  ctx.fillRect(0, 0, size, size);
  const s = size / VIEWBOX;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    for (const poly of stroke.polylines) {
      if (poly.points.length < 2) continue;
      ctx.beginPath();
      const first = poly.points[0]!;
      ctx.moveTo(first[0], first[1]);
      for (let i = 1; i < poly.points.length; i++) {
        const p = poly.points[i]!;
        ctx.lineTo(p[0], p[1]);
      }
      if (poly.closed) ctx.closePath();
      if (stroke.fill && stroke.fill !== 'none') {
        ctx.fillStyle = stroke.fill;
        ctx.fill();
      }
      if (stroke.stroke && stroke.stroke !== 'none') {
        ctx.strokeStyle = stroke.stroke;
        ctx.lineWidth = stroke.width;
        ctx.stroke();
      }
    }
  }
  ctx.restore();
  return canvas.toDataURL('image/png');
}