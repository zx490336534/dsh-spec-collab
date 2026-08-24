# v0.3.0 数据迁移、回滚与隐私边界

## 升级行为

v0.3.0 首次启动时读取 `collaboration-v2.json`，完成校验后在内存中转换为 v3，再通过临时文件、`fsync` 和原子 `rename` 写入 `collaboration-v3.json`。写入前会生成 `collaboration-v2.backup-<timestamp>.json`；原始 v2 文件始终保留。

迁移可以重复执行。若 v3 已存在，插件直接读取 v3，不再次覆盖；若数据损坏、schema 未知或迁移失败，启动会显示阻塞错误，不会创建空账本。

## 回滚到 v0.2.1

1. 停止当前 DSH Web 进程。
2. 安装或切换回插件 v0.2.1。
3. 重新启动。v0.2.1 继续读取未被修改的 `collaboration-v2.json`。

不要删除或改名 `collaboration-v3.json`。重新升级到 v0.3.0 后，插件会继续使用现有 v3 数据，不会用旧 v2 反向覆盖。

## 本地草稿

未正式保存的正文按 `requirementId + participantId` 保存在浏览器 IndexedDB。草稿不会跨浏览器或设备同步。只有点击“保存到版本库”或按 `Cmd/Ctrl+S`，正文才会写入 Git 并生成 commit。

## 客户数据隐私

客户与公司记录只允许显示名、公司名和外部编号。协议和界面均不提供邮箱、电话、凭证或附件字段。客户重要度只作为决策信号，不参与 Ready 强制门禁。
