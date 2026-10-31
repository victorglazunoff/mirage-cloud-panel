import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { readRequestBodyError } from '@/shared/utils.js';

/** The error express.json() hands to the error middleware for `body`. */
async function parserErrorFor(body: string, limit = '1kb'): Promise<unknown> {
  const parse = express.json({ limit });
  const request = Object.assign(
    (await import('node:stream')).Readable.from([Buffer.from(body)]),
    { headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, method: 'POST', url: '/' },
  );
  return new Promise((resolve) => {
    parse(request as never, {} as never, (error?: unknown) => resolve(error));
  });
}

test('malformed JSON is a 400 and the description never carries the raw body', async () => {
  const error = await parserErrorFor('{"username":"alice","password":"SECRET-123",}');
  assert.ok(error, 'express.json must reject the body');
  const described = readRequestBodyError(error);
  assert.deepEqual(described, { statusCode: 400, code: 'INVALID_JSON_BODY', message: 'Request body is not valid JSON' });
  assert.doesNotMatch(JSON.stringify(described), /SECRET/);
});

test('an oversized body is a 413; other errors are not body errors', async () => {
  const error = await parserErrorFor(JSON.stringify({ text: 'x'.repeat(2048) }));
  assert.equal(readRequestBodyError(error)?.statusCode, 413);
  assert.equal(readRequestBodyError(new Error('boom')), null);
  assert.equal(readRequestBodyError(null), null);
  assert.equal(readRequestBodyError({ type: 'other', status: 400 }), null);
});
