import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log, logError } from '../src/log.js';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('log/logError prefix an ISO8601 timestamp and forward the rest of the arguments untouched', () => {
  const calls = { log: [], error: [] };
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args) => calls.log.push(args);
  console.error = (...args) => calls.error.push(args);
  try {
    log('hello', 42);
    logError('oops', { a: 1 });
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  assert.equal(calls.log.length, 1);
  assert.match(calls.log[0][0], ISO8601);
  assert.deepEqual(calls.log[0].slice(1), ['hello', 42]);

  assert.equal(calls.error.length, 1);
  assert.match(calls.error[0][0], ISO8601);
  assert.deepEqual(calls.error[0].slice(1), ['oops', { a: 1 }]);
});
