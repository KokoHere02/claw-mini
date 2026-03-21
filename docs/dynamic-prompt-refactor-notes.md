# 动态 Prompt 重构记录

## 本次改动

本次没有重写整个 agent runtime，只做了最小可行重构：

- 新增 `src/agent/prompt-builder.ts`
- 把 planner / answer / recovery prompt 从 `src/agent/index.ts` 中抽离
- 改成按运行时上下文动态组装 prompt
- 保留现有 `runAgent` 主循环和大部分行为，降低改动风险

## 新增文件

- `src/agent/prompt-builder.ts`

## prompt-builder 当前职责

### 1. `buildPlannerPrompt(ctx)`

动态注入：

- 当前 step / maxSteps / remainingSteps
- 当前时间
- 当前工作目录
- 用户最近目标
- 当前工具列表
- 最近工具活动
- 最近上下文摘要

### 2. `buildAnswerPrompt(ctx)`

用于普通收尾回答，动态注入：

- system prompt
- step/maxSteps
- 当前时间
- 工作目录
- 用户目标
- 最近上下文
- 最近工具活动

### 3. `buildRecoveryPrompt(ctx, reason)`

用于失败或达到步数上限时的收尾 prompt。

## `runAgent` 当前变化

`src/agent/index.ts` 里的这几个静态 prompt 构建职责已经移除：

- `makePlannerSystemPrompt()`
- `makeDirectAnswerSystemPrompt()`

现在改为：

- planner 阶段调用 `buildPlannerPrompt(...)`
- 普通 fallback 阶段调用 `buildAnswerPrompt(...)`
- max-steps recovery 阶段调用 `buildRecoveryPrompt(...)`

## 这次重构的意义

重点不是“prompt 内容变多了”，而是：

- prompt 已开始与 runtime state 绑定
- prompt 组装职责从主循环中剥离
- 后续可以继续往 section registry / context engine 演进

## 还没有改的部分

这次故意没有动这些点：

1. `inferToolDecision(...)` 仍然存在
2. `runAgent` 主循环结构基本不变
3. 没有引入真正的 context compaction
4. 没有引入 loop detection registry
5. prompt section 还没有进一步拆到更细粒度 builder

## 下一步合理方向

### 方案 A

继续重构 `inferToolDecision(...)`，把它降级成少量 fast-path。

### 方案 B

继续拆 `prompt-builder.ts`：

- `buildRuntimeSection()`
- `buildToolSection()`
- `buildRecentToolSection()`
- `buildConversationSection()`
- `joinSections()`

### 方案 C

把 `PromptContext` 单独提成类型文件，并且引入 tool activity summary builder。

## 当前结论

本次重构已经把系统从：

- 静态 prompt 字符串散落在 `runAgent`

推进到：

- 动态 prompt builder 独立模块
- planner / answer / recovery 分层

这还不是 OpenClaw 那种完整 runtime，但已经是朝那个方向迈出的第一步。
