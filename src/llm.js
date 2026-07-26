/**
 * Extract the JSON object from a model reply. Some models/backends ignore
 * Ollama's format:'json' constraint and wrap the object in a markdown code
 * fence or prose — take the outermost {...} span.
 */
export function parseJsonReply(content) {
  const text = String(content ?? '');
  try {
    return JSON.parse(text);
  } catch {
    const span = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    try {
      return JSON.parse(span);
    } catch {
      throw new Error(`ollama returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}

/** Thin client for a (possibly remote) Ollama instance. */
export class Ollama {
  constructor({ url, chatModel, embedModel, embedPrefixes, embedDimensions, timeoutMs = 60_000, apiKey }) {
    this.url = url.replace(/\/+$/, '');
    this.chatModel = chatModel;
    this.embedModel = embedModel;
    // Retrieval-tuned models use task prefixes (asymmetric: documents vs
    // queries) — model-specific, so they ride in the config.
    this.embedPrefixes = { document: '', query: '', ...embedPrefixes };
    // Matryoshka dimension truncation (verified live against qwen3-embedding:
    // requesting fewer dims returns a genuinely shorter, still-normalized,
    // still-well-behaved vector) — opt-in per model, since not every
    // embedding model supports it.
    this.embedDimensions = embedDimensions || null;
    this.timeoutMs = timeoutMs;
    // Bearer token for an Ollama instance sitting behind auth (e.g. a
    // reverse proxy in front of it) — empty/omitted for a typical
    // unauthenticated local/LAN instance, which is still the common case.
    this.apiKey = apiKey || null;
    // Thinking models waste time and leak "thought" keys into the JSON;
    // ask Ollama to disable it. Cleared if the server rejects the param.
    this.disableThink = true;
  }

  /** Merge in an Authorization header when apiKey is configured. */
  #headers(extra = {}) {
    return this.apiKey ? { ...extra, authorization: `Bearer ${this.apiKey}` } : extra;
  }

  /** Quick reachability probe so a cron run can skip enrichment cleanly. */
  async available() {
    try {
      const res = await fetch(`${this.url}/api/tags`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Startup diagnostic: confirms the connection to Ollama works (auth
   * included) and that both configured models are actually installed
   * there, via the same /api/tags list available() only checks for a 200.
   * Returns { ok: true } or { ok: false, reason } rather than throwing —
   * this is a one-time report for the operator, not a per-request gate;
   * every real call site already tolerates Ollama being transiently
   * unreachable (available() is checked before enriching), so a failed
   * check here should be logged loudly by the caller, not stop the app
   * from doing everything else it can (ingestion, serving already-
   * enriched content).
   */
  async checkModels() {
    let data;
    try {
      const res = await fetch(`${this.url}/api/tags`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, reason: `${this.url}/api/tags -> ${res.status} ${text.slice(0, 200)}` };
      }
      data = await res.json();
    } catch (err) {
      return { ok: false, reason: `cannot reach Ollama at ${this.url}: ${err.message}` };
    }

    // Ollama lists installed models under their tagged name (e.g.
    // "gemma4:12b-it-qat"); a config entry with no tag implicitly means
    // ":latest", same as `ollama run` / the API itself would resolve it.
    const installed = new Set((data.models ?? []).map((m) => m.name ?? m.model).filter(Boolean));
    const hasModel = (wanted) => installed.has(wanted) || installed.has(`${wanted}:latest`);
    const missing = [...new Set([this.chatModel, this.embedModel])].filter((name) => !hasModel(name));

    if (missing.length) {
      return {
        ok: false,
        reason: `model(s) not installed on ${this.url}: ${missing.join(', ')} ` +
          `(installed: ${[...installed].sort().join(', ') || 'none'})`,
      };
    }
    return { ok: true };
  }

  async #post(path, body, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: this.#headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // controller.signal stays alive past the initial request — aborting
      // during body reading closes the connection and rejects res.text().
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ollama ${path} -> ${res.status} ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Single-turn chat forced into JSON mode; returns the parsed object.
   * timeoutMs overrides the instance default for calls that are known to
   * take longer than a typical per-article classification (e.g. reasoning
   * over an entire topic vocabulary at once — see proposeTopicMerges,
   * src/topicMerge.js).
   */
  async chatJSON(system, prompt, { numCtx, timeoutMs } = {}) {
    const body = {
      model: this.chatModel,
      stream: false,
      format: 'json',
      // Ollama's default context is small (4096); long prompts must ask
      // for more or they get silently truncated.
      options: { temperature: 0, ...(numCtx ? { num_ctx: numCtx } : {}) },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
    if (this.disableThink) body.think = false;

    let data;
    try {
      data = await this.#post('/api/chat', body, timeoutMs);
    } catch (err) {
      // Some models/servers reject the think param outright — fall back
      // once and stop sending it.
      if (!this.disableThink || !/think/i.test(err.message)) throw err;
      this.disableThink = false;
      delete body.think;
      data = await this.#post('/api/chat', body, timeoutMs);
    }
    return parseJsonReply(data.message?.content);
  }

  /**
   * Embed a text; returns a Float16Array. kind: 'document' | 'query'.
   * Half precision is ample for cosine similarity and halves storage
   * (see bufToVec) — Node needs v24+ for native Float16Array, no
   * hand-rolled bit manipulation.
   * dimensions overrides the instance default for this call.
   */
  async embed(text, kind = 'document', dimensions) {
    const body = {
      model: this.embedModel,
      input: (this.embedPrefixes[kind] ?? '') + text,
    };
    body.dimensions = dimensions ?? this.embedDimensions;
    const data = await this.#post('/api/embed', body);
    const vec = data.embeddings?.[0];
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('ollama /api/embed returned no embedding');
    }
    return Float16Array.from(vec);
  }
}
