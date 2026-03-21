# OpenClaw 处理方式 vs 当前项目对比

## 目的

这份文档回答两个问题：

1. OpenClaw 是如何处理 agent loop / tools / context / prompt 的
2. 我们当前项目和它相比，差距在哪里

说明：

- OpenClaw 部分基于其官方文档，不是我本地直接跑了它的源码。
- 我们当前项目部分基于本地代码：`src/agent/index.ts`、`src/config.ts`、`src/services/handle-message.ts` 等。

## 一、OpenClaw 的处理方式

### 1. OpenClaw 把 agent loop 当成“完整运行时”而不是一个函数

根据 OpenClaw 官方文档，agent loop 不是一个简单的：

- 读消息
- 调模型
- 调工具
- 回答

而是一整条运行时链路：

- intake
- context assembly
- model inference
- tool execution
- streaming replies
- persistence

官方文档明确说，它是“single, serialized run per session”，也就是：

- 每个 session 的 agent run 是串行的
- 整个 run 会带生命周期事件
- 工具、assistant delta、最终状态都是流式事件的一部分

参考：
- OpenClaw Agent Loop: https://docs.openclaw.ai/concepts/agent-loop

### 2. OpenClaw 有真正的 session 级串行化和队列系统

官方文档描述：

- runs are serialized per session key
- optionally through a global lane

这意味着它不是“某个函数自己 while 一下”那么简单，而是：

- 每个会话有执行 lane
- 避免并发 tool/session race
- 保证历史一致性

这点很关键，因为真正的 agent runtime 最怕：

- 同一会话同时跑多个 loop
- 工具结果交叉写入
- session history 混乱

参考：
- Agent Loop / Queueing + concurrency: https://docs.openclaw.ai/concepts/agent-loop

### 3. OpenClaw 的 system prompt 是运行时动态组装的，不是手写一大段硬编码后直接塞进去

官方文档明确说：

- system prompt is OpenClaw-owned
- rebuilt each run
- assembled from fixed sections

这些 section 包括：

- tool list
- safety
- skills list
- workspace
- docs location
- bootstrap files
- sandbox info
- current date/time
- runtime metadata

也就是说，OpenClaw 的 prompt 不是“写死一份人格词 + 工具说明”这么简单，而是运行时把系统状态拼进去。

参考：
- System Prompt: https://docs.openclaw.ai/concepts/system-prompt

### 4. OpenClaw 对 context 有明确分层，而不是把所有东西混成 messages

OpenClaw 的 context 文档把上下文拆得很清楚：

- system prompt
- conversation history
- tool calls + tool results
- attachments/transcripts
- compaction summaries
- hidden provider overhead

并且它还有：

- `/context list`
- `/context detail`
- compaction
- pruning

也就是说，OpenClaw 把“上下文是怎么构成的、哪些东西在消耗 token”当成一等公民处理，而不是隐式拼接。

参考：
- Context: https://docs.openclaw.ai/concepts/context

### 5. OpenClaw 的 tools 是一等工具系统，不只是本地几条 allowlist 命令

官方文档对 tools 的定义是：

- tools are typed functions the agent can invoke
- skills teach the agent when/how
- plugins package channels/providers/tools/skills together

也就是说它是三层结构：

1. Tools: 可调用能力
2. Skills: 告诉模型什么时候、怎么用
3. Plugins: 把能力打包成扩展系统

这和“代码里手写几个工具 + 正则判断何时调用”是两套复杂度。

参考：
- Tools and Plugins: https://docs.openclaw.ai/tools

### 6. OpenClaw 有专门的 tool-loop detection 机制

官方文档明确给了 tool-loop detection：

- repeated same-tool + same-params patterns
- known polling patterns
- ping-pong patterns
- warningThreshold / criticalThreshold / circuit breaker

这意味着 OpenClaw 已经把“agent 在同一个工具上打转”当成正式问题来处理，而不是靠临时补丁避免。

参考：
- Tool-loop detection: https://docs.openclaw.ai/tools/loop-detection

### 7. OpenClaw 有 hook / plugin interception 点

官方文档列出了这些 hook：

- before_model_resolve
- before_prompt_build
- before_tool_call
- after_tool_call
- tool_result_persist
- agent_end
- before_compaction / after_compaction

这说明 OpenClaw 的架构核心是：

- 运行时流程可插拔
- prompt 构建可插拔
- tool 调用前后可插拔
- 结果落盘前可插拔

这类设计能显著减少“为了一个需求去改核心 agent loop”的情况。

参考：
- Agent Loop / Hook points: https://docs.openclaw.ai/concepts/agent-loop

## 二、我们当前项目的处理方式

### 1. 我们现在的 loop 还是一个本地函数级实现

当前核心逻辑在：

- `src/agent/index.ts`
- `runAgent(messages)`

它的结构本质是：

1. 用当前 messages 判断下一步
2. 返回 `respond` 或 `call_tool`
3. 如果调工具，就执行
4. 把结果写回 `workingMessages`
5. 继续下一轮

这是“有 loop”，但还只是一个轻量 agent executor，不是完整 runtime。

### 2. 我们没有真正的 session run orchestration

虽然 `handleMessage` 里有：

- memory service
- event dedupe
- chat rate limit

但这不等于 OpenClaw 那种：

- per-session serialized lane
- global queue lane
- lifecycle stream
- wait API
- run state management

目前更像“收到一条消息，直接跑一次 `runAgent`”。

### 3. 我们的 prompt 仍然偏硬编码，即使已经做了文件化

现在我们虽然把：

- `SYSTEM_PROMPT`
- `AGENT_PLANNER_PROMPT`

迁到了 `prompts/` 文件中，但本质还是：

- 一段主 system prompt
- 一段 planner prompt
- 由代码做少量拼接

它还没有达到 OpenClaw 那种“运行时按 section 组装完整系统态”的程度。

### 4. 我们的 context 还是 message list 驱动，不是 context engine

当前 `runAgent` 的上下文主要就是：

- memory 里的对话历史
- 当前 user message
- tool_result / tool_error system message

这能工作，但缺点是：

- 没有上下文可视化
- 没有 token 构成分析
- 没有 compaction / pruning 策略
- 没有独立 context engine 抽象

### 5. 我们的工具选择一部分靠规则，一部分靠 planner JSON

当前结构是：

- `inferToolDecision(...)` 先做规则匹配
- 命中就直接选工具
- 不命中再让模型输出 JSON planner 决策

这比纯模型自由调用更可控，但也带来几个问题：

- 规则越来越多会越来越硬编码
- 新增场景要不停补正则
- planner 和 rule engine 是两套逻辑
- 规则判断和多轮状态之间容易打架

这和 OpenClaw 的“工具 + skills + runtime prompt”路线明显不同。

### 6. 我们没有成熟的 loop guardrail，只是最近修补了一个具体 bug

我们这次修了：

- 有 tool_result 后，不再对同一条 user message 重复规则选工具
- 对单步工具问题直接返回结果
- 模型返回 HTML 错页时做兜底

但这还是 case-by-case 修补，不是 OpenClaw 那种通用 loop detection 机制。

### 7. 我们没有 plugin / hook 扩展面

当前如果你想改：

- prompt build
- tool call 前处理
- tool result 后处理
- session end 行为

基本都得直接改核心代码。

而 OpenClaw 把这些点都抽成 hook/plugin 了。

## 三、核心差异总结

### OpenClaw 更像“完整 agent runtime”

OpenClaw 关注的是：

- session 串行化
- lifecycle
- queue
- prompt assembly
- context inspection
- compaction
- hook/plugin
- tool loop detection
- streaming
- persistence

### 我们当前更像“一个轻量 agent loop demo / 最小可用实现”

我们已经有：

- 多轮 loop
- 工具执行
- tool result 回填
- prompt 文件化
- 基础 memory
- 基础限流与去重

但还缺：

- 真正 runtime orchestration
- context engine
- 通用 loop guardrail
- hooks / plugin architecture
- structured event stream
- 更系统化的 prompt assembly

## 四、如果你要朝 OpenClaw 的方向演进，优先级应该是什么

### 第一优先级：把“规则选工具 + planner JSON + tool loop”拆成更清晰的 runtime 层

建议拆成：

- session run orchestration
- planner / executor 分离
- tool result persistence
- final reply shaping

不要继续把所有逻辑堆在 `runAgent` 里。

### 第二优先级：把 prompt assembly 做成结构化构建器

不要再把 prompt 当成大字符串。

建议拆成 section：

- identity
- runtime
- tools
- workspace/project context
- memory summary
- planner policy

这样才接近 OpenClaw 的处理方式。

### 第三优先级：加 loop detection / no-progress detection

这是我们当前最缺的运行时保护之一。

至少要记录：

- 最近 N 次 tool call
- tool name
- normalized args
- result hash / error hash

然后判断：

- same tool + same args repeated
- same failure repeated
- no-progress loop

### 第四优先级：减少硬编码 rule engine 的占比

不是说规则必须删掉，而是应该降级成：

- fast-path optimization
- obvious single-step requests

而不是成为主要 tool routing 机制。

### 第五优先级：引入 hook / middleware 机制

至少要让这些点可插：

- before_prompt_build
- before_tool_call
- after_tool_call
- before_final_answer
- on_run_end

不然系统会越来越难改。

## 五、最直接的结论

如果你说“我想要类似 OpenClaw 那种处理方式”，那真正的意思不是：

- 把当前 `runAgent` 再多写几个 if/else
- 再补几条正则
- 再补几段 prompt

而是要承认：

**OpenClaw 的核心不是一个更聪明的 `runAgent`，而是一套完整的 agent runtime 架构。**

我们现在已经有 loop 的雏形，但整体仍然停留在：

**可工作的最小 agent executor**

而不是：

**完整、可扩展、可观测、可治理的 agent runtime**

## 六、参考来源

### OpenClaw 官方文档

- Agent Loop: https://docs.openclaw.ai/concepts/agent-loop
- System Prompt: https://docs.openclaw.ai/concepts/system-prompt
- Context: https://docs.openclaw.ai/concepts/context
- Tools and Plugins: https://docs.openclaw.ai/tools
- Tool-loop detection: https://docs.openclaw.ai/tools/loop-detection

### 当前项目本地代码

- `src/agent/index.ts`
- `src/config.ts`
- `src/services/handle-message.ts`
- `src/agent/tool-runner.ts`
- `src/agent/tool-registry.ts`
