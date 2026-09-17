import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { mkdir, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DuelConfig, DuelRequest, DuelResponse, DrawResult } from '@bpd/shared';
import { DEFAULT_CONFIG, ROUND_LADDER, SYSTEM_PROMPT, buildUserPrompt } from '@bpd/shared';
import { drawWithModel } from './modelClient.js';

const PORT = Number(process.env.PORT ?? 3001);
/** Raw JSON audit trail. Overridable so tests can point it at a temp dir. */
const LOG_DIR = resolve(process.env.BPD_LOG_DIR ?? join(process.cwd(), 'logs'));
const LOG_FILE = join(LOG_DIR, 'raw-model-output.jsonl');

const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('access-control-allow-origin', '*');
  c.header('access-control-allow-headers', 'content-type');
  c.header('access-control-allow-methods', 'GET,POST,OPTIONS');
});

app.options('*', (c) => c.body(null, 204));

app.get('/api/health', (c) => c.json({ ok: true, service: 'blindfolded-pictionary-duel', port: PORT }));

app.get('/api/rounds', (c) => c.json({ rounds: ROUND_LADDER }));

/**
 * Append the raw model output for one duel to the audit log.
 * `rawContent` is the assistant `content` string only — reasoning_content is
 * never captured anywhere in this process, so it cannot leak into this file.
 *
 * Returns whether the write succeeded. The file's path stays server-side: it is
 * machine-specific and is never part of the API response.
 */
async function logDuel(entry: {
  at: string;
  subject: string;
  round: number;
  prompt: string;
  results: DrawResult[];
}): Promise<boolean> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const record = {
      at: entry.at,
      subject: entry.subject,
      round: entry.round,
      systemPrompt: SYSTEM_PROMPT,
      prompt: entry.prompt,
      models: entry.results.map((r) => ({
        seat: r.seat,
        model: r.model,
        status: r.status,
        latencyMs: r.latencyMs,
        totalLatencyMs: r.totalLatencyMs,
        attempts: r.attempts,
        validity: r.validity,
        note: r.note,
        error: r.error,
        reasoningTokens: r.reasoningTokens,
        completionTokens: r.completionTokens,
        truncated: r.truncated,
        pathCount: r.drawing.paths.length,
        label: r.drawing.label,
        requestBody: r.requestBody,
        rawContent: r.rawContent,
      })),
    };
    await appendFile(LOG_FILE, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch (e) {
    console.error('[bpd] failed to write raw output log:', (e as Error).message);
    return false;
  }
}

function validateConfig(input: unknown): { ok: true; config: DuelConfig } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'config is required' };
  const c = input as Partial<DuelConfig>;
  const baseUrl = typeof c.baseUrl === 'string' ? c.baseUrl.trim() : '';
  if (!baseUrl) return { ok: false, error: 'config.baseUrl is required' };
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: 'config.baseUrl must be an http(s) URL' };
  const apiKey = typeof c.apiKey === 'string' ? c.apiKey.trim() : '';
  if (!apiKey) {
    return {
      ok: false,
      error: 'No API key. Open Settings and paste one — it is stored in your browser only and sent to this server per request.',
    };
  }
  const modelA = typeof c.modelA === 'string' ? c.modelA.trim() : '';
  const modelB = typeof c.modelB === 'string' ? c.modelB.trim() : '';
  if (!modelA || !modelB) return { ok: false, error: 'Both model names are required' };
  const temperature = Number(c.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return { ok: false, error: 'temperature must be between 0 and 2' };
  }
  const maxTokens = Number(c.maxTokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 64 || maxTokens > 32000) {
    return { ok: false, error: 'maxTokens must be between 64 and 32000' };
  }
  return {
    ok: true,
    config: {
      baseUrl,
      apiKey,
      modelA,
      modelB,
      temperature,
      maxTokens: Math.round(maxTokens),
      disableReasoning: c.disableReasoning !== false,
    },
  };
}

app.post('/api/draw', async (c) => {
  let body: Partial<DuelRequest>;
  try {
    body = (await c.req.json()) as Partial<DuelRequest>;
  } catch {
    return c.json({ error: 'Request body must be JSON' }, 400);
  }

  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  if (!subject) return c.json({ error: 'subject is required' }, 400);
  if (subject.length > 300) return c.json({ error: 'subject must be 300 characters or fewer' }, 400);
  const round = Number.isFinite(Number(body.round)) ? Number(body.round) : 0;

  const checked = validateConfig(body.config);
  if (!checked.ok) return c.json({ error: checked.error }, 400);
  const config = checked.config;

  const prompt = buildUserPrompt(subject);
  const at = new Date().toISOString();

  // Both seats are dispatched concurrently with the identical prompt string.
  const [a, b] = await Promise.all([
    drawWithModel('A', config.modelA, subject, config),
    drawWithModel('B', config.modelB, subject, config),
  ]);

  const results: [DrawResult, DrawResult] = [a, b];
  const logged = await logDuel({ at, subject, round, prompt, results });

  const payload: DuelResponse = {
    subject,
    round,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    results,
    at,
    logged,
  };
  return c.json(payload);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[bpd] duel server listening on http://127.0.0.1:${info.port}`);
  console.log(`[bpd] raw model output log: ${LOG_FILE}`);
  console.log(`[bpd] default model A: ${DEFAULT_CONFIG.modelA} | model B: ${DEFAULT_CONFIG.modelB}`);
});