import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpSuccess, mcpError } from '../../src/lib/envelope.js';
import { UpstreamError, ValidationError, TimeoutError } from '../../src/lib/errors.js';

test('MCP structured clients receive the same knowledge object as text clients, including content=null', () => {
  for (const content of ['# Overview\nLive official documentation.', null]) {
    const data = { topic: 'overview', content, status: content ? 'available' : 'unavailable' };
    const result = mcpSuccess(data);
    assert.deepEqual(result.structuredContent, data);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.notDeepEqual(result.structuredContent, {});
  }
});

test('MCP errors distinguish upstream failures from invalid arguments without leaking details', () => {
  for (const [error, code] of [[new UpstreamError('private-origin', 403), 'upstream_error'], [new TimeoutError('private-origin'), 'upstream_timeout'], [new ValidationError(), 'invalid_request']]) {
    const result = mcpError(error);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, code);
    assert.equal(result.structuredContent.error, error.clientMessage);
    assert.doesNotMatch(JSON.stringify(result), /private-origin|403/);
  }
});
