/**
 * Shared contract between the duel server and the web client.
 * This is the single source of truth for the wire format.
 */

/** How a model's output survived validation. */
export type Validity = 'valid' | 'repaired' | 'forfeited';

/** One stroke of a drawing, exactly as the model emitted it. */
export interface DrawPath {
  d: string;
  stroke: string;
  fill: string;
  width: number;
}

/** The JSON object the models are instructed to produce. */
export interface DrawPayload {
  paths: DrawPath[];
  label: string;
}

/** Per-model result of one duel. */
export interface DrawResult {
  /** Which seat this model occupies. */
  seat: 'A' | 'B';
  /** Model id as configured. */
  model: string;
  /** HTTP status of the final attempt (0 when the request never left). */
  status: number;
  /** Wall-clock latency of the winning attempt, in ms. */
  latencyMs: number;
  /** Sum of latency across all attempts (initial + retry). */
  totalLatencyMs: number;
  /** How many upstream calls were made (1 = clean, 2 = retried once). */
  attempts: number;
  validity: Validity;
  /** Human-readable reason when validity is not 'valid'. */
  note?: string;
  /** Provider error text, verbatim, when the call failed. */
  error?: string;
  /** Parsed + validated drawing. Empty for a forfeit. */
  drawing: DrawPayload;
  /** Reasoning token count from usage.completion_tokens_details.reasoning_tokens. */
  reasoningTokens: number;
  completionTokens: number;
  promptTokens: number;
  /** True when the provider reported finish_reason === 'length'. */
  truncated: boolean;
  /** Raw assistant content string, exactly as returned. Never contains reasoning_content. */
  rawContent: string;
  /** The full request body sent upstream, for auditability. */
  requestBody: unknown;
}

/** Response body of POST /api/draw. */
export interface DuelResponse {
  subject: string;
  round: number;
  /** The exact user prompt sent to BOTH models. Identical by construction. */
  prompt: string;
  systemPrompt: string;
  results: [DrawResult, DrawResult];
  /** Server-side timestamp, ISO 8601. */
  at: string;
  /**
   * Whether this duel was appended to the server's raw JSON audit log.
   * Deliberately a boolean rather than a path: the log's location on disk is
   * machine-specific, so it is never sent to the browser.
   */
  logged?: boolean;
}

/** Client-supplied model configuration. Never persisted server-side. */
export interface DuelConfig {
  baseUrl: string;
  apiKey: string;
  modelA: string;
  modelB: string;
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
}

export interface DuelRequest {
  subject: string;
  round: number;
  config: DuelConfig;
}

/** One rung of the difficulty ladder. */
export interface Round {
  round: number;
  subject: string;
  blurb: string;
}

/**
 * The fixed ladder. Escalation is the whole point: each rung adds a spatial
 * constraint that punishes a model that cannot hold a scene together.
 */
export const ROUND_LADDER: readonly Round[] = [
  { round: 1, subject: 'a cat', blurb: 'one object, no scene' },
  { round: 2, subject: 'a cat on a bicycle', blurb: 'two objects, contact point' },
  {
    round: 3,
    subject: 'a cat riding a bicycle through a city at night',
    blurb: 'scene, depth, lighting',
  },
  {
    round: 4,
    subject: 'a cat riding a bicycle through a city at night, in the rain',
    blurb: 'scene + weather + occlusion',
  },
] as const;

export const DEFAULT_CONFIG: DuelConfig = {
  baseUrl: 'https://api.particle.ai/v1',
  apiKey: '',
  modelA: 'deepseek-v4-flash-0731',
  modelB: 'deepseek-v4.1-flash',
  temperature: 0,
  maxTokens: 1600,
  disableReasoning: true,
};

export const SYSTEM_PROMPT =
  'You are a vector illustrator. You output only valid JSON. You never output prose, markdown, or commentary.';

/**
 * The smallest max_tokens that can work when reasoning is enabled.
 *
 * `max_tokens` pays for the model's thinking as well as its answer, and a
 * thinking model that runs out mid-thought returns no content at all — not a
 * truncated drawing, nothing. Measured against the real provider with
 * deepseek-v4.1-flash: budgets of 1,600, 4,000 and 8,192 were consumed
 * entirely by reasoning and produced zero paths, "a cat" needed about 6,500,
 * and a city scene needed about 8,350 before finishing at 16,384. Below this
 * floor, reasoning cannot produce a drawing by construction, so the server
 * treats it as a floor rather than letting a wasted call fail.
 */
export const REASONING_MIN_BUDGET = 16384;

/** Build the user prompt. Both models receive byte-identical output from this. */
export function buildUserPrompt(subject: string): string {
  return (
    `Draw ${subject} as SVG path data. Use a 0 0 400 400 viewBox. ` +
    'Output ONLY JSON matching this schema: ' +
    '{"paths": [{"d": "<svg path data>", "stroke": "<hex colour>", "fill": "none|hex", "width": <number>}], "label": "<short label>"}. ' +
    'Use at least 3 and at most 40 paths. Coordinates must stay inside the viewBox. ' +
    'Do not include any text in the drawing.'
  );
}

/** Valid SVG path start commands. */
export const PATH_COMMANDS = ['M', 'm', 'L', 'l', 'C', 'c', 'Q', 'q', 'Z', 'z'] as const;

/** Total stroke length of a drawing, used for reveal pacing. */
export function pathCount(d: DrawPayload): number {
  return d.paths.length;
}