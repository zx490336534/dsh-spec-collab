# 独立复核本轮真实 DSH 验收

先读 [报告](../report.md)。自动化准入回归不依赖模型或 DSH 服务；真实模型输出具有不确定性，不能把本次空 findings 当作所有重跑都会得到的结果。

## 离线核对本次已执行证据

在仓库根目录执行；使用全新临时目录，不覆盖已有工作区。

```sh
READY_REVIEW_ROOT=$(mktemp -d)
git clone docs/acceptance/ready-admission-2026-10-27/live-final/fixture.bundle "${READY_REVIEW_ROOT:?}/source"
git clone docs/acceptance/ready-admission-2026-10-27/live-final/spec-history.bundle "${READY_REVIEW_ROOT:?}/spec"
git -C "${READY_REVIEW_ROOT:?}/source" show fcf74a7cd303ce0fe3c35a332acb0ca3025a34b5:src/submission.ts
git -C "${READY_REVIEW_ROOT:?}/spec" show 9b5a4eee6b1936e8de3ef15c3371381d126050e2:requirements/隔离验收-超时重试需求-49bb25b0/spec.md
git -C "${READY_REVIEW_ROOT:?}/spec" rev-parse 9b5a4eee6b1936e8de3ef15c3371381d126050e2^
```

最后一行应返回 `d12cf52e961bf6aa929e88b0dcb8ebbe700bc912`。对照 [来源核验](source-verification.json) 和 [正文差异](spec-diff.txt)。

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const base='docs/acceptance/ready-admission-2026-10-27/live-final/'
const rows=readFileSync(base+'tool-events.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line))
const results=new Map(rows.filter(row=>row.type==='tool/result').map(row=>[row.data.message.source.callId,row]))
const calls=rows.filter(row=>row.type==='tool/call')
assert.equal(calls.length,27)
for(const call of calls)assert.ok(results.has(call.data.callId))
const submissions=calls.filter(row=>row.data.name==='spec_submit_review')
assert.deepEqual(submissions.map(row=>row.seq),[2503,4341,5508])
for(const call of submissions)assert.ok(results.get(call.data.callId).data.message.content.every(block=>block.type!=='tool-result'||!block.isError))
const ready=JSON.parse(readFileSync(base+'ready.json','utf8')).requirement.readyPackage
assert.equal(createHash('sha256').update(readFileSync(base+'Ready.md')).digest('hex'),ready.packageHash)
assert.equal(ready.commit,'9b5a4eee6b1936e8de3ef15c3371381d126050e2')
console.log({pairedCalls:calls.length,successfulReviewSubmissions:submissions.length,commit:ready.commit,packageHash:ready.packageHash})
JS
```

这会验证全部工具调用配对、三次审核提交的工具结果、Ready 正文哈希及固定版本。它不证明 27 次调用都成功；[索引](trace-index.json) 明确记录 15 次错误。seq 599/600 的原 read 返回、seq 2934 的原 Spec 返回可在 [原始工具事件](tool-events.jsonl) 中直接检查，不能以摘要代替。

## 重跑确定性准入回归

```sh
pnpm run typecheck
pnpm test
node scripts/verify-ready-admission.mjs --baseline 311b9f7 --output /tmp/ready-before
node scripts/verify-ready-admission.mjs --output /tmp/ready-after
```

基线应为 9 失败、3 通过，exit 1；修复后为 12/12，exit 0。源代码版本不同则以各次 metadata 的源码和测试 SHA-256 为准。脚本支持 `--node /absolute/path/to/node`；本机实际测试 Node 为 `/Users/zhongxin/.hermes/node/bin/node`，避免桌面签名 Node 加载第三方原生模块的 Team ID 限制。

## 重跑真实宿主

前提：Node 24、Git、zstd、pnpm 11，以及自己有权使用的模型供应商配置。临时凭证已清除，证据目录不包含可直接复用的密钥。请保持当前桌面实例与原业务账本独立。

1. 创建真实路径规范化后的 `dsh-ready-live-*` 临时根目录，并建立 project、data、dsh-home 子目录。把 [运行时清单](../live/runtime/package.json)、[pnpm 配置](../live/runtime/pnpm-workspace.yaml)、[lock](../live/runtime/pnpm-lock.yaml) 和 [官方 boot 启动器](../live/runtime/acceptance-boot.mjs) 放在临时 runtime 目录，在那里运行 `pnpm install --frozen-lockfile`。
2. 对该独立 DSH_HOME 用已安装的 CLI 初始化 Web profile，并执行 `plugin --profile web add -w link:<本仓库绝对路径>`。profile 根配置保持 `[]`，bundle 为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-spec-collab`。这些步骤仅准备临时 profile。
3. 在临时 profile 的私有 patch 中配置自己的 `llm-pi-ai` 与 `agent-default-model`。本次实际为 route `magpie-responses`、model `codex/gpt-6.1-sol`，通过临时凭证服务中的 `MAGPIE_GATEWAY_KEY` 读取授权凭证。不要把值写入仓库、日志或本文件。
4. 在同一私有 patch 中加 `spec-collab.config.dataRoot=<临时根>/data`、`repositoryPath=<临时根>/data/repository`、`defaultContext.documentPaths=[README.md,src/submission.ts]`。这两条路径必须显式设置，不能仅修改 DSH_HOME。
5. 从本仓库运行 `node --experimental-transform-types scripts/seed-ready-acceptance.mjs <临时根>`。它拒绝覆写已有账本，创建有两行源码的独立 Git fixture，并生成 seed 元数据。初审、二审与初始确认明确为合成前置。
6. 从临时 project 目录，以独立 DSH_HOME 和 `READY_ACCEPTANCE_PORT=<空闲 loopback 端口>` 运行启动器。它使用官方 boot 和完整 profile，省略标准旧 CLI 不兼容的配置监听步骤。确认启动输出包含 `apiProxyAvailable: true`，Spec `/state` 只含一条该 fixture。
7. 建立独立输出目录，把 [refined-spec.md](refined-spec.md) 复制进去。运行下面的公开 HTTP 操作脚本，其中 root/url/output 都使用新值：

```sh
node scripts/live-ready-acceptance.mjs --phase request --url <loopback-url> --root <临时根> --output <独立输出目录>
node scripts/live-ready-acceptance.mjs --phase observe --url <loopback-url> --root <临时根> --output <独立输出目录>
node scripts/live-ready-acceptance.mjs --phase refine --url <loopback-url> --root <临时根> --output <独立输出目录>
node scripts/live-ready-acceptance.mjs --phase running --url <loopback-url> --root <临时根> --output <独立输出目录>
node scripts/live-ready-acceptance.mjs --phase observe --url <loopback-url> --root <临时根> --output <独立输出目录>
node scripts/live-ready-acceptance.mjs --phase generate --url <loopback-url> --root <临时根> --output <独立输出目录>
```

不要连续调用 observe 忙轮询：应看 SSE `/api/spec-collab/events` 或宿主日志，等待真实 run 发生变化。`refine` 编码的是本轮具体发现和验收选择；若新模型输出不同，先逐条核对来源并调整处置，不能用脚本自动忽略新阻塞。`generate` 会断言真实预审 completed、六门通过，再由测试角色对当前版本确认和生成。

完成后停止自己创建的验收进程，保留测试账本和 Git，删除临时凭证及私有 provider 配置。当前桌面 DSH 0.2.1-rc.3、新宿主接口兼容、GUI 点击及完整 Playwright 仍属于本轮未通过的验证项目。
