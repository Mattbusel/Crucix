// Sanctions sources (OpenSanctions, US Restricted Parties) — unit tests
// Uses Node.js built-in test runner (node:test) — no extra dependencies

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { briefing as opensanctions } from '../apis/sources/opensanctions.mjs';
import { briefing as usRestricted, parseChanges } from '../apis/sources/us-restricted.mjs';

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENSANCTIONS_API_KEY;
const originalPin = process.env.US_RESTRICTED_RELEASE;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENSANCTIONS_API_KEY;
  else process.env.OPENSANCTIONS_API_KEY = originalKey;
  if (originalPin === undefined) delete process.env.US_RESTRICTED_RELEASE;
  else process.env.US_RESTRICTED_RELEASE = originalPin;
});

function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(text) });
}

describe('OpenSanctions', () => {
  it('reports a missing key instead of returning empty results', async () => {
    delete process.env.OPENSANCTIONS_API_KEY;
    globalThis.fetch = mock.fn(() => jsonResponse({ detail: 'No API key provided.' }, 401));
    const data = await opensanctions();
    assert.match(data.error, /API key/);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });

  it('sends the key and reads total.value', async () => {
    process.env.OPENSANCTIONS_API_KEY = 'test-key';
    globalThis.fetch = mock.fn((url) => url.includes('/search/')
      ? jsonResponse({ total: { value: 42, relation: 'eq' }, results: [{ id: 'x', caption: 'X Corp', schema: 'Company' }] })
      : jsonResponse([]));
    const data = await opensanctions();
    const searchCall = globalThis.fetch.mock.calls.find(c => c.arguments[0].includes('/search/'));
    assert.equal(searchCall.arguments[1].headers.Authorization, 'ApiKey test-key');
    assert.equal(data.recentSearches[0].totalResults, 42);
    assert.equal(data.totalSanctionedEntities, 42 * data.recentSearches.length);
    assert.equal(data.errors, undefined);
  });
});

const MANIFEST = {
  built_at: '2026-11-18T02:14:50Z',
  content_sha256: 'abc',
  names_changed: true,
  errors: {},
  lists: {
    us_dod_1260h: {
      name: 'DoD Chinese Military Companies (Section 1260H)', operator: 'DoD', source: 'Federal Register',
      records: 186, aliases: 97, latest_listing: '2026-06-10', fetched_at: '2026-11-18T02:14:50Z',
      notes: { later_notices: [{ action: 'removed', name: 'WuXi AppTec Co., Ltd.', date: '2026-11-10', doc: '2026-22840', url: 'https://www.federalregister.gov/d/2026-22840' }] },
    },
    us_dhs_uflpa: {
      name: 'UFLPA Entity List', operator: 'DHS', source: 'dhs.gov',
      records: 190, aliases: 131, latest_listing: '2026-10-29', fetched_at: null, notes: {},
    },
  },
  affiliates: { records: 177, data_date: '2026-11-18', stale: false, files: {
    'affiliates.covered.senzing.jsonl': { records: 34 }, 'affiliates.review.senzing.jsonl': { records: 143 } } },
};

const CHANGES = `# Build 2026-11-18

- us_dod_1260h: 186 records, 97 aliases
- us_dhs_uflpa: 190 records, 131 aliases (kept previous build: HTTP Error 403)

## us_dod_1260h

- removed: WuXi AppTec Co., Ltd. (WuXi AppTec)

## Affiliates (derived, evidence not determination)

- 177 records
- changes: added 1
  - added: HIKVISION SINGAPORE PTE. LTD. (lei:2549009CXKM0B6NW2K50)
`;

describe('US Restricted Parties', () => {
  it('parses list and affiliate changes from CHANGES.md', () => {
    const c = parseChanges(CHANGES);
    assert.deepEqual(c.us_dod_1260h, { added: [], removed: ['WuXi AppTec Co., Ltd. (WuXi AppTec)'] });
    assert.deepEqual(c.affiliates.added, ['HIKVISION SINGAPORE PTE. LTD. (lei:2549009CXKM0B6NW2K50)']);
    assert.equal(Object.keys(c).length, 2);
  });

  it('reads the newest data release, skipping code releases', async () => {
    delete process.env.US_RESTRICTED_RELEASE;
    globalThis.fetch = mock.fn((url) => {
      if (url.includes('api.github.com')) return jsonResponse([{ tag_name: 'v0.6.0' }, { tag_name: 'data-2026-11-18' }]);
      if (url.endsWith('/data-2026-11-18/manifest.json')) return jsonResponse(MANIFEST);
      if (url.endsWith('/data-2026-11-18/CHANGES.md')) return jsonResponse(CHANGES);
      return jsonResponse('not found', 404);
    });
    const data = await usRestricted();
    assert.equal(data.release, 'data-2026-11-18');
    assert.equal(data.totalRecords, 376);
    assert.equal(data.lists.find(l => l.list === 'us_dhs_uflpa').stale, true);
    assert.equal(data.lists[0].laterNotices[0].doc, '2026-22840');
    assert.deepEqual(data.recentChanges.map(c => [c.list, c.addedCount, c.removedCount]),
      [['us_dod_1260h', 0, 1], ['affiliates', 1, 0]]);
    assert.deepEqual(data.affiliates, { records: 177, covered: 34, review: 143, dataDate: '2026-11-18', stale: false });
  });

  it('honors a pinned release without calling the GitHub API', async () => {
    process.env.US_RESTRICTED_RELEASE = 'data-2026-11-17';
    globalThis.fetch = mock.fn((url) => url.endsWith('manifest.json') ? jsonResponse(MANIFEST) : jsonResponse(CHANGES));
    const data = await usRestricted();
    assert.equal(data.release, 'data-2026-11-17');
    assert.ok(globalThis.fetch.mock.calls.every(c => !c.arguments[0].includes('api.github.com')));
  });

  it('returns an error object when the manifest cannot be fetched', async () => {
    process.env.US_RESTRICTED_RELEASE = 'data-2026-11-17';
    globalThis.fetch = mock.fn(() => jsonResponse('gone', 404));
    const data = await usRestricted();
    assert.match(data.error, /HTTP 404/);
  });
});
