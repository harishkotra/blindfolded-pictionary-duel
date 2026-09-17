import type { DuelConfig } from '@bpd/shared';
import { DEFAULT_CONFIG } from '@bpd/shared';

const KEY = 'bpd.config.v1';

/**
 * Settings live in localStorage only. The API key is never written to the
 * repo, never logged by the server, and never persisted anywhere but here.
 */
export function loadConfig(): DuelConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<DuelConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : DEFAULT_CONFIG.baseUrl,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      modelA: typeof parsed.modelA === 'string' && parsed.modelA ? parsed.modelA : DEFAULT_CONFIG.modelA,
      modelB: typeof parsed.modelB === 'string' && parsed.modelB ? parsed.modelB : DEFAULT_CONFIG.modelB,
      temperature: Number.isFinite(Number(parsed.temperature)) ? Number(parsed.temperature) : DEFAULT_CONFIG.temperature,
      maxTokens: Number.isFinite(Number(parsed.maxTokens)) ? Number(parsed.maxTokens) : DEFAULT_CONFIG.maxTokens,
      disableReasoning: parsed.disableReasoning !== false,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: DuelConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    /* private browsing: settings simply will not persist */
  }
}

export function clearConfig(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}