# 目录与命名规范化（2026-03-30）

## 本次改动范围
本次只做了低风险、可直接落地的命名规范化，不改业务逻辑。

## 修改前/修改后

### 服务层文件命名
- `src/services/handle-message.ts` -> `src/services/message-handler.ts`
- `src/services/message-content.ts` -> `src/services/message-content-parser.ts`
- `src/services/message-debug.ts` -> `src/services/message-debug-formatter.ts`

### 测试与脚本命名
- `src/tests/vitest/handle-message.spec.ts` -> `src/tests/vitest/message-handler.spec.ts`
- `src/tests/agent-tools.ts` -> `src/tests/manual-agent-tools.ts`
- `src/tests/task-agent.ts` -> `src/tests/manual-task-agent.ts`

### 脚本入口同步
- `package.json`
  - `"test": "scripts\\tsx-utf8.cmd src/tests/agent-tools.ts"`
  - -> `"test": "scripts\\tsx-utf8.cmd src/tests/manual-agent-tools.ts"`
  - `"test:task-agent": "scripts\\tsx-utf8.cmd src/tests/task-agent.ts"`
  - -> `"test:task-agent": "scripts\\tsx-utf8.cmd src/tests/manual-task-agent.ts"`

## 引用同步情况
已同步更新以下引用，避免重命名后路径失效：
- `src/adapters/long-connection.ts`
- `src/routes/feishu.ts`
- `src/services/message-handler.ts`
- `src/services/user-message-builder.ts`
- `src/tests/vitest/message-handler.spec.ts`

## 规范化原则（本次采用）
- 文件名优先表达“职责”而非“动作过程”。
- `parser`/`formatter`/`handler` 后缀用于区分模块职责。
- 手工脚本与自动化测试在命名上区分：`manual-*` 明确非单测入口。

## 后续建议（暂未执行）
- 可考虑把 `src/tests/manual-*.ts` 迁移到 `src/examples/` 或 `scripts/`，进一步区分“示例脚本”和“测试代码”。
- 可在项目根目录增加统一命名约定文档（如 `docs/naming-conventions.md`）。
