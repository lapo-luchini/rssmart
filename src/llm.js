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
  constructor({ url, chatModel, embedModel, embedPrefixes, embedDimensions, timeoutMs = 60_000 }) {
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
    // Thinking models waste time and leak "thought" keys into the JSON;
    // ask Ollama to disable it. Cleared if the server rejects the param.
    this.disableThink = true;
  }

  /** Quick reachability probe so a cron run can skip enrichment cleanly. */
  async available() {
    try {
      const res = await fetch(`${this.url}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async #post(path, body, timeoutMs = this.timeoutMs) {
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read body text with its own timeout: AbortSignal only protects the
    // initial request phase, not res.json() — which can hang forever if
    // Ollama sends headers but the body stream stalls.
    const text = await Promise.race([
      res.text(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`response body read timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    if (!res.ok) {
      throw new Error(`ollama ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
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
   */
  async embed(text, kind = 'document') {
    const body = {
      model: this.embedModel,
      input: (this.embedPrefixes[kind] ?? '') + text,
    };
    if (this.embedDimensions) body.dimensions = this.embedDimensions;
    const data = await this.#post('/api/embed', body);
    const vec = data.embeddings?.[0];
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('ollama /api/embed returned no embedding');
    }
    return Float16Array.from(vec);
  }
}
