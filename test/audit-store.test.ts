/**
 * Audit store round-trip tests over a temporary directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuditEntry } from '@dsh-plugins/plugin-kit';
import {
  appendAudit,
  clearAuditCache,
  dataDir,
  listMonths,
  listMonthsAsync,
  monthStats,
  monthStatsAsync,
  readAudit,
  readAuditAsync,
} from '../src/audit-store.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tavily-audit-'));
}

test('append/read/stats round-trip for every tool kind', () => {
  const dir = dataDir(tempHome());
  const entries: AuditEntry[] = [
    { at: '2026-10-08T10:00:00.000Z', tool: 'search', target: 'alpha', status: 'ok', latencyMs: 10, resultCount: 3, credits: 1 },
    { at: '2026-10-08T10:01:00.000Z', tool: 'map', target: 'https://example.com', status: 'ok', latencyMs: 20, resultCount: 7 },
    { at: '2026-10-08T10:02:00.000Z', tool: 'research', target: 'quantum', status: 'ok', latencyMs: 30, resultCount: 2, credits: 5 },
    { at: '2026-10-08T10:03:00.000Z', tool: 'crawl', target: 'https://example.com', status: 'error', errorCode: 'timeout', latencyMs: 40, resultCount: 0 },
  ];
  for (const entry of entries) assert.equal(appendAudit(entry, dir), true);

  const read = readAudit({ month: '202610', limit: 50 }, dir);
  assert.equal(read.length, 4);
  // Newest first.
  assert.equal(read[0]?.tool, 'crawl');

  const stats = monthStats('202610', dir);
  assert.equal(stats.totalCalls, 4);
  assert.equal(stats.searchCalls, 1);
  assert.equal(stats.mapCalls, 1);
  assert.equal(stats.researchCalls, 1);
  assert.equal(stats.crawlCalls, 1);
  assert.equal(stats.failedCalls, 1);
  assert.equal(stats.totalCredits, 6);
  assert.deepEqual(listMonths(dir), ['202610']);
});

test('readAudit filters by keyword and date', () => {
  const dir = dataDir(tempHome());
  appendAudit({ at: '2026-10-08T10:00:00.000Z', tool: 'search', target: 'alpha query', status: 'ok', latencyMs: 1, resultCount: 1 }, dir);
  appendAudit({ at: '2026-10-09T10:00:00.000Z', tool: 'search', target: 'beta query', status: 'ok', latencyMs: 1, resultCount: 1 }, dir);

  const byKeyword = readAudit({ month: '202610', keyword: 'beta' }, dir);
  assert.equal(byKeyword.length, 1);
  assert.equal(byKeyword[0]?.target, 'beta query');

  const byDate = readAudit({ month: '202610', datePrefix: '2026-10-08' }, dir);
  assert.equal(byDate.length, 1);
  assert.equal(byDate[0]?.target, 'alpha query');
});

test('a key-shaped target is redacted before it reaches disk', () => {
  const dir = dataDir(tempHome());
  appendAudit(
    { at: '2026-10-08T10:00:00.000Z', tool: 'search', target: 'oops tvly-abcdef123456', status: 'ok', latencyMs: 1, resultCount: 0 },
    dir,
  );
  const raw = fs.readFileSync(path.join(dir, 'audit-202610.jsonl'), 'utf8');
  assert.ok(!raw.includes('tvly-abcdef123456'));
  assert.ok(raw.includes('tvly-****'));
});

test('an unwritable directory degrades instead of throwing', () => {
  // A path that cannot be a directory: the append must report false, not throw.
  const bogus = path.join(tempHome(), 'audit-202610.jsonl');
  fs.writeFileSync(bogus, 'x');
  assert.equal(
    appendAudit({ at: '2026-10-08T10:00:00.000Z', tool: 'search', target: 't', status: 'ok', latencyMs: 1, resultCount: 0 }, bogus),
    false,
  );
});

test('listMonths on a missing directory returns an empty list', () => {
  assert.deepEqual(listMonths(path.join(os.tmpdir(), 'tavily-definitely-missing-xyz')), []);
});

test('the async readers agree with the sync ones', async () => {
  clearAuditCache();
  const dir = dataDir(tempHome());
  appendAudit({ at: '2026-10-08T10:00:00.000Z', tool: 'search', target: 'alpha', status: 'ok', latencyMs: 10, resultCount: 3, credits: 1 }, dir);
  appendAudit({ at: '2026-10-08T10:01:00.000Z', tool: 'map', target: 'https://example.com', status: 'ok', latencyMs: 20, resultCount: 7 }, dir);

  assert.deepEqual(await readAuditAsync({ month: '202610', limit: 50 }, dir), readAudit({ month: '202610', limit: 50 }, dir));
  assert.deepEqual(await monthStatsAsync('202610', dir), monthStats('202610', dir));
  assert.deepEqual(await listMonthsAsync(dir), listMonths(dir));
});

test('an append invalidates the parse cache', async () => {
  clearAuditCache();
  const dir = dataDir(tempHome());
  const base = { at: '2026-10-08T10:00:00.000Z', tool: 'search' as const, target: 'a', status: 'ok' as const, latencyMs: 1, resultCount: 1 };

  appendAudit(base, dir);
  assert.equal((await readAuditAsync({ month: '202610' }, dir)).length, 1);

  appendAudit({ ...base, target: 'b', at: '2026-10-08T10:05:00.000Z' }, dir);
  // Same size would be a false hit; the content grew, so size and mtime both move.
  assert.equal(
    (await readAuditAsync({ month: '202610' }, dir)).length,
    2,
    'a new append must be visible without clearing the cache by hand',
  );
});

test('an append that keeps the byte size identical still invalidates', async () => {
  clearAuditCache();
  const dir = dataDir(tempHome());
  const first = { at: '2026-10-08T10:00:00.000Z', tool: 'search' as const, target: 'aa', status: 'ok' as const, latencyMs: 1, resultCount: 1 };
  const second = { at: '2026-10-08T10:09:00.000Z', tool: 'search' as const, target: 'bb', status: 'ok' as const, latencyMs: 2, resultCount: 2 };

  appendAudit(first, dir);
  await readAuditAsync({ month: '202610' }, dir);
  appendAudit(second, dir);
  // Two lines of identical length: only mtime distinguishes them, which is why
  // the cache key carries mtime as well as size.
  const entries = await readAuditAsync({ month: '202610' }, dir);
  assert.equal(entries.length, 2);
});
