import http from 'node:http';
import { openDb } from '../src/db.js';

export function tempDb() {
  return openDb(':memory:');
}

/**
 * Start a Hono app for a test (Bun's native server, or @hono/node-server
 * under Node — same split createApp's caller uses in bin/rssmart.js).
 * Returns { url, close() }.
 */
export async function startApp(app) {
  if (typeof Bun !== 'undefined') {
    const server = Bun.serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    return {
      url: `http://127.0.0.1:${server.port}`,
      close: () => server.stop(true),
    };
  }
  const { serve } = await import('@hono/node-server');
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
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

/** HTTP server serving RSS per path; routes maps to XML strings or, for
 *  encoding tests, {body: Buffer, type: string}. */
export async function startRssServer(routes = new Map()) {
  const server = http.createServer((req, res) => {
    const route = routes.get(req.url);
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    if (typeof route === 'object' && route.body) {
      res.writeHead(200, { 'content-type': route.type ?? 'text/xml' }).end(route.body);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(route);
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
          // stub.chat may be async (used to simulate slow generations)
          Promise.resolve(stub.chat(data)).then((reply) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(reply) } }));
          });
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
    ollama: {
      url: 'http://127.0.0.1:1',
      chatModel: 'test-chat',
      embedModel: 'test-embed',
      embedDimensions: null,
      dedupEmbedDimensions: null,
      embedPrefixes: { document: '', query: '' },
      timeoutMs: 5000,
      topicMergeTimeoutMs: 60_000,
      apiKey: '',
    },
    enrich: {
      workers: 1,
      maxAttempts: 5,
      dupThreshold: 0.87,
      dupWindowDays: 14,
      fetchMinChars: 500,
      allowPrivateFetch: true,
      maxInputChars: 8000,
      maxArticleChars: 50_000,
      maxSuggestedTopics: 150,
      linkExpandMaxChars: 0,
    },
    cron: { maxRunMs: 300_000 },
    scheduler: { enabled: true, minIntervalMin: 15, maxIntervalMin: 1440 },
    scoring: {
      knn: 20,
      voteDecayHalflifeYears: null,
      weights: { topics: 1, embedding: 0, depth: 0, feed: 0 },
      recomputeDebounceSec: 120,
      hotDecayPerDay: 0,
    },
    triage: { roundRobinWindowDays: 7 },
    mastodon: { url: '', token: '', username: '', password: '' },
    server: { host: '127.0.0.1', port: 0 },
    auth: { password: '' },
    ...overrides,
  };
}
