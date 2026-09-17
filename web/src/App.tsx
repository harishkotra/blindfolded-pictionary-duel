import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DuelConfig, DrawResult } from '@bpd/shared';
import { ROUND_LADDER } from '@bpd/shared';
import { DuelCanvas, type SeatPhase } from './components/DuelCanvas.js';
import { Filmstrip } from './components/Filmstrip.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { SvgFallback } from './components/SvgFallback.js';
import { loadConfig, saveConfig } from './lib/storage.js';
import { useDuel, type HistoryEntry } from './lib/useDuel.js';
import { buildStrokes, type Stroke } from './lib/svgPath.js';

/** Whatever is currently on the two sheets, live or replayed. */
interface Shown {
  round: number;
  subject: string;
  results: [DrawResult, DrawResult];
  prompt: string;
}

export default function App() {
  const [config, setConfig] = useState<DuelConfig>(() => loadConfig());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [activeRound, setActiveRound] = useState<number | null>(null);
  const [replay, setReplay] = useState<HistoryEntry | null>(null);
  const [playToken, setPlayToken] = useState(0);
  const [copied, setCopied] = useState(false);

  const duel = useDuel(config);
  const keyMissing = config.apiKey.trim().length === 0;

  // A clean clone has no key: open settings immediately rather than failing a call.
  useEffect(() => {
    if (keyMissing) setSettingsOpen(true);
  }, [keyMissing]);

  const shown: Shown | null = useMemo(() => {
    if (replay) {
      return {
        round: replay.round,
        subject: replay.subject,
        results: replay.results,
        prompt: replay.prompt,
      };
    }
    if (!duel.response) return null;
    return {
      round: duel.response.round,
      subject: duel.response.subject,
      results: duel.response.results,
      prompt: duel.response.prompt,
    };
  }, [replay, duel.response]);

  // Replaying a filmstrip frame re-parses that round's paths.
  const strokes = useMemo<[Stroke[], Stroke[]]>(() => {
    if (!replay) return duel.strokes;
    return [
      buildStrokes(replay.results[0].drawing.paths),
      buildStrokes(replay.results[1].drawing.paths),
    ];
  }, [replay, duel.strokes]);

  const start = useCallback(
    (subject: string, round: number) => {
      setReplay(null);
      setActiveRound(round);
      setPlayToken((t) => t + 1);
      void duel.run(subject, round);
    },
    [duel],
  );

  const onReplay = useCallback((entry: HistoryEntry) => {
    setReplay(entry);
    setActiveRound(entry.round);
    setPlayToken((t) => t + 1);
  }, []);

  const onSaveConfig = useCallback((next: DuelConfig) => {
    setConfig(next);
    saveConfig(next);
    setSettingsOpen(false);
  }, []);

  const copyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(duel.allRawJson);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [duel.allRawJson]);

  const busy = duel.status === 'drawing';

  // What each seat should be showing right now. Without this the seats fell
  // back to the "Blank sheet" idle overlay for the whole request, which reads
  // as "nothing is happening" during a minutes-long reasoning call.
  const seatPhase: SeatPhase =
    duel.status === 'drawing'
      ? 'loading'
      : duel.status === 'error'
        ? 'error'
        : shown
          ? 'ready'
          : 'idle';

  return (
    <div className="app">
      <header className="top">
        <div className="top__brand">
          <p className="eyebrow">Two models · one subject · raw SVG path data</p>
          <h1 className="top__title">
            Blindfolded
            <br />
            Pictionary Duel
          </h1>
          <p className="top__sub">
            No retouching, no image models, no second chances. Both models get the same prompt and
            return path data. What you see is what it drew.
          </p>
        </div>

        <div className="top__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setFallbackOpen(true)}
            disabled={!shown}
          >
            Plain SVG view
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={copyAll}
            disabled={duel.history.length === 0}
            title="Copy the raw JSON every model returned this session"
          >
            {copied ? 'Copied' : 'Copy all raw JSON'}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      <nav className="ladder" aria-label="Round ladder">
        {ROUND_LADDER.map((rung) => (
          <button
            key={rung.round}
            type="button"
            className={`rung ${activeRound === rung.round ? 'rung--active' : ''}`}
            onClick={() => start(rung.subject, rung.round)}
            disabled={busy}
          >
            <span className="rung__num">R{rung.round}</span>
            <span className="rung__subject">{rung.subject}</span>
            <span className="rung__blurb">{rung.blurb}</span>
          </button>
        ))}

        <form
          className="custom"
          onSubmit={(e) => {
            e.preventDefault();
            const subject = custom.trim();
            if (subject) start(subject, 0);
          }}
        >
          <label className="field">
            <span className="field__label">Custom subject</span>
            <span className="field__row">
              <input
                className="field__input"
                type="text"
                value={custom}
                maxLength={300}
                placeholder="a lighthouse in a storm"
                onChange={(e) => setCustom(e.target.value)}
              />
              <button type="submit" className="btn btn--primary" disabled={busy || !custom.trim()}>
                Duel
              </button>
            </span>
          </label>
        </form>
      </nav>

      {duel.error && (
        <div className="banner banner--error" role="alert">
          <strong>The duel could not start.</strong>
          <span>{duel.error}</span>
          <button type="button" className="btn btn--ghost" onClick={() => setSettingsOpen(true)}>
            Check settings
          </button>
        </div>
      )}

      {duel.status === 'invalid-output' && !duel.error && (
        <div className="banner banner--warn" role="status">
          <strong>At least one model forfeited.</strong>
          <span>
            It failed validation twice. The raw output is preserved below and in the server log.
          </span>
        </div>
      )}

      <main className="arena">
        <DuelCanvas
          seat="A"
          result={shown?.results[0] ?? null}
          strokes={strokes[0]}
          playToken={playToken}
          accent="#ff9d2e"
          phase={seatPhase}
          reasoningOn={!config.disableReasoning}
        />

        <div className="divider" aria-hidden="true">
          <span className="divider__line" />
          <span className="divider__label">same prompt</span>
          <span className="divider__line" />
        </div>

        <DuelCanvas
          seat="B"
          result={shown?.results[1] ?? null}
          strokes={strokes[1]}
          playToken={playToken}
          accent="#3fe0d0"
          phase={seatPhase}
          reasoningOn={!config.disableReasoning}
        />
      </main>

      <section className="promptbox" aria-label="Exact prompt sent to both models">
        <h2 className="promptbox__title">
          The identical prompt
          <span className="promptbox__tag">sent byte-for-byte to both models</span>
        </h2>
        <p className="promptbox__body">
          {shown?.prompt ??
            'Press a rung to see the exact prompt both models receive.'}
        </p>
        {duel.response?.logged && (
          <p className="promptbox__log">
            Raw JSON for every duel is appended to the server's audit log.
          </p>
        )}
      </section>

      <Filmstrip history={duel.history} onClear={duel.clearHistory} onReplay={onReplay} />

      <footer className="foot">
        <p>
          Paths are parsed and drawn client-side. Nothing is cached, templated, or hand-authored — if
          both panels ever look identical, the two model names are the same.
        </p>
        <p className="foot__credit">
          <span>
            Built by{' '}
            <a href="https://harishkotra.me" target="_blank" rel="noreferrer noopener">
              Harish Kotra
            </a>
          </span>
          <span className="foot__sep" aria-hidden="true">
            ·
          </span>
          <a href="https://dailybuild.xyz" target="_blank" rel="noreferrer noopener">
            Checkout my other builds
          </a>
        </p>
      </footer>

      <SettingsPanel
        open={settingsOpen}
        config={config}
        onClose={() => setSettingsOpen(false)}
        onSave={onSaveConfig}
      />
      <SvgFallback entry={shown} open={fallbackOpen} onClose={() => setFallbackOpen(false)} />
    </div>
  );
}