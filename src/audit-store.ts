/**
 * Plugin-owned audit file store: appends JSONL lines under the DSH home dir
 * (`~/.dsh/tavily/audit-YYYYMM.jsonl`), reads recent entries back for the
 * settings page. Never persists API keys (see `@dsh-plugins/plugin-kit`
 * audit serialization, which also redacts anything key-shaped).
 *
 * @module audit-store
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  entriesFileName,
  filterEntries,
  parseEntry,
  serializeEntry,
  summarize,
  type AuditEntry,
  type AuditStats,
} from '@dsh-plugins/plugin-kit';

export const DATA_DIR_NAME = 'tavily';
export const MAX_AUDIT_FILE_BYTES = 10 * 1024 * 1024;

export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

export function dataDir(home = resolveDshHome()): string {
  const dir = path.join(home, DATA_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // A locked-down profile may forbid creating the directory. Callers treat
    // append/read as best-effort so tool registration never fails because the
    // audit directory is unavailable.
  }
  return dir;
}

/** Append one entry; best-effort, never throws. Returns false when dropped. */
export function appendAudit(entry: AuditEntry, dir = dataDir()): boolean {
  const line = serializeEntry(entry);
  if (!line) return false;
  const file = path.join(dir, entriesFileName(new Date(entry.at)));
  try {
    const stat = fs.existsSync(file) ? fs.statSync(file) : undefined;
    if (stat && stat.size + Buffer.byteLength(line) > MAX_AUDIT_FILE_BYTES) {
      // Rotate: keep the oversized file, start a `-r1` overflow file.
      const overflow = file.replace(/\.jsonl$/, '-r1.jsonl');
      fs.appendFileSync(overflow, line, 'utf8');
      return true;
    }
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export interface AuditQuery {
  month?: string;
  datePrefix?: string;
  keyword?: string;
  limit?: number;
}

function monthFile(dir: string, month: string): string {
  return path.join(dir, `audit-${month}.jsonl`);
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Read entries for one month (default: current), newest first. */
export function readAudit(query: AuditQuery = {}, dir = dataDir()): AuditEntry[] {
  const month = query.month ?? currentMonth();
  const lines: string[] = [];
  for (const file of [monthFile(dir, month), monthFile(dir, month).replace(/\.jsonl$/, '-r1.jsonl')]) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      lines.push(...raw.split('\n'));
    } catch {
      // An absent month file is normal.
    }
  }
  const entries = lines.map(parseEntry).filter((entry): entry is AuditEntry => entry !== undefined);
  return filterEntries(entries, {
    datePrefix: query.datePrefix,
    keyword: query.keyword,
    limit: query.limit ?? 50,
  });
}

/** Month stats for the settings-page fallback quota card. */
export function monthStats(month = currentMonth(), dir = dataDir()): AuditStats {
  const raw: string[] = [];
  try {
    raw.push(...fs.readFileSync(monthFile(dir, month), 'utf8').split('\n'));
  } catch {
    // No data yet.
  }
  const entries = raw.map(parseEntry).filter((entry): entry is AuditEntry => entry !== undefined);
  return summarize(entries);
}

/** List available audit months (YYYYMM) present on disk, newest first. */
export function listMonths(dir = dataDir()): string[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const months = new Set<string>();
  for (const file of files) {
    const match = /^audit-(\d{6})(?:-r1)?\.jsonl$/.exec(file);
    if (match?.[1]) months.add(match[1]);
  }
  return [...months].sort().reverse();
}
