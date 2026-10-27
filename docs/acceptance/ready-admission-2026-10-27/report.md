# Ready 准入一致性调查与验收

本轮处理的问题是：前端要求当前 Git commit 的研发预审完成，服务端 `ready.generate` 却可以在没有该结果时生成 Ready Spec。调查、复现与修复以 `311b9f7f06af433acef032acd913ef93adea53fe` 为基线；修复尚未提交，工作树内容由 [after/metadata.json](after/metadata.json) 中的 SHA-256 固定。产品能力仍止于 Ready Spec。

**问题与影响。** 调用者绕过前端，直接 POST `/api/spec-collab/action`，只要进入共审、正文通过六项结构检查、双方确认当前版本，就能在研发预审缺失、失败、运行中或只完成旧版本预审时生成 Ready。六项 PASS 和双方确认因而不能证明既定审核流程已走完。HTTP 回归在基线实际得到 200，在修复后得到 400，完成当前版本预审后才返回 200。

## 原始约定与版本

以下引用均已检查原文，版本为 Git 对象，不以当前行号推定历史内容。[原始摘录](original-evidence.txt) 保留提交全 SHA、原路径与原行号。可用 `git show <commit>:<path>` 独立核查。

| 条件 | 既有明确约定、实现差异或待决定事项 | 原始位置与版本 |
| --- | --- | --- |
| 产品初审、人工回应、产品二审 | 既有流程明确包含。创建时自动初审；服务端产品阶段推进只硬性检查当前版本二审完成，不检查初审完成。初审逐 commit 重跑是现有前端限制，不能据此宣称原约定已精确定义该规则。 | `349e522:README.md:11–17`；`349e522:src/review-runtime.ts:97–98`；`311b9f7:src/engine.ts:724–732`；`311b9f7:src/client/workflow.ts:49` |
| 研发预审 | 原流程要求产品确认后产研共审；旧教程明确进入共审后运行研发智能预审。前端自 `fb70d2b` 起要求当前 commit 已完成 `engineering-precheck`，服务端漏查。 | `349e522:README.md:15`；`349e522:src/review-runtime.ts:99`；`ee7bb81:docs/usage-walkthrough.md:50`；`311b9f7:docs/usage-walkthrough.md:41`；`fb70d2b:src/client/workflow.ts:84` |
| 变更审核 | 保存、恢复、接受 Patch 会自动触发。原文要求重做受影响审核，没有明确规定每个新 commit 必须重做全部四类，亦未规定 change-review 能替代二审或研发预审。本轮不增加这种替代关系。 | `349e522:README.md:31`；`349e522:src/review-runtime.ts:100`；`311b9f7:docs/usage-walkthrough.md:52`；`311b9f7:src/engine.ts:210–232,288–301` |
| 当前版在途审核、待审 Patch | 基线前端已有等待和人工接受/拒绝流程；服务端 Ready 未执行。作为同一准入规则的组成部分，本轮同步执行。不是新增“所有历史审核都必须成功”的要求。 | `fb70d2b:src/client/workflow.ts:30–45,92–95`；`349e522:README.md:30–31`；`ee7bb81:docs/usage-walkthrough.md:34–38` |
| 人工与双角色确认 | AI 不能代替人工确认或标记 Ready。双方必须确认同一个当前 commit。有效条件为 active + scope=version + 当前 commit，章节/AC/Decision 确认不能替代。 | `349e522:README.md:30,32`；`ee7bb81:docs/usage-walkthrough.md:46,52`；`311b9f7:src/engine.ts:310–324,718` |
| 六项检查 | 目标、AC、范围、业务语义、证据、测试约束全部通过。实现是章节、长度、占位词、AC 格式、来源状态和当前阻塞项检查；不代表深度语义审查通过。 | `349e522:README.md:33`；`311b9f7:README.md:131`；`311b9f7:src/engine.ts:786–797` |
| 阻塞项 | 回答不必然解决。产品阶段可显式转交共审；最终 Ready 的当前 blocking 项仍必须解决或转成非阻塞待核验。旧 commit 的审核项保留追溯，默认不阻塞新 commit。 | `ee7bb81:docs/usage-walkthrough.md:30,63`；`311b9f7:src/engine.ts:241,726,789` |
| 事实证据 | FACT 必须具有可访问、带版本的证据。无法核验的内容保留 TO_VERIFY。当前代码只校验证据元数据，不会自行读取来源核验事实。空 sources 和 unverified 来源不会自动导致失败。 | `349e522:README.md:27`；`311b9f7:README.md:171–173`；`311b9f7:src/engine.ts:128,795` |
| Ready 输出和边界 | 输出 commit、稳定 AC、Decision、来源、非阻塞问题及双方确认人。无“至少一条 Decision”门槛，客户重要度不阻断 Ready；Ready 不证明实现、测试或发布完成。 | `349e522:README.md:34`；`311b9f7:docs/migration-v3.md:23`；`311b9f7:docs/usage-walkthrough.md:45`；`311b9f7:README.md:8` |

首版 `349e522` 的成功用例已经只提交产品二审即期望 Ready 成功。`fb70d2b` 增加前端流程引导时，没有同步增加服务端研发预审门。`311b9f7` 只刷新教程，没有撤销 README 中的二审流程。这些历史支持“长期未统一执行约定”，不能支持“新版产品决定研发预审可选”。

## 实际调用路径与机制

```text
workflowState / SpecWorkbench.confirmWorkflow
  → client api.action
  → POST /api/spec-collab/action
  → parseEnvelope + loopback / same-origin guard
  → CollaborationEngine.apply → applyFresh(ready.generate)
  → GitRequirementStore.read(currentCommit) → readiness
  → readyAdmission → ReadyPackage → stage=ready
```

基线中，[路由](../../../src/routes.ts) 只在创建和绑定时额外核查工作区可用性；Ready 直接调用 Engine，没有隐藏的研发预审补充门。`stage.advance` 保证进入产品确认时的当前版二审，进入共审时的当前版产品确认，但不会替 Ready 检查研发预审。通用 DSH 工具审批也不构成 Spec 专属门。

真实 AI 结果的另一条路径为 `ctx.tools.register` → `spec_submit_review.execute` → `engine.submitReview`。提交成功把对应 run 设为 completed；普通 assistant 文本不等于提交结果。原有成功测试通过伪协调器取得 session，再直接调用 `submitReview` 提交空二审结果；它没有执行真实模型，也没有提交研发预审。

## 实际修改与确定规则

[共享准入模块](../../../src/ready-admission.ts) 集中当前版本审核、双方整版确认、在途审核、待审 Patch 和 Ready 生成条件。[Engine](../../../src/engine.ts) 在正式写入前调用同一函数，并从 Git 重算六项检查；[前端流程](../../../src/client/workflow.ts) 读取相同派生结果，新增错误也有中文处置提示。客户端不能通过上传伪造 PASS 绕过服务端，因为 `ready.generate` 不接收该结果。

本轮生成条件为：人工操作；已关联工作区；处于 joint-review；当前 commit 至少一次 completed 研发预审；当前 commit 没有 queued/running 审核；当前 commit 没有 pending Patch；六项检查通过；产品和研发分别持有 active 的当前 commit 整版确认。

同版本曾经成功、后来重试失败，仍沿用基线前端“存在一次 completed 即满足”的语义；正在运行的重试阻断生成。未新增确认必须晚于审核的时间戳排序规则。每次正文改版后，旧预审不再匹配当前 SHA，双方整版确认亦失效。进入共审后改版不自动退回产品阶段，因而不要求所有四类审核重新执行；这一点保持既有阶段模型。

[新增回归](../../../tests/ready-admission.spec.ts) 从公开 action 构造流程，使用真实临时 Git 仓库；HTTP 用例运行真实 `makeRoutes`，没有私改 Engine 内存。[原 Engine 成功用例](../../../tests/engine.spec.ts) 现在明确提交研发预审，并完成当前版本在途审核。产品说明同步到 [README](../../../README.md)。

在新增拒绝路径上还复现了一个既有异步引用问题：`apply` 拒绝动作时恢复 cloned state，而尚未返回的审核启动回调继续写旧 record/run 对象，当前账本因而丢失 running/sessionId。基线根因位于 `src/engine.ts:110–113,467–468`。仅补准入门后的[失败输出](delayed-launch-before.txt) 实际得到 queued 且无 sessionId；最终回调按 ID 查找当前 record/run，并保持已有终态，12 项回归中的专门用例验证拒绝后仍正确关联会话。这是保障新增等待门可正确使用所需的局部修复，未重构整体事务机制。

## 反例与前后结果

下表是同一测试文件对基线与工作树的实际结果。[修复前输出](before/regression.txt) 和 [修复后输出](after/regression.txt) 保留逐项测试名称；元数据记录测试文件和源码哈希。基线 9 个失败指“安全性预期被违反”，不是环境启动错误。

| 场景 | 预期依据 | 基线实际结果 | 修复后实际结果与机制 |
| --- | --- | --- | --- |
| 无研发预审，六门通过且双方已确认 | 共审后的研发检查约定；前端当前版预审要求 | 错误生成 Ready | 拒绝，提示需要当前版研发检查；账本不变 |
| 预审 queued | 审核尚未提交结果；前端等待 | 错误生成 | 拒绝，在途审核门 |
| 预审 running | 同上 | 错误生成 | 拒绝，在途审核门 |
| 预审 failed，无同版成功结果 | 失败不等于 completed | 错误生成 | 拒绝，缺当前版已完成预审 |
| 预审属于旧 commit，改版后双方已重新确认 | 审核固定 SHA，旧结论不能证明新正文 | 错误生成 | 拒绝，commit 不匹配 |
| 当前版已完成预审，六门及确认齐全 | 正例 | 生成 | 生成；Ready 包固定同一 SHA |
| 改版并完成新预审，但双方仍只有旧确认 | 确认绑定版本，正文变化使整版确认失效 | 拒绝；重确认后生成 | 同样拒绝；仅产品重确认仍拒绝，双方齐全后生成 |
| 旧 commit 的迟到审核提交 | run/current/提交 commit 必须一致 | 拒绝 `review run is stale` | 保持拒绝 |
| 同版有先前成功预审，又有复审运行中 | 前端全局等待当前版在途 run | 错误生成 | 拒绝，在途审核门 |
| 当前版 pending Patch | 前端要求人工接受或拒绝 | 错误生成 | 拒绝，待处理 Patch 门 |
| Ready 被拒绝时审核启动 Promise 尚未返回 | 新拒绝门不能丢失会话关联；异步结果应更新当前账本 | 基线先错误放行；仅补门的中间版本复现 queued/sessionId 丢失 | 拒绝后启动回调仍记录 running 与 sessionId，真实会话可追溯 |
| 经真实 HTTP action 路由，无预审/完成预审 | HTTP 必须复用 Engine 约束 | 无预审返回 200 | 无预审返回 400；完成后返回 200 |

## 独立复核

安装仓库依赖后，在仓库根目录执行：

```sh
pnpm run typecheck
pnpm test
node scripts/verify-ready-admission.mjs --baseline 311b9f7 --output /tmp/ready-before
node scripts/verify-ready-admission.mjs --output /tmp/ready-after
```

基线命令预期 exit 1，工作树命令预期 exit 0。源码、工具事件与 Git bundle 的独立核对及真实宿主重跑步骤见 [replay](live-final/replay.md)。脚本用 `git archive` 在临时目录还原指定提交，只复制同一个新回归文件，并复用安装依赖；不 checkout/reset/stash 工作树。`--node <absolute-path>` 可选择测试 Node。当前机器签名的桌面内置 Node 直接加载 Rollup 原生模块会触发 Team ID 校验错误；实际使用 PATH 中的 `/Users/zhongxin/.hermes/node/bin/node`，版本 `v24.21.0`。失败的环境尝试没有计入基线业务失败。

已执行：类型检查 exit 0；最终完整非浏览器套件 13 文件、100/100 通过；TypeScript 声明构建与 tsdown Host/Client 构建通过；同一组 12 个准入测试基线 9 失败/3 通过，修复后 12/12 通过。见 [类型检查](typecheck.txt)、[初轮完整测试 99/99](full-tests.txt)、[最终检查输出](final-checks.txt)、[前后哈希](after/metadata.json)。完整 Playwright 体验套件未执行，它依赖既有演示数据；本轮 GUI 点击验收亦未完成，浏览器原任务空间在恢复时已不存在。

## 真实 DSH 验收

最终验收使用真实 DSH Web profile，地址为 `http://127.0.0.1:55169`；完成后已停止。CLI 与 app-boot 固定为 `0.1.1-rc.1`，其余组件的确切版本见 [运行时 lock](live/runtime/pnpm-lock.yaml)。当前桌面 `http://127.0.0.1:62120` 为 `0.2.1-rc.3`，Desktop profile 未加载此插件，使用新接口，本轮没有把它当作修复已加载的证据。

标准旧 CLI 的配置监听步骤因 Cordis HMR 接口差异退出。验收通过官方 `loadProfile` 和 `boot` 组合完整 profile，加载原样 Host/Client 构建及真实模型、API、工具、会话持久化服务；仅省略 CLI 的配置文件监听。没有替换 Spec 路由、coordinator 或 AI 工具实现。保留了[启动器](live/runtime/acceptance-boot.mjs)、[启动尝试](live/runtime-startup-attempts.txt)及[最终 Host 输出](live-final/host.txt)，这一差异不能等同于标准 CLI 安装验收通过。

[最终环境](live-final-environment.json) 隔离了 DSH_HOME、项目、账本和 Spec Git 仓库，并显式配置 dataRoot/repositoryPath。只换 DSH_HOME 不足以隔离插件，因为其默认目录来自 `homedir()/.dsh/spec-collab`。本轮默认业务账本前后均为 revision 229，文件仍保留原修改时间；没有对其构造 Engine 或执行写操作。临时私有配置和所需单个模型凭证已[清除](cleanup.json)。测试账本、Git 历史及导出证据继续保留。

[数据准备脚本](../../../scripts/seed-ready-acceptance.mjs) 将产品初审、二审、初始 change-review 与双方确认明确标成合成前置。随后通过真实 HTTP 和真实模型执行的步骤见[原始操作日志](live-final/operations.jsonl)：

| 时间（2026-10-27，Asia/Shanghai） | 实际操作 | 实际结果 |
| --- | --- | --- |
| 10:26:58 | 当前版没有研发预审，六项结构门通过且双方已有合成确认；请求 Ready | HTTP 400，`engineering precheck is required for the current version` |
| 10:26:58–10:30:02 | 请求真实研发预审，模型读取来源和 Spec，提交两项发现 | run completed；一项 blocking，证据门失败 |
| 10:34:11 | 审核虽已完成，但阻塞未处理，尝试生成 Ready | HTTP 400，`readiness gate is not satisfied`；没有因 completed 而跳过内容门 |
| 10:34:11 | 对发现做验收角色回应，保存[补齐规则的 Spec](live-final/refined-spec.md)，记录 Decision | 新 commit `9b5a4eee6b1936e8de3ef15c3371381d126050e2`；双方旧整版确认均 invalidated；自动 change-review 和新研发预审被请求 |
| 10:34:21 | 真实模型审核仍运行时生成 Ready | HTTP 400，`current version review is still running` |
| 10:36:36 前 | 模型完成 change-review，再完成当前版研发预审 | 两次 `spec_submit_review` 均获非错误结果；当前六门通过、无 pending Patch |
| 10:36:36 | 验收产品、验收研发分别确认新 commit，再请求 Ready | HTTP 200；阶段 ready，生成固定版本的 [Ready Spec](live-final/Ready.md) |

最终 Ready 绑定 `9b5a4eee6b1936e8de3ef15c3371381d126050e2`，SHA-256 为 `d21e98799268b8425afb155818a89bc8fdafa6eda28eb4489ed00e6babb7d9d1`，已从导出 Markdown 独立重算一致。角色、需求和业务取舍均是隔离验收数据，由脚本驱动测试角色；它不是生产需求的人工批准记录，也不代表业务重试功能已实现。

真实 AI session 为 `session-e1925105-d302-4a2f-80ac-ffede2c1404e`。[原始工具事件](live-final/tool-events.jsonl)保留 session 元数据、三轮 turn 起止、全部 tool/call 与对应 tool/result，原事件没有改写成摘要。[索引](live-final/trace-index.json)逐项记录原 seq/callId、来源压缩日志 SHA-256 和提交参数。27 次工具调用全部按 call ID 配对，其中 15 次为失败结果，3 次审核提交成功；三轮 turn/end 均为 completed。关键事件为：

| 行为 | 原始 call → result seq | 证明范围 |
| --- | --- | --- |
| 读取项目说明与两行源码 | 599→601、600→602 | 工具实际返回了指定文件内容；证明读取发生，不保证理解或事实结论完整 |
| 读取 Git HEAD 元数据并检索源码 | 939→941、940→942、943→944 | 读取了 HEAD/日志及常量文本；没有成功执行 Git 命令 |
| 读取初版固定 Spec | 748→749 | 返回初版 commit 与正文、确认和来源 |
| 初版研发预审提交 | 2503→2504 | run `252620f9-a105-4295-bab3-565cf13634a3`，初版 `d12cf52e961bf6aa929e88b0dcb8ebbe700bc912`，两项发现 |
| 新版读取和变更审核提交 | 2933→2934、4341→4342 | run `fb89beaf-d1ff-47b6-83a7-bdc4a1d10a8f`，新版 commit；提交一项确认状态 FACT 和一项非阻塞 TO_VERIFY |
| 新版读取和研发预审提交 | 4723→4724、5508→5509 | run `ff30cd84-445a-4b2f-88b9-0d8d93ad0bd7`，新版 commit；无新增发现 |

15 次失败是 Bash 工具调用失败，不能当作 Git 核验成功。模型后来使用 read/glob/grep 取得文件，并在审核中明确将完整 Git 历史、工作树与来源 commit 一致性、父子差异归属列为 TO_VERIFY。尤其 change-review 虽完成结构化提交，但其摘要明确说未拿到父提交和差异；不应把 completed 解读成完成了严格 Git diff 审核。

已逐项核对原文支持范围，见[来源核验](live-final/source-verification.json)：源码只支持常量声明为 0，不支持网络执行或幂等能力已经存在；原 Spec 确实缺少提交标识与等待边界；“最多两次”的歧义为语义推断。变更审核中的 FACT 与原 seq 2934 返回的正文、active Decision 和两项 invalidated 确认一致。独立 Git 检查另行确认两份来源文件与 `fcf74a7cd303ce0fe3c35a332acb0ca3025a34b5` 的 Git 对象逐字节相同，工作树干净，并确认新版的直接父提交是初版；这补足的是人工验收证据，不能倒推模型执行过 Git。保留[源码 bundle](live-final/fixture.bundle)、[Spec 历史 bundle](live-final/spec-history.bundle)及[正文差异](live-final/spec-diff.txt)。

失败的基础设施尝试单独保留在 [live](live/operations.jsonl)：首次工作区路径未规范化导致 attach failed，Ready 仍拒绝；另一次模型因未配置隔离凭证而结束，原始 [MISSING_CREDENTIAL](live/credential-failure-events.jsonl) 事件没有计入成功审核。后者暴露“turn 异常结束未自动同步为 run failed”的既有集成缺口，最终使用新建、正确配置凭证的独立数据集重跑，没有手动伪造 completed 或清掉阻塞来完成验收。

GUI 点击与完整 Playwright 套件未通过验收：最初当前桌面页要求认证，后来原浏览器任务空间已不存在，未另开空间假称完成 UI 验收。当前 `0.2.1-rc.3` 兼容、模型严格父子差异审查、伪造审核来源拒绝测试也尚未验证；人工产品语义批准只发生于验收角色和可丢弃数据，不外推到生产需求。

## 证据的证明范围与后续事项

| 层面 | 支持证据 | 能证明什么 | 不能由此推出什么 |
| --- | --- | --- | --- |
| 字段和状态 | 类型检查、工具 schema、Engine 校验、反例测试 | 格式、枚举、当前 run 状态及现有结构门通过；FACT 至少有一个声明可访问且带版本的 evidence | 来源实际可访问、版本真实、事实准确、模型真的读取过文件 |
| Git 版本一致性 | 真实临时 Git 仓库、commit 绑定、旧 SHA 反例、baseCommit 冲突测试、Ready 包 SHA | 本文档审核/确认/产物绑定相同的需求版本；旧结果不能替代新版本 | 被引用外部仓库 SHA 一定存在、所述事实被该版本原文支持 |
| 真实 AI 行为 | 需原始 tool/call 与对应 tool/result、真实 session/run/commit、来源快照 | 某次调用实际发生、工具返回了哪些文件内容、结构化结果是否提交 | 每个 token 都被理解、每个结论正确、其他会话也遵守读取要求 |
| 需求语义质量 | 人工逐条检查原文、需求、Review Item、AC 和风险处置；模型审核作为辅助 | 被逐条复核的具体陈述获得支持；明确记录哪些仍为推断/假设/待核验 | 六项 PASS、空 findings、completed 标记能够自动保证语义充分 |

仍需决定的产品语义：每次改版应重做哪些审核；change-review 与其他审核的替代关系；同版本失败重试是否撤销先前成功；确认是否必须晚于最新审核；何种风险允许从 blocking 降为非阻塞 TO_VERIFY。本轮保持既有语义，未把这些未决项偷偷变成新门。

后续工程事项：

1. `spec_submit_review` 的 session/role 来自模型自报，未绑定工具执行上下文；run 不校验真实提交 session，缺少一次性提交限制。`reviewKind` 入参也未参与身份核对。当前“completed”仍不能独立证明审核来源可信。见基线 `src/tools.ts:48–69`、`src/engine.ts:120–135`。
2. FACT 证据只有元数据校验，尚无来源访问、SHA 可解析性和引用原文蕴含检查。`ai-conversation` 过滤工具事件且未覆盖 history 分页，不能替代原始工具轨迹。见基线 `src/review-runtime.ts:42–63`。
3. 产品初审的前端限制与服务端阶段推进仍有差异；按本轮“一项问题做透”的边界保留为后续。
4. 重命名会产生新 commit 并使确认失效，但基线未像 save/restore/patch.accept 一样清除旧 Ready 包、退回共审和使旧 Patch 过期。见基线 `src/engine.ts:187–196`。需要单独修复及回归。
5. 当前桌面 DSH `0.2.1-rc.3` 的 API 兼容和加载验收独立于本轮准入规则修复。不能宣称此构建可直接用于该实例。
6. 原始 turn/end 已为 MISSING_CREDENTIAL 错误时，插件 run 仍显示 running；当前门会拒绝 Ready，但界面不能准确区分模型失败和仍在运行。见[原始异常](live/credential-failure-events.jsonl)和[当时 API 状态](live/observed.json)。需另行接通会话结束与审核 run 状态同步，不能通过伪造 completed 绕过。

最终[独立离线核对](independent-verification.json)已实际执行：从两个导出 bundle 克隆新仓库；校验来源 Git 对象、Ready 中正文与 Git 正文一致、27 对工具事件、3 次非错误审核提交、Ready 哈希及源码/构建哈希；证据目录未发现扫描的授权凭证值。验收脚本语法检查和 `git diff --check` 通过。本报告记录发布前的验收快照；后续提交和发布状态以 Git 与 npm 记录为准。
