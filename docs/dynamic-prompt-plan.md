# 动态 Prompt 方案

## 目标

把当前项目从“大字符串 prompt + 正则规则 + 局部补丁”的方式，演进到更接近 agent runtime 的动态 prompt 结构。

核心目标不是让 prompt 更长，而是：

- 分层
- section 化
- 运行时注入状态
- planner / answer / recovery 分离

## 一、为什么要做动态 Prompt

当前问题：

1. prompt 仍然有较多硬编码
2. planner prompt 和 answer prompt 结构混杂
3. 工具、状态、步骤信息没有统一组装层
4. `inferToolDecision(...)` 承担了过多硬编码路由职责
5. loop 状态没有被完整反映到 prompt 里

动态 Prompt 的核心价值是：

- 让模型能感知运行时状态
- 让 prompt 可维护
- 降低硬编码规则扩张速度
- 为后续 runtime 分层打基础

## 二、Prompt 分层设计

建议拆成 4 类 prompt。

### 1. Core System Prompt

作用：

- 定义身份
- 定义语言
- 定义回答风格
- 定义总体原则

特点：

- 较稳定
- 不承担具体规划逻辑
- 不关心每轮 step 状态

### 2. Planner Prompt

作用：

- 专门决定下一步动作
- 输出结构化决策
- 只负责：`respond` 或 `call_tool`

特点：

- 强依赖运行时状态
- 必须动态
- 应包含 step、tools、recent results、recent errors、loop warning

### 3. Answer Prompt

作用：

- 基于当前已有上下文生成最终用户答复
- 不再做规划
- 不再决定工具

特点：

- 和 planner 职责严格分离
- 只关注“如何回答”

### 4. Recovery Prompt

作用：

- 工具失败时收尾
- planner 异常时收尾
- 达到最大步数时收尾

特点：

- 负责限制说明
- 负责基于已有结果给出最佳可用答案

## 三、运行时应注入哪些动态字段

动态 Prompt 不应该只依赖静态文件，而应注入当前运行时状态。

建议注入这些字段：

### 1. `step`

- 当前是第几轮

### 2. `maxSteps`

- 最大允许轮数

### 3. `remainingSteps`

- 剩余轮数

### 4. `currentTime`

- 当前时间

### 5. `workspace`

- 当前工作目录

### 6. `toolList`

- 当前可用工具列表
- 工具说明
- 参数说明

### 7. `recentToolCalls`

- 最近几轮调用过哪些工具

### 8. `recentToolResults`

- 最近几轮工具结果摘要

### 9. `recentToolErrors`

- 最近几轮工具错误摘要

### 10. `loopWarning`

- 是否出现重复调用
- 是否出现无进展

### 11. `conversationSummary`

- 历史摘要
- 不应无脑塞全量消息

### 12. `latestUserGoal`

- 当前用户真正的目标

## 四、Section 化设计

Prompt 不应该手写成一整块长字符串，而应拆成 section builder。

### Planner Prompt 建议 section

1. `Identity Section`
   - 当前角色是 planner

2. `Runtime Section`
   - step/maxSteps/currentTime/workspace

3. `Tool Section`
   - tool list
   - tool usage hints

4. `State Section`
   - recent tool calls
   - recent tool results
   - recent tool errors
   - loop warnings

5. `Task Section`
   - latest user goal
   - current conversation summary

6. `Policy Section`
   - 什么时候直接答
   - 什么时候调工具
   - 什么时候停止

7. `Output Contract Section`
   - 只能输出 JSON
   - schema 固定

### Answer Prompt 建议 section

1. `Identity Section`
2. `User Goal Section`
3. `Relevant Context Section`
4. `Tool Result Section`
5. `Tool Error Section`
6. `Answer Policy Section`

### Recovery Prompt 建议 section

1. `Identity Section`
2. `Failure State Section`
3. `Known Result Section`
4. `Known Error Section`
5. `Recovery Policy Section`

## 五、建议的 Prompt Builder 接口

建议新建统一的 prompt builder 模块，而不是在 `src/agent/index.ts` 里继续堆字符串。

例如：

```ts
buildCoreSystemPrompt(ctx)
buildPlannerPrompt(ctx)
buildAnswerPrompt(ctx)
buildRecoveryPrompt(ctx)
```

上下文结构建议类似：

```ts
type PromptContext = {
  step: number;
  maxSteps: number;
  remainingSteps: number;
  currentTime: string;
  workspace: string;
  latestUserGoal: string;
  conversationSummary?: string;
  tools: ToolSummary[];
  recentToolCalls: ToolCallSummary[];
  recentToolResults: ToolResultSummary[];
  recentToolErrors: ToolErrorSummary[];
  loopWarning?: string;
};
```

## 六、Planner Prompt 模板草案

```text
[IDENTITY]
You are the planning layer of an agent runtime.

[RUNTIME]
step={{step}}
max_steps={{maxSteps}}
remaining_steps={{remainingSteps}}
current_time={{currentTime}}
workspace={{workspace}}

[USER_GOAL]
{{latestUserGoal}}

[TOOLS]
{{toolList}}

[RECENT_TOOL_ACTIVITY]
{{recentToolCalls}}

[RECENT_RESULTS]
{{recentToolResults}}

[RECENT_ERRORS]
{{recentToolErrors}}

[LOOP_WARNING]
{{loopWarning}}

[POLICY]
- Prefer direct response if enough evidence already exists.
- Call a tool only if it materially improves correctness.
- Do not repeat the same ineffective tool call.
- If a tool failed, adapt.
- Choose only the next best action.

[OUTPUT]
Return JSON only:
{"action":"respond","answer":"..."}
or
{"action":"call_tool","tool":"tool_name","arguments":{"key":"value"}}
```

## 七、Answer Prompt 模板草案

```text
[IDENTITY]
你是 CLAW-MINI，一个中文 AI 助手。

[GOAL]
基于现有上下文直接回答用户，不再规划，不再调用工具。

[USER_GOAL]
{{latestUserGoal}}

[RELEVANT_CONTEXT]
{{conversationSummary}}

[TOOL_RESULTS]
{{recentToolResults}}

[TOOL_ERRORS]
{{recentToolErrors}}

[POLICY]
- 优先使用已获得的事实
- 不编造
- 不暴露内部推理
- 结果不足时明确指出限制
- 输出简洁、直接、中文
```

## 八、Recovery Prompt 模板草案

```text
[IDENTITY]
你是 CLAW-MINI，一个中文 AI 助手。

[STATE]
模型规划或工具执行出现异常。

[USER_GOAL]
{{latestUserGoal}}

[KNOWN_RESULTS]
{{recentToolResults}}

[KNOWN_ERRORS]
{{recentToolErrors}}

[POLICY]
- 不编造缺失信息
- 明确说明限制
- 基于已有结果给出最佳可用答案
```

## 九、落地后应弱化或移除的旧结构

如果按这个方案落地，当前这些东西应该逐步弱化：

1. `makePlannerSystemPrompt()` 的大字符串硬编码
2. `makeDirectAnswerSystemPrompt()` 的大字符串硬编码
3. `inferToolDecision(...)` 作为主要 tool router 的地位
4. 依赖正则硬编码去判断大量用户意图

## 十、建议落地顺序

### 第一步

先新建 `prompt-builder.ts`，不要立刻重写整个 runtime。

### 第二步

把当前 planner prompt、answer prompt、recovery prompt 拆开。

### 第三步

先注入这些动态字段：

- step
- maxSteps
- currentTime
- tool list
- recent tool results
- recent tool errors

### 第四步

再逐步压缩 `inferToolDecision(...)`，把它降级成少量 fast-path。

### 第五步

最后再考虑：

- conversation compaction
- loop detection
- prompt section registry

## 十一、结论

动态 Prompt 的本质不是：

- 写更长的 prompt
- 再补更多规则

而是：

- prompt 分层
- section 化
- runtime state 注入
- planner / answer / recovery 分离

这也是当前项目从“最小 agent executor”走向“更完整 agent runtime”的必要一步。
