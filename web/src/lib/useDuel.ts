import { useCallback, useMemo, useRef, useState } from 'react';
import type { DuelConfig, DuelResponse, DrawResult } from '@bpd/shared';
import { buildStrokes, type Stroke } from './svgPath.js';
import { renderThumbnail } from './duelRenderer.js';

export type DuelStatus = 'idle' | 'drawing' | 'rendered' | 'invalid-output' | 'error';

export interface HistoryEntry {
  id: string;
  round: number;
  subject: string;
  at: string;
  results: [DrawResult, DrawResult];
  thumbs: [string, string];
  prompt: string;
}

export interface DuelState {
  status: DuelStatus;
  response: DuelResponse | null;
  error: string | null;
  /** Parsed strokes per seat, ready for the renderer. */
  strokes: [Stroke[], Stroke[]];
  history: HistoryEntry[];
}

const EMPTY_STROKES: [Stroke[], Stroke[]] = [[], []];

export function useDuel(config: DuelConfig) {
  const [state, setState] = useState<DuelState>({
    status: 'idle',
    response: null,
    error: null,
    strokes: EMPTY_STROKES,
    history: [],
  });
  const inFlight = useRef(false);

  const run = useCallback(
    async (subject: string, round: number) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setState((s) => ({ ...s, status: 'drawing', error: null, response: null, strokes: EMPTY_STROKES }));

      try {
        const res = await fetch('/api/draw', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subject, round, config }),
        });

        const text = await res.text();
        if (!res.ok) {
          let message = text;
          try {
            const parsed = JSON.parse(text) as { error?: string };
            if (parsed.error) message = parsed.error;
          } catch {
            /* keep raw text */
          }
          setState((s) => ({ ...s, status: 'error', error: message, strokes: EMPTY_STROKES }));
          return;
        }

        const data = JSON.parse(text) as DuelResponse;
        const strokes: [Stroke[], Stroke[]] = [
          buildStrokes(data.results[0].drawing.paths),
          buildStrokes(data.results[1].drawing.paths),
        ];

        const anyForfeit = data.results.some((r) => r.validity === 'forfeited');
        const thumbs: [string, string] = [
          renderThumbnail(strokes[0]),
          renderThumbnail(strokes[1]),
        ];

        setState((s) => ({
          status: anyForfeit ? 'invalid-output' : 'rendered',
          response: data,
          error: null,
          strokes,
          history: [
            ...s.history,
            {
              id: `${data.at}-${round}-${subject}`,
              round,
              subject,
              at: data.at,
              results: data.results,
              thumbs,
              prompt: data.prompt,
            },
          ],
        }));
      } catch (e) {
        setState((s) => ({
          ...s,
          status: 'error',
          error: `Could not reach the duel server: ${(e as Error).message}`,
          strokes: EMPTY_STROKES,
        }));
      } finally {
        inFlight.current = false;
      }
    },
    [config],
  );

  const clearHistory = useCallback(() => {
    setState((s) => ({ ...s, history: [] }));
  }, []);

  /** Every raw JSON string, for the "Copy all raw JSON" button. */
  const allRawJson = useMemo(() => {
    const records = state.history.map((h) => ({
      round: h.round,
      subject: h.subject,
      at: h.at,
      prompt: h.prompt,
      models: h.results.map((r) => ({
        seat: r.seat,
        model: r.model,
        validity: r.validity,
        note: r.note,
        error: r.error,
        latencyMs: r.latencyMs,
        attempts: r.attempts,
        reasoningTokens: r.reasoningTokens,
        completionTokens: r.completionTokens,
        pathCount: r.drawing.paths.length,
        rawContent: r.rawContent,
      })),
    }));
    return JSON.stringify(records, null, 2);
  }, [state.history]);

  return { ...state, run, clearHistory, allRawJson };
}