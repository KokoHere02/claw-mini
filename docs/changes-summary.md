# 本轮改动总结

本文档总结本轮新增功能与优化点，按模块说明改动内容、涉及文件和作用。

## 一、Agent 工具调用优化

### 1. AI 决定是否调用哪个工具

目的：

- 去掉原来基于关键词规则的工具推断
- 改成由模型根据用户输入决定是否调用工具

涉及文件：

- `src/agent/index.ts`

改动内容：

- 将 `inferToolDecision` 从规则匹配改成基于模型的结构化输出
- 使用 `generateObject + zod schema` 代替脆弱的 JSON 文本解析
- 保留失败兜底，不让工具推断错误直接打断主流程

带来的效果：

- 工具选择更灵活
- 更容易扩展工具
- 降低规则硬编码维护成本

### 2. 工具直接返回策略优化

目的：

- 不再依赖关键词决定是否直接返回工具结果
- 改成由工具元数据控制

涉及文件：

- `src/agent/index.ts`
- `src/agent/tool-types.ts`
- `src/agent/tools/get-current-time.ts`
- `src/agent/tools/calculate-expression.ts`

改动内容：

- 为 `ToolDefinition` 增加 `directReturn?: boolean`
- `shouldReturnDirectToolAnswer` 改成读取工具元数据
- `get_current_time`、`calculate_expression` 标记为可直接返回

带来的效果：

- 主流程不再绑定大量工具名判断
- 新增工具时更容易配置行为
- 保持“简单问题快速返回”的能力

### 3. 工具展示文本下沉到工具层

目的：

- 去掉 agent 主流程里的工具名分支格式化逻辑
- 让工具自己返回可展示文本

涉及文件：

- `src/agent/index.ts`
- `src/agent/tools/get-current-time.ts`
- `src/agent/tools/calculate-expression.ts`
- `src/agent/tools/http-request.ts`
- `src/agent/tools/run-command.ts`

改动内容：

- 删除主流程中的 `formatToolAnswer`
- 改成读取工具结果里的 `displayText`
- 各个工具补充 `displayText`

带来的效果：

- agent 只负责编排，不再负责按工具名组装回答
- 工具职责更完整
- 后续扩展工具时不必改 agent 主流程

### 4. run-command 工具改成命令字符串模式

目的：

- 不再使用固定命令 ID（pwd/ls/cat）模式
- 允许 AI 生成更灵活的只读命令

涉及文件：

- `src/agent/tools/run-command.ts`
- `src/agent/index.ts`

改动内容：

- `run_command` 的参数改成单个 `command` 字符串
- 工具层做安全校验
- 禁止链式命令、重定向、写操作、危险 git 操作、网络类命令
- 仅允许一组只读命令前缀
- 更新 AI 提示词，让模型产出安全命令字符串

带来的效果：

- 命令调用比旧版更灵活
- 安全边界仍保留在工具层
- AI 决定执行什么，工具决定允不允许执行

## 二、Phase 4 记忆管理

### 1. MemoryStore 扩展 summary 字段

目的：

- 每个 chatId 不再只保存 recent messages
- 为后续动态 prompt 和摘要压缩提供基础

涉及文件：

- `src/services/memory.ts`

改动内容：

- 新增 `SessionMemory`
- 每个 session 现在包含：
  - `recentMessages`
  - `summary`
- 新增接口：
  - `getSession`
  - `getSummary`
  - `updateSummary`
  - `replaceRecentMessages`

带来的效果：

- memory 从“短期消息缓存”升级成“带 summary 的会话状态”

### 2. summary 注入 prompt

目的：

- 让 Agent 在回复时看到会话摘要

涉及文件：

- `src/agent/dynamic-prompt.ts`
- `src/services/handle-message.ts`

改动内容：

- 新增 `buildSummaryContextMessage(summary)`
- 在消息进入 `runAgent` 前，把 summary 以 `system` message 的形式插入对话上下文

带来的效果：

- 旧上下文可压缩后继续参与后续推理
- 为后续长会话和动态 prompt 打基础

### 3. 自动摘要生成

目的：

- 当 recent messages 过多时，把旧消息压缩成 summary
- 保留最近几条消息继续作为原始上下文

涉及文件：

- `src/services/memory-summarizer.ts`
- `src/services/handle-message.ts`

改动内容：

- 新增 `maybeSummarizeSession`
- 在回复落库后尝试摘要
- 超过阈值时：
  - 压缩较旧消息
  - 更新 summary
  - 只保留最近若干条原始消息
- 摘要失败只记录日志，不影响正常回复

带来的效果：

- 会话不会无限堆积原始消息
- 后续 prompt 更稳定可控

### 4. summary prompt 可配置

目的：

- 不把摘要模型提示词写死在代码里
- 支持后续按业务调 prompt

涉及文件：

- `prompts/memory-summary.default.txt`
- `src/config.ts`
- `src/services/memory-summarizer.ts`

改动内容：

- 新增默认摘要 prompt 文件
- 新增配置项：
  - `MEMORY_SUMMARY_PROMPT_FILE`
  - `MEMORY_SUMMARY_PROMPT`
- `memory-summarizer` 改为读取配置中的 prompt

带来的效果：

- 摘要策略可以独立调整
- 和 system/planner prompt 的配置方式保持一致

### 5. summary 行为可配置

目的：

- 不把摘要触发条件和保留消息数写死在代码里

涉及文件：

- `src/config.ts`
- `src/services/memory-summarizer.ts`

改动内容：

- 新增配置项：
  - `MEMORY_SUMMARY_TRIGGER_MESSAGE_COUNT`
  - `MEMORY_SUMMARY_KEEP_RECENT_MESSAGE_COUNT`
- `memory-summarizer` 改为读取配置值

带来的效果：

- 可以按不同场景调节摘要频率
- 更适合后续调优上下文长度

### 6. 调试命令支持

目的：

- 快速观察当前 memory 和 summary 是否工作正常

涉及文件：

- `src/services/feishu.ts`
- `src/services/handle-message.ts`

改动内容：

- 新增命令：
  - `#summary` / `/summary`
  - `#memory` / `/memory`
- 直接在消息入口短路返回当前 summary 或 memory 状态

带来的效果：

- 可以直接从飞书查看摘要结果
- 排查 memory 行为更方便

## 三、记忆持久化

### 1. 文件仓储抽象

目的：

- 让 memory 不只存在于进程内存
- 为后续切换 SQLite 做接口准备

涉及文件：

- `src/services/memory-repository.ts`
- `src/services/file-memory-repository.ts`

改动内容：

- 抽出 `MemoryRepository` 接口
- 新增 `FileMemoryRepository`
- 基于 JSON 文件读写 `SessionMemory`

带来的效果：

- 持久化层和业务层分离
- 后面可以替换存储实现而不大改 `MemoryService`

### 2. MemoryService 接入持久化

目的：

- 写入、更新、删除 memory 时同步落盘
- 服务重启时可恢复会话记忆

涉及文件：

- `src/services/memory.ts`
- `src/services/handle-message.ts`

改动内容：

- `MemoryService` 支持注入 `MemoryRepository`
- `getSession` 内存 miss 时从 repository 加载
- 以下操作自动持久化：
  - `appendExchange`
  - `updateSummary`
  - `replaceRecentMessages`
  - `resetConversation`
- 在消息入口注入 `FileMemoryRepository`

带来的效果：

- 服务重启后仍可恢复历史 summary 和 recent messages

### 3. 默认存储目录独立到用户目录

目的：

- 让持久化文件不污染项目目录

涉及文件：

- `src/config.ts`

改动内容：

- 默认 `MEMORY_STORAGE_DIR` 改为：
  - `~/.claw-mini/memory`
- 仍支持通过环境变量覆盖

带来的效果：

- 数据目录更独立
- 更符合本地应用缓存/状态存储习惯

### 4. 启动时清理过期 memory 文件

目的：

- 防止会话文件无限累积

涉及文件：

- `src/services/memory-cleaner.ts`
- `src/index.ts`
- `src/config.ts`

改动内容：

- 新增 `cleanupExpiredMemoryFiles`
- 服务启动时执行一次 TTL 清理
- 新增配置项：
  - `MEMORY_TTL_DAYS`
- 默认 TTL 为 30 天

带来的效果：

- 旧会话文件会在启动时自动清理
- 文件数量不会无上限增长

## 四、文档补充

### 1. Agent 代码方案文档

涉及文件：

- `docs/agent-code-plan.md`

作用：

- 总结 Router / Profile / Loop / Tool Runtime 的推荐架构

### 2. Phase 4 记忆管理文档

涉及文件：

- `docs/phase4-memory-plan.md`

作用：

- 说明 summary、userFacts、dynamic prompt 的设计方向

### 3. 持久化方案文档

涉及文件：

- `docs/phase4-memory-persistence-plan.md`

作用：

- 说明为什么先做文件持久化，以及后续迁移 SQLite 的路径

## 五、当前状态总结

本轮完成的核心能力：

- Agent 工具选择从规则改成 AI 决策
- 工具结果展示逻辑下沉到工具层
- 引入 summary 作为会话长期上下文
- 自动生成 summary 并注入 prompt
- memory 已支持文件持久化
- 启动时会清理过期 memory 文件
- 支持通过飞书命令调试当前 summary / memory

当前这套系统已经具备：

- 短期记忆
- 会话摘要
- 动态 prompt 注入
- 基础持久化
- 启动清理

Phase 4 目前已经从“设计阶段”进入“可运行 MVP 阶段”。

## 六、飞书附件处理说明

### 1. 当前支持的消息类型

目前消息链路支持：

- `text`
- `image`
- `file`
- `post`

处理路径是：

1. `src/services/handle-message.ts` 接收飞书事件
2. `src/services/message-content.ts` 解析消息内容
3. `src/services/user-message-builder.ts` 下载飞书附件
4. 转换成模型输入后交给 `runAgent`

### 2. 为什么 `.docx` 会报 `Bad Request`

`.docx` 是 Office 文档。

当前系统并没有先把 `.docx` 解包提取成纯文本，而是尝试把附件走模型文件输入链路。
在这条链路下，部分模型网关或 OpenAI 兼容网关会直接返回：

- `APICallError`
- `Bad Request`

因此问题通常不是“飞书下载失败”，而是“当前模型请求路径不接受原始 `.docx` 二进制”。

### 3. 现在代码里的处理方式

在 `src/services/user-message-builder.ts` 中，附件目前按三类处理：

- 文本类文件：先解码成纯文本，再作为文本输入交给模型
- PDF：保留为文件输入
- Office 文档：提前拦截，直接返回明确错误

也就是说目前的能力边界是：

- `.txt`、`.md`、`.json`、`.csv` 等文本文件可以处理
- `.pdf` 可以继续透传
- `.docx`、`.xlsx`、`.pptx` 这类 Office 文件暂不直接支持

### 4. 为什么要提前拦截 Office 文档

提前拦截比直接把 `.docx` 发给模型更合理，原因是：

- 错误更明确
- 避免无意义的模型请求
- 用户看到的是“当前不支持”，而不是模糊的 400

正确的未来支持路径应该是：

`飞书文件 -> 本地解析 Office 内容 -> 提取文本 -> 再交给模型`

而不是：

`飞书文件 -> 原始 .docx 二进制 -> 直接交给模型`

### 5. 为什么新建文档文件时被沙箱拦住

本次原本计划新增一个独立文档：

- `docs/feishu-attachment-handling.md`

但在调用 `apply_patch` 新建这个文件时，工具连续返回：

- `windows sandbox: setup refresh failed with status exit code: 1`

这说明失败点不在补丁内容本身，而在当前 Windows 沙箱刷新阶段。

从现象上看：

- 修改已有文件也在这一轮被同样错误拦截
- 失败发生在 `apply_patch` 进入真正写入之前

所以本次改为尝试把说明写入现有文档 `docs/changes-summary.md`，避免信息丢失。

## 七、Task Agent 的 Bad Request 警告说明

### 1. 现象

运行 `npm run test:task-agent` 时，任务可能已经执行成功，但日志里会反复出现：

```txt
AI_APICallError: Bad Request
url: https://api-vip.codex-for.me/v1/chat/completions
```

这说明某条内部模型调用失败了，但主流程后续还有兜底，所以功能还能继续跑。

### 2. 根因

真正触发警告的不是 Phase 5 的任务编排本身，而是旧 Agent 主循环里的快速工具判断分支：

- 文件：`src/agent/index.ts`
- 函数：`inferToolDecision(...)`

这条分支原来使用的是：

```ts
generateText(...)
```

当前项目使用的网关：

```txt
https://api-vip.codex-for.me/v1
```

对这条调用路径兼容性不稳定，所以会出现：

1. `inferToolDecision(...)` 先发起一次模型请求
2. 网关返回 `400 Bad Request`
3. 代码进入 `catch`
4. 日志打印警告
5. 主流程继续走后面的 planner 或 answer 路径

所以这个问题本质上是：

- 一条可选 fast-path 失败了
- 主流程没死
- 但日志很脏

### 3. 为什么 Task Agent 更容易看到这个警告

因为当前 `step-executor` 是复用旧的：

- `runAgent(messages)`

也就是说，Task Agent 的每个步骤执行时，都会进入旧 Agent loop。

而旧 Agent loop 一开始就会尝试 `inferToolDecision(...)`。

所以只要这条分支和当前网关不兼容，任务每跑一步，都可能额外打一条 `Bad Request` 警告。

### 4. 已做修复

修复文件：

- `src/agent/index.ts`

修复方式：

- 把 `inferToolDecision(...)` 从 `generateText(...)` 改成：

```ts
streamText(...) + stepCountIs(1)
```

原因是：

- 当前项目其他主链路大量使用 `streamText(...)`
- 这条路径在现有网关上更稳定
- 比 `generateText(...)` 更不容易触发 `400 Bad Request`

### 5. 修复后的预期效果

修复后：

- fast-path 工具判断能力仍然保留
- Task Agent 仍然正常执行
- 日志里的 `AI_APICallError: Bad Request` 警告应显著减少或消失

### 6. 以后再出现类似问题怎么排查

如果再次看到：

```txt
AI_APICallError: Bad Request
```

建议按这个顺序排查：

1. 先看是哪条日志 message 打出来的
2. 找到对应函数
3. 看它用的是 `generateText`、`generateObject` 还是 `streamText`
4. 优先把不稳定分支统一到当前项目已经验证过的调用方式

### 7. 当前结论

这次警告不是因为：

- 任务编排设计错了
- 工具执行错了
- Task Agent 整体方案不可用

而是因为：

- 旧 Agent loop 里还有一条快速工具判断分支
- 那条分支用了对当前网关兼容性较差的调用方式

解决方法就是：

- 不重写整套任务编排
- 只把这条分支统一到更稳定的 `streamText(...)` 路径

## 八、为什么已经 `await` 了流，还是会出现 JSON 解析报错

### 1. 现象

日志里会出现类似报错：

```txt
[agent] failed to parse planner JSON
SyntaxError: Unexpected token '\\'
```

并且从调用栈看，问题出在：

- `src/agent/index.ts`
- `planNextStep(...)`

看起来像是：

- 明明已经 `await` 等待了 `streamText(...)`
- 为什么拿到的还是“不完整 JSON”

### 2. 根因

这次问题的关键不是：

- 流还没收完
- `await` 没生效
- SDK 提前返回半截文本

真正的问题是：

**模型返回的是“完整的错误格式文本”，不是“半截文本”。**

也就是说，代码确实已经拿到了完整输出，但这个输出长得像：

```txt
"\n    {\n      \"action\": \"respond\", ... }"
```

或者：

```txt
```json
{
  "action": "respond",
  "answer": "..."
}
```
```

甚至可能是：

- JSON 外面又包了一层字符串
- 带转义换行 `\n`
- 带代码块 fence
- 前后夹杂其他说明文本

所以报错本质上不是“没等完”，而是：

- 代码按“纯 JSON 对象文本”去解析
- 实际拿到的是“字符串化 JSON”或“包装过的 JSON”

### 3. 为什么会报 `Unexpected token '\\'`

因为像这种内容：

```txt
"\n    {\n      \"action\": ... }"
```

在第一次直接 `JSON.parse(...)` 时，返回的可能是：

- 一个字符串

而不是：

- 一个对象

如果后续代码继续把它当成普通对象 JSON 去处理，就会在某一层再次解析时遇到转义字符，最终抛出：

```txt
Unexpected token '\\'
```

这说明：

- 内容已经完整
- 只是格式和预期不一致

### 4. 已做修复

这次修复不是去改 `await`，而是去改“JSON 文本解析层”。

修复文件：

- `src/agent/index.ts`
- `src/agent/task-planner.ts`
- `src/services/memory-summarizer.ts`

新增思路是统一使用一层更鲁棒的 `parseJsonLikeText(...)`：

1. 先尝试直接 `JSON.parse(trimmed)`
2. 如果 parse 结果还是字符串，就递归再 parse 一次
3. 如果不是纯 JSON，就先从文本里提取 `{...}`
4. 再做一次 `JSON.parse(...)`
5. 如果 parse 结果还是字符串，再递归解包
6. 最后再交给 schema 或业务校验

### 5. 修复后的效果

修复后，这几类返回都能兼容：

- 纯 JSON 对象文本
- fenced JSON
- 被包成字符串的 JSON
- 带转义换行的 JSON 文本
- 前后带少量说明文本的 JSON

也就是说，现在系统不再要求模型必须返回“最完美”的 JSON 形式，而是允许一定程度的包装和转义。

### 6. 当前结论

如果以后再看到类似报错，先不要默认认为：

- 流没收完
- `await` 不可靠
- SDK 有问题

更常见的真实原因是：

- 模型已经完整返回了内容
- 但它返回的是“格式不标准的 JSON 文本”
- 所以需要更鲁棒的解包和解析策略

这次的正确修复方向不是：

- 改流式等待逻辑

而是：

- 改 JSON 兼容解析层

## 九、本轮任务编排改动总结

### 1. 这轮主要做了什么

本轮核心目标是把系统从“单轮 agent loop”推进到 Phase 5 的“任务编排”能力。

也就是让系统具备：

- 多步任务分解
- 顺序执行
- 进度反馈
- 结果合成

同时，在真正接入主流程的过程中，又顺手修了一批由于模型网关兼容性、JSON 格式不稳定、日志输出链路导致的问题。

### 2. 新增的主要功能

#### 2.1 任务编排核心类型

新增文件：

- `src/agent/task-types.ts`

新增内容包括：

- `TaskRunStatus`
- `TaskStepStatus`
- `TaskStep`
- `TaskPlan`
- `TaskRun`
- `TaskProgressEvent`
- `TaskExecutionReport`
- `TaskOrchestrationResult`

作用：

- 给 Phase 5 的任务计划、步骤状态、进度事件、最终执行结果提供统一数据结构
- 后续 planner、orchestrator、step executor、synthesizer 都围绕这些类型协作

#### 2.2 任务计划生成器

新增文件：

- `src/agent/task-planner.ts`

作用：

- 根据当前对话生成结构化 `TaskPlan`
- 把用户请求拆成 1 到 5 个顺序步骤
- 每一步包含：`id / title / goal / expectedOutput`

代码含义：

- 这是 Phase 5 的“计划层”
- 先做计划，再执行步骤，而不是像原来一样完全靠 loop 临场决定所有动作

#### 2.3 任务编排器

新增文件：

- `src/agent/task-orchestrator.ts`

作用：

- 负责完整任务生命周期
- 先调用 `buildTaskPlan(...)`
- 然后按顺序逐步执行每一个 step
- 更新 step 状态
- 发出 progress event
- 最后调用 synthesizer 合成最终答案

代码含义：

- 这是 Phase 5 的“调度层”
- 它不关心每一步具体怎么做，只关心任务如何从 `planning -> running -> completed/failed`

#### 2.4 默认步骤执行器

新增文件：

- `src/agent/step-executor.ts`

作用：

- 把当前任务中的某一个 step，转换成旧 `runAgent(...)` 能理解的一组上下文消息
- 然后复用原本的 agent loop 执行当前 step

代码含义：

- 这是“桥接层”
- 它让我们不用立刻重写旧的 `runAgent`，就能把它收缩成“单步骤执行器”来为 Phase 5 服务

#### 2.5 最终结果合成器

新增文件：

- `src/agent/result-synthesizer.ts`

作用：

- 根据 `TaskRun` 构造 `TaskExecutionReport`
- 再基于执行报告生成最终用户回答

代码含义：

- 这是“收尾层”
- 它把步骤执行结果整合成最终答复，而不是让模型只凭最后一轮上下文临场发挥

#### 2.6 独立任务入口

新增文件：

- `src/agent/task-agent.ts`

作用：

- 把 `task-planner + task-orchestrator + step-executor + result-synthesizer` 串起来
- 对外提供统一入口：`runTaskAgent(...)`

代码含义：

- 这是新任务编排主链路的门面
- 主流程只需要调它，不需要自己拼装四个模块

#### 2.7 Task Agent 测试入口

新增文件：

- `src/tests/task-agent.ts`

同时更新：

- `package.json`

新增脚本：

- `test:task-agent`

作用：

- 本地直接测试 `runTaskAgent(...)`
- 输出计划、步骤进度、最终答案、任务快照

### 3. 主流程接入的改动

修改文件：

- `src/services/handle-message.ts`

改动内容：

- 原来主流程调用的是 `runAgent(conversation)`
- 现在改成调用 `runTaskAgent({ messages, onProgress })`

同时新增了任务进度日志：

- `task planned`
- `task step started`
- `task step completed`
- `task step failed`
- `task completed`
- `task failed`

代码含义：

- 飞书消息入口现在已经正式切到 Phase 5 编排链路
- 旧 `runAgent` 仍然保留，但已经退居到“步骤执行器内部复用”的角色

### 4. 做过的优化

#### 4.1 收紧步骤执行器的工具使用倾向

修改文件：

- `src/agent/step-executor.ts`

问题：

- 接入 Phase 5 后，step executor 有时会倾向于为了求稳而去读文件或调工具
- 即使当前对话和前序步骤里已经有足够信息，也可能额外走 `run_command`

优化方式：

- 在 step 上下文里加强提示：
  - 只有在确实提升正确性时才使用工具
  - 如果已有对话或前一步结果足够，就直接回答
  - 不要无意义地读文件、列目录、重复调工具

效果：

- 降低不必要工具调用
- 保留需要真实取证时的读文件能力

#### 4.2 单步成功任务直接返回步骤结果

修改文件：

- `src/agent/result-synthesizer.ts`

问题：

- 对于“现在几点”“算个表达式”这类简单任务，工具已经得到正确结果
- 如果仍然走最终模型合成，模型反而可能把答案改坏

优化方式：

- 如果整个任务只有 1 个成功步骤且没有失败步骤，直接返回该步骤结果
- 不再调用模型做最终合成

效果：

- 简单任务回归到更稳定、更直接的行为
- 减少模型合成误伤正确结果的概率

#### 4.3 步骤执行场景里的 `directReturn` 工具强制直出

修改文件：

- `src/agent/index.ts`

问题：

- 原来的 `shouldReturnDirectToolAnswer(...)` 更偏向普通聊天场景判断
- 接入 step executor 后，某些本该直接返回的工具结果没有及时返回

优化方式：

- 如果当前上下文里存在 `[TASK_EXECUTION_CONTEXT]`
- 并且工具本身带 `directReturn: true`
- 那么直接返回工具结果

效果：

- `get_current_time`、`calculate_expression` 这类工具在 Phase 5 下也能保持原有直出体验

### 5. 修复过的主要问题

#### 5.1 Task Planner 首跳 `Bad Request`

问题现象：

- `task-agent` 一开始就报 `AI_APICallError: Bad Request`
- 连 `planned` 都没打印出来

根因：

- `task-planner.ts` 最早版本使用了 `generateObject(...)`
- 当前 OpenAI-compatible 网关对这条结构化输出路径兼容性不稳定

修复方式：

- 改成 `streamText(...)`
- 强制模型返回 JSON 文本
- 再在本地解析 JSON

效果：

- Task planner 能在当前网关下稳定工作

#### 5.2 `inferToolDecision(...)` 持续刷 `Bad Request` 警告

问题现象：

- Task Agent 最终能执行成功
- 但日志里反复出现：
  - `AI_APICallError: Bad Request`
  - `[agent] ai tool inference failed`

根因：

- 旧 Agent loop 里有一条快速工具判断分支 `inferToolDecision(...)`
- 它使用的是 `generateText(...)`
- 当前网关对这条路径兼容性不稳定

修复方式：

- 把 `inferToolDecision(...)` 也统一改成：
  - `streamText(...) + stepCountIs(1)`

效果：

- 减少或消除这类兼容性 warning

#### 5.3 为什么已经 `await` 了流，还是会 JSON 解析失败

问题现象：

- planner / task planner / memory summarizer 明明已经等完整个流
- 还是报 JSON parse 错误

根因：

- 不是“流没收完”
- 而是模型返回的是“完整但格式不标准的 JSON 文本”
- 例如：
  - JSON 被包成字符串
  - 带转义换行
  - fenced JSON
  - 前后带说明文本

修复方式：

- 新增统一的 `parseJsonLikeText(...)`
- 支持：
  - 直接 parse
  - parse 出字符串后递归再 parse
  - 从混合文本中提取 `{...}` 再 parse

已应用到：

- `src/agent/index.ts`
- `src/agent/task-planner.ts`
- `src/services/memory-summarizer.ts`

效果：

- JSON 兼容性显著提升
- 不再把“格式不标准但内容完整”的输出误判成半截流

#### 5.4 `get_current_time` 工具已成功执行，但最终回答却说“无法确定时间”

问题现象：

- 日志显示：
  - planner 已选择 `get_current_time`
  - 工具已成功执行
  - 已拿到 `displayText`
- 但最后回复给用户的不是时间，而是错误或空洞总结

根因：

- Phase 5 接入后，简单 direct-return 工具的正确结果仍然被后续步骤或最终合成重新处理
- 结果被模型改坏了

修复方式：

- 步骤执行场景下，`directReturn` 工具强制直出
- 单步成功任务跳过结果合成，直接返回步骤结果

效果：

- “现在几点”“算个表达式”这类简单问题重新回到原本正确行为

#### 5.5 conversation summary 刷新失败

问题现象：

- 日志出现：
  - `failed to refresh conversation summary`
  - `No JSON object found in text`

根因：

- `memory-summarizer.ts` 最早版本仍依赖严格 JSON 输出
- 当前网关或模型有时返回非标准格式文本

修复方式：

- 把 memory summarizer 也改成 `streamText(...) + parseJsonLikeText(...)`
- 如果模型摘要失败，再退化成本地 fallback summary

额外优化：

- 这类失败日志从 `warn` 降成了 `info`

效果：

- summary 系统更稳
- 不再因为模型格式波动就整轮失败
- 控制台噪音显著下降

### 6. 日志链路做过的处理

#### 6.1 Pino 中文乱码问题

问题现象：

- `console.log` 能正常输出中文
- `pino` 输出中文是乱码

修复方式：

- 开发环境不再强依赖 `pino` 输出
- `src/utils/logger.ts` 改成：
  - 生产环境继续用 `pino`
  - 开发环境改成 `console` 后端 logger

随后又补了：

- 时间前缀
- `INFO / WARN / ERROR` 颜色

效果：

- 开发环境中文日志恢复正常
- 保留基本可读性

#### 6.2 控制台刷大段乱码内容

问题现象：

- 某些日志会把完整消息内容、summary preview、原始错误对象整包打出来
- 一旦内容里有中文，在当前终端环境里会显得非常乱

修复方式：

- `handle-message.ts` 里不再直接打印完整 `event`
- 不再打印 `summaryPreview`
- 错误对象只保留精简字段：
  - `name`
  - `message`
  - `url`
  - `statusCode`

效果：

- 日志更聚焦
- 噪声更少
- 更适合排查真正问题

### 7. 这轮代码整体的意义

这轮不是单纯“补了几个文件”，而是做了两件更重要的事：

#### 7.1 正式把项目从“单体 agent loop”推进到“任务编排 runtime”

新增的 planner / orchestrator / step executor / synthesizer 这一套，意味着系统开始具备：

- 计划
- 执行
- 跟踪
- 汇总

而不是只靠旧 `runAgent(...)` 一轮轮临场决策。

#### 7.2 在接入 Phase 5 的过程中，把网关兼容性、JSON 解析、日志可观测性这些地基问题也一起补强了

否则就会出现：

- 任务编排写出来了
- 但动不动 `Bad Request`
- 动不动 JSON parse 失败
- 简单问题反而变差
- 日志还看不懂

这轮代码的价值就在于：

- 不只是把“任务编排骨架”搭起来
- 还把它真正推到了“能接主流程、能跑、能定位问题、能逐步稳定”的状态

### 8. 当前状态结论

到目前为止，这轮完成的核心结果是：

- Phase 5 的任务编排链路已经建成
- 主流程已经接入 `runTaskAgent(...)`
- 简单 direct-return 工具问题已修复回正确行为
- JSON 解析兼容性已显著增强
- summary 系统已加 fallback
- 日志可读性已恢复

当前系统已经不再只是：

- 一个单体 `runAgent`

而是已经具备：

- 任务计划
- 步骤执行
- 进度日志
- 最终结果合成
- 基础兜底和兼容层

后续如果继续演进，比较自然的方向会是：

- 增加 `#plan` / `#task` 调试命令
- 复用已读文件结果，减少重复 `run_command`
- 进一步优化结果合成策略
- 让 summary fallback 更智能

## 十、Pino 中文日志乱码的根因与修复

### 1. 现象

开发环境里出现了一个很典型的现象：

- `console.log('中文')` 能正常输出
- `pino` / `pino-pretty` 输出中文却是乱码

这会导致：

- 普通控制台测试看起来正常
- 但项目正式日志依然看不懂

### 2. 为什么不是业务代码的问题

这个问题不是：

- 消息内容编码错了
- 中文字符串本身坏了
- 业务逻辑把文本处理坏了

因为同一段中文：

- `console.log(...)` 正常
- `pino(...)` 异常

说明问题不在业务层，而在：

- 日志输出链路
- 终端编码环境
- Windows 控制台 code page

### 3. 根因

排查后发现，当前终端环境的 code page 不是 UTF-8，而是：

```txt
Active code page: 936
```

同时 PowerShell 侧的输出编码也不是 UTF-8。

这意味着：

- 开发环境控制台默认不是按 UTF-8 处理输出
- `pino` / `pino-pretty` 走到 stdout 时，很容易在当前 Windows 终端链路里把中文打坏

所以根因不是：

- `pino` 完全不能输出中文

而是：

- **当前 Windows 开发终端不是 UTF-8 输出环境，而 `pino` 正好更容易暴露这个问题**

### 4. 为什么之前临时换成 console logger 能缓解

之前临时把开发环境 logger 切成 `console` 后端后，现象会变好一些。

原因不是 `console` 比 `pino` 更“高级”，而是：

- `console.log` 在当前终端下对中文的处理路径和 `pino` 不完全一样
- 所以它看起来更正常

但这只是“绕开问题”，不是从根上解决问题。

### 5. 正确修复方式

这次最终采用的修复思路是：

#### 5.1 恢复 logger 到正式形态

文件：

- `src/utils/logger.ts`

处理方式：

- 恢复为 `pino + pino-pretty`
- 不再长期依赖临时的 console logger

这样日志能力本身仍然保持：

- level
- pretty output
- 时间戳
- 颜色

#### 5.2 在开发启动脚本里强制切换终端到 UTF-8

新增文件：

- `scripts/tsx-utf8.cmd`

内容核心是：

```cmd
chcp 65001 > nul
call node_modules\.bin\tsx.CMD %*
```

作用：

- 在真正启动 `tsx` 之前
- 先把 Windows 控制台 code page 切成 UTF-8

#### 5.3 更新 package.json 的脚本入口

修改文件：

- `package.json`

把这些脚本：

- `dev`
- `test`
- `test:task-agent`

统一改成通过：

- `scripts\tsx-utf8.cmd`

启动。

这样做的意思是：

- 不是每次手动切编码
- 而是让项目脚本默认就以 UTF-8 环境启动

### 6. 这次修复的本质

这次修复不是“继续调整 pino 配置”，而是承认一个更底层的事实：

- 日志框架没法单独拯救错误的终端编码环境

也就是说：

- 如果开发终端不是 UTF-8
- 那么你换 logger 风格、换 formatter、换 pretty，都只是局部补救

真正的根修方式是：

- **先把开发启动链路的编码环境切到 UTF-8，再让 pino 正常工作。**

### 7. 修复后的使用方式

之后开发环境建议都通过项目脚本启动，例如：

```bash
npm run dev
```

```bash
npm run test
```

```bash
npm run test:task-agent
```

而不要直接在一个未知编码状态的终端里手敲 `tsx ...`。

### 8. 当前结论

Pino 中文乱码的根因不是：

- Pino 本身不能打印中文
- 项目字符串编码错了
- 某段业务代码把文本弄坏了

真正原因是：

- **Windows 开发终端默认 code page 不是 UTF-8，导致 pino 输出链路中的中文显示异常。**

这次的正确修复方式是：

- 恢复正式 logger 方案
- 在开发启动脚本层统一切换到 UTF-8
- 让 `npm run dev / test / test:task-agent` 默认运行在正确编码环境下
