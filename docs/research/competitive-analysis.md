# ProvenLoop 调研结论

> 本文记录 ProvenLoop 在产品定义之前和之后完成的技术、产品及竞品调研。  
> 产品完整方案见同目录的 `ProvenLoop-product-design.md`。

**调研快照：** 2026-08-20  
**首发环境：** Windows + `agency copilot` + GitHub Copilot CLI

## 1. 结论摘要

最初设想是做一个本地、无感、跨 Session 的 Coding Agent Memory：

```text
安装一次
  -> 用户照常使用 Copilot
  -> 自动观察 Session
  -> 沉淀个人习惯和工程经验
  -> 下次相关任务自动使用
  -> 越用越少重复解释，越少重犯错误
```

调研后需要修正定位。

以下能力已经有大量现成方案：

- 捕获 Coding Agent Session。
- 后台总结和压缩。
- MCP 检索注入。
- 短期、长期记忆分层。
- Git Commit 转换为工程记忆。
- Semantic、Episodic、Procedural Memory。
- 用户纠正、测试成功或失败等 Outcome Signal。
- 跨 Claude Code、Codex、Copilot 等 Agent 共享记忆。
- 将稳定规则同步到 `AGENTS.md`、`CLAUDE.md` 等文件。

因此 ProvenLoop 不应再定位为：

> Local-first coding-agent memory。

更准确的定位是：

> **ProvenLoop 是 Coding Agent 的软件成果反馈学习层。它把 Session、Commit、PR、Review、CI、测试和后续 Bug Fix 连接成工作轨迹，利用后续结果反向校正早期 Agent 决策。**

推荐技术策略：

```text
Build the differentiating layer
Integrate the commodity memory layer
```

即：

- 使用 Memorix 提供通用 Memory、MCP、Hooks、Git Memory、检索和生命周期。
- ProvenLoop 自研 Work Episode、Outcome Linker、跨时间因果复盘和效果评估。
- 不 Fork Memorix；通过其 npm SDK 和 MCP Server 嵌入能力组合扩展。
- 不要求额外 API Key；后台分析调用用户已经登录的 `agency copilot -p`。
- 用户启动方式保持 `agency copilot` 不变。

---

## 2. GitHub Copilot CLI 原生能力

### 2.1 Session 历史

Copilot CLI 会记录：

- 用户 Prompt。
- Assistant 回复。
- 工具调用和结果。
- 修改的文件。
- Token、模型和耗时。
- Checkpoint、Session 引用等结构化数据。

本地位置：

```text
~/.copilot/session-state/<session-id>/
~/.copilot/session-store.db
```

每个 Session 目录通常包含：

```text
events.jsonl
workspace.yaml
checkpoints/
files/
```

`events.jsonl` 是完整事件流，可能包含：

```text
user.message
assistant.message
tool.execution_start
tool.execution_complete
session.mode_changed
```

`session-store.db` 是 SQLite 索引，包含：

```text
sessions
turns
session_files
session_refs
assistant_usage_events
checkpoints
search_index
```

Session 数据与 Copilot Memory 是两个不同系统。

### 2.2 本机数据实测

2026-08-17 对当前机器的检查结果：

| 数据 | 数量 |
|---|---:|
| 数据库中的 Sessions | 90 |
| 本地 Session 目录 | 81 |
| 同时存在于数据库和目录 | 74 |
| 仅数据库中存在 | 16 |
| 仅目录中存在、尚未索引 | 7 |
| 对话 Turns | 524 |
| 文件操作记录 | 853 |
| 模型 Usage 记录 | 9,431 |
| Agent trajectory 事件 | 10,312 |

历史范围：

```text
最早：2026-03-19 05:24 UTC+8
最新：2026-08-17
```

文件规模：

```text
session-store.db：约 18 MiB
session-state：约 3.59 GiB
```

GitHub 文档没有声明 Session 历史的固定自动过期时间。通常保留到用户主动删除。Copilot Memory 的 28 天规则不适用于 Session 历史。

### 2.3 Chronicle

Copilot CLI 已提供：

```text
/chronicle search
/chronicle standup
/chronicle tips
/chronicle cost tips
/chronicle improve
/chronicle reindex
```

Chronicle 可以搜索历史、分析 Token 和生成建议，但它不是可编程的工程反馈学习系统。

### 2.4 超长 Session

Copilot 在 Context 接近约 95% 时自动 Compact，也支持：

```text
/compact
/context
/usage
```

ProvenLoop 不应整段重新读取或重新发送超长 Session，而应：

```text
增量读取 events.jsonl
  -> 按 Prompt 或任务切片
  -> 提取结构化信号
  -> 保存引用和摘要
  -> 只在需要时读取局部证据
```

### 2.5 Hooks

Copilot CLI 支持用户级 Hook：

```text
~/.copilot/hooks/*.json
```

重要事件：

```text
sessionStart
sessionEnd
userPromptSubmitted
userPromptTransformed
preToolUse
postToolUse
postToolUseFailure
agentStop
preCompact
errorOccurred
```

关键能力：

- `sessionStart` 可以注入 `additionalContext`。
- `postToolUse` 可以追加 Context 或修改工具结果。
- `sessionEnd` 可以触发后台处理。
- `userPromptSubmitted` 的配置文件 Hook 不能直接修改 Prompt。
- `userPromptTransformed` 可以修改模型看到的 Prompt，但不适合作为通用 Memory API。

Hook 必须保持快速。ProvenLoop 采用：

```text
sessionEnd Hook
  -> 写入持久队列
  -> 唤醒 Worker
  -> 立即返回
```

而不是在 Session 结束时同步等待复盘。

### 2.6 OpenTelemetry

Copilot CLI 原生支持 OpenTelemetry，默认关闭。

可以观测：

- Agent invocation。
- LLM calls。
- Tool calls。
- Token。
- 耗时和错误。
- 子 Agent Trace。

示例：

```powershell
$env:COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME\.copilot\copilot-otel.jsonl"
copilot
```

这适合 Observability，但不是 ProvenLoop 的核心数据模型。Session 事件、Git 和 GitHub 生命周期数据更适合做学习证据。

---

## 3. GitHub Copilot Memory

### 3.1 保存什么

Copilot Memory 保存两类条目：

#### Repository-level facts

- 编码约定。
- 架构决定。
- 构建和测试命令。
- 项目规则。

#### User-level preferences

- 交互风格。
- 个人编码习惯。
- 工作流偏好。

### 3.2 大致实现

公开信息表明其工作流类似：

```text
Copilot 交互
  -> 提取候选事实或偏好
  -> 按用户或仓库范围存储
  -> 新任务时检索相关条目
  -> 验证是否仍成立
  -> 注入当前 Agent Context
```

Repository fact：

- 保存支持该事实的代码引用。
- 使用前根据当前 Branch 重新验证。
- 只用于同一仓库。

User preference：

- 可以引用用户原话。
- 绑定当前用户和 billing entity。
- 可以跨仓库使用。

未使用的 Memory 经过 28 天会自动删除，成功验证和使用可能重置计时。

### 3.3 与 ProvenLoop 的区别

| 维度 | Copilot Memory | ProvenLoop |
|---|---|---|
| 主要内容 | 事实与偏好 | 工作过程、结果和经验教训 |
| 学习单位 | 单条 Memory | Work Episode |
| 工程数据 | 代码引用 | Session、Commit、PR、Review、CI、Bug Fix |
| 短期开发 Context | 不专门绑定 Branch | Branch Context |
| 后续 Bug 反向复盘 | 不是核心能力 | 核心差异 |
| 效果指标 | 未公开 | 纠正次数、重试、首次成功率 |
| 存储 | GitHub 托管 | 本地可审计 |
| Agent 范围 | GitHub Copilot | 通用 Core + 多 Agent Adapter |

如果 ProvenLoop 只保存偏好和仓库事实，会被 Copilot Memory 覆盖。

---

## 4. Session Viewer 与 Observability 工具

已经存在针对 Copilot CLI 的工具：

### TracePilot

<https://github.com/MattShelton04/TracePilot>

- Windows Tauri 桌面应用。
- Session、对话、工具调用、Todo、Checkpoint。
- Token、成本、Timeline、Waterfall。
- 搜索、分析和 Session Orchestration。

### gh-agent-viz

<https://github.com/maxbeizer/gh-agent-viz>

- GitHub CLI TUI。
- 本地与远程 Agent Session。
- Tool Timeline、Telemetry、Diff、Resume。

### copilot-session-tools

<https://github.com/Arithmomaniac/copilot-session-tools>

- Web UI 和 CLI。
- 读取 Chronicle。
- 扩展工具调用、Diff、Thinking Blocks。

### copilot-replay

<https://github.com/Lukasedv/copilot-replay>

- 回放 `events.jsonl`。
- 面向演示和逐事件浏览。

结论：

> 不应该再做普通 Session Viewer。查看“发生了什么”已经不是空白市场。

---

## 5. 第三方 LLM Memory 方案

### 5.1 Mem0

<https://github.com/mem0ai/mem0>

定位：

- 面向 AI 应用开发者的通用 Memory SDK/API。

能力：

- 从对话提取事实。
- User、Agent、Run 作用域。
- 向量、BM25、Entity 检索。
- 去重和长期偏好。

缺口：

- 不理解 Git、PR、Review、测试和后续 Bug。
- 没有 Work Episode。
- 不以工程结果改善为指标。

值得借鉴：

- Append-only evidence。
- Scope 模型。
- Hybrid retrieval。
- History 和 Audit。

### 5.2 Zep / Graphiti

<https://github.com/getzep/graphiti>

Graphiti 是时态 Knowledge Graph：

- Episode。
- Entity。
- Fact provenance。
- `valid_at`、`invalid_at`、`expired_at`。
- Semantic、BM25 和 Graph traversal。

与 ProvenLoop 最相关的是：

- 区分事件发生时间和系统观察时间。
- 原始 Evidence 不覆盖。
- 新证据可以使旧结论失效。
- Saga 可以作为 Work Episode 的参考。

不适合 MVP 作为默认依赖：

- 需要图数据库。
- 部署和维护过重。
- Coding 生命周期仍需 ProvenLoop 自己建模。

### 5.3 Letta / MemGPT

<https://github.com/letta-ai/letta-code>

能力：

- Core Memory 和 Archival Memory。
- Stateful Agent。
- Agent 主动改写记忆。
- Git-backed Memory Filesystem。
- 后台 Dreaming。

区别：

- Letta 是完整 Agent Runtime。
- ProvenLoop 是附着于现有 Coding Agent 的学习层。

值得借鉴：

- Memory 修改带原因和版本记录。
- Working 与 Archival Memory 分层。
- 后台 Reflection。

### 5.4 LangMem / LangGraph Memory

<https://github.com/langchain-ai/langmem>

明确区分：

```text
Semantic Memory
Episodic Memory
Procedural Memory
```

支持：

- Agent 当场写入。
- Background Manager。
- Trajectory + Feedback 驱动 Prompt 优化。

缺口：

- 没有 Session、Git、PR Collector。
- 没有 Coding Work Episode。
- 只是开发框架，不是开箱即用产品。

### 5.5 Cognee

<https://github.com/topoteretes/cognee>

能力：

- Graph + Vector Memory。
- Coding Agent Plugin。
- Prompt 前 Recall。
- Tool Trace Capture。
- Session End 后同步到长期 Memory。

与 ProvenLoop 的 Hooks、Worker、逐 Prompt 检索形态高度重合。

缺口：

- 没有明确的软件生命周期因果复盘。
- 不以 Markdown 为长期事实来源。
- 重点仍是 Recall，而不是结果学习。

### 5.6 Supermemory

<https://github.com/supermemoryai/supermemory>

能力：

- 用户 Profile。
- Temporal Fact。
- Contradiction 和 Expiry。
- Agent Plugin 和 MCP。

缺口：

- 公共仓库不能完整验证核心引擎。
- 没有 PR、Review、CI、Bug Fix 的工程因果链。

### 5.7 Claude-Mem

<https://github.com/thedotmack/claude-mem>

这是运行形式最接近 ProvenLoop 的方案：

- Lifecycle Hooks。
- 后台 Worker。
- SQLite。
- Chroma Semantic Search。
- Session Summary。
- MCP Progressive Disclosure。

它主要回答：

> 以前做过什么？

ProvenLoop 应回答：

> 为什么以前那次实现会遗漏这个问题？后续什么证据证明了它？以后怎样避免？

### 5.8 Basic Memory

<https://github.com/basicmachines-co/basic-memory>

采用：

- Markdown 是 Source of Truth。
- SQLite 是可重建索引。
- MCP 读写。
- 人和 AI 可以编辑同一份知识。

这证明 ProvenLoop 的 Markdown + SQLite 设计合理，但该设计本身不是差异化。

---

## 6. Memorix 深入评估

项目：

<https://github.com/AVIDS2/memorix>

调研时状态：

```text
版本：1.7.2
License：Apache-2.0
Stars：约 665
Forks：约 53
主要语言：TypeScript
Node：>= 22.18
```

项目非常活跃，但主要提交集中在一名维护者。当前公开发布说明称约有 2,900 个测试，并覆盖 Windows、macOS、Ubuntu 和大型数据集验证。

### 6.1 Agent 集成

Memorix 已支持：

- GitHub Copilot CLI。
- Claude Code。
- Codex。
- Cursor。
- Windsurf。
- Gemini CLI。
- OpenCode。
- Kiro。
- 其他 Coding Agent。

Copilot Plugin 包含：

```text
MCP
Skills
Hooks
```

Copilot Hook 已监听：

```text
sessionStart
sessionEnd
userPromptSubmitted
postToolUse
preCompact
```

安装方式：

```text
memorix setup --agent copilot --global
```

### 6.2 Memory Layers

#### Observation Memory

支持：

```text
session-request
gotcha
problem-solution
how-it-works
what-changed
discovery
why-it-exists
decision
trade-off
reasoning
```

#### Reasoning Memory

保存：

- 为什么做出选择。
- 替代方案。
- 约束。
- 风险和 Trade-off。

#### Git Memory

Commit 会转换成：

- Commit Hash。
- Changed Files。
- Title 和 Narrative。
- 推断的 Observation Type。
- Concepts 和 Entities。

支持 Git Hook 和历史回填。

#### Long-term Memory

类型：

```text
episodic
semantic
procedural
```

生命周期：

```text
candidate
  -> qualified
  -> approved
  -> archived / superseded
```

### 6.3 存储与检索

- SQLite 是规范存储。
- Orama 负责全文和混合检索。
- Embedding 可关闭、使用 API 或本地 Provider。
- 支持 Token Budget。
- 支持 Progressive Disclosure。
- 支持 Source-aware Ranking。
- 支持项目身份和可见性边界。

### 6.4 Memory Formation

Formation Pipeline：

```text
Extract
  -> Resolve
  -> Evaluate
```

功能：

- 提取原子事实。
- 规范化标题。
- Entity Resolution。
- 类型纠正。
- Merge、Evolve、Discard。
- 长期价值评分。
- Core、Contextual、Ephemeral 分类。

### 6.5 Evidence Governor

Memorix 已有较成熟的 Memory Quality 设计：

```text
scope
  -> provenance
  -> freshness
  -> conflict
  -> quality
  -> token budget
```

可以：

- 没有合格 Memory 时主动 Abstain。
- 代码变化后降级旧 Memory。
- 保留原始 Evidence。
- 避免模型静默覆盖事实。
- 解释 Memory 被包含或排除的原因。

### 6.6 Outcome Signal

已经定义：

```text
verification-passed
verification-failed
verified-reuse
user-pin
user-correction
source-changed
conflict-confirmed
manual-review
```

失败、纠正、源码变化会将 Memory 降级。

这说明“Outcome 影响 Memory Quality”本身已不是 ProvenLoop 的独特创新。

### 6.7 Rules 与 Skills

Memorix 可以：

- 将知识提升为 Mini Skill。
- 同步到多个 Agent 的规则文件。
- 维护 MCP、Hook、Skill 和 Instruction 集成。

因此 ProvenLoop 不应花大量时间重新实现规则格式转换。

### 6.8 SDK

公开 SDK：

```typescript
import {
  createMemoryClient,
  createMemorixServer,
} from "memorix/sdk";
```

`MemoryClient` 支持：

```text
store
search
get
getAll
count
resolve
close
```

`createMemorixServer` 可以注册到已有 MCP Server，为组合扩展提供基础。

### 6.9 无 API Key 行为

Memorix 不要求 API Key 才能工作。

无 API Key 时仍可使用：

- SQLite 存储。
- BM25 全文检索。
- Hooks。
- MCP。
- Git Memory。
- 本地规则过滤和去重。
- Memory Lifecycle。

关闭 Embedding：

```toml
[embedding]
provider = "off"
```

没有 `MEMORIX_LLM_API_KEY` 时：

- LLM Formation 不可用。
- LLM Summarization 不可用。
- 智能 Dedup 和 Rerank 不可用。
- 系统降级为本地 Heuristic 模式。

这对 ProvenLoop 是可接受的，因为 ProvenLoop 可以使用用户已登录的 Copilot 完成后台推理。

### 6.10 Memorix 尚未覆盖的差异

调研未发现 Memorix 完整实现：

```text
Session
  -> Branch
  -> Commit
  -> PR
  -> Review
  -> CI / Test
  -> Merge
  -> 后续 Issue / Bug Fix / Revert
```

也未发现产品级自动完成：

> 后续这个 Bug Fix 应归因于几周前哪个 Agent PR 漏掉了什么检查？

Memorix 有 Outcome Signal，但主要是单条 Memory 或 Workflow 的质量反馈，不是完整软件生命周期因果分析。

---

## 7. 为什么不 Fork Memorix

不 Fork 不等于不能扩展。

推荐使用组合架构：

```text
ProvenLoop Copilot Plugin
├─ ProvenLoop Hooks
├─ ProvenLoop MCP Tools
├─ Work Episode Builder
├─ Outcome Linker
├─ Retrospective Analyzer
└─ memorix npm dependency
   ├─ Storage
   ├─ Search
   ├─ Git Memory
   ├─ Lifecycle
   └─ Generic MCP Tools
```

示意代码：

```typescript
import {
  createMemoryClient,
  createMemorixServer,
} from "memorix/sdk";

const server = new McpServer(...);

// 注册 Memorix 通用工具。
await createMemorixServer(projectRoot, server);

// 注册 ProvenLoop 差异化工具。
registerEpisodeTools(server);
registerOutcomeTools(server);
registerRetrospectiveTools(server);
```

ProvenLoop 保存自己的领域模型：

```text
LifecycleEvent
WorkEpisode
EpisodeLink
OutcomeEvidence
Retrospective
BehaviorMetric
```

最终稳定结论写入 Memorix：

```typescript
await memory.store({
  entityName: "auth-rate-limiter",
  type: "problem-solution",
  title: "IPv6 handling was missing",
  narrative: "...",
  relatedCommits: ["abc", "def"],
  topicKey: "retrospective:auth-rate-limiter",
});
```

只有以下情况下才需要 Fork：

- ProvenLoop 必须修改 Memorix 内部 Schema。
- 需要的 API 无法通过 SDK 或 CLI 实现。
- 上游不接受必要的 Extension API。
- 运行性能要求必须侵入核心执行路径。

优先顺序：

```text
Public SDK
  -> 独立 ProvenLoop Store
  -> 向 Memorix 提交上游 PR
  -> 最后才 Fork
```

---

## 8. 无额外 API Key 的后台推理

用户已经通过 Agency 使用 GitHub Copilot：

```powershell
agency copilot
```

Agency 支持把 Prompt 和参数传给底层 Copilot CLI：

```powershell
agency copilot -p "..."
```

因此 ProvenLoop 后台 Worker 可以调用：

```powershell
$env:PROVENLOOP_INTERNAL = "1"
agency copilot -p "分析这些 Session、Commit、PR、Review 和测试证据，生成结构化复盘"
```

特点：

- 不需要 OpenAI、Anthropic 或 Memorix API Key。
- 复用用户现有 GitHub Copilot 登录和订阅。
- 使用用户已有的 Agency Copilot 模型能力。
- 后台分析是独立 Copilot Session。
- 用户当前前台 Session 不需要等待。

`PROVENLOOP_INTERNAL=1` 用于让 Hook 跳过内部分析 Session，避免递归：

```text
分析 Session
  -> Hook 又触发分析
  -> 无限循环
```

后台 Worker 仍应：

- 使用持久队列。
- 保证同时只有一个 Worker。
- 任务完成后退出。
- 机器重启后继续处理积压。
- 无价值 Session 不调用 AI。

---

## 9. `agency copilot` 启动兼容性

当前用户启动方式：

```powershell
agency copilot
```

Agency 的 `copilot` 命令会运行底层 GitHub Copilot CLI，并支持：

- Copilot Plugin。
- `~/.copilot` 配置。
- MCP。
- Agent。
- Copilot 原生参数转发。

ProvenLoop 全局 Plugin 安装位置：

```text
~/.copilot/plugins/local/provenloop/
```

安装后用户仍然运行：

```powershell
agency copilot
```

不需要：

```text
provenloop copilot
memorix copilot
特殊 Wrapper
```

正常调用会自动加载 Plugin。

注意：

- `agency copilot --profile-only ...` 会忽略未在 Profile 中声明的环境配置和 Plugin。
- `--no-config-plugins` 会关闭 Agency 配置中的自动 Plugin。
- 如果用户采用这些特殊参数，需要在 Profile 中显式声明 ProvenLoop。

普通 `agency copilot` 不受影响。

---

## 10. 最新推荐架构

```text
                    agency copilot
                           |
                           v
                GitHub Copilot CLI
                           |
            +--------------+--------------+
            |                             |
            v                             v
      ProvenLoop Hooks               ProvenLoop MCP
            |                             |
            v                             v
    Persistent Event Queue       Per-Prompt Context Query
            |                             |
            v                             |
   On-demand Shared Worker                |
            |                             |
    +-------+------------------+          |
    |                          |          |
    v                          v          |
Lifecycle Collectors    Retrospective AI  |
Session / Git / GitHub   agency copilot -p|
    |                          |          |
    +------------+-------------+----------+
                 |
                 v
        ProvenLoop Domain Store
      Work Episode / Outcomes / Metrics
                 |
                 v
             Memorix SDK
      Generic Memory / Search / Lifecycle
```

### Memorix 负责

- 项目身份。
- 通用 Observation。
- Reasoning 和 Git Memory。
- SQLite 存储。
- BM25 和可选 Semantic Search。
- Memory Lifecycle。
- Evidence Qualification。
- 通用 MCP 工具。
- Rule 和 Skill 同步。
- 多 Agent 集成基础。

### ProvenLoop 负责

- Copilot Session 与 GitHub 生命周期 Collector。
- Branch、Commit、PR、Review、CI、Issue、Fix 关系。
- Work Episode Builder。
- Outcome Linker。
- 跨时间因果复盘。
- 纠正和重试指标。
- Branch Context。
- 新任务的 Episode-aware Retrieval。

---

## 11. 修订后的 MVP

### P0：真正差异化

1. **统一生命周期事件模型**

```text
session
prompt
tool
branch
commit
pull-request
review
test
ci
issue
fix
revert
correction
```

2. **Work Episode Builder**

关联依据：

- Repo ID。
- Branch。
- Commit ancestry。
- PR 和 Issue 引用。
- 修改文件重合。
- 时间。
- Prompt 语义。
- 测试名称和错误。

3. **Outcome Linker**

检测：

- 后续测试失败。
- Review Correction。
- Revert。
- Fix Commit。
- 用户纠正。

并找到可能需要重新评估的旧 Episode。

4. **Retrospective Analyzer**

结构化输出：

```text
earlier assumption
missing check or invariant
later evidence
generalized lesson
applicability
counterevidence
confidence
```

5. **Behavior Metrics**

主指标：

```text
相似任务中用户纠正次数下降
```

辅助指标：

- 工具和测试重试。
- 重复输入 Context。
- 首次通过 CI 或 Review。
- 错误 Memory 导致失败的频率。

### P1：必要体验

- Copilot Plugin 一键安装。
- 非阻塞 Hook 和持久队列。
- Branch Context。
- 每 Prompt MCP 检索。
- Explain 和 Forget。

### 不应重点自研

- 通用 Memory CRUD。
- 通用向量数据库。
- 通用 Embedding Provider。
- 通用 Rules 转换。
- 普通 Session Viewer。
- 普通 Dashboard。
- 通用 Agent Orchestration。

---

## 12. Build vs Integrate 决策

### 集成 Memorix

使用：

- npm package。
- `memorix/sdk`。
- `createMemoryClient`。
- `createMemorixServer`。
- Memorix Observation 和 Git Memory。

### ProvenLoop 独立实现

自建：

- Lifecycle Store。
- Work Episode Store。
- Outcome Evidence。
- Retrospective Card。
- Effect Evaluation。

### 不立即采用

- Graphiti 作为默认后端：过重。
- Mem0 作为 Canonical Store：模型不适合工程 Evidence。
- 自建通用向量搜索：没有差异。
- 深度 Fork Memorix：维护成本和上游漂移风险高。

---

## 13. 主要风险

### Memorix 演进过快

风险：

- SDK 尚不覆盖全部内部能力。
- 主要维护者集中。
- Schema 和 API 可能快速变化。

缓解：

- 只依赖公开 `memorix/sdk`。
- 固定兼容版本。
- ProvenLoop 领域数据独立保存。
- 增加 Adapter 层。
- 必要能力优先上游贡献。

### Memorix 的 SQLite 是 Canonical Store

这与最初“Markdown 是全部事实来源”的设计不同。

推荐调整：

- Memorix 保存通用 Observation 和检索记录。
- ProvenLoop 的最终 Retrospective Card 可以继续保存 Markdown。
- ProvenLoop 将 Markdown 结论索引到 Memorix。
- 不要求 Memorix 所有内部数据都转换成 Markdown。

### 后台 Copilot 调用递归

缓解：

- `PROVENLOOP_INTERNAL=1`。
- Hook 检测并跳过。
- 内部 Session 标记来源。

### 自动因果归因错误

缓解：

- 多信号关联。
- 每条结论必须引用具体 Evidence。
- 低置信结论不自动注入。
- 新冲突立即暂停旧结论。

### Plugin 没有加载

缓解：

- `provenloop doctor`。
- 检查 `agency copilot` Profile。
- 检查 Plugin、MCP 和 Hook 状态。
- 安装后启动新 Session 验证。

---

## 14. 最终判断

### 可以基于 Memorix 扩展

而且比自建全部基础设施更合理。

但 ProvenLoop 不能只是：

```text
Memorix + Copilot Adapter
```

因为 Memorix 已经有 Copilot Adapter。

ProvenLoop 必须集中在：

```text
完整软件生命周期事件
  -> Work Episode
  -> 后续 Outcome
  -> 反向因果复盘
  -> 可验证的工程经验
  -> 下一次减少纠正
```

### 推荐产品关系

```text
Memorix
  = 通用 Coding Agent Memory Platform

ProvenLoop
  = Outcome-aware Engineering Learning Engine
```

### 推荐用户体验

概念安装：

```powershell
provenloop install
```

安装器内部完成：

- 安装 ProvenLoop Copilot Plugin。
- 安装或打包 Memorix Dependency。
- 注册 Hook。
- 注册 MCP。
- 建立 Worker。
- 扫描最近 30 天历史建立长期基线。

用户之后始终使用：

```powershell
agency copilot
```

不需要额外 API Key，不需要改变启动方式，也不需要手动触发学习。

---

## 15. 主要参考资料

### GitHub Copilot

- <https://docs.github.com/en/copilot/concepts/agents/copilot-memory>
- <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle>
- <https://docs.github.com/en/copilot/reference/hooks-reference>

### Memorix

- <https://github.com/AVIDS2/memorix>
- <https://github.com/AVIDS2/memorix/blob/main/docs/ARCHITECTURE.md>
- <https://github.com/AVIDS2/memorix/blob/main/docs/GIT_MEMORY.md>
- <https://github.com/AVIDS2/memorix/blob/main/docs/MEMORY_FORMATION_PIPELINE.md>
- <https://github.com/AVIDS2/memorix/blob/main/docs/1.4.2-EVIDENCE-GOVERNED-MEMORY-SPEC.md>
- <https://github.com/AVIDS2/memorix/blob/main/src/sdk.ts>
- <https://github.com/AVIDS2/memorix/blob/main/src/knowledge/outcome-types.ts>

### 其他 Memory

- <https://github.com/mem0ai/mem0>
- <https://github.com/getzep/graphiti>
- <https://github.com/letta-ai/letta-code>
- <https://github.com/langchain-ai/langmem>
- <https://github.com/topoteretes/cognee>
- <https://github.com/supermemoryai/supermemory>
- <https://github.com/thedotmack/claude-mem>
- <https://github.com/basicmachines-co/basic-memory>

### Copilot Session 工具

- <https://github.com/MattShelton04/TracePilot>
- <https://github.com/maxbeizer/gh-agent-viz>
- <https://github.com/Arithmomaniac/copilot-session-tools>
- <https://github.com/Lukasedv/copilot-replay>
