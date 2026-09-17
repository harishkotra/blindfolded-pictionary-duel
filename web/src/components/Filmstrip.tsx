import type { HistoryEntry } from '../lib/useDuel.js';

interface Props {
  history: HistoryEntry[];
  onClear: () => void;
  onReplay: (entry: HistoryEntry) => void;
}

export function Filmstrip({ history, onClear, onReplay }: Props) {
  return (
    <section className="strip" aria-label="Round history">
      <header className="strip__head">
        <h2 className="strip__title">Filmstrip</h2>
        <p className="strip__hint">
          {history.length === 0
            ? 'Every duel lands here, so the escalation is visible in one frame.'
            : `${history.length} round${history.length === 1 ? '' : 's'} drawn this session.`}
        </p>
        {history.length > 0 && (
          <button type="button" className="btn btn--ghost" onClick={onClear}>
            Clear
          </button>
        )}
      </header>

      <ol className="strip__rail">
        {history.length === 0 && (
          <li className="strip__empty">
            <span>R1</span>
            <span>R2</span>
            <span>R3</span>
            <span>R4</span>
          </li>
        )}
        {history.map((entry) => (
          <li key={entry.id} className="frame">
            <button
              type="button"
              className="frame__button"
              onClick={() => onReplay(entry)}
              title={`Replay round ${entry.round}: ${entry.subject}`}
            >
              <div className="frame__pair">
                <img className="frame__img" src={entry.thumbs[0]} alt={`Model A, ${entry.subject}`} />
                <img className="frame__img" src={entry.thumbs[1]} alt={`Model B, ${entry.subject}`} />
              </div>
              <div className="frame__caption">
                <span className="frame__round">R{entry.round}</span>
                <span className="frame__subject" title={entry.subject}>
                  {entry.subject}
                </span>
              </div>
              <div className="frame__counts">
                <span>A {entry.results[0].drawing.paths.length}p</span>
                <span>B {entry.results[1].drawing.paths.length}p</span>
              </div>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}