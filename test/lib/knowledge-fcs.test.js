import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FCS_REFERENCE } from '../../src/lib/fcs.js';

test('FCS discovery uses the released canonical website and no invented planned link', () => {
  assert.equal(FCS_REFERENCE.links.website, 'https://frankencoin.com/fcs');
  assert.equal(FCS_REFERENCE.plannedLinks, undefined);
  assert.equal(FCS_REFERENCE.sources.website.branch, 'main');
  assert.match(FCS_REFERENCE.sources.website.url, /src\/content\/en\/fcs\.json$/);
  const forbidden = ['fcs', 'frankencoin', 'com'].join('.');
  for (const file of ['README.md','CLAUDE.md','docs/FCS.md']) {
    assert.ok(!readFileSync(new URL('../../'+file, import.meta.url),'utf8').includes(forbidden), file);
  }
  assert.ok(!JSON.stringify(FCS_REFERENCE).includes(forbidden));
});

test('runtime documentation follows the official main branch', () => {
  assert.match(FCS_REFERENCE.sources.documentation.url, /blob\/main\/fcs.md$/);
  assert.equal(FCS_REFERENCE.mechanics, undefined);
});
