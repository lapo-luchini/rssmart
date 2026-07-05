import http from 'node:http';
import { openDb } from '../src/db.js';

export function tempDb() {
  return openDb(':memory:');
}

export function rssXml({ title = 'Test Feed', items = [] }) {
  const itemXml = items
    .map(
      (i) => `
    <item>
      <title>${i.title}</title>
      <link>${i.link ?? `https://example.com/${encodeURIComponent(i.title)}`}</link>
      <guid>${i.guid ?? i.link ?? `guid-${i.title}`}</guid>
      ${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''}
      <description><![CDATA[${i.description ?? ''}]]></description>
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${title}</title>
    <link>https://example.com</link>
    <description>test</description>
    ${itemXml}
  </channel>
</rss>`;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

/** HTTP server serving RSS XML per path; routes is a mutable Map. */
export async function startRssServer(routes = new Map()) {
  const server = http.createServer((req, res) => {
    const xml = routes.get(req.url);
    if (!xml) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(xml);
  });
  const url = await listen(server);
  return { url, routes, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Stub of the Ollama HTTP API. Behavior is swappable per test via
 * stub.chat / stub.embed; records calls for assertions.
 */
export async function startOllamaStub() {
  const stub = {
    calls: { chat: [], embed: [] },
    chat: () => ({ topics: ['tech'], summary: 'A short generated preview.' }),
    embed: (input) => {
      // Deterministic pseudo-embedding, distinct per distinct input.
      const vec = new Array(8).fill(0);
      for (let i = 0; i < input.length; i++) {
        vec[i % 8] += Math.sin(input.charCodeAt(i) * (i + 1)) ;
      }
      return vec;
    },
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = body ? JSON.parse(body) : {};
      try {
        if (req.url === '/api/chat') {
          stub.calls.chat.push(data);
          const reply = stub.chat(data);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(reply) } }));
        } else if (req.url === '/api/embed') {
          stub.calls.embed.push(data);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ embeddings: [stub.embed(data.input)] }));
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  stub.url = await listen(server);
  stub.close = () => new Promise((r) => server.close(r));
  return stub;
}

export function testConfig(overrides = {}) {
  return {
    db: ':memory:',
    feeds: [],
    ollama: {
      url: 'http://127.0.0.1:1',
      chatModel: 'test-chat',
      embedModel: 'test-embed',
      timeoutMs: 5000,
    },
    enrich: {
      maxAttempts: 5,
      dupThreshold: 0.87,
      dupWindowDays: 14,
      fetchMinChars: 500,
      allowPrivateFetch: true, // test stubs listen on loopback
      maxInputChars: 8000,
    },
    cron: { maxRunMs: 300_000 },
    // topics-only by default so scoring tests exercise one signal at a time
    scoring: { knn: 20, weights: { topics: 1, embedding: 0, depth: 0, feed: 0 } },
    server: { host: '127.0.0.1', port: 0 },
    ...overrides,
  };
}
