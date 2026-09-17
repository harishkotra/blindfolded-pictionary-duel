import type { DuelConfig, DrawResult } from '@bpd/shared';
import { REASONING_MIN_BUDGET, SYSTEM_PROMPT, buildUserPrompt } from '@bpd/shared';
import { parseDrawing } from './validate.js';

const REQUEST_TIMEOUT_MS = 180_000;

/** Next token budget to try after a failure caused by a budget that was too small. */
function escalateBudget(current: number): number {
  return Math.max(current * 2, REASONING_MIN_BUDGET);
}

/**
 * The budget to actually send.
 *
 * With reasoning off, the user's number is used as-is. With reasoning on, it is
 * a floor: a budget below REASONING_MIN_BUDGET cannot produce a drawing, so
 * honouring it literally would only guarantee a wasted call.
 */
function startingBudget(config: DuelConfig): number {
  return config.disableReasoning
    ? config.maxTokens
    : Math.max(config.maxTokens, REASONING_MIN_BUDGET);
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface ChatChoice {
  finish_reason?: string;
  message?: {
    role?: string;
    content?: string | null;
    /**
     * Deliberately typed as unknown and never read: reasoning_content must not
     * be logged, stored, or rendered. Only its token count is reported.
     */
    reasoning_content?: unknown;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: Usage;
  error?: { message?: string; type?: string; code?: string };
}

interface Attempt {
  status: number;
  latencyMs: number;
  content: string;
  finishReason: string;
  reasoningTokens: number;
  completionTokens: number;
  promptTokens: number;
  errorText?: string;
  transportError?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function readUsage(usage: Usage | undefined): {
  reasoningTokens: number;
  completionTokens: number;
  promptTokens: number;
} {
  const reasoning =
    usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens ?? 0;
  return {
    reasoningTokens: Number.isFinite(reasoning) ? Number(reasoning) : 0,
    completionTokens: Number(usage?.completion_tokens ?? 0),
    promptTokens: Number(usage?.prompt_tokens ?? 0),
  };
}

/** Build the request body. Both seats use this, so the prompt is identical by construction. */
export function buildRequestBody(
  model: string,
  subject: string,
  config: DuelConfig,
  maxTokens: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    temperature: config.temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(subject) },
    ],
  };
  if (config.disableReasoning) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return body;
}

async function callOnce(
  model: string,
  subject: string,
  config: DuelConfig,
  maxTokens: number,
): Promise<{ attempt: Attempt; requestBody: Record<string, unknown> }> {
  const requestBody = buildRequestBody(model, subject, config, maxTokens);
  const started = Date.now();
  const base: Attempt = {
    status: 0,
    latencyMs: 0,
    content: '',
    finishReason: '',
    reasoningTokens: 0,
    completionTokens: 0,
    promptTokens: 0,
  };

  try {
    const res = await fetch(joinUrl(config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      // Surface the provider's real error text, verbatim.
      let message = text;
      try {
        const parsed = JSON.parse(text) as ChatResponse;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        /* keep raw text */
      }
      return {
        attempt: { ...base, status: res.status, latencyMs, errorText: message || res.statusText },
        requestBody,
      };
    }

    let json: ChatResponse;
    try {
      json = JSON.parse(text) as ChatResponse;
    } catch {
      return {
        attempt: {
          ...base,
          status: res.status,
          latencyMs,
          errorText: `provider returned non-JSON body: ${text.slice(0, 300)}`,
        },
        requestBody,
      };
    }

    const choice = json.choices?.[0];
    const message = choice?.message;
    const usage = readUsage(json.usage);
    // NOTE: message.reasoning_content is intentionally never read or stored.
    const content = typeof message?.content === 'string' ? message.content : '';

    return {
      attempt: {
        status: res.status,
        latencyMs,
        content,
        finishReason: choice?.finish_reason ?? '',
        ...usage,
      },
      requestBody,
    };
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      attempt: {
        ...base,
        latencyMs: Date.now() - started,
        transportError: timedOut
          ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : `${err.name}: ${err.message}`,
      },
      requestBody,
    };
  }
}

function forfeit(
  seat: 'A' | 'B',
  model: string,
  attempts: Attempt[],
  reason: string,
  requestBody: unknown,
): DrawResult {
  const last = attempts[attempts.length - 1]!;
  const totalLatencyMs = attempts.reduce((sum, a) => sum + a.latencyMs, 0);
  const reasoningTokens = attempts.reduce((sum, a) => sum + a.reasoningTokens, 0);
  return {
    seat,
    model,
    status: last.status,
    latencyMs: last.latencyMs,
    totalLatencyMs,
    attempts: attempts.length,
    validity: 'forfeited',
    note: reason,
    error: last.errorText ?? last.transportError,
    drawing: { paths: [], label: 'forfeit' },
    reasoningTokens,
    completionTokens: attempts.reduce((sum, a) => sum + a.completionTokens, 0),
    promptTokens: last.promptTokens,
    truncated: last.finishReason === 'length',
    rawContent: last.content,
    requestBody,
  };
}

/** Non-retryable: the request itself is wrong (auth, unknown model, bad payload). */
function isFatalStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Call one model and return its validated drawing.
 *
 * Retry policy (exactly one retry):
 *  - invalid/unparseable output, empty content, truncation, 429/5xx, transport error
 *  - the retry raises the token budget when the failure was empty or truncated,
 *    doubling it and also clearing REASONING_RETRY_FLOOR so that a model which
 *    thinks before it draws gets enough room to finish
 * A second failure is recorded as a forfeit rather than thrown.
 */
export async function drawWithModel(
  seat: 'A' | 'B',
  model: string,
  subject: string,
  config: DuelConfig,
): Promise<DrawResult> {
  const attempts: Attempt[] = [];
  let requestBody: unknown = null;
  let maxTokens = startingBudget(config);
  let lastReason = 'unknown failure';

  for (let i = 0; i < 2; i++) {
    const { attempt, requestBody: body } = await callOnce(model, subject, config, maxTokens);
    requestBody = body;
    attempts.push(attempt);

    if (attempt.transportError) {
      lastReason = attempt.transportError;
      continue;
    }
    if (attempt.errorText) {
      lastReason = `HTTP ${attempt.status}: ${attempt.errorText}`;
      if (isFatalStatus(attempt.status)) break;
      continue;
    }
    if (!attempt.content.trim()) {
      const nextBudget = escalateBudget(maxTokens);
      lastReason = attempt.finishReason === 'length'
        ? `empty content: the model spent its entire ${maxTokens}-token budget on reasoning (finish_reason=length)`
        : 'empty content';
      maxTokens = nextBudget;
      continue;
    }

    const outcome = parseDrawing(attempt.content);
    if (!outcome.ok) {
      lastReason = `invalid output: ${outcome.reason}`;
      if (attempt.finishReason === 'length') maxTokens = escalateBudget(maxTokens);
      continue;
    }

    const totalLatencyMs = attempts.reduce((sum, a) => sum + a.latencyMs, 0);
    return {
      seat,
      model,
      status: attempt.status,
      latencyMs: attempt.latencyMs,
      totalLatencyMs,
      attempts: attempts.length,
      validity: outcome.repaired ? 'repaired' : 'valid',
      note: outcome.repaired ? outcome.repairs.join('; ') : undefined,
      drawing: outcome.drawing,
      reasoningTokens: attempts.reduce((sum, a) => sum + a.reasoningTokens, 0),
      completionTokens: attempts.reduce((sum, a) => sum + a.completionTokens, 0),
      promptTokens: attempt.promptTokens,
      truncated: attempt.finishReason === 'length',
      rawContent: attempt.content,
      requestBody,
    };
  }

  return forfeit(seat, model, attempts, lastReason, requestBody);
}