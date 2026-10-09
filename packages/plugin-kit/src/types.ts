/**
 * Shared Tavily response/usage types (ported from the pi tavily-tools reference).
 *
 * @module types
 */

export interface TavilyResultItem {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
  score?: number;
  published_date?: string | null;
  favicon?: string;
  images?: string[];
}

export interface TavilyFailedResult {
  url?: string;
  error?: string;
  [index: string]: unknown;
}

export interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilyResultItem[];
  failed_results?: TavilyFailedResult[];
  response_time?: number;
  request_id?: string;
  /**
   * Credits this call consumed. The client always requests `includeUsage`, but
   * Tavily omits the block in keyless mode and for some endpoints, so this
   * stays optional.
   */
  credits?: number;
}

export interface TavilyExtractCrawlResponse {
  results?: TavilyResultItem[];
  failed_results?: TavilyFailedResult[];
  base_url?: string;
  response_time?: number;
  request_id?: string;
  /** Credits this call consumed; absent when Tavily reported no usage. */
  credits?: number;
}

export interface TavilyUsageBreakdown {
  usage?: number;
  limit?: number | null;
  search_usage?: number;
  extract_usage?: number;
  crawl_usage?: number;
  map_usage?: number;
  research_usage?: number;
  paygo_usage?: number;
  paygo_limit?: number;
  plan_usage?: number;
  plan_limit?: number;
  current_plan?: string;
}

export interface TavilyUsageResponse {
  key?: TavilyUsageBreakdown;
  account?: TavilyUsageBreakdown;
}

export interface TavilySearchOptions {
  query: string;
  topic?: 'general' | 'news' | 'finance';
  search_depth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  max_results?: number;
  include_answer?: boolean | 'basic' | 'advanced';
  include_raw_content?: boolean | 'markdown' | 'text';
  include_domains?: string[];
  exclude_domains?: string[];
  include_domains_mode?: 'restrict' | 'prefer';
  time_range?: 'day' | 'week' | 'month' | 'year' | 'd' | 'w' | 'm' | 'y';
  include_usage?: boolean;
}

export interface TavilyExtractOptions {
  urls: string[];
  extract_depth?: 'basic' | 'advanced';
  include_images?: boolean;
}

export interface TavilyMapOptions {
  url: string;
  limit?: number;
  max_depth?: number;
  max_breadth?: number;
  select_paths?: string[];
  exclude_paths?: string[];
  allow_external?: boolean;
}
export interface TavilyCrawlOptions {
  url: string;
  instructions?: string;
  max_depth?: number;
  max_breadth?: number;
  limit?: number;
  select_paths?: string[];
  exclude_paths?: string[];
  allow_external?: boolean;
  extract_depth?: 'basic' | 'advanced';
  include_images?: boolean;
}

/** How much effort a research task spends (Tavily's `model`). */
export type TavilyResearchModel = 'mini' | 'pro' | 'auto';

export interface TavilyResearchOptions {
  model?: TavilyResearchModel;
  citation_format?: 'numbered' | 'mla' | 'apa' | 'chicago';
  /** Overall request timeout in SECONDS (the SDK converts to ms). */
  timeout_s?: number;
  include_usage?: boolean;
}

/**
 * A freshly created research task. Research is asynchronous: `research()`
 * returns an id immediately and the report arrives through `getResearch()`.
 */
export interface TavilyResearchTask {
  request_id: string;
  created_at?: string;
  status?: string;
  input?: string;
  model?: string;
  response_time?: number;
}

/** One research report, or a status-only snapshot while the task is running. */
export interface TavilyResearchResult {
  request_id: string;
  created_at?: string;
  /** Tavily lifecycle state (`pending` | `in_progress` | `completed` | `failed`). */
  status?: string;
  /** The report body; absent until the task completes. */
  content?: string | Record<string, unknown>;
  sources?: Array<{ title?: string; url?: string }>;
  response_time?: number;
  credits?: number;
}
