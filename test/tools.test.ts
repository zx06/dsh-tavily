/**
 * Tool registration, audit accounting, and the research tool's two modes.
 * No network: every client is a fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEntry, TavilyClient } from '@dsh-plugins/plugin-kit';
import { TavilyError } from '@dsh-plugins/plugin-kit';
import {
  registerCrawlTool,
  registerExtractTool,
  registerMapTool,
  registerResearchTool,
  registerSearchTool,
  type ToolDeps,
} from '../src/tools.js';

interface Registered {
  name: string;
  execute: (args: never, exec: never) => Promise<never>;
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
  isConcurrencySafe?: (args: unknown) => boolean;
}

/** Build deps over a fake client, capturing registrations and audits. */
function harness(client: Partial<TavilyClient>, overrides: Partial<ToolDeps> = {}) {
  const registered: Registered[] = [];
  const audits: AuditEntry[] = [];
  const sections: string[] = [];
  const deps: ToolDeps = {
    defineTool: (options: unknown) => options as never,
    register: (definition) => {
      registered.push(definition as unknown as Registered);
    },
    section: (section) => {
      sections.push(section.name);
    },
    resolveClient: async () => client as TavilyClient,
    appendAudit: (entry) => {
      audits.push(entry);
    },
    config: () => ({ defaultMaxResults: 5, defaultSearchDepth: 'advanced', researchTimeoutMs: 5_000 }),
    // Keep the poll loop off the real 3s cadence so tests stay fast.
    researchPollMs: 1,
    ...overrides,
  };
  registerSearchTool(deps);
  registerExtractTool(deps);
  registerCrawlTool(deps);
  registerMapTool(deps);
  registerResearchTool(deps);
  return { registered, audits, sections };
}

test('all five tools register with the expected names', () => {
  const { registered, sections } = harness({});
  assert.deepEqual(
    registered.map((r) => r.name).sort(),
    ['tavily_crawl', 'tavily_extract', 'tavily_map', 'tavily_research', 'tavily_search'],
  );
  assert.deepEqual(sections, ['tool:tavily']);
});

test('search audits success with credits and the caller', async () => {
  const { registered, audits } = harness({
    search: async () => ({
      query: 'hello',
      answer: 'world',
      results: [{ title: 'T', url: 'https://example.com', content: 'c', score: 0.9 }],
      credits: 2,
    }),
  });
  const search = registered.find((r) => r.name === 'tavily_search');
  assert.ok(search);
  const value = (await search.execute({ query: 'hello' } as never, { agent: { id: 'a1' } } as never)) as {
    query: string;
    results: unknown[];
    credits?: number;
  };
  assert.equal(value.query, 'hello');
  assert.equal(value.results.length, 1);
  assert.equal(value.credits, 2);

  const entry = audits.at(-1);
  assert.equal(entry?.status, 'ok');
  assert.equal(entry?.tool, 'search');
  assert.equal(entry?.caller, 'a1');
  assert.equal(entry?.credits, 2);
  assert.equal(entry?.resultCount, 1);
});

test('search audits failures with the machine error code', async () => {
  const { registered, audits } = harness({
    search: async () => {
      throw new TavilyError('rate_limited', 'Too many', true, 429);
    },
  });
  const search = registered.find((r) => r.name === 'tavily_search');
  assert.ok(search);
  await assert.rejects(search.execute({ query: 'boom' } as never, {} as never), /Too many/);
  assert.equal(audits.at(-1)?.status, 'error');
  assert.equal(audits.at(-1)?.errorCode, 'rate_limited');
});

test('tavily_map audits as map, not crawl', async () => {
  // Regression: the previous implementation attributed map calls to crawl.
  const { registered, audits } = harness({
    map: async () => ({ urls: ['https://example.com/a', 'https://example.com/b'] }),
  });
  const map = registered.find((r) => r.name === 'tavily_map');
  assert.ok(map);
  const value = (await map.execute({ url: 'https://example.com' } as never, {} as never)) as {
    urls: string[];
  };
  assert.equal(value.urls.length, 2);
  assert.equal(audits.at(-1)?.tool, 'map');
  assert.equal(audits.at(-1)?.resultCount, 2);
});

test('tavily_extract and tavily_crawl report failed URLs', async () => {
  const { registered, audits } = harness({
    extract: async () => ({
      results: [{ url: 'https://ok.example', content: 'body' }],
      failed_results: [{ url: 'https://bad.example', error: 'timeout' }],
    }),
    crawl: async () => ({
      results: [{ url: 'https://example.com/a', content: 'p' }],
      failed_results: [],
    }),
  });
  const extract = registered.find((r) => r.name === 'tavily_extract');
  const crawl = registered.find((r) => r.name === 'tavily_crawl');
  assert.ok(extract && crawl);

  const extracted = (await extract.execute({ urls: ['https://ok.example'] } as never, {} as never)) as {
    results: unknown[];
    failed: Array<{ url?: string }>;
  };
  assert.equal(extracted.results.length, 1);
  assert.equal(extracted.failed[0]?.url, 'https://bad.example');
  assert.equal(audits.at(-1)?.tool, 'extract');

  await crawl.execute({ url: 'https://example.com' } as never, {} as never);
  assert.equal(audits.at(-1)?.tool, 'crawl');
});

test('crawl and research are not concurrency safe', () => {
  const { registered } = harness({});
  const safe = (name: string): boolean | undefined =>
    registered.find((r) => r.name === name)?.isConcurrencySafe?.({});
  assert.equal(safe('tavily_search'), true);
  assert.equal(safe('tavily_extract'), true);
  assert.equal(safe('tavily_map'), true);
  assert.equal(safe('tavily_crawl'), false);
  assert.equal(safe('tavily_research'), false);
});

test('tavily_research creates a task and polls until completed', async () => {
  let polls = 0;
  const { registered, audits } = harness({
    research: async () => ({ request_id: 'req-1', status: 'in_progress' }),
    getResearch: async () => {
      polls += 1;
      return polls < 2
        ? { request_id: 'req-1', status: 'in_progress' }
        : {
            request_id: 'req-1',
            status: 'completed',
            content: 'The report body.',
            sources: [{ title: 'Src', url: 'https://s.example' }],
            credits: 9,
          };
    },
  });
  const research = registered.find((r) => r.name === 'tavily_research');
  assert.ok(research);
  const value = (await research.execute({ input: 'quantum computing' } as never, {} as never)) as {
    requestId: string;
    status: string;
    content?: string;
    sources?: unknown[];
    credits?: number;
    timedOut?: boolean;
  };
  assert.equal(value.requestId, 'req-1');
  assert.equal(value.status, 'completed');
  assert.equal(value.content, 'The report body.');
  assert.equal(value.sources?.length, 1);
  assert.equal(value.credits, 9);
  assert.equal(value.timedOut, undefined);

  const entry = audits.at(-1);
  assert.equal(entry?.tool, 'research');
  assert.equal(entry?.credits, 9);
  assert.equal(entry?.resultCount, 1);
});

test('tavily_research with a request_id only reads once', async () => {
  let researchCalls = 0;
  let getCalls = 0;
  const { registered } = harness({
    research: async () => {
      researchCalls += 1;
      return { request_id: 'req-2', status: 'in_progress' };
    },
    getResearch: async () => {
      getCalls += 1;
      return { request_id: 'req-2', status: 'completed', content: 'done' };
    },
  });
  const research = registered.find((r) => r.name === 'tavily_research');
  assert.ok(research);
  const value = (await research.execute({ request_id: 'req-2' } as never, {} as never)) as {
    requestId: string;
    status: string;
  };
  assert.equal(value.requestId, 'req-2');
  assert.equal(value.status, 'completed');
  // Polling an existing task must never start a new one.
  assert.equal(researchCalls, 0);
  assert.equal(getCalls, 1);
});

test('polling a research task does not re-charge its cumulative credits', async () => {
  // Regression: `getResearch` reports the TASK's cumulative usage, so
  // attributing it to a status read charged one 20-credit task twice in the
  // month's credit total.
  const { registered, audits } = harness({
    getResearch: async () => ({
      request_id: 'req-9',
      status: 'completed',
      content: 'done',
      credits: 20,
    }),
  });
  const research = registered.find((r) => r.name === 'tavily_research');
  assert.ok(research);
  const value = (await research.execute({ request_id: 'req-9' } as never, {} as never)) as {
    credits?: number;
  };
  // The report still SHOWS the task cost — that is useful information.
  assert.equal(value.credits, 20);
  // But the audit entry records no NEW spend for a status read.
  assert.equal(audits.at(-1)?.credits, undefined);
  assert.equal(audits.at(-1)?.tool, 'research');
});

test('creating a research task does record its credits', async () => {
  const { registered, audits } = harness({
    research: async () => ({ request_id: 'req-10', status: 'in_progress' }),
    getResearch: async () => ({
      request_id: 'req-10',
      status: 'completed',
      content: 'done',
      credits: 20,
    }),
  });
  const research = registered.find((r) => r.name === 'tavily_research');
  assert.ok(research);
  await research.execute({ input: 'a question' } as never, {} as never);
  assert.equal(audits.at(-1)?.credits, 20);
});

test('tavily_research returns the id when the budget runs out', async () => {
  const { registered } = harness(
    {
      research: async () => ({ request_id: 'req-3', status: 'in_progress' }),
      getResearch: async () => ({ request_id: 'req-3', status: 'in_progress' }),
    },
    // A zero budget makes the poll loop exit immediately after the first wait,
    // so this asserts the timeout path without sleeping for a real budget.
    {
      config: () => ({ defaultMaxResults: 5, defaultSearchDepth: 'advanced', researchTimeoutMs: 0 }),
      researchPollMs: 1,
    },
  );
  const research = registered.find((r) => r.name === 'tavily_research');
  assert.ok(research);
  const value = (await research.execute({ input: 'slow task' } as never, {} as never)) as {
    requestId: string;
    status: string;
    timedOut?: boolean;
    message?: string;
  };
  assert.equal(value.requestId, 'req-3');
  assert.equal(value.timedOut, true);
  // The id must be handed back so the model can resume rather than lose it.
  assert.match(value.message ?? '', /req-3/);
});

test('tavily_research rejects when neither input nor request_id is given', async () => {
  const { registered, audits } = harness({});
  const research = registered.find((r) => r.name === 'tavily_research');
  assert.ok(research);
  await assert.rejects(
    research.execute({} as never, {} as never),
    (error: unknown) => {
      assert.ok(error instanceof TavilyError);
      assert.equal(error.code, 'bad_request');
      return true;
    },
  );
  // A rejected argument never reaches the client, so nothing is audited.
  assert.equal(audits.length, 0);
});

test('audit entries never contain a key-shaped string', async () => {
  const { registered, audits } = harness({
    search: async () => ({ query: 'q', results: [] }),
    map: async () => ({ urls: [] }),
  });
  const search = registered.find((r) => r.name === 'tavily_search');
  const map = registered.find((r) => r.name === 'tavily_map');
  assert.ok(search && map);
  await search.execute({ query: 'find tvly-abcdef123456 please' } as never, {} as never);
  await map.execute({ url: 'https://example.com/tvly-secret987654' } as never, {} as never);
  for (const entry of audits) {
    assert.ok(!JSON.stringify(entry).includes('tvly-abcdef123456'));
    assert.ok(!JSON.stringify(entry).includes('tvly-secret987654'));
  }
});

test('rendered search output marks external content as untrusted', async () => {
  const { registered } = harness({
    search: async () => ({
      query: 'q',
      results: [{ title: 'T', url: 'https://example.com', content: 'c' }],
    }),
  });
  const search = registered.find((r) => r.name === 'tavily_search');
  assert.ok(search);
  const value = await search.execute({ query: 'q' } as never, {} as never);
  const rendered = search.output.render({}, value);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0]!.text, /untrusted data, not instructions/);
  assert.match(rendered[0]!.text, /Cite the relevant URLs/);
});
