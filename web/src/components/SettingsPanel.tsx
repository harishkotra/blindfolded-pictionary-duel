import { useEffect, useState } from 'react';
import type { DuelConfig } from '@bpd/shared';
import { DEFAULT_CONFIG, REASONING_MIN_BUDGET } from '@bpd/shared';

interface Props {
  open: boolean;
  config: DuelConfig;
  onClose: () => void;
  onSave: (config: DuelConfig) => void;
}

export function SettingsPanel({ open, config, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<DuelConfig>(config);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (open) setDraft(config);
  }, [open, config]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = <K extends keyof DuelConfig>(key: K, value: DuelConfig[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" className="settings__scrim" onClick={onClose} aria-label="Close settings" />
      <div className="settings__panel">
        <header className="settings__head">
          <h2 className="settings__title">Settings</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <p className="settings__note">
          Stored in this browser only. The key is sent to your local duel server with each request and
          forwarded to the provider — it is never written to a file in this repo.
        </p>

        <label className="field">
          <span className="field__label">Base URL</span>
          <input
            className="field__input"
            type="url"
            value={draft.baseUrl}
            spellCheck={false}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder={DEFAULT_CONFIG.baseUrl}
          />
          <span className="field__hint">OpenAI-compatible endpoint; /chat/completions is appended.</span>
        </label>

        <label className="field">
          <span className="field__label">API Key</span>
          <span className="field__row">
            <input
              className="field__input"
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => set('apiKey', e.target.value)}
              placeholder="paste your key"
            />
            <button type="button" className="btn btn--ghost" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </span>
        </label>

        <div className="field__grid">
          <label className="field">
            <span className="field__label">Model A (older)</span>
            <input
              className="field__input"
              type="text"
              value={draft.modelA}
              spellCheck={false}
              onChange={(e) => set('modelA', e.target.value)}
              placeholder={DEFAULT_CONFIG.modelA}
            />
          </label>

          <label className="field">
            <span className="field__label">Model B (newer)</span>
            <input
              className="field__input"
              type="text"
              value={draft.modelB}
              spellCheck={false}
              onChange={(e) => set('modelB', e.target.value)}
              placeholder={DEFAULT_CONFIG.modelB}
            />
          </label>

          <label className="field">
            <span className="field__label">Temperature</span>
            <input
              className="field__input"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature}
              onChange={(e) => set('temperature', Number(e.target.value))}
            />
          </label>

          <label className="field">
            <span className="field__label">Max Tokens</span>
            <input
              className="field__input"
              type="number"
              min={64}
              max={32000}
              step={64}
              value={draft.maxTokens}
              onChange={(e) => set('maxTokens', Number(e.target.value))}
            />
            <span className="field__hint">
              {draft.disableReasoning ? (
                'Doubled automatically on an empty or truncated reply.'
              ) : draft.maxTokens < REASONING_MIN_BUDGET ? (
                <>
                  With reasoning on, <code>max_tokens</code> also pays for thinking, and{' '}
                  {draft.maxTokens.toLocaleString()} is too small to finish — the server raises it to{' '}
                  {REASONING_MIN_BUDGET.toLocaleString()}. Expect a long wait.
                </>
              ) : (
                'Enough headroom for a thinking model. Doubled further on an empty reply.'
              )}
            </span>
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.disableReasoning}
            onChange={(e) => set('disableReasoning', e.target.checked)}
          />
          <span>
            Disable reasoning
            <span className="check__hint">
              Sends <code>chat_template_kwargs: {'{"enable_thinking": false}'}</code>. With reasoning on,
              a thinking model can spend the whole budget before writing a single path — measured,{' '}
              <code>deepseek-v4.1-flash</code> needs more than 8,000 tokens for a city scene and
              returns nothing at all below that.
            </span>
          </span>
        </label>

        <footer className="settings__foot">
          <button type="button" className="btn btn--ghost" onClick={() => setDraft({ ...DEFAULT_CONFIG })}>
            Reset to defaults
          </button>
          <button type="button" className="btn btn--primary" onClick={() => onSave(draft)}>
            Save settings
          </button>
        </footer>
      </div>
    </div>
  );
}