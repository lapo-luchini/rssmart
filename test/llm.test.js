import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseJsonReply, Ollama } from '../src/llm.js';

test('parseJsonReply handles plain JSON', () => {
  assert.deepEqual(parseJsonReply('{"a": 1}'), { a: 1 });
});

test('parseJsonReply handles markdown-fenced JSON (real gemma behavior)', () => {
  const reply = '```json\n{\n  "topics": ["software"],\n  "summary": "It works."\n}\n```';
  assert.deepEqual(parseJsonReply(reply), { topics: ['software'], summary: 'It works.' });
});

test('parseJsonReply handles JSON wrapped in prose', () => {
  assert.deepEqual(parseJsonReply('Here you go: {"a": {"b": 2}} hope it helps'), { a: { b: 2 } });
});

test('parseJsonReply throws a labeled error on garbage', () => {
  assert.throws(() => parseJsonReply('no json here'), /ollama returned non-JSON/);
  assert.throws(() => parseJsonReply(null), /ollama returned non-JSON/);
});

test('chatJSON retries without think when the server rejects it, then stops sending it', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      if (body.think !== undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `"${body.model}" does not support thinking` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: '{"a":1}' } }));
    });
  });
  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${server.address().port}`));
  });

  try {
    const llm = new Ollama({ url, chatModel: 'old-model', embedModel: 'e' });
    assert.deepEqual(await llm.chatJSON('s', 'p'), { a: 1 });
    assert.deepEqual(await llm.chatJSON('s', 'p'), { a: 1 });
    assert.deepEqual(
      requests.map((r) => r.think),
      [false, undefined, undefined],
      'one rejected attempt, then think is never sent again',
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
