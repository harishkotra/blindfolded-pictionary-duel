import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DrawResult } from '@bpd/shared';
import { buildStrokes } from '../lib/svgPath.js';

/** The minimal shape the fallback needs: whatever is on the two sheets right now. */
export interface FallbackSubject {
  round: number;
  subject: string;
  results: [DrawResult, DrawResult];
}

interface Props {
  entry: FallbackSubject | null;
  open: boolean;
  onClose: () => void;
}

type Tab = 'A' | 'B';

/**
 * The plain-SVG fallback view: the same drawing rendered without WebGL.
 * Useful on machines without a GPU, and it is the honest way to show that the
 * canvas is nothing more than the model's own path data.
 */
export function SvgFallback({ entry, open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('A');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const strokes = useMemo(() => {
    if (!entry) return [];
    const result = tab === 'A' ? entry.results[0] : entry.results[1];
    return buildStrokes(result.drawing.paths);
  }, [entry, tab]);

  const copy = useCallback(async () => {
    if (!entry) return;
    const result = tab === 'A' ? entry.results[0] : entry.results[1];
    await navigator.clipboard.writeText(result.rawContent);
  }, [entry, tab]);

  if (!open || !entry) return null;

  const result = tab === 'A' ? entry.results[0] : entry.results[1];

  return (
    <div className="fallback" role="dialog" aria-modal="true" aria-label="SVG fallback view">
      <button type="button" className="settings__scrim" onClick={onClose} aria-label="Close" />
      <div className="fallback__panel">
        <header className="settings__head">
          <div>
            <h2 className="settings__title">Plain SVG view</h2>
            <p className="fallback__sub">
              Round {entry.round} · {entry.subject}
            </p>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="fallback__tabs" role="tablist">
          {(['A', 'B'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`tab ${tab === t ? 'tab--active' : ''}`}
              onClick={() => setTab(t)}
            >
              Model {t} · {entry.results[t === 'A' ? 0 : 1].model}
            </button>
          ))}
        </div>

        <div className="fallback__body">
          <svg
            className="fallback__svg"
            viewBox="0 0 400 400"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label={`Model ${tab} drawing of ${entry.subject}`}
          >
            <rect x="0" y="0" width="400" height="400" fill="#f5f3ec" />
            {strokes.map((stroke, i) =>
              stroke.polylines.map((poly, j) => (
                <path
                  key={`${i}-${j}`}
                  d={
                    `M ${poly.points.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' L ')}` +
                    (poly.closed ? ' Z' : '')
                  }
                  fill={stroke.fill === 'none' ? 'none' : stroke.fill}
                  stroke={stroke.stroke}
                  strokeWidth={stroke.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )),
            )}
          </svg>

          <div className="fallback__code">
            <div className="fallback__codehead">
              <span>Raw model output</span>
              <button type="button" className="btn btn--ghost" onClick={copy}>
                Copy this model's JSON
              </button>
            </div>
            <pre className="fallback__pre">{result.rawContent || '(empty)'}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}