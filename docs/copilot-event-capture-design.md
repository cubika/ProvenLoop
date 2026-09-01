# Copilot 异步事件采集方案

**状态：** Proposed，等待 F0-001 实测通过
**更新：** 2026-08-29

## 1. 要解决的问题

ProvenLoop 需要捕获 Copilot CLI 的用户消息、工具执行、Agent 完成和错误，
但不能拖慢前台交互。

现有 lifecycle Hook 不适合承担这项工作。Copilot CLI `1.0.82-0` 的实测结果是：

- PowerShell command Hook 的 P95 约为 700 到 800 ms；
- localhost HTTP 本身的 P95 约为 2 ms；
- Copilot 将事件送到 HTTP Hook 的耗时约为 450 到 1260 ms。

把 Hook 内部处理改成异步，只能缩短 handler 自己的工作时间，无法消除
Copilot 在调用 handler 之前产生的延迟。

## 2. 方案结论

主采集入口改为 Copilot CLI Extension 的 Session 事件流。Extension 通过
`session.on(...)` 接收 JSON-RPC notification，在独立 Node 进程中完成轻量
复制和异步入队。

```text
Copilot CLI Session
        |
        | session events
        v
ProvenLoop Extension
        |
        | bounded memory buffer
        v
Async queue writer
        |
        | atomic file replacement
        v
Persistent event queue
        |
        v
Shared host and worker
```

正常采集路径不安装 command 或 HTTP lifecycle Hook。Hooks 以后只用于确实
需要同步改变 Copilot 行为的策略，不用于遥测。

OpenTelemetry 和 Copilot Session 文件只负责对账和恢复，不能成为默认的
内容采集入口。

### 2.1 为什么不用其他入口

`notification` Hook 是 fire-and-forget，但只覆盖后台 shell、后台 Agent、
权限提示和 elicitation 等通知。它没有用户消息、普通前台工具、主 Agent
完成和 Session 生命周期，不能组成主事件流。

SDK programmatic Hook 仍是 request/response 调用，Copilot 会等待 callback
结果。它适合改变权限或工具行为，不适合遥测。

持续 tail `events.jsonl` 不会增加前台延迟，但文件路径和 schema 不是稳定
外部协议。它适合受版本约束的恢复，不适合成为实时主入口。

开启完整内容的 OTel 会扩大采集范围，包含 Prompt、回复、工具参数和系统
指令。默认启用不符合最小化原则。

## 3. 设计目标

这套方案必须满足：

- paired A/B 前台新增延迟 P95 不高于 10 ms；
- Extension、Worker 或存储故障不阻塞 Copilot；
- 支持的事件识别准确率不低于 95%；
- 原始内容写入磁盘前完成脱敏；
- 重复投递不产生重复事实；
- Extension 中断后可以发现缺口并恢复已落盘事件；
- 内部 ProvenLoop Session 不进入学习队列；
- 未验证的 Copilot 版本显式停用采集，不猜测兼容性。

## 4. 明确不做什么

F0 和 M0 不做以下工作：

- 不实现一套通用消息总线；
- 不追求跨机器 exactly-once；
- 不实时解析 Copilot 的内部 SQLite；
- 不默认开启包含完整 Prompt 和工具结果的 OTel；
- 不为采集单独启动多个常驻服务；
- 不在 Extension callback 中调用模型、GitHub 或其他外部网络服务。

M0 只需要一个 Extension 进程、已有的原子文件队列和一个共享 Host。

## 5. 组件职责

### 5.1 Copilot Extension

Extension 由 ProvenLoop 插件提供，并加入当前 Copilot Session。它负责：

- 订阅所需 Session 事件；
- 读取 Session ID、事件 ID、时间戳和父事件关系；
- 识别 ProvenLoop 内部 Session；
- 复制允许进入缓冲区的字段；
- 将事件交给异步 writer；
- 维护接收、丢弃、积压和缺口计数。

callback 禁止执行同步文件 I/O、网络请求、Git 查询、数据库操作和内容分析。
它只做有界的内存工作。

Repository、Branch 和 HEAD 使用异步维护的 workspace snapshot。Extension 在
Session 启动时建立快照，并在可能改变 Git 状态的工具完成后刷新。callback
只附加当前快照，不现场执行 Git 命令。快照不可用时写入 `unknown`，不能用
稍后观察到的状态回填。

### 5.2 内存缓冲区

每个 Extension 进程维护一个有界 FIFO 缓冲区，同时限制事件数量和总字节数。
具体上限由 F0 压测确定，不在设计阶段猜一个大数。

缓冲区满时不能静默丢弃：

1. 停止接收新的大字段，只保留事件元数据和内容摘要；
2. 累计缺失范围和事件数量；
3. writer 恢复后写入一条 `capture_gap`；
4. Reconciler 根据缺口范围尝试补齐。

这不是正常流控方式。任何 `capture_gap` 都会进入健康状态和 M0 Gate。

### 5.3 异步 queue writer

writer 在 Extension 进程内运行，但不占用 callback 调用栈。它负责：

- 对内容执行第一遍 secret redaction；
- 生成稳定事件 ID 和 deduplication key；
- 把事件序列化为版本化 envelope；
- 写入同目录临时文件；
- flush 写句柄；
- rename 为最终队列文件；
- 更新本进程的持久化水位。

每条事件使用独立文件和唯一名称。多个 Copilot Session 可以并发写队列，
不需要共享文件锁。

writer 不等待 Worker，也不直接写 canonical SQLite。Worker 停止时，队列继续
积压。

### 5.4 Shared Host 和 Worker

现有 Host 继续承担：

- 领取和确认队列项；
- schema validation；
- 第二遍脱敏；
- 适配器版本检查；
- canonical SQLite 事务；
- dead letter、retry 和显式错误；
- Work Episode 等后续消费者。

Extension 只负责安全交付原始事件，不包含领域逻辑。

### 5.5 Reconciler

Reconciler 是恢复组件，不持续 tail Copilot 文件。它在以下时间运行：

- Host 启动；
- Extension 报告 `capture_gap`；
- Session 正常关闭后；
- 用户执行 `provenloop doctor --repair-capture`。

Host 启动和 `doctor` 不能只依赖 `capture_gap`。Extension 可能在 gap
落盘前崩溃。Reconciler 会枚举最近修改过的受支持 Session，将其 source event
ID 与 pending queue 和 canonical capture watermark 对比，再扫描缺失范围。
已有 gap 时可以缩小扫描范围。

它按受支持的 Copilot 版本读取 `events.jsonl`。内部文件格式没有稳定兼容承诺，
因此每个解析器必须声明适用版本，未知格式进入显式错误。

Reconciler 不直接读取 Copilot 的内部 SQLite，避免锁冲突和内部 schema
耦合。

### 5.6 OpenTelemetry

OTel 是可选的元数据对账通道。默认只允许：

- Session 或 conversation ID；
- Agent 和工具 span；
- tool call ID、名称、耗时和错误类型；
- 模型调用耗时和 token 统计。

默认不开启 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`。该选项会
采集完整 Prompt、回复、工具参数、结果和系统指令，范围过大，不符合默认
最小化原则。

M0 不默认启用 OTel。它只作为诊断或 Extension 不可用时的候选 fallback，
并且必须先通过独立的性能和隐私测试。

ProvenLoop 不会静默修改 Copilot 自己的 `remoteExport` 设置。用户要求严格
本地模式时，`doctor` 检查该设置并给出明确提示，修改仍需用户确认。

## 6. 事件映射

| Copilot Session event | Canonical event | 必需字段 | 备注 |
|---|---|---|---|
| Extension 加入 Session | `session.started` | session、cwd、adapter version | 不是学习结果 |
| `user.message` | `prompt.submitted` 或 `user.corrected` | event ID、session、timestamp、content | 完整显式纠正标记映射为 `user.corrected`；否则为普通 Prompt |
| `tool.execution_start` | `tool.started` | call ID、tool name、arguments | 表示调用，不表示完成 |
| `tool.execution_complete` | `tool.completed` 或 `tool.failed` | call ID、success、result 或 error | 与 start 分开保存 |
| `assistant.message` | `agent.message` | message ID、content、parent | 保存有界回复内容 |
| `assistant.turn_end` | `agent.turn_completed` | turn ID | 只表示 turn 结束 |
| `session.idle` | `session.idle` | session、timestamp | ephemeral，不作为恢复依据 |
| `session.error` | `session.error` | safe error、error type | 原始堆栈先脱敏 |
| `session.shutdown` | `session.ended` | session、reason、timestamp | best effort，不作为唯一关闭信号 |
| `subagent.started` | `subagent.started` | parent、agent identity | M0 可采集但暂不消费 |
| `subagent.completed` 或 `subagent.failed` | 对应 subagent 事件 | parent、status、error | 保留过程证据 |

Adapter 必须保留 Copilot source event ID。Deduplication key 优先使用：

```text
adapter + adapterVersion + sessionId + eventType + sourceEventId
```

如果必需事件没有 source event ID，Adapter 将其标记为 malformed 或
incompatible。不能合成另一个 ID 后假装能够跨 Extension 和 Reconciler 去重。

## 7. 正常路径

一次工具调用的处理顺序是：

```text
tool.execution_start
  -> Extension callback 复制字段
  -> callback 返回
  -> writer 脱敏并原子入队
  -> Worker 写入 canonical SQLite

tool.execution_complete
  -> 独立 canonical event
  -> 通过 call ID 与 start 关联
```

工具开始和完成不能合并成一条记录。Copilot、Extension 或工具进程可能在两者
之间退出，缺少 completion 本身就是证据。

## 8. 内部 Session 隔离

ProvenLoop 的后台推理在启动 Copilot 前生成明确 Session ID，并登记到本地
`internal_sessions` 注册表。Extension 以 Session ID 判断是否跳过。

`PROVENLOOP_INTERNAL=1` 仍然保留，作为启动提示和诊断信息，但不作为唯一判断
依据。环境变量是否传入 Extension 必须由 F0 实测。

内部 Session 可以记录最小运行指标，但不能保存 Prompt、工具参数、工具结果，
也不能进入 Work Episode 或 Knowledge 流程。

## 9. 内容最小化和脱敏

进入持久队列前，事件字段分成三类。

始终保留：

- 事件、Session、工具和 call ID；
- 时间戳、顺序、状态和错误类型；
- Repository、Branch、HEAD 和 worktree identity；
- adapter 和 schema version；
- 内容摘要和截断信息。

按限额保留并先脱敏：

- 用户消息；
- 工具参数；
- 工具结果；
- safe error；
- Agent 最终回复。

默认不保留：

- 环境变量值；
- Copilot、GitHub 或 MCP 凭据；
- 完整系统 Prompt；
- MCP server secret 配置；
- 二进制附件；
- 超过限额的完整文件内容。

第二遍脱敏在 Worker 写 canonical SQLite 前执行。两个边界使用同一组规则版本，
但各自记录 redaction result 和规则版本。

## 10. 交付语义

采集采用 at-least-once 加幂等消费：

- Extension 可能重发尚未确认的事件；
- Queue 文件名不能作为 canonical identity；
- Worker 以 deduplication key 建唯一约束；
- 重复项保留接收计数，但只生成一个 canonical fact；
- malformed 和 unknown-version 事件进入 dead letter，不能伪装成成功。

不追求分布式 exactly-once。ProvenLoop 是单机产品，幂等入库和可对账恢复已经
覆盖主要风险。

## 11. 启动和关闭

### 安装

`provenloop install` 完成：

1. 从 marketplace 安装插件；
2. 静态检查插件清单、CLI 版本和 bundled SDK protocol；
3. 在第一个真实 Session 中完成 Extension runtime probe；
4. 创建数据目录和权限；
5. 注册 MCP 和 Extension；
6. 不修改用户现有登录凭据。

如果 Copilot 需要全局 experimental setting 才能运行 Extension，安装器必须
明确说明并获得确认。不能要求用户以后通过包装命令启动 Copilot。安装器只在
原值为 `false` 或缺失时记录自己改变过该设置，disable 或 uninstall 时据此
恢复；不能覆盖用户原本开启的设置。

F0 必须证明这个 opt-in 可以持久化、只影响所需功能，并能在 disable 或
uninstall 时回滚。做不到这一点，Extension 路线直接 No-Go。

### Session 启动

Extension 加入 Session 后：

- 校验 CLI 和 SDK protocol；
- 建立 Session capture state；
- 加载内部 Session 注册表；
- 启动 writer；
- 订阅事件。

任何一步失败都将 capture state 设为 `paused` 或 `incompatible`，但不会退出
Copilot。

### Session 关闭

`session.shutdown` 可能在 Extension 被终止前不可见。Extension 同时处理
`SIGTERM`，并在 CLI 提供的退出宽限期内尝试清空缓冲区。无论哪条信号先到，
drain 都有短 deadline。未完成的部分由 Reconciler 补账。

关闭路径不能无限等待磁盘、Worker 或模型。

## 12. 故障行为

| 故障 | ProvenLoop 行为 | Copilot 行为 |
|---|---|---|
| Extension 无法启动 | capture state 为 `paused`，记录原因 | 正常启动 |
| Extension API 不兼容 | capability 为 `incompatible` | 正常启动 |
| writer 暂时失败 | 有界重试，保留内存事件 | 不等待 |
| 缓冲区满 | 写 `capture_gap`，停止复制大字段 | 不等待 |
| 磁盘满或无权限 | 停止持久化并报告明确错误 | 不等待 |
| Worker 停止 | 队列积压 | 不受影响 |
| malformed event | dead letter | 不受影响 |
| OTel 不可用 | 关闭 OTel 对账 | Extension 继续 |
| Session 文件格式未知 | Reconciler 跳过并报告版本错误 | 不受影响 |
| Extension 进程崩溃 | 下次启动或关闭时对账 | 当前 Session 继续 |

所有失败都必须有明确状态。禁止返回空成功、伪造 completion 或静默丢弃。

## 13. 版本和 capability gate

版本号只负责快速筛选，最终判断依赖 capability probe。

每个受支持的 Copilot CLI 版本记录：

- CLI version；
- bundled SDK protocol；
- Extension host 可用性；
- 已观察事件类型；
- required field compatibility；
- Session 文件 parser version；
- OTel attribute mapping version；
- 最近一次 probe 结果。

启动时缺少必需事件或字段，采集进入 `incompatible`。新增未知事件可以作为
unknown envelope 保存，不能自动映射为已知领域事件。

首个候选版本仍是 Copilot CLI `1.0.82-0`。Extension spike 通过前，这个版本
只表示 Hook、MCP 和本地运行时已验证，不表示异步采集已支持。

## 14. 实施顺序

### A. Extension latency spike

- 创建最小插件 Extension；
- 订阅用户消息、工具开始和完成、turn end、error、shutdown；
- 只统计事件，不落盘内容；
- 对比 Extension 开启和关闭的前台耗时；
- 注入 callback 变慢、异常和进程退出。

该阶段只回答 Extension 是否适合主采集，不建立领域模型。

### B. Batch 1 capture contracts

- 冻结 versioned envelope 和 event identity；
- 定义 `CaptureAdapter`、capability matrix 和错误类型；
- 固定 Extension 与 Worker 的版本边界；
- 添加事件 fixture 和 unknown-version 路径。

完成 A 且 F0-001 解除后，Batch 1 可以继续。

### C. Batch 3 durable capture

- 增加 versioned envelope；
- 增加有界 buffer 和异步 writer；
- 接入第一遍 redaction；
- 实现原子队列文件；
- 实现 deduplication key 和 `capture_gap`；
- 运行 Worker 停止、磁盘错误和崩溃恢复测试。

### D. Recovery and compatibility

- 增加 Session 文件 Reconciler；
- 增加 capability matrix；
- 评估 metadata-only OTel；
- 增加 `doctor` 状态和修复命令；
- 冻结第一个受支持的 Extension 版本范围。

## 15. 验收和 Go/No-Go

Extension 方案满足以下条件才解除 F0-001：

- Windows 10 和 11 各采集至少 500 个代表性事件；
- Prompt、工具成功、工具失败、取消、resume、shutdown 和 subagent 均有样本；
- paired A/B 测试中，前台新增延迟 P95 不高于 10 ms；
- callback work duration P95 不高于 1 ms；
- Extension callback 故意 sleep、抛错或退出时，Copilot 仍可完成任务；
- Worker 停止和队列积压时，Copilot 不受影响；
- Extension 重启和 Reconciler 运行后，已落盘事件缺失为 0；
- Extension 在写入 `capture_gap` 前被终止，Reconciler 仍能发现并补齐缺口；
- duplicate canonical fact 为 0；
- seeded secret 持久化为 0；
- 内部 Session 内容持久化为 0；
- 未支持版本进入 `incompatible`，不会猜测解析。

事件 timestamp 到 callback 的 delivery latency 单独报告 P50、P95、最大值和
事件类型分布。它衡量采集新鲜度，不等于用户可见延迟。F0 不为它预设 10 ms
门槛，但必须证明不会持续积压，Session 结束后可以完成持久化或由 Reconciler
补齐。

如果 Extension 无法达到延迟或故障隔离要求，停止这条路线。下一候选是
metadata-only OTel 作为主元数据流，配合受支持版本的 Session 文件增量恢复。
不能退回同步 lifecycle Hook。

## 16. 需要后续验证的事项

- Extension 是否继承 `PROVENLOOP_INTERNAL`；
- Extension host 在 callback backlog 时是否影响 CLI；
- Extension 的 shutdown deadline 和强制终止行为；
- bundled SDK 在 CLI patch 版本间的兼容边界；
- OTel exporter 的缓冲、丢弃和 shutdown flush 行为；
- `events.jsonl` 在 Windows 上的追加、部分行和 resume 行为；
- 安装器修改 JSONC settings 时如何保留用户注释和其他字段。

这些问题都有对应实验，不需要先建立额外抽象。

## 17. 官方资料

- [About Copilot CLI extensions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-extensions)
- [Create a Copilot CLI extension](https://docs.github.com/en/copilot/tutorials/create-an-extension)
- [Copilot SDK streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events)
- [Copilot Hooks performance considerations](https://docs.github.com/en/copilot/concepts/agents/hooks#performance-considerations)
- [Copilot Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Copilot CLI OpenTelemetry monitoring](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#opentelemetry-monitoring)
- [Copilot CLI Session data](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)
- [GitHub Copilot SDK](https://github.com/github/copilot-sdk)
