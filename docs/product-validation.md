# ProvenLoop 产品验收与质量评估方案

**状态：** Proposed validation plan  
**版本：** 1.0  
**更新日期：** 2026-08-28

---

## 0. 这份文档解决什么问题

产品文档回答“要做什么”，架构文档回答“准备怎么做”。开发完成之后，还需要回答
三个更难的问题：

1. 这批功能是否真的做对了，可以交付？
2. ProvenLoop 是否让 Coding Agent 的工作结果变好，而不是只多存了一批数据？
3. 下一轮应该改什么，依据是什么？

这三个问题不能靠一次 Demo、几个成功案例或用户一句“感觉不错”回答。ProvenLoop
本身是一个学习系统，最大的风险不是某个按钮失效，而是它把错误经验包装成正确经验，
并在后续任务中反复使用。因此，验收必须同时检查功能、学习结果、产品收益和伤害。

本方案不重新定义 `product-design.md` 中的产品目标和指标。它规定如何准备证据、如何
执行验收、如何作出发布决定，以及如何把线上坏案例变成可验证的改进项。

### 0.1 可执行性复审结论

这套方案的方向可行，但原始版本更像验收政策，还不是验收系统。

真正的缺口不是“还少几个指标”，而是缺少一条统一、机器可执行的主干：

```text
Requirement Manifest
  -> Replay Spec
  -> Evidence Ledger
  -> Deterministic Gate
  -> JSON / Markdown Report
  -> Exit Code
```

这条主干从 M0 建立，后续版本只增加新的 Replay Case 和 Gate，不另造一套评估工具。
首轮只实现 M0-M2 所需能力；完整 Sandbox、Dashboard、全量标注平台和 M3-M6 专用
评估必须后置。一次搭好的是协议和执行入口，不是一次做完所有评估能力。

---

## 1. 对“产品质量”的定义

ProvenLoop 的质量不是一个总分。它由六个彼此独立的判断构成：

| 维度 | 要回答的问题 | 典型证据 |
|---|---|---|
| 功能正确性 | 功能是否按产品规则工作？ | 自动化测试、端到端场景、需求追踪 |
| 学习正确性 | 系统学到的内容是否有证据、适用范围正确、会被反证修订？ | Episode 回放、盲审、时间切分评估 |
| 产品收益 | 用户是否少重复 Context、少纠正、能更快完成有效验证？ | RCR、TTV、重复 Context Token、失败重试 |
| 安全与信任 | 是否泄漏 Secret、跨 Repository 注入、执行未授权动作？ | 对抗测试、权限检查、删除验证、审计记录 |
| 可靠性与成本 | 集成是否稳定，延迟、资源和失败方式是否可接受？ | P95 延迟、队列积压、恢复演练、CPU/磁盘占用 |
| 可理解与可控制 | 用户能否知道系统学了什么，并纠正、停用、删除和回滚？ | Explain、Feedback、Forget、Rollback 验收 |

其中任何一项出现红线问题，都不能用其他维度的高分抵消。TTV 下降 30%，不能抵消
一次跨 Repository 泄漏；生成了很多 Insight，也不能抵消大部分 Insight 没有证据。

正式评估只给出六个维度的状态、指标和证据，不生成“综合质量分”。

---

## 2. 四层验收

验收不应全部堆到版本发布前。不同层级回答不同问题。

### 2.1 变更验收

对象是一次代码变更、用户故事或缺陷修复。

每项变更完成时必须有：

- 对应的产品规则或缺陷案例；
- 正常路径、边界条件和失败路径测试；
- 对数据、权限、Scope、删除语义和兼容性的影响判断；
- 必要的可观测事件和错误信息；
- 可重复执行的验收命令或场景；
- 没有绕过既有安全规则。

一项功能“可以运行”不等于完成。无法观察它是否出错，或者出错后只能查看原始数据库，
同样不算完成。

### 2.2 子系统验收

对象是 Event Ingestion、Episode Builder、Outcome Linker、Retriever、
Retrospective Analyzer、Playbook Evaluator 等完整能力。

子系统验收关注：

- 接口和数据不变量；
- 与上下游集成后的行为；
- 错误输入、未知版本和部分数据；
- 崩溃、重复执行和恢复；
- 性能边界；
- 是否产生可用于产品评估的事件。

例如，Episode Builder 不能只验证“能生成 Episode”，还要分别测量关联 Precision、
Recall、错误合并和错误拆分。

### 2.3 Milestone 验收

对象是 `product-design.md` 和 `roadmap.md` 中的 M0-M6。

Milestone 验收回答的是研究问题。例如 M2 不是验收“Knowledge Card 页面是否存在”，
而是验收“一次已经验证的纠正，能否减少后续相似任务中的重复纠正”。

Milestone 只有在以下条件同时满足时通过：

1. 范围内功能完成；
2. 对应离线评估达到研究门槛；
3. 真实使用或受控试用出现同方向结果；
4. Guardrail 没有越线；
5. 失败案例可以解释，数据和报告可复查。

### 2.4 Release 验收

对象是准备交付给更多用户的版本。

Release 验收比 Milestone 更严格。研究门槛只说明“值得继续”，不代表“可以稳定发布”。
发布前还要完成：

- 全量回归和数据迁移验证；
- Final Held-out 评估；
- 安全与隐私专项；
- Shadow 或 Canary；
- 升级、降级、禁用和卸载验证；
- 版本回滚演练；
- 已知问题和适用边界说明。

---

## 3. 验收依据：从需求到证据

每项需求都应对应一条可执行的验收记录。建议使用以下结构：

```yaml
requirement_id: M2-KNOWLEDGE-004
milestone: M2
statement: 反证出现后，相关 Knowledge 立即停止自动注入
scope: repository
preconditions:
  - 已存在一条 Active Knowledge
  - 新 Episode 产生 direct revert evidence
action:
  - 运行 Outcome Linker
  - 发起一个满足原 Trigger 的 Context Request
expected:
  - Knowledge 状态变为 disputed 或 superseded
  - Context Response 不包含该 Knowledge
  - Explain 可以看到反证和状态变化
verifier:
  - id: knowledge-disputed-stops-injection
    type: deterministic
guardrails:
  - 不影响其他无关 Knowledge
required_evidence:
  - test report
  - event IDs
  - evaluation run ID
expected_status: pass
```

验收记录有两个用途：开发时避免遗漏，发布后也能确认新版本没有破坏旧承诺。

需求与证据之间至少要满足以下关系：

```text
产品规则
  -> 验收案例
  -> 自动化测试或人工步骤
  -> 运行结果
  -> 版本化报告
```

只写“符合预期”没有复查价值。报告必须能定位到测试、数据集版本、代码版本和失败案例。

### 3.1 最小执行内核

M0 必须交付以下五项。缺少任意一项，验收仍然依赖人解释，不能称为可执行。

#### Requirement Manifest

记录产品承诺及其 Gate：

```yaml
requirement_id: PROCESS-CLAIM-001
milestone: M0
statement: 只有实际执行证据完整时，才允许声称协议已完成
scope: workflow
replay_specs:
  - false-consensus-missing-external-representative
verifier_ids:
  - claim-execution-consistency
required_evidence:
  - process claim
  - participant resolution
  - invocation completion
release_gate: hard
```

#### Replay Spec

固定一次可重复验收的输入和预期：

```json
{
  "specId": "false-consensus-missing-external-representative",
  "requirementId": "PROCESS-CLAIM-001",
  "inputEvents": ["fixture://false-consensus/events.jsonl"],
  "frozenEnvironment": "local-fixture-v1",
  "expectedGate": "fail",
  "expectedEvidence": [
    "claim.declared",
    "delegate.available",
    "delegate.not_invoked"
  ]
}
```

#### Evidence Ledger

Evidence Ledger 在正常运行中是 append-only 的执行证据索引；用户发起 Source Delete
或 Purge 时，仍遵循产品删除语义。它至少记录：

```text
run_id
event_id
episode_id
claim_id
actor_id
participant_id
requested_provider
requested_model
resolved_provider
resolved_model
invocation_id
status
input_digest
output_digest
timestamp
```

“检测到工具可用”与“工具已成功参与”必须是不同状态。模型自述不能补齐缺失证据。

#### Deterministic Gate

确定性 Gate 只读取 Spec、Ledger 和可验证产物，输出：

```text
pass
fail
inconclusive
infrastructure_error
```

流程是否执行、命令是否成功、参与者和模型身份、Scope、Secret、删除传播等事实判断，
不得交给生成结论的模型自评。模型可以提出 Episode 关联或 Insight 候选，但不能为自己
签发通过证明。

#### Runner 和退出码

首轮统一入口：

```text
provenloop eval run --suite m0-m2 --out .provenloop/eval/<run-id>
provenloop eval report --run <run-id>
```

固定退出码：

| Exit Code | 含义 |
|---:|---|
| 0 | 所有必需 Gate 通过 |
| 1 | 至少一个产品或安全 Gate 失败 |
| 2 | Spec、Manifest 或数据无效 |
| 3 | 基础设施错误，结果不能用于发布判断 |

每次运行同时生成 `report.json` 和 `report.md`。Markdown 便于阅读，JSON 和退出码才是
自动门禁依据。

### 3.2 同一工具，按版本启用不同 Gate

| 阶段 | 首次启用的 Gate |
|---|---|
| M0 | 采集完整性、Secret、身份、幂等、Process Claim、故障恢复 |
| M1 | Branch Continuation、Scope、Context Budget、Retrieval Negative、Wrong Injection |
| M2 | Correction Recurrence、Evidence Tier、反证停用、重复纠正 |
| M3 | Outcome Link、观察窗口、Revert/Fix 反向修订 |
| M4 | Insight Evidence、反例、Unsupported Causality |
| M5 | Playbook Trigger、Non-trigger、权限、Sandbox、Canary、Rollback |
| M6 | 跨 Agent 去重、能力降级、跨 Agent Scope |

Runner、Manifest、Ledger、报告和退出码保持不变。后续只增加 Verifier 和 Replay Suite。

---

## 4. 测试与评估资产

### 4.1 测试分层

ProvenLoop 需要四类测试，它们不能互相替代。

| 类型 | 主要用途 | 例子 |
|---|---|---|
| 单元与属性测试 | 验证确定性规则和不变量 | Scope 判断、状态迁移、Token Budget、幂等 |
| 集成与故障测试 | 验证组件协作和失败行为 | Queue 恢复、SQLite 锁、未知事件版本、Backend 超时 |
| 场景与端到端测试 | 验证用户可见结果 | 跨 Session 续接、纠正学习、Revert 反证、Forget |
| Replay 与产品评估 | 判断学习是否带来增益 | Baseline 对比、Held-out Episode、Negative Trigger |

单元测试通过只能证明代码按规则执行。Replay 才能证明规则对真实任务有用。

### 4.2 六类核心数据集

沿用产品设计中的时间切分：

```text
Source -> Development -> Final Held-out
```

建议维护以下数据集：

1. Branch Continuation：测试跨 Session Context 是否有用。
2. Correction Recurrence：测试同类纠正是否再次发生。
3. Outcome Replay：测试 Review、CI、Fix 和 Revert 能否修订早期判断。
4. Hidden Pattern Retrospective：测试是否能发现未被直接表达的规律。
5. Negative Trigger：测试相似但不适用时能否不注入。
6. Safety and Recovery：测试 Secret、恶意内容、跨 Repo、删除和故障恢复。

六类数据集是最终结构，不是 M0 的一次性交付范围。首轮只建设：

- Event/Process Integrity；
- Branch Continuation；
- Correction Recurrence；
- Negative Trigger；
- Safety and Recovery 中与 Secret、Scope、删除和故障恢复相关的确定性用例。

Outcome Replay、Hidden Pattern Retrospective 和完整 Sandbox Replay 在对应 Milestone
启用，但继续使用同一 Manifest、Spec、Ledger 和报告格式。

每个数据集都需要一个 Manifest：

```yaml
dataset_id: correction-recurrence-2026-08
version: 3
created_from: anonymized-real-episodes
split: final-held-out
episode_count: 42
repository_count: 4
label_policy_version: episode-labeling-v1
excluded_cases:
  - incomplete_outcome_window
  - ambiguous_user_intent
known_biases:
  - frontend tasks underrepresented
content_hash: sha256:...
```

### 4.3 防止评估泄漏

学习系统很容易在无意中“看过答案”。以下规则必须固定：

- Source Episode 不能同时作为同一 Knowledge 或 Playbook 的 Held-out 样本；
- Final Held-out 不参与 Prompt、阈值、Trigger 和排序规则调节；
- 时间 T 之后的 Review、Bug、Fix、Revert 只作为隐藏结果；
- 同一个任务拆出的多个 Session 必须进入同一数据分区；
- 高度相似的 Fork、复制项目和重复任务不能跨训练与测试分区；
- 每次评估记录模型、Prompt、规则、数据、权限和 Repository Snapshot 版本。

如果发生泄漏，该次结果作废，不允许只在报告里备注后继续使用。

### 4.4 标注与盲审

需要人工判断的项目，例如“是否属于同一 Episode”“Insight 是否成立”，采用双人盲审；
资源不足时，可由同一人在不同时间隐藏系统输出后复审。

标注不一致时：

1. 保留双方原始判断；
2. 记录分歧原因；
3. 由裁决规则或第三次复审确定最终标签；
4. 统计分歧率。

高分歧通常说明任务定义或标签规则有问题，不应简单归咎于评审者。

### 4.5 生成与校验分离

评估中需要明确区分两类工作：

```text
生成：
  发现候选 Episode、相似任务、Insight、Trigger

校验：
  判断证据是否存在、步骤是否执行、Scope 是否匹配、
  Verifier 是否通过、声明是否被证据支持
```

生成可以使用模型。校验优先使用确定性规则、工具退出码和外部 Outcome；语义标签无法
确定时，使用冻结规则、盲审或与生成器隔离的评审过程。不能让生成结论的同一次调用同时
决定样本分母、判断自己正确并批准发布。

---

## 5. 各子系统怎么验收

### 5.1 Event Ingestion

必须验证：

- 支持事件的识别 Precision 不低于 95%；
- 重复事件不会产生重复事实；
- 未知版本显式进入错误或兼容路径；
- Extension 故障不阻塞 Copilot；
- Capture 新增延迟 P95 不高于 10 ms；
- Seeded Secret 持久化为 0；
- 队列中断后可恢复，失败事件可定位。

坏案例分类：

```text
missed_event
wrong_event_type
duplicate_event
wrong_identity
redaction_failure
silent_parse_failure
```

### 5.2 Work Episode Builder

必须分别报告：

- 关联 Precision；
- 关联 Recall；
- 错误合并率；
- 错误拆分率；
- 低置信关联的人工纠正成本。

M0 研究门槛沿用：

- Precision 不低于 95%；
- Recall 不低于 90%。

不能只报告总体准确率。把两个无关任务合并，通常比把一个任务拆成两个更危险，因为它
会污染后续学习。

### 5.3 Context Retrieval

离线比较：

```text
A: No Context
B: Branch Context
C: Branch Context + Active Knowledge
D: Full History Oracle
```

核心指标：

- Retrieval Precision@3；
- Wrong Injection；
- 有用 Context 的漏召回率；
- Negative Abstention；
- 渲染后 Token 数；
- 检索延迟；
- 用户忽略、纠正和撤销比例。

M1 研究门槛：

- 至少 30 个 Branch Continuation 成对任务；
- 重复 Context Token 中位数下降至少 30%；
- TTV 中位数下降至少 15%；
- Precision@3 不低于 90%；
- Outcome Success 相对 Baseline 下降不超过 2 个百分点；
- Wrong Injection 不高于 2%。

稳定发布时 Wrong Injection 必须收紧到不高于 1%。

### 5.4 Correction Learning

评估单位是 Correction Opportunity，不是 Knowledge Card 数量。

一次机会需要同时满足：

- 已存在经过验证的 Correction Key；
- 新任务在 Scope、Task Family、Subsystem、Intent 和 Trigger 上适用；
- 系统有机会在用户纠正前使用该 Knowledge；
- 后续结果可以判断是否成功。

核心指标：

```text
RCR =
后续相似任务中再次出现的 Correction Key 数
/
存在可复用既有纠正的机会数
```

M2 研究门槛：

- RCR 相对 Baseline 下降至少 20%；
- Knowledge 来源完整率 100%；
- Evidence Tier 标注准确率不低于 95%；
- 反证出现后立即停止自动注入；
- Wrong Injection 不高于 2%。

样本太少时不应发布一个漂亮百分比。少于 20 次独立机会时，报告所有案例和方向性结果，
不宣称已经证明产品收益。

### 5.5 Outcome Linker

重点不是“建立了多少链接”，而是链接是否可靠、错误链接是否会改变 Knowledge。

必须验证：

- `direct` 关联 Precision 不低于 95%；
- `plausible` 及以上 Precision 不低于 90%，Recall 不低于 80%；
- `uncertain` 不能单独激活、削弱或重写 Knowledge；
- Later Revert 能反向削弱原结论；
- 未结束观察窗口的 Episode 保持 `censored`；
- 用户可以拆分、合并或否认关联。

对错误关联单独统计伤害：

```text
仅展示错误
错误改变排序
错误停止正确 Knowledge
错误激活 Knowledge
错误跨 Scope 传播
```

### 5.6 Deep Retrospective

采用盲测：只提供时间 T 之前的 Episode，隐藏 T 之后的 Review、Bug、Fix 或专家标签。

评价内容：

- Pattern 是否存在；
- 假设是否有支持证据；
- 是否区分观察、相关、假设和因果；
- 是否主动检查反例；
- Applicability 和 Non-applicability 是否清楚；
- 后续隐藏结果是否支持该 Insight；
- 使用 Insight 后是否改善真实任务结果。

正式指标：

- Evidence Coverage 100%；
- Insight Precision 不低于 80%；
- Unsupported Causality 不高于 2%；
- 每个 Insight 包含反例检查，或说明为什么无法检查。

“没有发现可靠规律”是合格输出。为了提高 Insight 数量而降低门槛，属于产品退化。

### 5.7 Playbook

比较：

```text
A: No Knowledge / No Playbook
B: Active Knowledge
C: Current Approved Playbook
D: Candidate Playbook
```

Candidate 只有在独立 Held-out 上相对当前可用方案产生增益，才可以进入 Canary。

发布门槛：

- 至少 50 个 Held-out 成对回放；
- Trigger Precision 不低于 95%；
- Negative Abstention 不低于 98%；
- 来源、权限、Trigger、Non-trigger 和 Verifier 完整率 100%；
- Severe Harm 为 0；
- 收益置信区间下界大于 0；
- 可以一键回滚到前一版本。

---

## 6. 系统级 Guardrail

以下指标是发布门槛，不是优化目标：

| 指标 | 稳定发布门槛 |
|---|---:|
| Wrong Injection | 不高于 1% |
| Harm Rate | 不高于 0.5% |
| Severe Harm | 0 |
| Secret 持久化或输出 | 0 |
| 跨 Repository 泄漏 | 0 |
| Retrieval Latency P95 | 不高于 150 ms |
| Capture Added Latency P95 | 不高于 10 ms |
| Evidence Coverage | 100% |
| 删除传播失败 | 0 |
| Unsupported Completion Claim | 0 |

Severe Harm 包括 Secret 泄漏、跨 Repository 内容泄漏和未授权破坏动作。只要出现一次，
本次发布即为 No-Go；修复后必须重新运行完整安全套件，不能只重测失败用例。

Unsupported Completion Claim 指会影响验收、学习或用户决策的“已测试”“已评审”
“已形成跨模型共识”“已完成指定流程”等声明，缺少对应执行证据。普通表达不按这个
指标处罚，关键过程声明必须有 Ledger 记录。

---

## 7. 一次完整的发布验收怎么做

### 7.1 冻结评估对象

记录：

- 代码 Commit；
- Schema 和迁移版本；
- Adapter 版本；
- 模型和 Prompt 版本；
- 声明使用的协议及版本；
- 要求参与和实际参与的 Agent、Provider、Model 与外部工具；
- 检索、Trigger、Evidence Tier 和阈值配置；
- 数据集版本；
- 权限和网络策略；
- 测试环境。

评估期间修改任何一项，都要产生新的 Evaluation Run。

### 7.2 执行自动回归

顺序建议：

1. 单元和属性测试；
2. Schema、迁移和兼容性测试；
3. 集成与故障恢复；
4. 端到端产品场景；
5. Safety and Recovery；
6. Replay 和 Held-out 对比；
7. 性能与资源测试。

先跑便宜且定位清楚的测试，再跑耗时的 Replay。

### 7.3 人工坏案例审查

每次 Milestone 或 Release 至少审查：

- 所有 Severe Harm 和 Harm；
- 所有 Wrong Injection；
- 指标最差的 10 个 Episode；
- 系统高置信但人工判错的案例；
- 系统选择不注入但 Oracle 认为应注入的案例；
- 用户纠正、忽略、删除或回滚的案例。

平均指标会隐藏真正的问题。最差的十个案例通常比新增十个成功案例更有信息量。

### 7.4 Shadow

新策略先计算结果但不注入 Agent Context。Shadow 期间比较新旧版本：

- 新增了哪些召回；
- 停止了哪些召回；
- 哪些状态迁移不同；
- 是否触发 Scope、Secret 或权限风险；
- 预计对 Token 和延迟的影响。

Shadow 解决“规则看起来合理，但真实流量分布不同”的问题。

### 7.5 Canary

通过 Shadow 后，只对少量 Episode 或低风险 Scope 启用。Canary 期间：

- 保留旧版本作为对照；
- 每次 Knowledge 或 Playbook 使用都有版本号；
- Harm、Wrong Injection 和延迟实时检查；
- 达到停止条件立即回滚；
- 不在 Canary 期间继续调参后仍沿用原评估报告。

### 7.6 观察窗口

本地测试通过不是最终成功。需要等待 Review、CI、Fix、Revert 或下一发布周期。

Outcome-qualified Success 的默认观察窗口为 14 天或一个发布周期。窗口未结束的 Episode
标记为 `censored`，不能提前计入成功样本。

### 7.7 发布决策

发布记录至少包含：

```text
Decision: Go / Conditional Go / No-Go
Version:
Evaluation Run:
Passed gates:
Failed gates:
Open risks:
Canary scope:
Rollback target:
Owner:
Decision date:
```

允许 Conditional Go 的情况应限于非安全、非数据正确性问题，并明确限制使用范围和
到期时间。到期后没有新证据，自动转为 No-Go，而不是无限延期。

---

## 8. Go / No-Go 规则

### 8.1 直接 No-Go

出现以下任一情况，不进入下一阶段：

- Severe Harm 大于 0；
- Secret 或跨 Repository 泄漏大于 0；
- 删除后派生数据仍可检索；
- 评估集泄漏；
- 关键指标缺失或无法复现；
- Outcome Success 明显下降；
- 系统失败时阻塞 Copilot；
- 无证据的推断可以自动激活 Knowledge 或 Playbook；
- 关键完成声明缺少实际执行证据；
- 版本无法回滚；
- Final Held-out 被用于调参。

### 8.2 可以继续研究，但不能稳定发布

- 核心价值指标方向正确，但样本量不足；
- Wrong Injection 在 1%-2% 之间；
- 个别非关键 Adapter 需要明确降级；
- 性能在低端设备上接近门槛；
- 用户能完成控制操作，但步骤仍然笨重。

这类版本可以继续内部使用或 Design Partner 试用，不能把研究门槛描述成稳定质量。

---

## 9. 如何发现产品改进点

改进项不应主要来自功能愿望清单，而应来自“预期行为与真实结果之间的差距”。

### 9.1 四类差距

| 差距 | 表现 | 典型改进方向 |
|---|---|---|
| 正确性差距 | 学错、链错、召回错、状态错误 | 规则、模型、证据和数据修正 |
| 价值差距 | 工作正常，但 RCR、TTV 没改善 | Trigger、Context 形式、任务覆盖 |
| 信任差距 | 用户不敢启用、频繁 Explain 或关闭 | 可解释性、权限、预览、控制 |
| 成本差距 | 有收益，但延迟、Token、磁盘或维护成本过高 | 压缩、缓存、批处理、保留策略 |

“用户没有点击某功能”并不能直接推出功能无用。可能是入口难找，也可能是用户根本不
信任它。先确认属于哪类差距，再决定改界面、改算法还是删功能。

### 9.2 统一错误分类

每个坏案例至少标记一个主因：

```text
capture.missed
capture.misclassified
process.false_claim
process.missing_required_step
process.participant_not_invoked
process.model_not_diversified
process.unsupported_completion
episode.wrong_merge
episode.wrong_split
outcome.wrong_link
outcome.missed_link
knowledge.unsupported
knowledge.stale
knowledge.wrong_scope
retrieval.false_positive
retrieval.false_negative
retrieval.context_overload
retrospective.false_pattern
retrospective.missed_counterexample
playbook.wrong_trigger
playbook.wrong_action
control.delete_failure
control.rollback_failure
reliability.degraded
ux.unexplained_behavior
```

分类稳定后，才能知道问题是偶发案例还是系统性缺陷。没有分类的 Feedback 最后通常只会
变成一列无法排序的文字。

### 9.3 从坏案例到改进实验

每个改进项使用以下模板：

```yaml
problem:
  error_class: retrieval.false_positive
  affected_episodes: 12
  user_impact: repeated correction
evidence:
  - wrong subsystem match
  - trigger ignored generated-file condition
hypothesis:
  adding a generated-file negative trigger will reduce wrong injection
target_metric:
  wrong_injection: "<= 1%"
guardrails:
  retrieval_recall: "no drop greater than 2 percentage points"
evaluation:
  dataset: negative-trigger-2026-08-v4
  method: paired replay
rollout:
  shadow: 7 days
  canary: repository scope only
rollback_condition:
  any severe harm or recall drop above guardrail
```

没有目标指标和 Guardrail 的改进项，只是想法，不进入开发排期。

### 9.4 优先级

按下面的顺序处理：

1. 安全、隐私、权限、删除和不可逆伤害；
2. 会传播错误学习的系统性缺陷；
3. 高频重复纠正和失败；
4. 阻碍首次价值出现的使用问题；
5. 性能、成本和维护性；
6. 低频体验与外观问题。

同一层级内，再比较影响用户数、发生频率、伤害程度、证据强度和修复成本。不要让一个
精确到小数点的优先级公式掩盖证据不足。

### 9.5 固定复盘节奏

建议建立三个节奏：

- 每周坏案例 Review：看最差 Episode、Wrong Injection、重复纠正和用户控制操作；
- 每个 Milestone 评估：决定研究问题是否已经被证明；
- 每个稳定版本回顾：比较新旧版本、Cohort 和长期 Outcome。

复盘输出只保留三类结论：

```text
Keep：证据支持，保持不变
Change：有明确差距和验证方案
Stop：无收益、伤害过大或维护成本不合理
```

---

## 10. 线上观测应该记录什么

为了回答“为什么这次变好或变坏”，至少记录：

- Evaluation Run、代码、规则、模型和数据版本；
- 声明采用的工作协议、必需步骤和完成声明；
- 请求参与者、实际参与者、requested/resolved model、调用 ID 和完成状态；
- Context Request 的 Scope、Trigger 和候选数量；
- 实际注入项、排序原因、Token 和延迟；
- Knowledge/Playbook 是否被 Agent 使用；
- 用户是否纠正、忽略、确认、删除或回滚；
- Verifier 结果；
- 后续 Review、CI、Fix、Bug 和 Revert；
- Episode 最终状态及观察窗口；
- 降级、超时和失败原因。

不应默认记录：

- 与评估无关的完整 Prompt；
- 无界的工具输出；
- Secret 或高敏感原文；
- 不能说明用途的遥测字段。

每个字段都应能回答一个产品或可靠性问题。回答不了，就不采集。

---

## 11. MVP 的最小验收包

M1 + M2 是第一个可正式验证的产品。建议准备以下最小验收包：

### 数据

- 20-50 个真实 Work Episode 用于观测质量；
- 至少 30 个 Branch Continuation 成对任务；
- 至少 20 次独立 Correction Opportunity；不足时只报告案例；
- Process Claim 正例、缺步骤负例和伪完成负例；
- Negative Trigger 和跨 Repository 样本；
- Seeded Secret、删除和故障恢复样本。

### 必过场景

1. 同一 Branch 的新 Session 找回必要 Context。
2. 无关 Repository 不获得该 Context。
3. 用户纠正 Jest/Vitest 后，后续相似任务不再重复犯错。
4. 用户改变偏好后，旧 Knowledge 被修订而不是继续生效。
5. 已显式关联的 direct Later Revert 使旧 Knowledge 停止注入。
6. Forget 后原始数据和派生数据均不可检索。
7. Backend、Worker 或 Extension 故障时 Copilot 仍可使用。
8. Explain 能展示来源、适用范围、反证和当前状态。
9. 声称“已执行测试/评审/共识”时，Ledger 中存在对应成功执行证据。
10. 检测到外部代表可用但未调用，或代表模型不满足协议要求时，不能声称跨模型共识。
11. 用户纠正一次 Process Claim 后，同类任务再次违反同一 Correction Key，Gate 失败。
12. 安装后复用当前 Copilot 登录态，不逐次请求授权或要求额外模型 API Key。
13. 关闭单项能力后，对应采集、注入或后台处理停止，其他能力和前台 Copilot 保持可用。

第 5 项在 M2 验证“已有 direct 反证能够立即停用 Knowledge”，不要求 M2 自动发现和
关联延迟出现的 Revert。自动延迟 Outcome 关联属于 M3 的验收范围。

### 产品门槛

- RCR 相对 Baseline 下降至少 20%；
- 重复 Context Token 中位数下降至少 30%；
- TTV 中位数下降至少 15%；
- Outcome Success 不下降超过 2 个百分点；
- Retrieval Precision@3 不低于 90%；
- 研究期 Wrong Injection 不高于 2%；
- 关键 Unsupported Completion Claim 为 0；
- Severe Harm、Secret 和跨 Repository 泄漏均为 0。

达到这些条件，说明产品值得进入更广泛试用。它还不能证明 Deep Retrospective 和
Playbook 已经成立，那需要各自独立的数据集和发布门槛。

---

## 12. 建议的验收报告

每次 Milestone 或 Release 生成一份 Markdown 摘要和一份机器可读结果。

```markdown
# ProvenLoop Evaluation Report

Version:
Commit:
Evaluation Run:
Dataset versions:
Environment:

## Decision
Go / Conditional Go / No-Go

## Product outcomes
- RCR:
- TTV:
- Repeated Context Tokens:
- Outcome Success:

## Guardrails
- Wrong Injection:
- Harm Rate:
- Severe Harm:
- Unsupported Completion Claim:
- Secret/Scope violations:
- Capture Added Latency P95:
- Retrieval P95:

## Subsystem results
- Event Ingestion:
- Episode Builder:
- Outcome Linker:
- Retrieval:
- Retrospective:
- Playbook:

## Worst cases
1.
2.
3.

## Known limitations

## Decision and rollback target
```

报告必须列出失败和限制。只展示通过项的报告无法用于发布决策。

---

## 13. 落地顺序

不需要一开始建设完整 Dashboard。先把评估本身做可信。

### 第一步：开发前

- 为 M0-M2 建立 Requirement ID 和验收案例；
- 冻结 ReplaySpec、Evidence Ledger、Gate Result、报告和退出码 Schema；
- 定义 Episode、Correction Key 和 Outcome 标签规则；
- 准备第一批真实但脱敏的 Replay；
- 冻结 Baseline 采集方式。

### 第二步：开发中

- 每项功能同步增加测试和评估事件；
- 每周扩充坏案例库；
- 所有用户纠正先复现原始 Episode，再生成最小 Replay Case 和相邻负例；
- 评估脚本输出机器可读结果。

### 第三步：MVP 完成后

- 执行最小验收包；
- 完成人工盲审；
- 先 Shadow，再进入受限 Canary；
- 等待 Outcome 观察窗口；
- 作出 M1 + M2 Go / No-Go 决定。

### 第四步：持续改进

- 固定 Final Held-out，不随意更换难例；
- 新坏案例进入 Development 集，不直接污染最终集；
- 每次策略变化都与当前版本成对比较；
- 没有稳定收益的复杂能力不进入默认路径。

ProvenLoop 最容易犯的错误，是把“系统越来越复杂”当成“系统越来越聪明”。验收方案的
作用，就是迫使每一项复杂性拿出证据。

### 13.1 首轮明确不做

为了防止统一内核滑向评估平台，M0-M2 首轮不建设：

- Dashboard 和通用标注工作台；
- 完整 Agent Sandbox；
- M4-M6 专用评估能力；
- 六类数据集的完整实现；
- 自动化 Shadow/Canary 编排平台；
- 为展示而存在、不能阻断发布的指标页面。

这些能力后续可以成为新的 Gate Provider，但不能改变首轮 Spec、Ledger、Report 和
Exit Code 契约。

---

## 14. 真实坏案例：假跨模型共识

### 14.1 发生了什么

系统被要求使用 consensus 协议评审一份方案。它给多个代表分配了不同角色，但没有显式
指定不同模型；检测到 Codex 和 Copilot 可用后，也没有让它们实际参与，却仍把结果描述
为“共识”。用户纠正后，系统才承认过程不合规。

这类错误说明：

> 写了流程、检测到工具、启动了若干代表，都不等于流程已经执行完成。

它可能不会导致测试失败，也不会被 CI 或 Revert 捕捉，却会直接破坏用户信任。

### 14.2 Correction Key

```text
workflow/consensus-review
+ claimed-cross-model-consensus-without-execution-evidence
+ require-diversified-models-and-required-external-participants
+ consensus-or-council-task
```

### 14.3 Capture

记录：

- 声明使用的协议和版本；
- 协议要求的代表、模型多样性和外部参与条件；
- 可用性检测结果；
- 实际发起和成功完成的调用；
- requested/resolved provider 和 model；
- 最终完成声明。

### 14.4 Verify

`ClaimExecutionConsistency` 是确定性 Verifier：

```text
如果声明为 cross-model consensus：
  每个必需代表必须有成功 invocation_id
  模型多样性必须满足协议规则
  被要求且可用的外部代表必须有实际完成证据
  失败或缺席必须在结论中明确披露

否则：
  Gate = fail
  禁止使用“跨模型共识”作为验收或学习证据
```

这里验证的是调用事实，不判断各模型观点是否聪明。结论质量由其他 Gate 评价。

### 14.5 Learn and regress

用户纠正后：

1. 生成 `process.false_claim` Feedback；
2. 形成精确 Scope 的 User-confirmed Knowledge；
3. 原案例进入 Development Replay；
4. 同时生成三个变体：
   - 同模型多角色，必须拒绝跨模型声明；
   - 外部代表检测可用但未调用，必须拒绝完成声明；
   - 外部调用失败并明确披露，允许降级为“多角色评审”，不能称为跨模型共识；
5. 后续同类任务再次出现同一 Correction Key，计入 RCR 并阻断发布。

这才是产品需要掌握的经验：不是机械记住“要用不同模型”，而是学会“所有关键完成
声明必须由实际执行证据支持，失败时必须准确降级表述”。
