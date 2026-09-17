import { useEffect, useRef, useState } from 'react';
import type { DrawResult } from '@bpd/shared';
import { DuelScene, revealSeconds } from '../lib/duelRenderer.js';
import type { Stroke } from '../lib/svgPath.js';

/** What this seat is doing right now. */
export type SeatPhase = 'idle' | 'loading' | 'ready' | 'error';

interface Props {
  seat: 'A' | 'B';
  result: DrawResult | null;
  strokes: Stroke[];
  /** Bumping this replays the reveal. */
  playToken: number;
  accent: string;
  phase: SeatPhase;
  /** Whether this duel was sent with reasoning enabled. */
  reasoningOn: boolean;
  onProgress?: (p: number) => void;
}

const VALIDITY_LABEL: Record<string, string> = {
  valid: 'valid',
  repaired: 'repaired',
  forfeited: 'forfeited',
};

export function DuelCanvas({
  seat,
  result,
  strokes,
  playToken,
  accent,
  phase,
  reasoningOn,
  onProgress,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<DuelScene | null>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);

  // Tick a visible clock while the model is working. With reasoning enabled a
  // single call can run for a minute or more, and a silent seat looks broken.
  useEffect(() => {
    if (phase !== 'loading') {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(id);
  }, [phase]);

  // Create the scene once per seat.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new DuelScene(mount, {
      accent,
      tiltY: seat === 'A' ? 0.14 : -0.14,
    });
    scene.onProgress = (p) => {
      if (progressRef.current) progressRef.current.textContent = `${Math.round(p * 100)}%`;
      if (barRef.current) barRef.current.style.transform = `scaleX(${p})`;
      onProgress?.(p);
    };
    sceneRef.current = scene;
    // Dev-only handle so the reveal can be inspected from the console.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __bpd?: Record<string, unknown> };
      w.__bpd = { ...(w.__bpd ?? {}), [seat]: scene };
    }
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seat, accent]);

  // Load a new drawing whenever the strokes change.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setDrawing(strokes, revealSeconds(strokes.length));
    if (strokes.length > 0) scene.play();
  }, [strokes, playToken]);

  const forfeited = result?.validity === 'forfeited';
  const pathCount = result?.drawing.paths.length ?? 0;
  const pillState = phase === 'loading' ? 'drawing' : (result?.validity ?? 'idle');
  const pillLabel = phase === 'loading' ? 'drawing' : result ? VALIDITY_LABEL[result.validity] : 'idle';

  // The first attempt can be spent entirely on reasoning, in which case the
  // server retries with a doubled budget. Say so rather than looking stuck.
  const loadingHint = reasoningOn
    ? elapsed > 45
      ? 'Still working. A reasoning model can take a minute or more before it emits a single path.'
      : 'Reasoning is on, so it thinks before it draws. Nothing appears until it finishes.'
    : elapsed > 45
      ? 'Still working — the provider is slow to respond.'
      : 'Waiting for the model to return path data.';

  return (
    <section className={`seat seat--${seat.toLowerCase()}`} aria-label={`Model ${seat}`}>
      <header className="seat__head">
        <div className="seat__id">
          <span className="seat__badge" aria-hidden="true">
            {seat}
          </span>
          <div className="seat__names">
            <h2 className="seat__title">{seat === 'A' ? 'Model A' : 'Model B'}</h2>
            <p className="seat__model" title={result?.model ?? ''}>
              {result?.model ?? 'not called yet'}
            </p>
          </div>
        </div>
        <div className="seat__meta">
          <span className={`pill pill--${pillState}`}>{pillLabel}</span>
          {result && result.attempts > 1 && (
            <span className="pill pill--retry" title={result.note ?? ''}>
              retried ×{result.attempts - 1}
            </span>
          )}
        </div>
      </header>

      <div className="seat__stage">
        <div className="seat__canvas" ref={mountRef} />
        {forfeited && (
          <div className="seat__forfeit">
            <p className="seat__forfeit-title">Forfeit</p>
            <p className="seat__forfeit-reason">{result?.note ?? 'no usable output'}</p>
            {result?.error && <p className="seat__forfeit-error">{result.error}</p>}
          </div>
        )}
        {phase === 'loading' && (
          <div className="seat__loading">
            <span className="seat__spinner" aria-hidden="true" />
            <p className="seat__loading-title" role="status">
              {reasoningOn ? 'Thinking, then drawing…' : 'Drawing…'}
            </p>
            <p className="seat__loading-elapsed" aria-hidden="true">
              {elapsed.toFixed(1)}s
            </p>
            <div className="seat__loading-track" aria-hidden="true">
              <span className="seat__loading-sweep" />
            </div>
            <p className="seat__loading-hint">{loadingHint}</p>
          </div>
        )}
        {phase === 'idle' && (
          <div className="seat__forfeit seat__forfeit--idle">
            <p className="seat__forfeit-title">Blank sheet</p>
            <p className="seat__forfeit-reason">Pick a rung or type a subject to start the duel.</p>
          </div>
        )}
        {phase === 'error' && (
          <div className="seat__forfeit seat__forfeit--idle">
            <p className="seat__forfeit-title">Nothing drawn</p>
            <p className="seat__forfeit-reason">The request failed — see the message above.</p>
          </div>
        )}
        <div className="seat__progress" aria-hidden="true">
          <div className="seat__progress-bar" ref={barRef} />
        </div>
      </div>

      <dl className="seat__stats">
        <div className="stat">
          <dt>label</dt>
          <dd className="stat__value stat__value--label" title={result?.drawing.label ?? ''}>
            {result?.drawing.label ?? '—'}
          </dd>
        </div>
        <div className="stat">
          <dt>latency</dt>
          <dd className="stat__value">{result ? `${(result.latencyMs / 1000).toFixed(2)}s` : '—'}</dd>
        </div>
        <div className="stat">
          <dt>reasoning tok</dt>
          <dd className="stat__value">{result ? result.reasoningTokens.toLocaleString() : '—'}</dd>
        </div>
        <div className="stat">
          <dt>paths</dt>
          <dd className="stat__value">{result ? pathCount : '—'}</dd>
        </div>
        <div className="stat">
          <dt>reveal</dt>
          <dd className="stat__value">
            <span ref={progressRef}>0%</span>
          </dd>
        </div>
      </dl>

      {result?.note && result.validity !== 'forfeited' && (
        <p className="seat__note">Repaired: {result.note}</p>
      )}
      {result?.truncated && (
        <p className="seat__note seat__note--warn">
          Provider reported finish_reason=length — the drawing may be cut off.
        </p>
      )}
    </section>
  );
}