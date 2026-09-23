export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// Pinned, not `jev-latest`: minConfidence defaults are tuned against one version.
export const JEV_MODEL = "jev-1.13.0";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | null>;
}
export interface NoulQuestion {
  type: "noul";
  instructions: string | Record<string, unknown>;
  criteria?: { true?: string; false?: string };
}
export type JevQuestion = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface NoulAnswer {
  type: "noul";
  noul: number;
}
export type JevAnswer = ChoiceAnswer | NoulAnswer;

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The one method the navigate loop needs — what a test fakes. */
export interface JevChooser {
  ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult>;
}

export class JevError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "JevError";
  }
}

/** How the MCP layer reaches Jev without ever holding the key: a client, or why there is none. */
export type JevAccess =
  | { ok: true; client: JevChooser }
  | { ok: false; code: "navigate_disabled" | "navigate_key_unreadable"; message: string; hint: string };
export type JevProvider = () => JevAccess;

export interface JevClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  /** Retries on 429/529 only. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 529]);

export class JevClient implements JevChooser {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: JevClientOptions) {
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#model = opts.model ?? JEV_MODEL;
    this.#endpoint = opts.endpoint ?? JEV_ENDPOINT;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#retries = opts.retries ?? 2;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
    const body = JSON.stringify({ model: this.#model, state, questions });
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (e) {
        throw new JevError(`TypeSafe API unreachable: ${e instanceof Error ? e.message : String(e)}`, null);
      }
      if (RETRYABLE.has(res.status) && attempt < this.#retries) {
        await this.#sleep(250 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new JevError(`TypeSafe API ${res.status}: ${detail(text)}`, res.status);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new JevError("TypeSafe API returned a body that is not JSON", res.status);
      }
      const r = parsed as Partial<JevResult>;
      if (!r || typeof r !== "object" || !r.answers || typeof r.answers !== "object") {
        throw new JevError("TypeSafe API response has no `answers`", res.status);
      }
      return { model: String(r.model ?? this.#model), answers: r.answers, usage: r.usage };
    }
  }

  toJSON(): Record<string, unknown> {
    return { model: this.#model, endpoint: this.#endpoint };
  }
}

function detail(text: string): string {
  try {
    const b = JSON.parse(text) as { detail?: { message?: unknown } | unknown };
    const d = b.detail;
    if (d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string") return (d as { message: string }).message;
    if (typeof d === "string") return d;
    return JSON.stringify(d ?? b).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
