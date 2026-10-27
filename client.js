/**
 * tavily — browser half.
 *
 * Contributes the configuration UI to the plugin manager's detail page for this
 * bundle (`plugins.bundle.config`): the API-key form, the Tavily quota card, and
 * the local audit table. There is deliberately no `settings.section` — one
 * configuration surface, reached from the plugin's own page.
 *
 * Hand-written ModuleLoader bundle, as this repo's convention: no build step,
 * only the `react` the shell already provides. All colour comes from live
 * theme variables (`--dsw-*`), never from hard-coded palette values, so the
 * page follows light/dark without extra wiring.
 *
 * The key is the one control that never rides a response: the page learns only
 * whether one is configured (plus a mask), and writes it through the plugin's
 * own `/api/tavily/key` route, which validates against Tavily before storing.
 * Provider options are read and written through `ctx.configForms` — the
 * settings transport owns revision fencing, so the page never hand-writes a
 * configuration document.
 */
window.__ModuleLoader__.load({
  id: '@zx06/tavily',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    const NS = 'settings.tavily'
    const inject = ['slots', 'locale', 'configForms']
    const API = '/api/tavily'
    /** The package name; also the plugin manager's dispatch key for this bundle. */
    const PKG_NAME = '@zx06/tavily'
    /** Settings namespace == the Loader row id == the plugin name's last segment. */
    const CONFIG_NS = 'tavily'

    const DICT = {
      zh: {
        loading: '正在加载…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        keyLabel: 'API Key',
        keyPlaceholder: 'tvly-…',
        keyHint: '可在 Tavily Dashboard（app.tavily.com）申请。保存时会自动校验有效性，并通过 DSH 凭据服务加密保存。',
        configured: '已配置',
        notConfigured: '未配置',
        keylessOn: '免密模式已开启',
        keylessHint: '未配置 Key 时仍可使用搜索与正文抽取（共享限速）。crawl / map / research 需要 API Key。',
        source: '来源',
        srcConfig: '插件配置',
        srcCredentials: '凭据服务',
        srcEnv: '环境变量',
        srcNone: '未配置',
        save: '保存并校验',
        saving: '校验中…',
        clear: '清除',
        saveOk: 'Key 已保存并生效',
        saveFailed: '保存失败',
        clearOk: 'Key 已清除',
        optionsTitle: '搜索选项',
        optMaxResults: '默认结果数',
        optDepth: '默认搜索深度',
        optKeyless: '允许免密模式',
        optKeylessHint: '关闭后，未配置 Key 时工具将直接报错。',
        depthBasic: 'basic（1 credit）',
        depthAdvanced: 'advanced（2 credits）',
        optTimeout: '请求超时（毫秒）',
        optResearchTimeout: '研究任务超时（毫秒）',
        optionsSaved: '选项已保存',
        optionsFailed: '选项保存失败',
        usageTitle: '额度用量',
        usageRefresh: '刷新',
        usageLoading: '查询中…',
        usageFailed: '额度查询失败',
        usageUnlimited: '不限量',
        planLabel: '套餐',
        keyUsage: '本 Key 已用',
        accountUsage: '账户已用',
        dashboard: '前往 Tavily Dashboard',
        statsTitle: '本月用量',
        statCalls: '调用次数',
        statCredits: '消耗 credits',
        statFailed: '失败次数',
        statResults: '返回结果数',
        auditTitle: '审计日志',
        auditHint: '记录每次工具调用（时间 / 工具 / 目标 / 耗时 / 结果数 / 状态 / credits），不含 Key。',
        auditEmpty: '暂无记录',
        auditSearch: '按关键词过滤',
        auditRefresh: '刷新',
        colTime: '时间',
        colTool: '工具',
        colTarget: '目标',
        colLatency: '耗时',
        colResults: '结果数',
        colCredits: 'credits',
        colStatus: '状态',
        ok: '成功',
        err: '失败',
      },
      en: {
        loading: 'Loading…',
        loadFailed: 'Cannot reach plugin backend',
        retry: 'Retry',
        keyLabel: 'API Key',
        keyPlaceholder: 'tvly-…',
        keyHint: 'Get one at the Tavily dashboard (app.tavily.com). It is validated on save and stored through the DSH credential service.',
        configured: 'Configured',
        notConfigured: 'Not configured',
        keylessOn: 'Keyless mode enabled',
        keylessHint: 'Without a key, search and extract still work under a shared rate limit. crawl / map / research need an API key.',
        source: 'Source',
        srcConfig: 'plugin config',
        srcCredentials: 'credential store',
        srcEnv: 'environment',
        srcNone: 'not configured',
        save: 'Save & validate',
        saving: 'Validating…',
        clear: 'Clear',
        saveOk: 'Key saved and active',
        saveFailed: 'Save failed',
        clearOk: 'Key cleared',
        optionsTitle: 'Search options',
        optMaxResults: 'Default results',
        optDepth: 'Default search depth',
        optKeyless: 'Allow keyless mode',
        optKeylessHint: 'When off, tools fail immediately if no key is configured.',
        depthBasic: 'basic (1 credit)',
        depthAdvanced: 'advanced (2 credits)',
        optTimeout: 'Request timeout (ms)',
        optResearchTimeout: 'Research timeout (ms)',
        optionsSaved: 'Options saved',
        optionsFailed: 'Could not save options',
        usageTitle: 'Quota usage',
        usageRefresh: 'Refresh',
        usageLoading: 'Loading…',
        usageFailed: 'Quota lookup failed',
        usageUnlimited: 'Unlimited',
        planLabel: 'Plan',
        keyUsage: 'Key used',
        accountUsage: 'Account used',
        dashboard: 'Open Tavily Dashboard',
        statsTitle: 'This month',
        statCalls: 'Calls',
        statCredits: 'Credits used',
        statFailed: 'Failures',
        statResults: 'Results',
        auditTitle: 'Audit log',
        auditHint: 'One row per tool call (time / tool / target / latency / results / status / credits). Never contains the key.',
        auditEmpty: 'No records yet',
        auditSearch: 'Filter by keyword',
        auditRefresh: 'Refresh',
        colTime: 'Time',
        colTool: 'Tool',
        colTarget: 'Target',
        colLatency: 'Latency',
        colResults: 'Results',
        colCredits: 'Credits',
        colStatus: 'Status',
        ok: 'ok',
        err: 'error',
      },
    }

    async function api(path, options) {
      const { timeout = 15000, ...fetchOptions } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...fetchOptions, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 300) } }
        if (!response.ok) {
          const error = new Error(payload?.error ?? `HTTP ${response.status}`)
          error.code = payload?.code
          error.status = response.status
          throw error
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }
    const post = (path, body, timeout) => api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      timeout,
    })

    function fmtNum(n) {
      if (n === null || n === undefined) return '–'
      return Number(n).toLocaleString()
    }

    /**
     * Read the active locale tag.
     *
     * The service exposes `getLocale()`, not a `tag()` accessor, and the
     * snapshot shape has varied between releases — so this reads defensively
     * and falls back to the document language rather than throwing inside
     * render.
     */
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function'
          ? ctx.locale.getLocale()
          : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'zh'
      } catch { return 'zh' }
    }

    function UsageBar({ used, limit }) {
      if (limit === null || limit === undefined) return null
      const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
      return h('div', { className: 'tv_bar' },
        h('div', { className: 'tv_barfill', style: { width: `${pct}%` } }))
    }

    function QuotaCard({ t, usage, loading, error, onRefresh }) {
      const key = usage?.key
      const account = usage?.account
      /**
       * Render one "used / limit" line.
       *
       * Tavily returns `limit: null` for a key that inherits the account plan,
       * so printing "0 / 不限量" would imply an uncapped key when the account
       * cap is what actually applies. Show the used figure alone in that case.
       */
      const usageLine = (label, used, limit) =>
        h('p', null, limit === null || limit === undefined
          ? `${label}：${fmtNum(used)}`
          : `${label}：${fmtNum(used)} / ${fmtNum(limit)}`)
      return h('section', { className: 'tv_card' },
        h('div', { className: 'tv_row' },
          h('h3', null, t('usageTitle')),
          h('button', { className: 'tv_btn', onClick: onRefresh, disabled: loading === true },
            loading === true ? t('usageLoading') : t('usageRefresh'))),
        error ? h('p', { className: 'tv_err' }, `${t('usageFailed')}：${error}`) : null,
        !error && !usage ? h('p', { className: 'tv_note' }, t('usageLoading')) : null,
        account?.current_plan ? h('p', null, `${t('planLabel')}：${account.current_plan}`) : null,
        key ? h('div', { className: 'tv_block' },
          usageLine(t('keyUsage'), key.usage ?? 0, key.limit),
          h(UsageBar, { used: key.usage ?? 0, limit: key.limit })) : null,
        account ? h('div', { className: 'tv_block' },
          usageLine(t('accountUsage'), account.plan_usage ?? 0, account.plan_limit),
          h(UsageBar, { used: account.plan_usage ?? 0, limit: account.plan_limit })) : null,
        h('p', { className: 'tv_note' },
          h('a', { href: 'https://app.tavily.com/home', target: '_blank', rel: 'noreferrer' }, t('dashboard'))))
    }

    function StatsRow({ t, stats }) {
      if (!stats) return null
      const cells = [
        [t('statCalls'), stats.totalCalls],
        [t('statCredits'), stats.totalCredits],
        [t('statFailed'), stats.failedCalls],
        [t('statResults'), stats.totalResults],
      ]
      return h('div', { className: 'tv_stats' },
        cells.map(([label, value]) => h('div', { className: 'tv_stat', key: label },
          h('div', { className: 'tv_statval' }, fmtNum(value)),
          h('div', { className: 'tv_statlabel' }, label))))
    }

    function AuditTable({ t, entries }) {
      if (!entries || entries.length === 0) return h('p', { className: 'tv_note' }, t('auditEmpty'))
      return h('div', { className: 'tv_tablewrap' },
        h('table', { className: 'tv_table' },
          h('thead', null, h('tr', null,
            h('th', null, t('colTime')),
            h('th', null, t('colTool')),
            h('th', null, t('colTarget')),
            h('th', null, t('colLatency')),
            h('th', null, t('colResults')),
            h('th', null, t('colCredits')),
            h('th', null, t('colStatus')))),
          h('tbody', null, entries.map((e, i) => h('tr', { key: `${e.at}-${e.tool}-${i}` },
            h('td', { className: 'tv_nowrap' }, new Date(e.at).toLocaleString()),
            h('td', null, e.tool),
            h('td', { className: 'tv_target', title: e.target }, e.target),
            h('td', { className: 'tv_nowrap' }, `${e.latencyMs}ms`),
            h('td', null, String(e.resultCount)),
            h('td', null, e.credits === undefined ? '–' : String(e.credits)),
            h('td', null, e.status === 'error'
              ? h('span', { className: 'tv_pill tv_errpill' }, `${t('err')}${e.errorCode ? ` · ${e.errorCode}` : ''}`)
              : h('span', { className: 'tv_pill tv_okpill' }, t('ok'))))))))
    }

    /**
     * Provider options, backed by the shared config form.
     *
     * The form owns revision fencing and the Host write; this component only
     * stages text. A write is reported back so the page can show a notice
     * instead of silently discarding an edit.
     */
    function OptionsCard({ t, form, formSnapshot }) {
      const [draft, setDraft] = useState(null)
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const value = formSnapshot?.value ?? {}

      useEffect(() => {
        if (formSnapshot?.status === 'ready') setDraft(null)
      }, [formSnapshot?.revision, formSnapshot?.status])

      const current = {
        defaultMaxResults: draft?.defaultMaxResults ?? value.defaultMaxResults ?? 5,
        defaultSearchDepth: draft?.defaultSearchDepth ?? value.defaultSearchDepth ?? 'advanced',
        allowKeyless: draft?.allowKeyless ?? value.allowKeyless ?? true,
        requestTimeoutMs: draft?.requestTimeoutMs ?? value.requestTimeoutMs ?? 45000,
        researchTimeoutMs: draft?.researchTimeoutMs ?? value.researchTimeoutMs ?? 180000,
      }
      const patch = next => setDraft({ ...current, ...next })

      const onSave = async () => {
        if (!form || busy) return
        setBusy(true)
        setNotice('')
        try {
          const ok = await form.mutate([
            { op: 'set', path: ['defaultMaxResults'], value: Number(current.defaultMaxResults) },
            { op: 'set', path: ['defaultSearchDepth'], value: current.defaultSearchDepth },
            { op: 'set', path: ['allowKeyless'], value: current.allowKeyless === true },
            { op: 'set', path: ['requestTimeoutMs'], value: Number(current.requestTimeoutMs) },
            { op: 'set', path: ['researchTimeoutMs'], value: Number(current.researchTimeoutMs) },
          ])
          setNotice(ok ? t('optionsSaved') : t('optionsFailed'))
          if (ok) setDraft(null)
        } catch (e) {
          setNotice(`${t('optionsFailed')}：${e?.message ?? e}`)
        } finally {
          setBusy(false)
        }
      }

      return h('section', { className: 'tv_card' },
        h('div', { className: 'tv_row' },
          h('h3', null, t('optionsTitle')),
          h('button', { className: 'tv_btn tv_primary', disabled: busy || !form, onClick: () => onSave().then(() => {}) }, t('save'))),
        h('div', { className: 'tv_grid' },
          h('label', { className: 'tv_field' },
            h('span', null, t('optMaxResults')),
            h('input', {
              className: 'tv_input', type: 'number', min: 1, max: 10,
              value: current.defaultMaxResults,
              onChange: e => patch({ defaultMaxResults: e.target.value }),
            })),
          h('label', { className: 'tv_field' },
            h('span', null, t('optDepth')),
            h('select', {
              className: 'tv_input',
              value: current.defaultSearchDepth,
              onChange: e => patch({ defaultSearchDepth: e.target.value }),
            },
              h('option', { value: 'basic' }, t('depthBasic')),
              h('option', { value: 'advanced' }, t('depthAdvanced')))),
          h('label', { className: 'tv_field' },
            h('span', null, t('optTimeout')),
            h('input', {
              className: 'tv_input', type: 'number', min: 1000, step: 1000,
              value: current.requestTimeoutMs,
              onChange: e => patch({ requestTimeoutMs: e.target.value }),
            })),
          h('label', { className: 'tv_field' },
            h('span', null, t('optResearchTimeout')),
            h('input', {
              className: 'tv_input', type: 'number', min: 10000, step: 10000,
              value: current.researchTimeoutMs,
              onChange: e => patch({ researchTimeoutMs: e.target.value }),
            }))),
        h('label', { className: 'tv_check' },
          h('input', {
            type: 'checkbox',
            checked: current.allowKeyless === true,
            onChange: e => patch({ allowKeyless: e.target.checked }),
          }),
          h('span', null, t('optKeyless'))),
        h('p', { className: 'tv_note' }, t('optKeylessHint')),
        notice ? h('p', { className: 'tv_note' }, notice) : null)
    }

    function SettingsPage(props) {
      const ctx = props.ctx
      const locale = props.locale ?? 'zh'
      const t = key => (DICT[locale] && DICT[locale][key]) ?? DICT.zh[key] ?? key
      const [summary, setSummary] = useState(undefined)
      const [summaryError, setSummaryError] = useState('')
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [usage, setUsage] = useState(undefined)
      const [usageLoading, setUsageLoading] = useState(false)
      const [usageError, setUsageError] = useState('')
      const [entries, setEntries] = useState([])
      const [keyword, setKeyword] = useState('')
      const [formSnapshot, setFormSnapshot] = useState(undefined)
      const formRef = useRef(undefined)

      const loadSummary = useCallback(() => {
        setSummaryError('')
        return api('/summary').then(setSummary).catch(e => setSummaryError(String(e?.message ?? e)))
      }, [])
      const loadUsage = useCallback(() => {
        setUsageLoading(true)
        setUsageError('')
        return api('/usage', { timeout: 20000 })
          .then(payload => setUsage(payload.usage))
          .catch(e => { setUsage(undefined); setUsageError(String(e?.message ?? e)) })
          .finally(() => setUsageLoading(false))
      }, [])
      const loadAudit = useCallback((q) => {
        const params = new URLSearchParams({ limit: '50' })
        if (q) params.set('q', q)
        return api(`/audit?${params.toString()}`)
          .then(payload => setEntries(payload.entries ?? []))
          .catch(() => {})
      }, [])

      // Bind the shared config form once; it owns the namespace subscription.
      useEffect(() => {
        const forms = ctx?.configForms
        if (!forms || typeof forms.get !== 'function') return undefined
        let form
        try { form = forms.get(CONFIG_NS) } catch { return undefined }
        if (!form) return undefined
        formRef.current = form
        setFormSnapshot(form.getSnapshot())
        const off = form.subscribe(() => setFormSnapshot(form.getSnapshot()))
        return () => { try { off() } catch { /* already disposed */ } }
      }, [ctx])

      useEffect(() => {
        loadSummary().then(() => {})
        loadAudit().then(() => {})
      }, [loadSummary, loadAudit])

      // Quota needs a key; only ask once one is known to be configured.
      useEffect(() => {
        if (summary?.configured === true) loadUsage().then(() => {})
      }, [summary?.configured, loadUsage])

      const onSave = async () => {
        if (!draft.trim() || busy) return
        setBusy(true)
        setNotice('')
        try {
          const payload = await post('/key', { apiKey: draft.trim() }, 30000)
          setNotice(t('saveOk'))
          setDraft('')
          setSummary(s => s ? { ...s, configured: true, maskedKey: payload.maskedKey } : s)
          loadSummary().then(() => {})
        } catch (e) {
          setNotice(`${t('saveFailed')}：${e?.message ?? e}`)
        } finally {
          setBusy(false)
        }
      }
      const onClear = async () => {
        if (busy) return
        setBusy(true)
        try {
          await api('/key', { method: 'DELETE' })
          setNotice(t('clearOk'))
          setUsage(undefined)
          loadSummary().then(() => {})
        } catch (e) {
          setNotice(`${t('saveFailed')}：${e?.message ?? e}`)
        } finally {
          setBusy(false)
        }
      }

      if (summary === undefined && !summaryError) return h('p', null, t('loading'))
      if (summaryError && summary === undefined) {
        return h('div', null,
          h('p', null, t('loadFailed')),
          h('button', { className: 'tv_btn', onClick: () => loadSummary().then(() => {}) }, t('retry')))
      }

      const sourceLabel = {
        config: t('srcConfig'),
        credentials: t('srcCredentials'),
        env: t('srcEnv'),
        none: t('srcNone'),
      }[summary?.keySource] ?? summary?.keySource ?? ''

      // The plugin manager's detail page renders this bundle's title and
      // description immediately above the slot, so the form starts at the first
      // card instead of repeating a page header of its own.
      return h('div', { className: 'tv_page' },
        h('section', { className: 'tv_card' },
          h('h3', null, t('keyLabel')),
          h('p', null,
            summary?.configured === true
              ? h('span', { className: 'tv_pill tv_okpill' },
                  `${t('configured')}${summary.maskedKey ? ` · ${summary.maskedKey}` : ''} · ${t('source')}: ${sourceLabel}`)
              : h('span', { className: 'tv_pill tv_errpill' },
                  summary?.keyless === true ? `${t('notConfigured')} · ${t('keylessOn')}` : t('notConfigured'))),
          h('div', { className: 'tv_row' },
            h('input', {
              className: 'tv_input tv_grow',
              type: 'password',
              value: draft,
              placeholder: t('keyPlaceholder'),
              autoComplete: 'off',
              onChange: e => setDraft(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter') onSave().then(() => {}) },
            }),
            h('button', { className: 'tv_btn tv_primary', disabled: busy || !draft.trim(), onClick: () => onSave().then(() => {}) },
              busy ? t('saving') : t('save')),
            summary?.configured === true
              ? h('button', { className: 'tv_btn', disabled: busy, onClick: () => onClear().then(() => {}) }, t('clear'))
              : null),
          h('p', { className: 'tv_note' }, t('keyHint')),
          summary?.configured !== true && summary?.keyless === true
            ? h('p', { className: 'tv_note' }, t('keylessHint'))
            : null,
          notice ? h('p', { className: 'tv_note' }, notice) : null),

        h(OptionsCard, { t, form: formRef.current, formSnapshot }),

        summary?.configured === true
          ? h(QuotaCard, { t, usage, loading: usageLoading, error: usageError, onRefresh: () => loadUsage().then(() => {}) })
          : null,

        h('section', { className: 'tv_card' },
          h('h3', null, t('statsTitle')),
          h(StatsRow, { t, stats: summary?.stats })),

        h('section', { className: 'tv_card' },
          h('div', { className: 'tv_row' },
            h('h3', null, t('auditTitle')),
            h('button', { className: 'tv_btn', onClick: () => loadAudit(keyword).then(() => {}) }, t('auditRefresh'))),
          h('p', { className: 'tv_note' }, t('auditHint')),
          h('input', {
            className: 'tv_input',
            value: keyword,
            placeholder: t('auditSearch'),
            onChange: e => setKeyword(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter') loadAudit(keyword).then(() => {}) },
          }),
          h(AuditTable, { t, entries })))
    }

    const CSS = [
      // Scoped to the page root so nothing here can leak into shell chrome.
      '.tv_page{display:flex;flex-direction:column;gap:12px;max-width:860px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}',
      '.tv_page h3{margin:0;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.tv_card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}',
      '.tv_card>h3{margin-bottom:8px}',
      '.tv_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.tv_row h3{margin:0;margin-right:auto}',
      '.tv_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:8px 0}',
      '.tv_field{display:flex;flex-direction:column;gap:4px;font-size:12px}',
      '.tv_field>span{color:var(--dsw-alias-label-secondary)}',
      '.tv_input{box-sizing:border-box;width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}',
      '.tv_input:focus{outline:none;border-color:var(--dsw-alias-border-l2)}',
      '.tv_input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.tv_grow{flex:1 1 240px;min-width:0}',
      '.tv_btn{padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:13px;white-space:nowrap}',
      '.tv_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3))}',
      '.tv_btn:disabled{opacity:.55;cursor:default}',
      // The shell paints its own primary buttons with these two tokens. An
      // invented token name silently drops the declaration, leaving invisible
      // text on a filled button — which is exactly what shipped first.
      '.tv_primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
      '.tv_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.tv_check{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:13px;cursor:pointer}',
      '.tv_note{color:var(--dsw-alias-label-secondary);font-size:12px;margin:4px 0}',
      '.tv_err{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.tv_block{margin:8px 0}',
      '.tv_block p{margin:2px 0}',
      '.tv_bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.tv_barfill{height:100%;background:var(--dsw-alias-brand-primary)}',
      '.tv_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}',
      '.tv_stat{padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.tv_statval{font-size:18px;color:var(--dsw-alias-label-primary)}',
      '.tv_statlabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      // The audit table has seven columns and must not stretch the card.
      '.tv_tablewrap{max-width:100%;overflow-x:auto}',
      '.tv_table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}',
      '.tv_table th,.tv_table td{border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 8px;text-align:left;vertical-align:top}',
      '.tv_table th{color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap}',
      '.tv_table tr:last-child td{border-bottom:none}',
      '.tv_nowrap{white-space:nowrap}',
      '.tv_target{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tv_pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;white-space:nowrap}',
      '.tv_okpill{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.tv_errpill{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent);color:var(--dsw-alias-state-error-primary)}',
    ].join('\n')

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'tavily: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'tavily')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'tavily: styles')
      // The plugin manager renders this on the bundle's own detail page, between
      // its description and its rows. `key` must be the PACKAGE name: the owner
      // dispatches with `entryKey = pkg.name`, so the settings namespace
      // (`tavily`) would never match and the section would silently never show.
      // The owner passes only `view` and `entryKey` — no `form` — so the config
      // comes from `ctx.configForms`, keyed by the Loader row id (`tavily`).
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PKG_NAME,
        locale: NS,
      }, props => h(SettingsPage, { ...props, locale: localeTag(ctx), ctx })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = '@zx06/tavily'
    return module.exports
  },
})
