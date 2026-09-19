/**
 * A typed TypeSafe System One client.
 *
 * The wire contract implemented here is the one documented at
 * https://docs.typesafe.ai:
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <TYPESAFE_API_KEY>
 *   { "state": <string | object>, "model": "jev-latest", "questions": { id: {...} } }
 *
 * Responses carry `answers.<id>` in one of three shapes, discriminated by
 * `type`:
 *   noul   -> { noul: 0..1 }                          (probability the statement holds)
 *   choice -> { choice, probabilities, confidence }   (one option from a set)
 *   score  -> { score, legend?, confidence }          (fractional position on a scale)
 *
 * Only these three primitives exist, `instructions` is optional everywhere, a
 * Choice takes 1..255 options, a Score takes 2..10 levels, and many questions
 * can be asked in one call (they are answered together and never see each
 * other). All of that is normalised here so no other module has to know the
 * wire format.
 */

export type AnswerType = 'noul' | 'choice' | 'score';

export interface NoulAnswer {
  type: 'noul';
  /** Probability that the statement is true, 0..1. */
  noul: number;
}

export interface ChoiceAnswer<T extends string = string> {
  type: 'choice';
  choice: T;
  /** Probability per option; sums to 1 across all supplied options. */
  probabilities: Record<string, number>;
  /** How peaked the distribution is on the winner, 0..1. */
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Fractional score between levels, e.g. 1.4 between level 1 and level 2. */
  score: number;
  legend?: Record<string, string>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type AnswerMap = Record<string, Answer>;

export interface EvaluateResult {
  model: string;
  answers: AnswerMap;
  requestId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
  raw: unknown;
}

export interface NoulQuestion {
  type: 'noul';
  instructions?: unknown;
  criteria?: unknown;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions?: unknown;
  criteria: Record<string, unknown>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions?: unknown;
  criteria: unknown[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type QuestionSet = Record<string, Question>;

export interface TypeSafeClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class TypeSafeError extends Error {
  public readonly status: number | null;
  public readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = 'TypeSafeError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** True when the noul probability should be read as "yes". */
export function noulYes(value: number): boolean {
  return value >= 0.5;
}

/** Distance from a coin flip: 0 when torn, 1 when certain. */
export class TypeSafeClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: TypeSafeClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'jev-latest';
    this.baseUrl = (options.baseUrl ?? 'https://api.typesafe.ai').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 12000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  public getModel(): string {
    return this.model;
  }

  /**
   * Sends one batch of questions about one piece of state. `state` may be a
   * string or any JSON-serialisable object; a structured object is strongly
   * preferred, because it lets each question name the exact field to look at.
   */
  public async evaluate(
    state: unknown,
    questions: QuestionSet,
    signal?: AbortSignal
  ): Promise<EvaluateResult> {
    if (Object.keys(questions).length === 0) {
      throw new TypeSafeError('At least one question is required', null, false);
    }

    const body = JSON.stringify({ state, model: this.model, questions });
    const started = Date.now();
    let lastError: TypeSafeError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter, capped so a chess move never stalls
        // on a slow upstream.
        const backoff = Math.min(250 * 2 ** (attempt - 1), 1500) + Math.random() * 120;
        await sleep(backoff, signal);
      }

      try {
        const response = await this.post(body, signal);
        const latencyMs = Date.now() - started;

        if (!response.ok) {
          const text = await safeText(response);
          const retryable =
            response.status === 408 || response.status === 429 || response.status >= 500;
          lastError = new TypeSafeError(
            `TypeSafe responded ${response.status}: ${text.slice(0, 300)}`,
            response.status,
            retryable
          );
          if (!retryable) throw lastError;
          continue;
        }

        const json = (await response.json()) as Record<string, unknown>;
        return this.parseResult(
          json,
          latencyMs,
          response.headers.get('x-typesafe-request-id') ?? undefined
        );
      } catch (error) {
        if (error instanceof TypeSafeError) {
          lastError = error;
          if (!error.retryable) throw error;
          continue;
        }
        if (isAbort(error) || (signal && signal.aborted)) {
          throw new TypeSafeError('TypeSafe request aborted', null, false);
        }
        lastError = new TypeSafeError(`TypeSafe request failed: ${describe(error)}`, null, true);
      }
    }

    throw lastError ?? new TypeSafeError('TypeSafe request failed', null, true);
  }

  private async post(body: string, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await fetch(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Normalises the documented answer shapes and rejects anything unexpected. */
  private parseResult(
    json: Record<string, unknown>,
    latencyMs: number,
    requestId?: string
  ): EvaluateResult {
    const answerSource = json.answers;
    if (!answerSource || typeof answerSource !== 'object') {
      throw new TypeSafeError('TypeSafe response contained no answers object', null, true);
    }

    const answers: AnswerMap = {};
    for (const [id, raw] of Object.entries(answerSource as Record<string, unknown>)) {
      const answer = parseAnswer(raw);
      if (answer) answers[id] = answer;
    }

    const usageSource = json.usage as Record<string, unknown> | undefined;
    return {
      model: typeof json.model === 'string' ? json.model : this.model,
      answers,
      requestId,
      usage: usageSource
        ? {
            inputTokens: asNumber(usageSource.input_tokens),
            outputTokens: asNumber(usageSource.output_tokens)
          }
        : undefined,
      latencyMs,
      raw: json
    };
  }
}

function parseAnswer(raw: unknown): Answer | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const declared = typeof record.type === 'string' ? record.type : undefined;

  if (declared === 'noul') {
    const value = asNumber(record.noul);
    return value === undefined ? null : { type: 'noul', noul: clamp01(value) };
  }

  if (declared === 'choice') {
    const choice = typeof record.choice === 'string' ? record.choice : undefined;
    if (choice === undefined) return null;
    return {
      type: 'choice',
      choice,
      probabilities: parseProbabilities(record.probabilities),
      confidence: clamp01(asNumber(record.confidence) ?? 0)
    };
  }

  if (declared === 'score') {
    const score = asNumber(record.score);
    if (score === undefined) return null;
    return {
      type: 'score',
      score,
      legend: parseLegend(record.legend),
      confidence: clamp01(asNumber(record.confidence) ?? 0)
    };
  }

  // Shapes that omit `type` are inferred from which key is present, so a future
  // server revision that drops the discriminator still works.
  if (typeof record.noul === 'number') return { type: 'noul', noul: clamp01(record.noul) };
  if (typeof record.choice === 'string') {
    return {
      type: 'choice',
      choice: record.choice,
      probabilities: parseProbabilities(record.probabilities),
      confidence: clamp01(asNumber(record.confidence) ?? 0)
    };
  }
  if (typeof record.score === 'number') {
    return {
      type: 'score',
      score: record.score,
      legend: parseLegend(record.legend),
      confidence: clamp01(asNumber(record.confidence) ?? 0)
    };
  }

  return null;
}

function parseLegend(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const legend: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') legend[key] = value;
  }
  return Object.keys(legend).length > 0 ? legend : undefined;
}

function parseProbabilities(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const num = asNumber(value);
    if (num !== undefined) result[key] = clamp01(num);
  }
  return result;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true }
    );
  });
}
export function noulCertainty(value: number): number {
  return Math.abs(value * 2 - 1);
}