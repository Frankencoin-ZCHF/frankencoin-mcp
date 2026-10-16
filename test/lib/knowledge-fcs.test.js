import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FCS_REFERENCE } from '../../src/lib/fcs.js';

test('FCS discovery uses the released canonical website and no invented planned link', () => {
  assert.equal(FCS_REFERENCE.links.website, 'https://frankencoin.com/fcs');
  assert.equal(FCS_REFERENCE.plannedLinks, undefined);
  assert.equal(FCS_REFERENCE.sources.website.branch, 'main');
  assert.equal(FCS_REFERENCE.sources.website.commit, '444f8318b25068b46b81b8117b661a0119740fe4');
  assert.match(FCS_REFERENCE.sources.website.url, /src\/content\/en\/fcs\.json$/);
  const forbidden = ['fcs', 'frankencoin', 'com'].join('.');
  for (const file of ['README.md','CLAUDE.md','docs/FCS.md']) {
    assert.ok(!readFileSync(new URL('../../'+file, import.meta.url),'utf8').includes(forbidden), file);
  }
  assert.ok(!JSON.stringify(FCS_REFERENCE).includes(forbidden));
});

test('current released documentation supersedes the historical audit quorum', () => {
  assert.match(FCS_REFERENCE.mechanics.qualification, /shared.*1%|1%.*shared/);
  assert.doesNotMatch(FCS_REFERENCE.mechanics.qualification, /at least 2%/);
  assert.equal(FCS_REFERENCE.sources.documentation.commit, 'a1322816a282debedd8ab3dfae89a7f1364f4590');
  assert.match(FCS_REFERENCE.sources.mechanics.note, /historical/i);
});
