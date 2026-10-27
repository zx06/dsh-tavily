# @zx06/tavily

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/zx06/dsh-tavily)

DeepSeek Harness 的 Tavily 联网搜索插件。它同时提供两种接入方式：

1. **`ctx.web` 搜索 provider**（id `tavily`）——注册进 DSH 的 web 能力 seam，
   于是壳自带的 `web_search` 工具也能返回 Tavily 结果。
2. **五个独立工具**——不依赖 provider 选择，装上即可用。

外加一个配置界面（API Key、搜索选项、额度卡片、审计日志），就挂在插件详情页上。

## 安装

```bash
# npm 通道（推荐）
dsh plugin --profile web add @zx06/tavily

# GitHub 通道
dsh plugin --profile web add github:zx06/dsh-tavily
```

两个通道安装的都是同一份构建产物。装好后重启 profile，打开
**插件管理器 → @zx06/tavily 详情页** 填 API Key 即可（也可先用免密模式）。

## 功能

| 工具 | 说明 | 需要 Key |
| --- | --- | --- |
| `tavily_search` | 联网搜索（query/topic/depth/结果数/域名过滤/时间窗），返回标题、链接、摘要、评分与可选 AI answer | 否（免密可用） |
| `tavily_extract` | 按 URL 抽取正文 | 否（免密可用） |
| `tavily_crawl` | 从入口 URL 爬取相关页面 | 是 |
| `tavily_map` | 列出站点 URL 结构 | 是 |
| `tavily_research` | 深度研究任务，返回带引用的报告；异步，单工具双模式 | 是 |

**`tavily_research` 的两种模式**

- 传 `input`：创建任务并在工具内轮询到完成（受 `researchTimeoutMs` 限制）。
  若超时仍在运行，会返回 `requestId` 与提示，不会丢失任务。
- 传 `request_id`：只查询一次状态，用于继续轮询已有任务。

配置界面包含：API Key 表单（密文，保存时自动校验）、搜索选项（默认结果数/深度/超时/
是否允许免密）、额度卡片（Tavily `/usage`）、本月用量统计、审计日志表。

它注册在插件管理器的 **`plugins.bundle.config`** 槽位，因此只出现在
`@zx06/tavily` 自己的插件详情页上，不占用「设置」侧栏。插件管理器会渲染这个
bundle 的标题和描述，所以界面本身不再重复页头。

## 本地联调

```bash
pnpm install && pnpm build
```

然后用 `install_bundle` 安装本仓库根目录（本地路径通道）。

## 配置 API Key

优先级从高到低：

1. **插件管理器 → @zx06/tavily 详情页 → 填写 API Key**（推荐）。保存时会先用 Tavily
   `/usage` 校验有效性，通过后写入 DSH 凭据服务（`$DSH_HOME/.credentials.yaml`）。
2. 环境变量 `TAVILY_API_KEY`。注意：继承的环境变量**只读且遮蔽写入**——
   若它已设置，配置界面会拒绝保存并提示你取消该环境变量。
3. 插件 config 的字面量 `apiKey` 字段（`role('secret')`，不会出现在任何响应里）。

凭据引用名可通过 `apiKeyEnv` 改（默认 `TAVILY_API_KEY`）。

Key 申请地址：<https://app.tavily.com>。

## 免密模式

Tavily 允许无 Key 使用 `search` 与 `extract`（共享限速）。本插件默认开启
（`allowKeyless: true`）：

- 未配置 Key 时，`tavily_search` / `tavily_extract` 仍可用；
- `crawl` / `map` / `research` 会给出明确提示，而不是上游报错；
- 触发免密限速时会提示配置 Key 及建议等待秒数。

关闭 `allowKeyless` 后，未配置 Key 时所有工具直接报错。

## 接入 `ctx.web`

插件会注册一个 id 为 `tavily` 的搜索 provider。DSH 的 provider 选择规则是：

- 未配置 `web.searchProvider` 且只有一个可用 provider → 自动选中；
- 配置了 `web.searchProvider: tavily` → 选中 Tavily；
- 未配置 Key 且关闭免密时，`available()` 返回 `false`，**不会**参与选择——
  这样单 provider 部署不会因为 Tavily 未配置而变成 `WEB_PROVIDER_AMBIGUOUS`。

当前 profile 若把 `web.searchProvider` 钉为 `deepseek-official`，Tavily provider
不会被选中；此时直接用 `tavily_*` 工具即可。

## 审计

`~/.dsh/tavily/audit-YYYYMM.jsonl`，每行一次调用：时间、工具、目标、耗时、结果数、
状态/错误码、调用方、本次消耗的 credits。Key 永不写入（目标里形如 `tvly-...` 的字符串
也会被脱敏）。可在插件详情页查看，也可直接读文件。

## 与旧版 `@dsh-plugins/search-tavily` 的差异（破坏性变更）

- **包名/entry id 变更**：`search-tavily` → `tavily`。设置命名空间、`ctx.web`
  provider id 同步变更。
- **Key 存储变更**：不再读写 `~/.dsh/tavily.key`，也不再通过 `configEditor` 改写
  profile patch；统一走 DSH 凭据服务。旧的 key 文件会被忽略，请在插件详情页重新填写。
- **审计目录变更**：`~/.dsh/search-tavily/` → `~/.dsh/tavily/`。
- **新增**：`ctx.web` provider、`tavily_research`、免密模式、credits 记录、
  `map` 的审计归类修正（此前被误记为 `crawl`）。

## 开发

```bash
pnpm install     # 安装依赖（含私有的 @dsh-plugins/plugin-kit workspace 包）
pnpm build       # 先 tsc 构建 kit，再出类型声明，最后 esbuild 打包 dist/host.js
pnpm typecheck   # 类型检查
pnpm lint        # 语法检查（node --check）
pnpm test        # 单测（84 个：插件 68 + kit 16，全部离线，不打真网）
```

### 为什么 `dist/host.js` 是提交进仓库的

插件直接从 GitHub 安装（`github:zx06/dsh-tavily`）时，消费端不会跑构建，
所以入口文件必须在检出里就存在。

`scripts/bundle.mjs` 用 esbuild 把私有的 `@dsh-plugins/plugin-kit` 内联进
`dist/host.js`——它是 `devDependencies` 里的 workspace 包，消费端解析不到。
`@deepseek-ai/*`（宿主运行时）与 `@tavily/core`（真实 npm 包）保持 external：
前者必须绑定宿主自己的 cordis / 工具注册表实例，后者让消费端正常去重。
