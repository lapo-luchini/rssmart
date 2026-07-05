/** Thin client for a (possibly remote) Ollama instance. */
export class Ollama {
  constructor({ url, chatModel, embedModel, timeoutMs = 60_000 }) {
    this.url = url.replace(/\/+$/, '');
    this.chatModel = chatModel;
    this.embedModel = embedModel;
    this.timeoutMs = timeoutMs;
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

  async #post(path, body) {
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ollama ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  /** Single-turn chat forced into JSON mode; returns the parsed object. */
  async chatJSON(system, prompt) {
    const data = await this.#post('/api/chat', {
      model: this.chatModel,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    });
    const content = data.message?.content;
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(`ollama returned non-JSON: ${String(content).slice(0, 200)}`);
    }
  }

  /** Embed a text; returns a Float32Array. */
  async embed(text) {
    const data = await this.#post('/api/embed', {
      model: this.embedModel,
      input: text,
    });
    const vec = data.embeddings?.[0];
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('ollama /api/embed returned no embedding');
    }
    return Float32Array.from(vec);
  }
}
