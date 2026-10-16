import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.CACHE_ENABLED = 'false';
const { dispatchTool } = await import('../../src/tools/dispatch.js');
const { setFetchImpl } = await import('../../src/upstream/client.js');
const { DOC_FILES } = await import('../../src/lib/constants.js');
const doc = readFileSync(new URL('../fixtures/live-audit/overview.md', import.meta.url), 'utf8');
const github = (content) => new Response(JSON.stringify({content: Buffer.from(content).toString('base64')}));

test('all document topics reject JSON/HTML placeholders instead of reporting available documentation', async () => {
  for (const payload of ['{}', '[]', '<!doctype html><html><body>Gateway error</body></html>']) {
    setFetchImpl(async () => github(payload));
    for (const topic of Object.keys(DOC_FILES)) {
      const result = await dispatchTool('get_knowledge', {topic});
      assert.equal(result.content, null, `${topic}: ${payload}`);
      assert.equal(result.sources.github.status, 'unavailable');
      assert.equal(result.sources.github.code, 'upstream_error');
      assert.notEqual(result.status, 'available');
      assert.ok(result.source.startsWith('https://github.com/Frankencoin-ZCHF/gitbook/blob/main/'));
    }
  }
});

test('empty Contents bodies retry the same released main file, not a fabricated success', async () => {
  const urls = [];
  setFetchImpl(async url => {
    urls.push(url);
    return url.startsWith('https://api.github.com/') ? github('') : new Response(doc);
  });
  const result = await dispatchTool('get_knowledge', {topic: 'overview'});
  assert.equal(result.content, doc);
  assert.equal(result.status, 'available');
  assert.deepEqual(urls, [
    'https://api.github.com/repos/Frankencoin-ZCHF/gitbook/contents/README.md?ref=main',
    'https://raw.githubusercontent.com/Frankencoin-ZCHF/gitbook/main/README.md',
  ]);
});

test('malformed website JSON is an upstream error, not invalid arguments or internal error', async () => {
  setFetchImpl(async () => github('{broken'));
  await assert.rejects(() => dispatchTool('get_knowledge', {topic: 'compliance'}), error => error.code === 'upstream_error' && error.status === 502);
});
