/**
 * Plugin-local audit log: one JSONL line per Tavily call.
 *
 * Used when DSH exposes no native audit API. The API key is NEVER written:
 * entries carry only masked identity and call metadata.
 *
 * @module audit
 */

export type AuditTool = 'search' | 'extract' | 'crawl' | 'map' | 'research';
export type AuditStatus = 'ok' | 'error';

/** Every member, used to validate parsed lines and to total per-tool stats. */
const AUDIT_TOOLS: readonly AuditTool[] = ['search', 'extract', 'crawl', 'map', 'research'];

export interface AuditEntry {
  /** ISO timestamp of call completion. */
  at: string;
  tool: AuditTool;
  /** Full query text for search; URL(s) for extract/crawl/map; research input. Kept for audit, never includes the key. */
  target: string;
  status: AuditStatus;
  /** Machine error code (e.g. `invalid_api_key`), absent on success. */
  errorCode?: string;
  /** Wall-clock latency in ms. */
  latencyMs: number;
  /** Number of results returned (0 on error/empty). */
  resultCount: number;
  /** Caller identity when DSH provides one (agent/session id), else undefined. */
  caller?: string;
  /**
   * Tavily credits this call consumed, when the response reported it
   * (`includeUsage`). Absent in keyless mode, which returns no usage block.
   */
  credits?: number;
}

export interface AuditStats {
  totalCalls: number;
  searchCalls: number;
  extractCalls: number;
  crawlCalls: number;
  mapCalls: number;
  researchCalls: number;
  failedCalls: number;
  totalResults: number;
  /** Sum of reported credits; entries without usage contribute nothing. */
  totalCredits: number;
  recentTargets: string[];
}

const MAX_TARGET_LEN = 400;

function fileNameFor(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `audit-${y}${m}.jsonl`;
}

/** Serialize one entry. Throws nothing; returns undefined when the entry is not JSON-safe. */
export function serializeEntry(entry: AuditEntry): string | undefined {
  try {
    const safe: AuditEntry = {
      ...entry,
      // Defensive: never persist anything resembling a Tavily key.
      target: redactApiKeyLike(entry.target.slice(0, MAX_TARGET_LEN)),
    };
    const record = safe as unknown as Record<string, unknown>;
    if ('apiKey' in record) {
      delete record.apiKey;
    }
    return `${JSON.stringify(safe)}\n`;
  } catch {
    return undefined;
  }
}

/** Parse one JSONL line back into an entry; returns undefined for corrupt lines. */
export function parseEntry(line: string): AuditEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AuditEntry>;
    if (typeof parsed.at !== 'string' || typeof parsed.tool !== 'string') return undefined;
    if (!AUDIT_TOOLS.includes(parsed.tool as AuditTool)) return undefined;
    const out: AuditEntry = {
      at: parsed.at,
      tool: parsed.tool as AuditTool,
      target: typeof parsed.target === 'string' ? parsed.target : '',
      status: parsed.status === 'error' ? 'error' : 'ok',
      latencyMs: typeof parsed.latencyMs === 'number' ? parsed.latencyMs : 0,
      resultCount: typeof parsed.resultCount === 'number' ? parsed.resultCount : 0,
    };
    if (typeof parsed.errorCode === 'string') out.errorCode = parsed.errorCode;
    if (typeof parsed.caller === 'string') out.caller = parsed.caller;
    if (typeof parsed.credits === 'number') out.credits = parsed.credits;
    return out;
  } catch {
    return undefined;
  }
}

export function entriesFileName(date: Date): string {
  return fileNameFor(date);
}

/** Aggregate entries into month-level stats for the configuration panel's fallback card. */
export function summarize(entries: readonly AuditEntry[]): AuditStats {
  const stats: AuditStats = {
    totalCalls: 0,
    searchCalls: 0,
    extractCalls: 0,
    crawlCalls: 0,
    mapCalls: 0,
    researchCalls: 0,
    failedCalls: 0,
    totalResults: 0,
    totalCredits: 0,
    recentTargets: [],
  };
  for (const entry of entries) {
    stats.totalCalls += 1;
    // Explicit per-tool branches: an `else` here silently attributes a newly
    // added tool to whichever branch happens to be last.
    switch (entry.tool) {
      case 'search':
        stats.searchCalls += 1;
        break;
      case 'extract':
        stats.extractCalls += 1;
        break;
      case 'crawl':
        stats.crawlCalls += 1;
        break;
      case 'map':
        stats.mapCalls += 1;
        break;
      case 'research':
        stats.researchCalls += 1;
        break;
    }
    if (entry.status === 'error') stats.failedCalls += 1;
    stats.totalResults += entry.resultCount;
    if (typeof entry.credits === 'number') stats.totalCredits += entry.credits;
  }
  stats.recentTargets = entries
    .slice(-10)
    .map((entry) => entry.target)
    .reverse();
  return stats;
}

/** Filter entries by optional date prefix (YYYY-MM-DD) and/or keyword. */
export function filterEntries(
  entries: readonly AuditEntry[],
  query?: { datePrefix?: string; keyword?: string; limit?: number },
): AuditEntry[] {
  const keyword = query?.keyword?.trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    if (query?.datePrefix && !entry.at.startsWith(query.datePrefix)) return false;
    if (keyword && !entry.target.toLowerCase().includes(keyword)) return false;
    return true;
  });
  const limit = query?.limit ?? 50;
  return filtered.slice(-limit).reverse();
}

/**
 * Redact anything that looks like an embedded Tavily key (`tvly-...`) from
 * free text (queries/URLs). Belt-and-braces on top of never accepting the key
 * as a tool argument.
 */
export function redactApiKeyLike(text: string): string {
  return text.replace(/tvly-[A-Za-z0-9_-]{6,}/g, 'tvly-****');
}
