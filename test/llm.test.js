import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonReply } from '../src/llm.js';

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
