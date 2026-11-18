// US Restricted Parties — DoD 1260H, Section 889, FCC Covered List, UFLPA, BIOSECURE (interim)
// No auth required. These five US lists are not in OFAC's SDN list or the trade.gov
// Consolidated Screening List. A public CI job rebuilds them every day from the
// Federal Register, eCFR, fcc.gov and dhs.gov and publishes a dated GitHub release
// with manifest.json (counts, hashes, source documents) and CHANGES.md (names
// added and removed since the previous build).
// Source: https://github.com/Mattbusel/us-restricted-parties (data CC BY 4.0)

import { safeFetch } from '../utils/fetch.mjs';

const REPO = 'Mattbusel/us-restricted-parties';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
const DOWNLOAD = `https://github.com/${REPO}/releases/download`;
const MAX_NAMES = 25;

// safeFetch keeps only the first 500 chars of a non-JSON body, and CHANGES.md
// can list hundreds of names, so it is read as text here.
async function fetchText(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Crucix/1.0' } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { text: await res.text() };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Data releases are tagged data-YYYY-MM-DD[-HHMM]; code releases (v*) are skipped.
// Set US_RESTRICTED_RELEASE to pin one tag.
export async function resolveRelease(pinned = process.env.US_RESTRICTED_RELEASE) {
  if (pinned) return { tag: pinned };
  const releases = await safeFetch(API, { timeout: 15000, headers: { Accept: 'application/vnd.github+json' } });
  if (!Array.isArray(releases)) return { error: releases?.error || 'Unexpected GitHub releases response' };
  const data = releases.find(r => typeof r.tag_name === 'string' && r.tag_name.startsWith('data-') && !r.draft);
  return data ? { tag: data.tag_name, publishedAt: data.published_at } : { error: 'No data release found' };
}

// CHANGES.md -> { us_dod_1260h: { added: [...], removed: [...] }, affiliates: {...} }
export function parseChanges(text) {
  const out = {};
  let section = null;
  for (const line of String(text || '').split('\n')) {
    const head = line.match(/^##\s+(\S+)/);
    if (head) {
      section = head[1].toLowerCase() === 'affiliates' ? 'affiliates' : head[1];
      continue;
    }
    const m = line.match(/^\s*-\s+(added|removed):\s+(.+?)\s*$/);
    if (!m || !section) continue;
    out[section] ??= { added: [], removed: [] };
    out[section][m[1]].push(m[2]);
  }
  return out;
}

function compactList(key, m) {
  return {
    list: key,
    name: m.name,
    operator: m.operator,
    records: m.records,
    aliases: m.aliases,
    latestListing: m.latest_listing,
    // fetched_at is null when the agency site failed and the previous build was kept
    stale: m.fetched_at == null,
    source: m.source,
    laterNotices: (m.notes?.later_notices || []).map(n => ({
      action: n.action, name: n.name, date: n.date, doc: n.doc, url: n.url,
    })),
  };
}

export function summarize(manifest, changesText, tag) {
  const lists = Object.entries(manifest?.lists || {}).map(([k, m]) => compactList(k, m));
  const changes = Object.entries(parseChanges(changesText)).map(([list, c]) => ({
    list,
    addedCount: c.added.length,
    removedCount: c.removed.length,
    added: c.added.slice(0, MAX_NAMES),
    removed: c.removed.slice(0, MAX_NAMES),
  }));
  const aff = manifest?.affiliates;
  return {
    source: 'US Restricted Parties',
    timestamp: new Date().toISOString(),
    release: tag,
    releaseUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    builtAt: manifest?.built_at,
    contentSha256: manifest?.content_sha256,
    totalRecords: lists.reduce((s, l) => s + (l.records || 0), 0),
    lists,
    namesChanged: Boolean(manifest?.names_changed),
    recentChanges: changes,
    // Companies the listed parties own 50%+ or control (OFAC 50 Percent Rule,
    // BIS Affiliates Rule), from GLEIF ownership links. Evidence, not a determination.
    affiliates: aff ? {
      records: aff.records,
      covered: aff.files?.['affiliates.covered.senzing.jsonl']?.records,
      review: aff.files?.['affiliates.review.senzing.jsonl']?.records,
      dataDate: aff.data_date,
      stale: Boolean(aff.stale),
    } : null,
    upstreamErrors: manifest?.errors || {},
  };
}

export async function briefing() {
  const rel = await resolveRelease();
  if (rel.error) {
    return { source: 'US Restricted Parties', error: rel.error, timestamp: new Date().toISOString() };
  }
  const [manifest, changes] = await Promise.all([
    safeFetch(`${DOWNLOAD}/${rel.tag}/manifest.json`, { timeout: 15000 }),
    fetchText(`${DOWNLOAD}/${rel.tag}/CHANGES.md`),
  ]);
  if (manifest?.error || !manifest?.lists) {
    return {
      source: 'US Restricted Parties',
      release: rel.tag,
      error: manifest?.error || 'manifest.json has no lists',
      timestamp: new Date().toISOString(),
    };
  }
  const out = summarize(manifest, changes.text ?? '', rel.tag);
  if (changes.error) out.changesError = changes.error;
  return out;
}

// Run standalone
if (process.argv[1]?.endsWith('us-restricted.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
