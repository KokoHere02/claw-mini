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

## 十一、任务编排 agent 的并发改造方案

### 1. 问题定位

当前 task agent 回消息慢，通常不是单点模型推理慢，而是主链路里有很多本可以并行的工作被串行了：

- 任务规划先跑一次
- 每个 step 再跑一次 agent loop
- step 内工具调用串行执行
- 回复前还做 summary 刷新、memory 落盘、清理

所以提速的关键不是“把所有东西并发”，而是把**可独立的读操作和后台收尾**拆出去。

### 2. 能并发的部分

可以并发的：

- 互不依赖的任务步骤
- 同一步里多个只读工具
- summary 刷新、memory 持久化、清理任务
- 多个外部信息源抓取

不要并发的：

- 有依赖关系的步骤
- 会修改状态的工具
- 发消息、写文件、更新 memory
- 需要严格顺序的推理链

原则很简单：

- 读可以并发
- 写要串行
- 依赖要串行

### 3. 最适合当前仓库的三种方案

#### 3.1 步骤分组并发

让 planner 不只输出 step list，还输出 `dependsOn` 或 `parallelGroup`。

执行器按 group 跑：

```txt
group 1 -> Promise.all([...steps])
group 2 -> Promise.all([...steps])
group 3 -> final synthesis
```

这是收益最高的方案之一，适合任务本身天然可拆分的场景。

#### 3.2 步骤内多工具并发

如果某一步需要多个独立信息源，就不要让 agent 一次只挑一个工具。

改成：

- 一次生成多个 tool call
- 只读工具并发执行
- 汇总后再进入下一轮

适合：

- 同时查多个 URL
- 同时读多个文件
- 同时做计算和时间查询

#### 3.3 主回复链路最小化

用户只关心什么时候收到回复，所以：

- 回复用户之前只保留必要工作
- summary 刷新和 memory 清理放到后台异步跑
- 如果飞书链路允许，先回一个“处理中”再继续算

这个方案对体感提升很明显，而且风险低。

### 4. 推荐执行模型

建议把执行器拆成三层：

#### 4.1 计划层

职责：

- 产出任务步骤
- 标注哪些步骤可并行
- 标注哪些步骤必须串行

建议结构：

```ts
type TaskStep = {
  id: string;
  title: string;
  goal: string;
  dependsOn?: string[];
  parallelGroup?: string;
};
```

#### 4.2 调度层

职责：

- 按依赖拓扑排序
- 把同组步骤同时发起
- 收集结果后再进入下一组

这层不关心工具细节，只负责调度。

#### 4.3 执行层

职责：

- 执行单个步骤
- 执行步骤内的工具
- 维护失败和重试

这层里只有只读工具适合 `Promise.all`。

### 5. 落地优先级

#### 第一优先级：把后台收尾移出主链路

先改：

- `src/services/handle-message.ts`
- `src/services/memory-summarizer.ts`
- `src/services/memory.ts`

做法：

- 先发用户回复
- summary 刷新和 memory 清理放到 `finally` 之后异步跑
- 失败只记日志，不阻塞回消息

这一步最稳，收益也最快。

#### 第二优先级：步骤级并发

再改：

- `src/agent/task-orchestrator.ts`
- `src/agent/task-planner.ts`
- `src/agent/task-types.ts`

做法：

- 让 planner 输出 `dependsOn` 或 `parallelGroup`
- orchestrator 对同组步骤使用 `Promise.all`
- 结果按步骤 id 回填

#### 第三优先级：步骤内工具并发

再改：

- `src/agent/step-executor.ts`
- `src/agent/tool-runner.ts`

做法：

- 允许一次执行多个只读工具
- 工具返回统一结构
- 合并工具结果后再回给模型

### 6. 风险点

#### 6.1 并发会放大错误

如果同一组里有一个工具超时，不能让整个任务卡死。

建议：

- 单工具超时
- 单步骤超时
- 组级别汇总错误

#### 6.2 并发会增加日志噪音

要给并发任务加上：

- step id
- group id
- tool name
- request id

否则出问题时很难排查。

#### 6.3 并发不等于更快的最终答案

如果 planner 仍然生成太细的串行步骤，收益会很有限。

所以并发方案要和 planner 一起改，不是只改 runner。

### 7. 最小可落地版本

如果只做一个最小版本，我建议这样：

1. 先把 `summary` 和 `memory` 的后台处理移出主回复链路
2. 再让 planner 输出 `parallelGroup`
3. orchestrator 对同组步骤并发执行
4. 最后再考虑步骤内多工具并发

这个顺序风险最低，也最容易观察效果。

### 8. 结论

这套项目要提速，最有效的方向是：

- 步骤级并发
- 步骤内只读工具并发
- 回复后的后台收尾

不要把所有 agent 流程硬并发。真正该并发的是：

- 能独立完成的读操作
- 能并行验证的信息源
- 不影响用户首包时间的收尾工作

如果只做一件事，优先做：

```txt
主回复链路最小化 + 后台收尾异步化
```

如果再做第二件事，再做：

```txt
planner 输出可并行步骤 + orchestrator 按组并发
```

## 十二、编码 Agent 的并发方案

目标不是“把 Agent 全部并发化”，而是把当前编码 Agent 里真正适合并发的部分拆出来，在不破坏正确性的前提下缩短响应时间。

### 1. 原则

Agent 并发的核心原则只有三条：

- 读操作可以并发
- 写操作尽量串行
- 有依赖的步骤必须串行

如果不先守住这三条，并发只会把错误放大。

### 2. 最适合并发的地方

#### 2.1 多源读取

例如：

- 同时读取多个文件
- 同时查看多个模块
- 同时抓多个外部信息源
- 同时跑多个只读命令

这类操作彼此独立，结果只是给后续分析提供素材，天然适合并发。

#### 2.2 独立子任务

如果任务可以拆成多个互不依赖的子任务，就不要强行线性执行。

例如：

- 一路分析前端目录
- 一路分析后端目录
- 一路检查测试入口

只要这些结果最后再汇总，就应该并发。

#### 2.3 后台收尾

用户不需要等待这些工作完成：

- 会话摘要刷新
- memory 落盘
- 启动清理
- 埋点和日志整理

这些工作放在主回复之后异步执行，收益通常立刻可见。

### 3. 不应该并发的地方

下面这些即使能并发，也不建议第一版做：

#### 3.1 有上下文依赖的步骤

例如：

- 先定位 bug
- 再修改代码
- 再跑验证

这类步骤前后有严格依赖，强行并发会让后面的结果建立在错误前提上。

#### 3.2 写操作

例如：

- 改同一个文件
- 更新会话状态
- 写磁盘
- 发送消息

这些动作如果并发，最容易产生竞态和覆盖。

#### 3.3 最终回答生成

最终回答通常依赖所有前序结果收敛，不应该和子任务并发生成。

### 4. 推荐的并发层次

#### 第一层：收尾异步化

这是最低风险的一层。

做法：

- 主链路只保留“理解请求 -> 生成答案 -> 发消息”
- 摘要、落盘、清理全部放后台

收益：

- 直接减少首包时间
- 基本不影响主逻辑

#### 第二层：步骤级并发

让任务编排能表达“哪些步骤互不依赖”。

建议 planner 输出：

```ts
type TaskStep = {
  id: string;
  title: string;
  goal: string;
  dependsOn?: string[];
};
```

然后 orchestrator 做一件事：

- 没有依赖关系的步骤并发执行
- 有依赖关系的步骤等前置完成后再执行

这是 Agent 并发里收益最大的部分。

#### 第三层：步骤内工具并发

当单个步骤需要多个只读工具时，不要让模型一轮只发一个工具。

适合并发的工具：

- 多文件读取
- 多 URL 请求
- 多个只读 shell 命令
- 多个静态检查任务

执行方式：

- 同一轮里发起多个只读工具
- 用 `Promise.allSettled` 收集结果
- 再把结果交给模型汇总

### 5. 最适合编码 Agent 的具体方案

#### 阶段 1：读并发，写串行

这是第一版最推荐的边界。

规则：

- 读文件可以并发
- 查找符号可以并发
- 读命令可以并发
- 改文件必须串行
- 运行验证可以视情况并发，但默认串行

这样能拿到大部分收益，同时控制复杂度。

#### 阶段 2：子任务并发

在需要较大范围分析时，把任务拆成多个独立 worker：

- worker A 看入口和路由
- worker B 看数据层
- worker C 看测试和脚本

最后由主流程汇总。

这里的关键不是多开线程，而是让任务结构本身支持并行。

#### 阶段 3：验证并发

当代码改动分布在不同区域，可以并发跑验证。

例如：

- 一边跑类型检查
- 一边跑单测
- 一边做只读静态扫描

但这一步必须注意资源占用，不能让验证把主机打满。

### 6. 推荐的数据结构

如果你已经有任务编排，建议最少补这两个字段：

```ts
type TaskStep = {
  id: string;
  title: string;
  goal: string;
  dependsOn?: string[];
  readonly?: boolean;
};
```

如果你已经支持工具调用，可以再加：

```ts
type TaskStepToolCall = {
  tool: string;
  arguments: Record<string, unknown>;
  readonly: boolean;
};
```

这样执行器就能用统一规则判断：

- `readonly === true` 的工具可以并发
- `readonly === false` 的工具必须串行

### 7. 执行器建议

并发不要直接塞进主 Agent loop 里，建议落在 orchestration 层和 tool runner 层。

#### 7.1 orchestrator 负责步骤并发

职责：

- 解析依赖关系
- 找出当前可运行步骤
- 并发执行这些步骤
- 汇总结果

#### 7.2 step executor 负责步骤内工具并发

职责：

- 判断当前步骤需要哪些工具
- 过滤只读工具
- 并发执行只读调用
- 把结果合并成步骤结果

#### 7.3 synthesizer 负责最终串行收敛

职责：

- 汇总所有步骤结果
- 生成最终回答

不要把 synthesizer 做成并发。

### 8. 错误处理原则

并发方案里最容易出问题的是失败传播，所以建议一开始就定清楚：

#### 8.1 用 `Promise.allSettled`

因为你通常希望：

- 一个读取失败，不至于整组崩掉
- 能收集部分结果继续分析

#### 8.2 每个并发单元都要有超时

否则某个外部调用卡住，整组任务都会拖死。

#### 8.3 并发结果必须带来源信息

至少保留：

- step id
- tool name
- 输入参数
- 成功或失败

否则后续很难排查。

### 9. 最小可落地版本

如果只做一轮最小改造，我建议顺序是：

1. 先完成主回复链路瘦身，把收尾都移出主链路
2. 再让 planner 支持 `dependsOn`
3. orchestrator 做步骤级并发
4. 最后才做步骤内工具并发

不要反过来先做工具并发。因为如果任务结构本身还是线性的，步骤内并发收益有限。

### 10. 推荐结论

对当前编码 Agent，最合理的并发方案是：

- 主链路最小化
- 步骤级并发
- 只读工具并发
- 写操作串行
- 最终答案串行收敛

也就是：

```txt
先并发读，再串行写，最后统一收敛
```

这条路线最稳，也最接近工程上真正可维护的 Agent 并发。

## 十三、Agent 并发改造实现总结

本文档总结当前这轮围绕任务编排 Agent 和编码 Agent 所做的并发改造，重点说明：

- 已经改了什么
- 为什么这样改
- 当前主流程如何接入
- 现阶段能力边界在哪里
- 已知风险和后续建议

### 1. 改造目标

这轮改造的目标不是把整个 Agent Runtime 全部并发化，而是把最有收益、最容易控制风险的几层并发先接进去：

1. 主回复链路瘦身
2. 任务步骤级并发
3. 单步骤内只读工具并发
4. 同任务内只读证据复用

整体原则是：

- 先并发读
- 保持写串行
- 最终答案串行收敛

### 2. 主流程接入情况

当前并发逻辑已经接入主流程，不是停留在独立测试代码里。

主链路如下：

1. 飞书消息入口在 `src/services/handle-message.ts`
2. 消息进入 `runTaskAgent(...)`
3. `runTaskAgent(...)` 在 `src/agent/task-agent.ts` 中调用 `runTaskOrchestration(...)`
4. `runTaskOrchestration(...)` 使用 `executeTaskStepWithAgentLoop`
5. `executeTaskStepWithAgentLoop` 就是当前已经带并发逻辑的 `src/agent/step-executor.ts`

也就是说：

- 飞书收到的真实消息已经会走到新的步骤并发和步骤内只读工具并发逻辑

### 3. 主回复链路瘦身

#### 3.1 改动目的

用户体感慢，最直接的来源之一是：

- 回消息前做了太多收尾工作

所以先把不影响用户首包时间的动作移出主路径。

#### 3.2 当前处理方式

在 `src/services/handle-message.ts` 中，成功路径已经改成：

1. 组织对话上下文
2. 调用 `runTaskAgent(...)`
3. 得到最终回复
4. 先发送消息
5. 再更新 memory
6. 再异步做 summary 刷新

同时还做了两件事：

- 成功链路拆进 `handleConversationMessage(...)`
- 错误链路拆进 `handleMessageError(...)`

这样 `handleMessage(...)` 本身只保留消息入口和分发逻辑。

#### 3.3 后台任务方式

没有引入统一队列。

当前使用的是轻量后台执行：

- `src/services/background-task.ts`

实现方式是：

- `setImmediate(...)`
- 包一层错误日志

也就是说当前只是：

- fire-and-forget 的后台收尾

而不是带顺序调度的任务队列。

#### 3.4 已异步化的收尾项

当前已移出主链路的主要收尾包括：

- 会话摘要刷新
- memory 持久化写入
- memory 删除
- 启动时的过期 memory 清理

### 4. 任务步骤级并发

#### 4.1 改动目的

之前 `task-orchestrator` 是严格线性执行：

- step1 跑完
- step2 才开始
- step3 再开始

这会把天然独立的步骤硬串行。

#### 4.2 数据结构变化

在 `src/agent/task-types.ts` 中，为 `TaskStep` / `TaskPlanStep` 增加了：

```ts
dependsOn?: string[];
```

作用是：

- 显式表达当前 step 依赖哪些前置 step

#### 4.3 planner 改动

在 `src/agent/task-planner.ts` 中做了三件事：

1. schema 支持 `dependsOn`
2. 提示词改成允许表达依赖，而不是默认纯线性
3. 本地做依赖归一化

归一化规则包括：

- 只保留合法 step id
- 只保留对更早 step 的依赖
- 去掉自依赖
- 去重

这样即使模型生成了脏依赖，也会被本地收敛。

#### 4.4 orchestrator 改动

在 `src/agent/task-orchestrator.ts` 中，原来的线性 `for` 循环被替换成了“按批次调度”：

1. 找到当前所有 `pending` 且依赖已满足的 step
2. 这些 step 同时标记为 `running`
3. 用 `Promise.allSettled(...)` 并发执行
4. 汇总本批次执行结果
5. 如果有失败，任务整体失败
6. 如果还有 pending step，继续下一批

#### 4.5 当前执行语义

当前不是任意 DAG 调度器，而是“最小可落地”的依赖批次执行：

- 同一批可运行步骤并发
- 依赖不满足的步骤等待
- 如果最终还有 pending step 但永远无法运行，则报：

```txt
Task plan contains unresolved step dependencies.
```

### 5. 单步骤内只读工具并发

#### 5.1 改动目的

即使进入某个具体 step，以前也还是：

- Agent 选一个工具
- 执行一个工具
- 再进入下一轮

这对“同一步里需要多个独立读取”的场景还是偏慢。

#### 5.2 改动位置

核心实现在：

- `src/agent/step-executor.ts`

这个文件已经从简单桥接层，演变成：

- 步骤上下文构造
- 只读工具并行规划
- 并发执行
- 结果回注入
- 再交给 `runAgent(...)` 做最终收敛

#### 5.3 只读工具标记

为了让执行器能区分哪些工具可并发，先给工具定义补了：

```ts
readonly?: boolean;
```

位置在：

- `src/agent/tool-types.ts`

当前已标记为只读的工具有：

- `get_current_time`
- `calculate_expression`
- `http_request`
- `run_command`

对应文件：

- `src/agent/tools/get-current-time.ts`
- `src/agent/tools/calculate-expression.ts`
- `src/agent/tools/http-request.ts`
- `src/agent/tools/run-command.ts`

#### 5.4 规划方式

在每个 step 内，会先单独调用一次模型做“并发只读工具规划”。

规划函数：

- `planParallelReadonlyTools(...)`

它会拿到：

- 当前 step 的 `id / title / goal / expectedOutput`
- 前序步骤摘要
- 当前可用只读工具列表

模型需要返回：

```ts
{
  toolCalls: Array<{
    tool: string;
    arguments?: Record<string, unknown>;
  }>
}
```

#### 5.5 规划约束

提示词里已经加了这些限制：

- 只允许选择只读工具
- 最多选择 N 个工具
- 工具之间必须独立
- 如果现有上下文足够，不要选工具
- 不要重复同一个证据读取

#### 5.6 执行方式

规划完成后，会进入：

- `executeParallelReadonlyTools(...)`

执行方式是：

- 对规划出的只读工具调用 `Promise.allSettled(...)`
- 每个工具执行前仍然走统一的 `runner.run(...)`
- 工具结果和错误都被转成标准消息

这样做的原因是：

- 单个读取失败不应该拖垮整个批次
- 部分成功结果仍然可以参与后续回答

#### 5.7 回注入方式

每个工具执行后，会把结果变成：

- assistant 的 `call_tool` 记录
- system 的 `[tool_result]` 或 `[tool_error]`

然后把这些消息追加到 step 上下文里，再调用：

- `runAgent(messages)`

所以当前设计不是“并发工具直接产出最终答案”，而是：

- 并发只负责更快取证
- 最终收敛仍交给现有 agent loop

### 6. 只读工具并发的预算控制

#### 6.1 改动目的

如果没有预算控制，并发层容易变成新的拖慢点：

- 规划太慢
- 工具批次太慢
- 超时后底层任务还在偷偷跑

所以先加最基本的预算边界。

#### 6.2 当前配置项

已在 `src/config.ts` 中增加：

```ts
AGENT_MAX_PARALLEL_READONLY_TOOLS
AGENT_PARALLEL_READONLY_PLAN_TIMEOUT_MS
AGENT_PARALLEL_READONLY_EXECUTION_BUDGET_MS
```

分别控制：

- 单步最多并发几个只读工具
- 工具规划允许耗时多久
- 整批只读工具执行允许耗时多久

#### 6.3 当前默认值

默认值为：

- 最大并发工具数：`3`
- 规划超时：`3000ms`
- 执行预算：`9000ms`

#### 6.4 超时策略

在 `step-executor.ts` 内部，用了局部 `withTimeout(...)` 包装：

- 规划阶段
- 并发执行阶段

如果这里失败，会：

- 打日志
- 回退到原始 `baseMessages`
- 继续走普通 `runAgent(...)`

也就是说：

- 并发层失败不会直接让 step 失败
- 会自动降级回原来的单步路径

### 7. 重复调用去重

#### 7.1 改动目的

模型在工具规划时，即使提示了“不要重复”，仍可能给出重复调用。

所以需要本地兜底去重。

#### 7.2 实现方式

在 `step-executor.ts` 中：

- 使用 `buildToolCallKey(...)`
- 按 `tool + arguments` 做 JSON key
- 对规划结果本地去重

这样可以避免同一步里：

- 同一个工具
- 用同一组参数
- 被重复执行多次

### 8. 任务内只读结果缓存

#### 8.1 改动目的

如果前面的步骤已经读取过同样证据，后面的步骤再读一次通常是浪费。

所以加了任务内只读缓存。

#### 8.2 缓存范围

当前缓存范围是：

- 同一个 `runTaskAgent(...)` 执行期内
- 只复用前序已完成步骤中的只读工具结果

不做：

- 跨会话缓存
- 跨请求缓存
- 磁盘缓存

#### 8.3 构建方式

在 `step-executor.ts` 中：

- `buildReadonlyToolCache(previousSteps)`

它会扫描前序步骤里的 `toolCalls`

筛选条件：

- `toolCall.result` 存在
- `toolCall.error` 不存在
- 工具元数据 `readonly === true`

#### 8.4 命中规则

缓存 key 仍然是：

- `tool + arguments`

只要完全一致，就直接命中。

#### 8.5 命中后的行为

命中缓存后：

- 不再真正执行工具
- 直接复用旧结果
- 日志里会增加 `cacheHits`

### 9. 缓存来源注入

#### 9.1 改动目的

只做缓存命中还不够，模型还需要知道：

- 这个结果是复用的
- 来自哪个前序步骤

否则模型容易把缓存结果误当成当前 step 新鲜读取的证据。

#### 9.2 当前实现

在 `ReadonlyToolCacheEntry` 里增加了：

```ts
sourceStepId: string;
sourceStepTitle: string;
```

并且在 `[tool_result]` system message 中注入：

- `cache: hit` / `cache: miss`
- `source_step_id`
- `source_step_title`

如果是当前 step 新执行得到的结果，则缓存条目会标成：

- `sourceStepId: "__current_step__"`
- `sourceStepTitle: "current step"`

#### 9.3 实际意义

这一步主要是为了稳定后续模型理解，不是为了提速本身。

它让模型能区分：

- 当前新读取的证据
- 从前序步骤复用过来的证据

### 10. 日志与可观测性

#### 10.1 当前新增日志

在 `step-executor.ts` 中新增了这些日志：

- `[task-step] planned parallel readonly tools`
- `[task-step] executed parallel readonly tools`
- `[task-step] failed to plan or execute parallel readonly tools`

#### 10.2 当前日志内容

会记录：

- `stepId`
- 计划的只读工具及参数
- 实际执行的只读工具
- 每个工具是否成功
- `cacheHits`
- 预算配置

#### 10.3 作用

这一步不是业务功能，但很关键，因为没有这些日志，后面几乎无法判断：

- 模型有没有真的规划并发
- 并发层是否在频繁降级
- 缓存是否生效

### 11. 测试入口

为了方便本地验证，已经补了一个 CLI 测试入口：

- `src/tests/task-agent.ts`

并且 `package.json` 里已有脚本：

```json
"test:task-agent": "scripts\\tsx-utf8.cmd src/tests/task-agent.ts"
```

当前这个测试入口会输出：

- 用户输入
- planner 生成的任务步骤
- 每一步的进度事件
- 最终回答
- 整个 `taskRun` 快照

可直接用于手工验证：

- 步骤级并发有没有生效
- 只读工具并发有没有生效
- `dependsOn` 是否合理
- `toolCalls` 是否记录到 step 上

### 12. 当前能力边界

到目前为止，这轮并发改造已经具备：

- 主链路瘦身
- 后台收尾异步化
- 任务步骤依赖表达
- 可运行步骤批次并发
- 单步骤内只读工具并发
- 只读工具数量和时间预算控制
- 重复只读调用去重
- 同任务内只读结果缓存
- 缓存来源回注入上下文
- 基本日志可观测

但还没有做这些：

- 真正可取消的超时中断
- 写操作并发控制
- 跨任务只读缓存
- 更细的优先级调度
- step 内部多轮工具规划
- 并发后的全面自动化测试

### 13. 已知风险

#### 13.1 direct-return 工具语义可能被削弱

当前步骤内预取只读工具后，结果会先作为上下文消息再交给 `runAgent(...)` 收敛。

这意味着某些本来适合“工具直出”的简单问题，可能被模型重新表述。

#### 13.2 timeout 只是包装层超时，不是真正取消

现在的超时只是让包装 Promise 失败，底层请求不一定真的停止。

也就是说：

- 超时预算能让主流程继续
- 但底层 fetch / shell / 模型调用可能还在跑

#### 13.3 并发规划提示仍然看不到完整已有上下文

当前并发只读工具规划主要看到：

- 当前 step
- 前序步骤摘要
- 工具列表

它没有直接看到全部 `input.messages`，因此仍可能产生一些多余读取。

### 14. 后续建议

如果继续往下迭代，最推荐的顺序是：

#### 14.1 先修 review 中的高优先级问题

尤其是：

- direct-return 工具的回归风险
- timeout 不可取消的问题

#### 14.2 再补验证

建议加：

- orchestrator 依赖批次测试
- step-executor 并发工具测试
- 缓存命中测试
- 降级路径测试

#### 14.3 最后再扩展更激进的并发

例如：

- step 内多轮并发规划
- 更复杂的 DAG 调度
- 跨任务缓存

在当前阶段，优先把已有并发路径做稳，比继续扩功能更重要。

---

# 取消链路改造方案

## 一、背景

当前项目已经有多处“超时控制”，但这些超时本质上只是包装层超时，不是真正的取消。

典型表现：

- step 超时后，orchestrator 不再等待该 step
- 工具超时后，调用方收到 rejected promise
- 但底层 LLM 请求、HTTP 请求、shell 命令仍可能继续执行

这会带来几个直接问题：

- 继续消耗模型/工具资源
- 已经超时的旧任务仍可能在后台跑完
- 旧任务结果可能晚到并污染日志、状态、memory，甚至继续向用户回写
- 后续如果加入“用户主动取消”，当前架构也无法真正停掉执行链路

所以这个问题不应继续通过 `Promise.race(...)` 或局部 `withTimeout(...)` 修补，而应该改成真正的 end-to-end cancellation。

## 二、当前现状

### 1. 包装层超时

当前主要是这两类：

- `src/agent/step-executor.ts`
- `src/agent/tool-runner.ts`

两处 `withTimeout(...)` 都是：

- 到时后 reject
- 但不会主动停止底层正在运行的异步操作

### 2. LLM 调用没有统一取消信号

当前多个模块都直接调用 `streamText(...)`：

- `src/agent/index.ts`
- `src/agent/step-executor.ts`
- `src/agent/task-planner.ts`
- `src/agent/result-synthesizer.ts`
- `src/services/memory-summarizer.ts`

这些调用点目前没有统一的 `AbortSignal` 透传。

### 3. 工具执行没有取消协议

当前 `ToolDefinition` 的签名是：

```ts
execute: (params: Record<string, unknown>) => Promise<unknown>;
```

这意味着：

- tool runner 无法把取消信号传给工具
- 工具实现也没有统一方式感知“任务已被取消”

### 4. 编排层只有 failed，没有 cancelled

当前 step 状态主要是：

- `pending`
- `running`
- `completed`
- `failed`

取消、超时、真实执行失败被混在一起，后续观测和重试策略会比较混乱。

## 三、目标

目标不是“更快返回超时错误”，而是：

1. 当 step 超时或用户主动取消时，底层执行链路尽量真正停止
2. 取消信号从入口一直传到最底层 LLM / HTTP / shell
3. 即使底层没有完全停住，也不能再把旧结果写回当前有效状态
4. 区分 `failed`、`cancelled`、`timed_out`，让日志和状态更准确

## 四、总体方案

核心思路：

- 用 `AbortController` / `AbortSignal` 替代“只在外层 reject 的 timeout”
- 在运行时上下文中透传 `signal`
- 所有可中断的底层操作都接收并响应该 `signal`
- 在状态层引入 `cancelled` / `timed_out`
- 增加 `runId` 或 generation guard，防止旧任务结果回写

可以概括成一句话：

> 从“调用方放弃等待”升级成“系统显式发出取消，并要求下游协同终止”。

## 五、分层改造设计

### 1. 运行时上下文层

建议给以下主链路统一增加可选 `signal`：

- `runTaskAgent(...)`
- `runTaskOrchestration(...)`
- `executeTaskStepWithAgentLoop(...)`
- `runAgent(...)`
- `buildTaskPlan(...)`
- `synthesizeTaskResult(...)`

建议引入一个统一运行时对象，避免后面继续把参数越传越散：

```ts
type ExecutionContext = {
  signal?: AbortSignal;
  runId: string;
  startedAt: number;
};
```

初期也可以不抽对象，先直接加 `signal?: AbortSignal`，降低改动面。

### 2. timeout 改造成 abort

现有：

```ts
withTimeout(promise, timeoutMs)
```

建议替换为“生成带超时的 signal”：

```ts
type TimeoutSignalResult = {
  signal: AbortSignal;
  dispose: () => void;
};
```

设计要求：

- 支持只靠 timeout 自动 abort
- 支持父 signal 已取消时级联取消
- 支持执行结束后清理 timer

推荐工具函数：

- `createTimeoutController(timeoutMs, parentSignal?)`
- `throwIfAborted(signal)`
- `isAbortError(error)`

这样 step 超时时，不是单纯 reject，而是：

- timeout 到期
- controller.abort(new Error(...))
- 下游收到 signal 并停止

### 3. LLM 层接入取消

所有 `streamText(...)` 调用都应透传统一 `signal`。

覆盖范围至少包括：

- task planning
- step 内并发只读工具规划
- `runAgent(...)` 主循环里的模型调用
- result synthesizer
- memory summarizer

如果 SDK 支持 abort，这一层能解决大部分“模型还在后台继续跑”的问题。

注意：

- 不能只在最外层 step 上挂 timeout，而中间又新建无父级 signal
- 每个子阶段如果有独立预算，应基于父 signal 派生子 controller
- 父级取消时，所有子阶段都必须同步失效

### 4. Tool Runtime 层改造

建议把工具签名改成：

```ts
type ToolExecutionInput = {
  params: Record<string, unknown>;
  signal?: AbortSignal;
};

type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (input: ToolExecutionInput) => Promise<unknown>;
  timeoutMs?: number;
  directReturn?: boolean;
  readonly?: boolean;
};
```

然后 `ToolRunner.run(...)` 也接收 `signal`。

执行策略：

- 先校验参数
- 合成 tool 自己的 timeout signal
- 把最终 signal 传给 `tool.execute(...)`
- 结束后清理 timeout 资源

这样工具层 timeout 就不再只是“runner 不等了”，而是真正通知工具停止。

### 5. 各类工具的取消方式

#### HTTP 工具

这是最容易改的一类。

方案：

- `fetch(url, { signal })`
- 收到 abort 后直接抛出 `AbortError`

#### shell / command 工具

这是最需要单独设计的一类。

如果命令工具基于 `child_process.spawn`：

- 创建子进程后保存句柄
- `signal` abort 时触发 `child.kill(...)`
- 同时处理 stdout/stderr 收尾

注意点：

- 要防止重复 kill
- 要区分“命令真的失败”与“命令是被取消”

如果当前实现不是 `spawn` 而是 `exec` / `execFile`，也应该确认其是否支持 `AbortSignal`，否则需要改到可控实现。

#### 纯同步/CPU 工具

如果某些工具是纯同步逻辑：

- 无法被外部硬中断
- 只能在执行前检查 `signal.aborted`
- 如果内部有循环，可在循环中间定期检查 `signal`

这类工具不是取消链路的重点，可以后补。

### 6. 编排层状态机

建议扩展 step / task run 状态：

- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`
- `timed_out`

至少需要做到：

- 用户主动取消时标记 `cancelled`
- 时间预算耗尽时标记 `timed_out`
- 真正的执行异常才标记 `failed`

这样后续日志、metrics、重试、告警才有意义。

### 7. 防旧结果回写

即使引入了 abort，仍然建议增加一层“结果有效性保护”。

原因：

- 某些下游库的取消不一定彻底
- shell 进程 kill 可能有延迟
- 网络请求可能已经进入不可逆阶段

建议为每次消息处理分配 `runId`，并在以下写操作前校验当前 run 是否仍有效：

- `sendTextMessage(...)`
- `memoryService.appendExchange(...)`
- summary refresh 写回
- 任何后续可能落库的执行结果

简化版做法：

- 每个 `chatId` 维护当前活跃 `runId`
- 新任务启动时覆盖旧 `runId`
- 旧任务即使晚完成，也因为 `runId` 不匹配而丢弃结果

这层保护非常重要，因为它解决的是“取消不彻底时的最终一致性问题”。

## 六、推荐落地顺序

### 第一阶段：先打通主取消链路

目标：

- 从 `handle-message` 到 `runTaskAgent` 到 `runAgent` 全链路支持 `signal`
- LLM 调用点全部支持取消

建议范围：

- `runTaskAgent`
- `runTaskOrchestration`
- `executeTaskStepWithAgentLoop`
- `runAgent`
- planner / synthesizer / summarizer / step 内 planner

这一阶段完成后，至少 LLM 请求不会在 step timeout 后继续长期占用资源。

### 第二阶段：工具层协议升级

目标：

- `ToolDefinition.execute(...)` 改为接收 `{ params, signal }`
- `ToolRunner.run(...)` 透传 signal
- 优先改掉 `http_request`
- 再改 `run_command`

建议优先级：

1. `http_request`
2. `run_command`
3. 其他可能有长耗时的工具

### 第三阶段：状态与结果保护

目标：

- 增加 `cancelled` / `timed_out`
- 加 `runId` 防旧结果回写
- 区分日志和错误处理路径

这一阶段完成后，系统行为会稳定很多，尤其是用户连续提问、重试、重复触发时。

## 七、最小可行版本

如果先做一个成本较低、收益明显的版本，建议只做下面几件事：

1. 给主链路所有 LLM 调用透传 `signal`
2. 把 step timeout 改成 abort controller，而不是 Promise 包装超时
3. 给 `http_request` 工具接入 `signal`
4. 给消息处理增加 `runId`，防止旧结果回写

这个版本已经能解决大部分实际问题：

- 超时的模型请求不再继续跑很久
- 一部分工具能真正停掉
- 即使后台还有残留执行，也不会污染最终状态

## 八、不推荐的做法

以下做法不建议继续扩展：

### 1. 继续叠加更多 `Promise.race(timeout)`

问题：

- 只能让上层更快结束
- 不会停止底层执行
- 会制造更多“表面结束、后台仍在运行”的幽灵任务

### 2. 只在 orchestrator 记录一个 cancelled 标记

问题：

- 只能改变状态显示
- 无法减少实际资源占用
- 无法阻止底层继续打日志、继续占连接、继续回写

### 3. 只在工具层做超时，不处理 LLM 层

问题：

- 当前长耗时大头很可能就是模型调用
- 工具可取消了，但主链路仍会留下后台 LLM 请求

## 九、风险与注意点

### 1. SDK 是否完整支持 abort

需要确认当前使用的 AI SDK / provider 接口是否完整支持 `AbortSignal`。

如果支持：

- 可直接接入

如果部分支持或行为不稳定：

- 仍然要接入 `runId` 保护
- 不能把一致性安全完全寄托在 abort 上

### 2. 并行 step 的 signal 隔离

当前 orchestrator 会并行跑同一批 runnable steps。

因此：

- 每个 step 最好有自己的子 controller
- 整个任务也有父 controller
- 父取消时，所有子 step 都取消
- 单 step timeout 时，只中止该 step，不误伤同批其他 step

### 3. background task 也要考虑取消边界

当前 summary refresh 是在后台异步触发的。

这里要明确：

- 它是否需要继承原任务 signal
- 或者至少在写回前检查 `runId` / conversation snapshot

否则主任务已结束或已被新任务替换时，后台总结仍可能覆盖新状态。

## 十、建议的数据结构调整

建议后续逐步引入：

```ts
type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';
```

以及：

```ts
type ExecutionContext = {
  runId: string;
  signal?: AbortSignal;
};
```

如果希望更强可观测性，还可以在 step 结果中附加：

- `endedAt`
- `abortReason`
- `timeoutMs`

## 十一、结论

这个问题的正确修复方向不是“让 timeout 包装更多层”，而是：

- 用 `AbortSignal` 建立真正的取消传播链
- 让 LLM、HTTP、shell 等底层执行单元响应取消
- 在状态层区分 `failed`、`cancelled`、`timed_out`
- 用 `runId` 保证旧执行结果不会污染当前有效对话

如果按收益和风险排序，最值得先做的是：

1. 主链路 `signal` 透传
2. LLM 调用接入 abort
3. `http_request` 与 `run_command` 接入取消
4. `runId` 防旧结果回写

这四项做完后，当前“步骤取消了，但底层还在跑”的主要问题就会明显缓解。

---

# 取消链路改造实现总结（审查版）

这一轮改造的目标不是继续堆更多 timeout 包装，而是把“调用方放弃等待”升级成“系统显式发出取消，并让下游协同终止”，同时避免旧任务结果在新消息到来后继续污染对话状态。

本轮已完成的范围包括：

- 主链路 `signal` 透传
- step 级 abort timeout
- tool runtime 接入 `signal`
- `http_request` / `run_command` 真正响应取消
- `runId` 防旧结果回写
- 状态拆分为 `cancelled` / `timed_out` / `failed`
- 用户可见错误提示按状态区分

下面按模块说明本轮具体改了什么，以及为什么这么改。

## 一、主链路 signal 透传

### 1. 改动内容

把 `AbortSignal` 从消息入口一路透传到任务编排和 LLM 调用层，涉及：

- `src/services/handle-message.ts`
- `src/agent/task-agent.ts`
- `src/agent/task-orchestrator.ts`
- `src/agent/task-planner.ts`
- `src/agent/step-executor.ts`
- `src/agent/index.ts`
- `src/agent/result-synthesizer.ts`

现在以下调用都支持接收 `signal`：

- `runTaskAgent(...)`
- `runTaskOrchestration(...)`
- `executeTaskStepWithAgentLoop(...)`
- `buildTaskPlan(...)`
- `runAgent(...)`
- `synthesizeTaskResult(...)`

同时，主链路里的 `streamText(...)` 调用已经统一接入 `abortSignal`。

### 2. 这么改的原因

如果不先把 `signal` 贯穿主链路，后面即便某一层能 `abort()`，也无法真正传到底层模型调用。

所以第一步必须先做接口打通，让：

- 上游能发出取消
- 中间层不丢失取消信号
- LLM 层能真正收到 `abortSignal`

这是后续所有真正取消能力的基础。

## 二、step 级 timeout 改成真实 abort

### 1. 改动内容

新增了统一 abort 工具：

- `src/utils/abort.ts`

它提供：

- `createChildAbortSignal(...)`
- `isAbortError(...)`
- `getAbortReasonMessage(...)`

然后在 `src/agent/task-orchestrator.ts` 里为每个 step 创建独立的子 signal：

- 父任务取消时，step 子 signal 会级联取消
- 配置了 step timeout 时，超时会直接触发 `abort()`

同时在 `src/config.ts` 里新增了：

- `AGENT_STEP_TIMEOUT_MS`

默认值是 `0`，即默认不开启 step 总超时，避免直接改变现有运行行为。

在 `src/agent/step-executor.ts` 中，原本“并发只读工具规划”这一步只是 `withTimeout(...)` 包装，现在已改成真实 abort：

- 规划超时会中断对应的 `streamText(...)`
- 不再只是外层 reject、底层继续跑

### 2. 这么改的原因

原来的 timeout 只有一个效果：

- 调用方不再等待结果

但底层 LLM 仍可能继续运行，资源依旧被占用。

把 step timeout 改成 abort 后，行为才变成：

- step 到时
- step 子 signal 被 abort
- 该 step 下的模型调用收到取消
- 编排层根据 abort reason 把结果归类为 `timed_out` 或 `cancelled`

这才是真正意义上的“step 被停止”。

## 三、tool runtime 接入 signal

### 1. 改动内容

工具接口从：

```ts
execute: (params: Record<string, unknown>) => Promise<unknown>;
```

改成：

```ts
type ToolExecuteInput = {
  params: Record<string, unknown>;
  signal?: AbortSignal;
};
```

涉及：

- `src/agent/tool-types.ts`
- `src/agent/tool-runner.ts`

`ToolRunner.run(...)` 现在会：

- 校验参数
- 为当前工具创建独立子 signal
- 将 tool timeout 转换成真正的 abort
- 把 `{ params, signal }` 传给工具实现
- 在工具结束后清理 timer 和父级监听

同时主调用方也已透传工具 signal：

- `src/agent/index.ts`
- `src/agent/step-executor.ts`

### 2. 这么改的原因

如果只让 step 层可取消，而 tool runtime 仍然是旧签名，那么：

- step 虽然 abort 了
- tool runner 却无法通知具体工具停止

所以工具层必须建立统一取消协议。

只有 runner 和工具实现都认识 `signal`，工具 timeout 才不再只是包装层超时，而是真正的执行取消。

## 四、具体工具的取消支持

### 1. `http_request`

改动文件：

- `src/agent/tools/http-request.ts`

改动点：

- 接收 `{ params, signal }`
- 在 DNS / URL 安全检查前后检查是否已取消
- `fetch(...)` 直接传入 `signal`

为什么这么改：

- `fetch` 本身支持 `AbortSignal`
- 这是最容易做到真实取消的工具类型

当前边界：

- `dns.lookup(...)` 本身不是可取消 API
- 这里只能做到调用前后检查 signal，无法中途硬中断 DNS 解析

### 2. `run_command`

改动文件：

- `src/agent/tools/run-command.ts`

改动点：

- 接收 `{ params, signal }`
- `spawn(...)` 时传入 `signal`
- abort 时显式 `child.kill()`
- 在 `close` / `error` 路径中区分“命令失败”和“命令被取消”

为什么这么改：

- shell 命令是最容易留下后台幽灵执行的工具之一
- 如果不保存子进程控制权，外层 timeout 只会让调用方放弃等待，但命令仍继续执行

### 3. 其他工具

改动文件：

- `src/agent/tools/calculate-expression.ts`
- `src/agent/tools/get-current-time.ts`

改动点：

- 统一改成新签名

为什么只做兼容，不做更多：

- 这两个工具本身是同步短任务
- 几乎没有“正在跑很久需要取消”的价值
- 当前只需兼容统一 runtime 协议即可

## 五、runId 防旧结果回写

### 1. 改动内容

在 `src/services/handle-message.ts` 中新增了每个 `chatId` 的活跃 run 跟踪：

- `activeChatRuns`
- `startChatRun(...)`
- `isActiveChatRun(...)`

行为变成：

- 每次新消息进入时，为该 `chatId` 生成新的 `runId`
- 如果该 chat 已有旧 run，旧 run 的 controller 会被 abort
- 任何结果写回前都校验当前 run 是否仍然有效

目前已加保护的写回点包括：

- 回复发送前
- 回复发送后、memory 写入前
- summary 后台刷新前
- summary 生成后、真正写回前
- 错误处理发送消息前

### 2. 这么改的原因

即使 abort 链路已经打通，也不能假设所有底层库都 100% 立即停止。

真实世界里仍可能发生：

- 请求已发出，取消稍晚生效
- 子进程 kill 有延迟
- 某个异步操作在 abort 前刚好完成

所以还必须有一层最终一致性保护：

- 旧 run 即使晚完成，也不能污染当前对话状态

这一层是“取消不彻底时的保险丝”。

## 六、状态拆分：cancelled / timed_out / failed

### 1. 改动内容

在 `src/agent/task-types.ts` 中扩展了状态类型：

- `TaskRunStatus`
- `TaskStepStatus`
- `TaskProgressEvent`

新增状态：

- `cancelled`
- `timed_out`

新增事件：

- `step_cancelled`
- `step_timed_out`
- `cancelled`
- `timed_out`

在 `src/agent/task-orchestrator.ts` 中，step 执行失败后不再一律写成 `failed`，而是根据 step 子 signal 的 abort reason 分类：

- 命中 timeout 语义 -> `timed_out`
- 命中 abort 但不是 timeout -> `cancelled`
- 非 abort 异常 -> `failed`

同时：

- `src/agent/result-synthesizer.ts` 更新了执行报告状态
- `src/services/handle-message.ts` 更新了日志分支
- `src/tests/task-agent.ts` 更新了进度打印分支

### 2. 这么改的原因

这三种状态的语义完全不同：

- `timed_out`：预算不够
- `cancelled`：被用户或新消息替换
- `failed`：真实执行异常

如果继续混成一个 `failed`，会导致：

- 日志误导
- UI 展示不准确
- 无法针对不同失败类型做不同重试/降级策略

所以必须拆开。

## 七、用户可见错误提示分类

### 1. 改动内容

在 `src/services/handle-message.ts` 中新增了错误分类 helper：

- `getErrorMessage(...)`
- `isTimeoutError(...)`
- `isSupersededRunError(...)`
- `buildUserFacingErrorMessage(...)`

当前对用户的回复策略是：

- 超时：`This request timed out before I could finish. Please try again, or narrow the request.`
- 取消：`This request was cancelled before it finished.`
- 被新消息顶掉的旧 run：静默，不回复错误
- 普通故障：`Service error. The issue has been recorded.`

### 2. 这么改的原因

如果所有错误都回复同一条“Service error”，用户根本分不清：

- 是模型/工具真的出错了
- 还是任务太长超时了
- 还是自己刚发的新消息把旧消息顶掉了

把用户提示分开以后：

- 可理解性更高
- 更符合真实状态
- 后续 UI 若要做更精细的状态呈现，也有统一入口

## 八、结果收敛逻辑调整

### 1. 改动内容

在 `src/agent/result-synthesizer.ts` 中：

- 执行报告状态不再只区分 `completed` / `failed`
- 如果 step 中存在 `cancelled` / `timed_out` / `failed` 任一状态，都会进入完整 synthesis 路径

同时 prompt 也更新为：

- 不仅解释失败
- 也解释 timeout / cancelled 的限制

### 2. 这么改的原因

之前只有“是否 failed”一个判断条件。

但现在如果任务是：

- 中途超时
- 被取消

它也不应该走“完全正常成功”的单步直返逻辑。

所以 synthesis 条件必须同步扩展。

## 九、验证方式

这轮改造后，我做的验证主要是模块加载验证，而不是完整集成测试。

原因：

- 当前仓库没有独立可直接运行的 TypeScript 编译检查链路
- `tsx` 在默认沙箱里会触发子进程限制，需要提权执行

本轮已做的验证包括：

- 主链路相关模块加载验证
- tool runtime 与工具模块加载验证
- `handle-message` 入口模块加载验证
- 状态拆分相关模块加载验证

验证结果均为：

- `module-load-ok`

这类验证能确认：

- import 关系没被打断
- 主要签名变更已联通
- 关键模块至少能正常解析和初始化

但它不能替代真正的行为测试。

## 十、当前边界与未完成项

虽然这轮已经把取消链路主体搭起来了，但仍有几个边界需要明确：

### 1. 并发只读工具执行预算仍是旧式包装 timeout

当前：

- 并发只读工具规划已经是真实 abort
- 但并发只读工具执行预算仍保留了旧的 `withTimeout(...)`

原因：

- 当时 tool 层尚未支持 signal 时，直接强改没有收益
- 现在 tool 层已支持 signal，后续可以继续把这一段也升级成 abort

### 2. DNS lookup 不是可中断 API

`http_request` 里：

- `fetch` 可取消
- DNS 解析只能前后检查 signal，不能中途硬中断

### 3. 还缺少真实场景回归测试

目前最值得补的测试场景包括：

- 新消息打断旧消息
- step timeout 后状态是否为 `timed_out`
- `http_request` 超时/取消是否停止
- `run_command` 取消后子进程是否被清理
- 旧 run 是否不会再写 memory / summary

### 4. 还没有把所有用户提示完全本地化/统一风格

当前一些直接展示给用户的字符串仍然是英文或沿用旧风格。

这不影响取消链路正确性，但后续若要上线体验更统一，建议再收一轮提示文案。

## 十一、总结

这轮改造的核心成果，不是“又加了几层 timeout”，而是把原先的伪取消改成了真实、分层、可观测的取消链路。

具体来说，已经做到：

- 入口到 LLM 的 `AbortSignal` 贯通
- step 级超时会真实触发 abort
- tool runtime 接入统一取消协议
- `http_request` / `run_command` 能真正响应取消
- 旧 run 不再污染当前对话
- 状态语义从单一 `failed` 拆成 `cancelled` / `timed_out` / `failed`
- 用户可见错误提示按真实状态区分

从架构收益上看，这轮改动解决的是三个长期隐患：

1. 超时后底层仍继续运行，资源浪费
2. 新消息到来后旧结果继续回写，状态污染
3. 所有异常都混成 failed，观测和处理策略失真

如果你现在要做审查，最建议重点看的点是：

1. `src/utils/abort.ts` 是否足够稳，是否满足后续复用
2. `src/agent/task-orchestrator.ts` 的状态分类是否符合预期
3. `src/agent/tool-runner.ts` 与工具签名改造是否清晰
4. `src/services/handle-message.ts` 的 `runId`/stale write guard 是否覆盖完整
5. 还有哪些路径仍然停留在“包装层 timeout 而不是真取消”

一句话总结：

这次不是在原有 timeout 之上继续打补丁，而是把运行时从“表面结束、底层继续跑”推进成了“可取消、可分级、可防脏写”的更完整状态。

## 十二、`http-request` 的 `signal` 行为补充说明

针对“调用者传入 `signal` 后，再修改这个参数，`http-request` 里会不会变化”这个问题，当前代码的结论如下：

1. `http-request` 工具拿到的不是调用方原始 `signal`，而是 `ToolRunner` 创建的子 `signal`。
2. 子 `signal` 会监听父 `signal` 的 abort 事件，所以父 controller 一旦 `abort()`，工具里的 `signal` 会同步变成 aborted。
3. 如果只是把外部变量重新赋值到另一个 `signal`（变量重绑），不会影响工具内部已经持有的那个 `signal` 引用。
4. `AbortSignal` 本身的 `aborted/reason` 不是通过“直接改值”来变化，而是通过对应 `AbortController.abort()` 触发。

可简化为：

- 改“变量指向”不会影响 `http-request` 内部信号。
- 对原父 controller 调用 `abort()` 会影响，并中断工具内流程（包含 `throwIfAborted(...)` 检查和 `fetch(..., { signal })`）。

## 十三、`step-executor.ts` 并行只读工具执行的 `withTimeout` 解析

你提到的文件名应是 `step-executor.ts`（不是 `set-executor.ts`）。

针对这段代码：

- `withTimeout(executeParallelReadonlyTools(...), parallelReadonlyExecutionBudgetMs, ...)`

可以拆成三层理解。

### 1. 传入的 `signal` 到底是谁

在 `task-orchestrator.ts` 里，每个 step 执行前会创建 `stepAbort`，然后把 `stepAbort.signal` 传给 `executeStep(...)`：

- `src/agent/task-orchestrator.ts:164-180`

所以 `step-executor.ts` 里看到的 `input.signal` 不是全局唯一 signal，而是“当前 step 的总 signal”（已经包含上游取消 + step timeout）。

并且这个 `input.signal` 会继续传给并行工具执行：

- `src/agent/step-executor.ts:495`
- `src/agent/step-executor.ts:385-387`

最终 `ToolRunner` 还会再给每个工具创建自己的子 signal（tool timeout）：

- `src/agent/tool-runner.ts:63-67`

也就是：

`任务级 signal -> stepAbort.signal -> 并行工具共享的 step signal -> 每个工具自己的 tool signal`

### 2. 为什么外层还要再包一层 `withTimeout`

`withTimeout` 包在 `executeParallelReadonlyTools(...)` 外层，作用是给“整批并行只读工具”加一个总预算（execution budget），避免这一步无限拖慢当前 step。

对应配置：

- `AGENT_PARALLEL_READONLY_EXECUTION_BUDGET_MS`
- 默认映射到 `config.agent.parallelReadonlyExecutionBudgetMs`（`src/config.ts`）

这个设计的目标更偏“编排层快速收敛”：

- 超预算就尽快放弃等待并行只读工具结果
- 回退到 `messages = baseMessages`
- 继续让 `runAgent(...)` 执行当前 step（不因为并行只读工具卡住而阻塞）

对应代码路径：

- 超预算抛错 -> `catch` -> `messages = baseMessages`
- `src/agent/step-executor.ts:513-530`

### 3. 关键行为边界：`withTimeout` 只限“等待时间”，不主动 abort 底层执行

当前 `withTimeout` 实现是 Promise 包装超时（`reject`），不会对内部 promise 发取消信号：

- `src/agent/step-executor.ts:65-80`

这意味着：

- 外层可能已经因 budget 超时而进入 `catch`
- 但 `executeParallelReadonlyTools(...)` 内部任务可能仍在后台继续，直到它们自然结束，或直到 `input.signal`（step signal）被 abort

所以现在的真实语义是：

- `withTimeout` = 编排层“最多等多久”
- `signal` = 底层“什么时候真正取消”

两者职责不同，不冲突，但确实存在“外层不等了、底层可能还在跑一会儿”的窗口。

### 4. 小结

这段代码同时存在两套时间控制：

1. `signal` 链路控制“能不能被真正取消”（任务/step/tool 级）。
2. `withTimeout` 控制“编排层最多等待并行只读工具多久”。

因此你的理解是对的：传进去的是当前 step 的总 signal；而外层再包 `withTimeout`，主要是为了给这段并行只读工具执行加一个“等待预算上限”，让 step 能更快继续往下走。

## 十四、日志与用户返回文案统一规范

本节用于约束后续代码的日志输出与用户可见文案，避免风格漂移。

### 1. 日志事件命名规范

统一格式：

`[scope] event_name`

要求：

- `scope` 使用小写英文，表示模块边界，例如：`message`、`task`、`task_step`、`agent`、`ws`、`memory`。
- `event_name` 使用小写下划线风格，表达“发生了什么”，例如：`handling_started`、`step_completed`、`tool_execution_failed`。
- 一个日志事件名只表达一个动作，不要在 message 字符串中混入长句解释。

示例：

- `logger.info({ chatId, eventId }, '[message] handling_started')`
- `logger.warn({ stepId, error }, '[task] step_timed_out')`
- `logger.error({ err }, '[ws] connect_failed')`

### 2. 日志级别使用规范

- `info`：正常流程节点与状态推进（开始、完成、跳过、命中缓存等）。
- `warn`：可恢复异常或业务预期内失败（超时、取消、不支持输入、回退路径）。
- `error`：不可忽略的失败（主流程失败、外部依赖失败、导致请求无法完成）。

不要把成功路径打成 `warn` 或 `error`。

### 3. 结构化字段规范

日志应始终带结构化上下文，避免仅输出纯文本。

建议优先字段：

- 会话维度：`chatId`、`eventId`、`runId`
- 任务维度：`stepId`、`index`、`total`
- 工具维度：`tool`、`arguments`（必要时脱敏）
- 错误维度：`err`（优先对象，避免只放字符串）

要求：

- 敏感信息不得直接入日志。
- 超长文本（模型回复、网页正文）只保留预览片段，例如 `resultPreview`。

### 4. 禁止事项

- 运行时业务代码中直接使用 `console.log` / `console.warn` / `console.error`。
- 同一语义在不同模块使用不同事件名。
- 在日志 message 中混用中英文长句，造成检索困难。

说明：

- 示例脚本和测试代码可保留 `console.*` 作为调试输出，不纳入运行时日志规范。

### 5. 用户可见文案规范

用户可见文本统一集中管理在：

- `src/constants/user-facing-text.ts`

要求：

- 对用户回复尽量使用中文、简短、可执行。
- 同一类错误只保留一个标准文案（如超时、取消、通用失败）。
- 业务代码中避免散落硬编码字符串，统一引用常量。

示例：

- 超时：`请求处理超时，请重试或缩小问题范围。`
- 取消：`请求已取消。`
- 通用失败：`服务暂时不可用，请稍后重试。`

### 6. 新增代码自检清单

提交前自检：

1. 新日志是否符合 `[scope] event_name`。
2. 新日志是否使用了正确级别（info/warn/error）。
3. 是否带了必要上下文字段（chatId/eventId/runId 等）。
4. 是否新增了散落硬编码用户文案。
5. 用户文案是否已抽到 `user-facing-text.ts`。

### 7. 推荐的模块 scope 对照

- 消息入口：`[message]`
- 任务编排：`[task]`
- 步骤执行：`[task_step]`
- Agent 主循环：`[agent]`
- WebSocket 长连接：`[ws]`
- 内存持久化：`[memory]` / `[memory_repo]` / `[memory_cleaner]`
- 路由层：`[feishu_route]`
- 后台任务：`[background]`

后续新增模块时，优先沿用已有 scope；确需新增时保持小写英文与单一职责。

## 十五、并行只读工具去 `withTimeout` 方案（改为 signal/abort 驱动）

你提的方向是对的：既然当前工具链已经支持 `signal`，并行只读工具执行阶段可以不再依赖 `withTimeout(...)` 做“外层放弃等待”，而改成“超时即真实取消”。

### 1. 当前问题（为什么要去掉 `withTimeout`）

当前实现：

- `executeParallelReadonlyTools(...)` 外层包了 `withTimeout(...)`
- 超时后上层会快速进入 `catch`
- 但底层并行工具任务不一定被立即中止（除非后续 `input.signal` 恰好触发 abort）

结果是：

- 编排层视角超时了
- 实际执行层可能还在跑一小段时间
- 会出现“上层已放弃等待、底层仍在收尾”的时间窗口

### 2. 目标状态

并行只读工具执行阶段统一采用“子 signal + timeout abort”：

- 到预算时间后，不是仅 reject promise
- 而是直接 `abort()` 当前并行执行子树
- 工具运行中的 fetch/shell 等会收到取消信号并尽快停止

这会让“执行预算超时”与“底层执行终止”语义一致。

### 3. 推荐改造方案

在 `step-executor.ts` 的并行执行分支中，替换：

- `withTimeout(executeParallelReadonlyTools(...), budgetMs, ...)`

为：

1. 创建执行期子 signal（例如 `executionAbort`）
   - `parentSignal: input.signal`
   - `timeoutMs: config.agent.parallelReadonlyExecutionBudgetMs`
   - `timeoutReason: Parallel readonly execution ... timed out after ...`

2. 把 `executionAbort.signal` 传给 `executeParallelReadonlyTools(...)`

3. `await executeParallelReadonlyTools(...)` 后 `finally` 里 `executionAbort.dispose()`

4. 在 `catch` 分支按 abort reason 分类
   - timeout 走“预算超时”语义
   - 非 timeout 但 aborted 走“取消”语义
   - 其他异常走普通失败语义

这样实现后可以删除 `withTimeout` 函数（若该文件内无其他用途）。

### 4. 伪代码示意

```ts
const executionAbort = createChildAbortSignal({
  parentSignal: input.signal,
  timeoutMs: config.agent.parallelReadonlyExecutionBudgetMs,
  timeoutReason: `Parallel readonly execution for ${input.step.id} timed out after ${config.agent.parallelReadonlyExecutionBudgetMs}ms`,
});

const parallelExecution = await executeParallelReadonlyTools(
  plannedToolCalls,
  readonlyToolCache,
  executionAbort.signal,
).finally(() => {
  executionAbort.dispose();
});
```

核心点：

- 超时 -> `executionAbort.signal.aborted === true`
- 工具 runner/工具实现会沿 signal 链收到取消
- 不再是“外层超时包装”

### 5. 与现有链路的一致性

该改造与当前架构是同向的：

- 你们已经有 `createChildAbortSignal(...)`
- tool runner 已给每个 tool 建立子 signal
- 工具实现（如 `http_request`、`run_command`）已支持 signal

所以并行执行阶段去掉 `withTimeout` 不会破坏现有设计，反而把“计划阶段”和“执行阶段”的超时策略统一为同一种 abort 模式。

### 6. 风险与注意点

1. `Promise.allSettled(...)` 行为

- 某个工具被 abort 后会返回 rejected（AbortError/timeout reason）
- allSettled 会等待所有分支收敛
- 这是可接受的：因为分支已收到 abort，收敛时间应显著缩短

2. 错误文案区分

- 建议在日志中明确区分：`readonly_execution_timed_out` vs `readonly_execution_aborted`
- 避免都落成同一个“failed to execute readonly tools”

3. 缓存写入时机

- 当前仅在工具成功完成后写 cache，这个策略继续保持即可
- 被 abort 的分支不写 cache，防止污染

### 7. 最小落地步骤

1. 在 `step-executor.ts` 并行执行段引入 `executionAbort` 子 signal。
2. 删除 `withTimeout(...)` 对并行执行的包裹，改为直接 await + abort timeout。
3. 把执行失败日志拆成更清晰的 timeout/abort/error 三类事件名。
4. 补一条回归用例：
   - 将 `parallelReadonlyExecutionBudgetMs` 设很小
   - 触发至少一个慢只读工具
   - 断言超时后流程继续，且工具被 signal 取消（而非持续后台运行）。

### 8. 结论

在你们“工具已支持 signal”这个前提下，最佳方案是：

- 去掉并行只读执行阶段的 `withTimeout` 包装
- 改为 `createChildAbortSignal(timeout)` 驱动真实取消

这能把“超时判定”升级为“超时即终止执行”，语义更一致，资源回收更可控。

## 十六、落地实现细化（可直接照改）

下面给出一版更贴近当前代码结构的“最小改动实现”，目标是低风险替换，不改业务语义。

### 1. `step-executor.ts` 改造点

当前位置：

- `executeTaskStepWithAgentLoop(...)` 中
- `plannedToolCalls.length` 分支里
- 现在是 `withTimeout(executeParallelReadonlyTools(...), ...)`

建议改为：

```ts
const executionAbort = createChildAbortSignal({
  parentSignal: input.signal,
  timeoutMs: config.agent.parallelReadonlyExecutionBudgetMs,
  timeoutReason: `Parallel readonly execution for ${input.step.id} timed out after ${config.agent.parallelReadonlyExecutionBudgetMs}ms`,
});

const parallelExecution = await executeParallelReadonlyTools(
  plannedToolCalls,
  readonlyToolCache,
  executionAbort.signal,
).finally(() => {
  if (executionAbort.signal.aborted) {
    executionAbortReason = getAbortReasonMessage(executionAbort.signal);
  }
  executionAbort.dispose();
});
```

并补一个局部变量：

```ts
let executionAbortReason: string | undefined;
```

然后在 `catch` 里和现有 `planningAbortReason` 一起归并：

```ts
const abortReason = executionAbortReason ?? planningAbortReason;
```

### 2. 错误分类建议

`catch` 中建议区分三类：

1. planning 超时/取消（来自 `planningAbortReason`）
2. execution 超时/取消（来自 `executionAbortReason`）
3. 其他异常

日志事件名可拆成：

- `[task_step] readonly_planning_failed`
- `[task_step] readonly_execution_timed_out`
- `[task_step] readonly_execution_aborted`
- `[task_step] readonly_execution_failed`

这样后续观测能直接知道瓶颈在“规划”还是“执行”。

### 3. `withTimeout` 处理建议

当并行执行阶段完全迁移后：

- 若 `withTimeout` 仅剩该处使用，可删除函数
- 若还有其他调用，可保留但注释为“仅用于非可取消异步”

建议注释（如果保留）：

- “优先使用 abort signal；仅当下游无法响应 abort 时再使用包装 timeout”

### 4. 兼容性检查点

改完后重点确认：

1. `executeParallelReadonlyTools(...)` 的 `signal` 仍透传到 `runner.run(...)`
2. `runner.run(...)` 继续创建 tool 子 signal（tool timeout）
3. 工具异常在 `Promise.allSettled(...)` 中仍被收敛成 `tool_error` message
4. `messages = baseMessages` 的回退逻辑不变（保证 step 不被卡死）

### 5. 推荐回归场景

1. **执行预算超时**
   - 配置很小 budget
   - 安排慢只读工具
   - 预期：快速进入回退，且工具被 abort

2. **父 signal 取消**
   - 在并行执行中途取消 step
   - 预期：execution 子 signal 级联取消

3. **部分成功 + 部分失败**
   - 多工具并发，部分命中 cache，部分 abort
   - 预期：成功工具产出正常注入，失败工具生成 `tool_error`

4. **普通异常**
   - 工具内部抛非 abort 错误
   - 预期：归类为 execution failed，而不是 timed_out/cancelled

### 6. 一句话落地策略

先把并行执行从“包装 timeout”改成“execution 子 signal timeout”，再把日志分类拆清楚；这样能在不改主流程行为的前提下，获得真实取消与更清晰的可观测性。

## 十七、为什么 `plannedReadonlyTools` 为空，但后续仍有工具调用

你的现象是：

- 用户问题：`387 + 654 - 120 = ?`
- 日志：`[task_step] planned_readonly_tools ... plannedReadonlyTools: []`
- 但后面仍然发生了工具调用（来自 `runAgent` 阶段）

这个现象是符合当前架构的，不是冲突。

### 1. `planParallelReadonlyTools(...)` 的定位

`planParallelReadonlyTools(...)` 的作用是：

- 在 step 执行前，尝试“预先挑选一批可并行、只读、彼此独立”的工具调用
- 它是**可选优化层**（prefetch），不是主执行器
- 允许返回空数组（`toolCalls: []`）

所以它返回空，含义是：

- “这一步先不做并行只读工具预取”
- 不是“本 step 完全不能调用工具”

### 2. 为什么简单算式也可能规划为空

虽然 `calculate_expression` 是只读工具，但并行规划模型被提示了：

- 仅在“materially useful”时才选工具
- 能直接回答时可以不选工具
- 返回 0 到 N 个工具都可以

因此模型可能判断：

- 这是简单任务，先不做并行预取（返回 `[]`）

这一步的输出本来就带有“保守跳过”的设计，不保证每次都选中。

### 3. 为什么后续又会调用工具

并行规划之后，真正执行 step 的主链路是 `runAgent(...)`。

`runAgent(...)` 里还有自己的工具决策流程（如 `inferToolDecision` / planner 决策），所以会出现：

- 预规划阶段没选工具
- 主执行阶段仍然决定调用 `calculate_expression`

这是两层决策：

1. 预执行并行只读规划（可为空）
2. 主执行 Agent 决策（可调用工具）

两者不是互斥关系。

### 4. 当前设计的真实语义

`plannedReadonlyTools: []` 只表示：

- “没有提前并行执行工具”

不表示：

- “本 step 不会用工具”

所以你看到的日志组合本质是：

- 预取优化未命中
- 主执行正常命中工具

### 5. 是否需要调整

如果你希望“简单算式尽量在预规划阶段就稳定选工具”，可以做定向策略收敛：

1. 在 `planParallelReadonlyTools` 的 prompt 中增加更强约束：
   - 明确要求：算术表达式优先选 `calculate_expression`
2. 对明显表达式加本地规则短路：
   - 命中算术模式时直接注入一个 planned tool call，绕过模型波动
3. 继续保留 `runAgent` 兜底：
   - 即使预规划漏选，主执行仍可补上

推荐做法是“规则短路 + 模型规划并存”，这样稳定性最高。

### 6. 结论

你看到的日志并不代表功能异常。

`planParallelReadonlyTools(...)` 的核心价值是“可选并行预取”，不是“唯一工具规划入口”；
真正是否调用工具，仍由后续 `runAgent` 主执行链路决定。

## 十八、规则短路 + 模型规划并存方案（完整草案）

目标：

- 简单、确定性任务（如四则运算）稳定命中工具。
- 复杂任务继续走模型规划，保持灵活性。
- 两层并存，互相兜底。

### 1. 总体执行顺序

建议顺序：

1. 本地规则短路（deterministic）
2. `planParallelReadonlyTools(...)`（模型并行预取）
3. `runAgent(...)` 主执行（最终兜底）

说明：

- 规则短路只负责“明显确定性场景”。
- 模型规划负责“非确定性或组合型场景”。
- 主执行链路继续保留，防止前两层漏判。

### 2. 接入位置

文件：`src/agent/step-executor.ts`

在 `executeTaskStepWithAgentLoop(...)` 中，当前调用 `planParallelReadonlyTools(...)` 的位置前，新增规则短路分支。

当前逻辑（简化）：

- `plannedToolCalls = await planParallelReadonlyTools(...)`

建议改为：

```ts
const shortcutToolCalls = inferDeterministicReadonlyTools(input);

const plannedToolCalls = shortcutToolCalls.length
  ? shortcutToolCalls
  : await planParallelReadonlyTools({
      ...input,
      signal: planningAbort.signal,
    });
```

### 3. 最小规则（第一阶段只做算式）

规则函数建议：

```ts
function inferDeterministicReadonlyTools(input: ExecuteTaskStepInput): PlannedReadonlyToolCall[] {
  const lastUserMessage = [...input.messages].reverse().find((m) => m.role === 'user');
  const text = lastUserMessage ? stringifyMessageContent(lastUserMessage).trim() : '';
  if (!text) return [];

  const normalized = text.replace(/[？?=]/g, '').trim();
  const isMathExpression =
    /^[\d\s+\-*/().]+$/.test(normalized)
    && /\d/.test(normalized)
    && /[+\-*/]/.test(normalized);

  if (!isMathExpression) return [];

  return [
    {
      tool: 'calculate_expression',
      arguments: { expression: normalized },
    },
  ];
}
```

边界建议：

- 仅在文本完全匹配算式字符集时触发。
- 先不支持“中文描述型数学题”（避免误判）。

### 4. 并存策略细节

1. 规则命中时：

- 直接采用规则产出的 planned tool calls。
- 跳过 `planParallelReadonlyTools`，减少模型抖动。

2. 规则未命中时：

- 按现有流程走 `planParallelReadonlyTools`。

3. 无论是否命中规则：

- 仍执行后续 `runAgent(...)`。
- 主执行链路负责最终补漏与答案生成。

### 5. 去重与一致性

当前已有 `buildToolCallKey(...)` 去重逻辑，可继续复用：

- 即使后续链路再次出现相同工具调用，也可通过 key 去重或缓存命中降低重复执行。

建议：

- 保留当前 readonly cache 机制。
- 规则命中产出的调用也进入同一缓存体系，避免逻辑分叉。

### 6. 日志规范建议

新增两个事件名：

- `[task_step] readonly_shortcut_hit`
- `[task_step] readonly_shortcut_miss`

推荐字段：

- `stepId`
- `matchedRule`（如 `math_expression_v1`）
- `plannedReadonlyTools`

这样后续可以快速统计：

- 规则命中率
- 命中后是否减少模型规划调用

### 7. 扩展路线（第二阶段）

在算式规则稳定后，可逐步增加：

1. 时间查询规则：

- 命中明确时间意图时注入 `get_current_time`

2. 单 URL 抓取规则：

- 文本中仅包含明确 HTTPS URL 且意图为“读取内容”时注入 `http_request`

3. 只读命令规则（谨慎）：

- 仅命中严格模板（如版本查询）
- 必须继续通过 `run_command` 安全校验

### 8. 风险与控制

风险：

- 规则过宽导致误触发。

控制：

- 第一阶段只做“高确定性、低歧义”规则。
- 保守设计：宁可 miss，不要误命中。
- 保留 `runAgent` 主链路兜底。

### 9. 验收标准

1. 输入纯算式（例如 `387 + 654 - 120 = ?`）时：

- `plannedReadonlyTools` 不再稳定为空。
- 日志出现 `readonly_shortcut_hit`。

2. 普通复杂问题：

- 规则 miss，流程与现在一致。

3. 最终回答质量：

- 不因引入规则而下降。
- 复杂任务仍可依赖模型规划与主执行链路。

### 10. 一句话总结

用“规则短路”保证确定性任务稳定命中工具，用“模型规划”覆盖复杂场景，再由 `runAgent` 做最终兜底，是当前架构下兼顾稳定性与灵活性的最小改造方案。

## 十九、项目不足与优化/新功能路线图（执行版）

以下方案基于当前代码现状，按“收益/风险/实现成本”分层，避免一次性大改。

### 1. 当前主要不足（按优先级）

#### P0：测试与回归保障不足

现状：

- 目前只有脚本式测试入口（`src/tests/*.ts`），缺少稳定的单元/集成测试框架。
- 并行只读工具、取消链路、runId 防脏写这些关键行为缺少自动回归。

风险：

- 改动后容易出现“功能能跑但行为退化”。
- 取消、超时、并行等边界问题难以及时发现。

#### P0：任务执行观测深度不足

现状：

- 事件日志已有，但缺少统一的指标统计（成功率、超时率、工具命中率、空规划率）。
- 无法量化判断某次 prompt 调整是变好还是变坏。

风险：

- 调优过程只能靠感受，难做数据驱动迭代。

#### P1：并行只读规划命中不稳定

现状：

- `planParallelReadonlyTools` 允许返回空，且对简单任务可能保守跳过。
- 最终要靠 `runAgent` 二次决策补调用。

风险：

- 多一次决策链路，增加延迟与不确定性。

#### P1：附件处理能力仍有明显边界

现状：

- Office 文档支持不完整（尤其 xlsx/pptx）。
- 解析失败后的降级策略偏弱（多数直接报不支持）。

风险：

- 文件场景的用户体验不连续。

#### P2：配置治理与运行治理不足

现状：

- 配置项已增加不少，但缺少“环境校验 + 默认策略说明 + 启动时完整配置摘要”。
- 缺少运维向的健康信号（例如最近 N 次失败原因分布）。

风险：

- 线上问题排查成本高。

### 2. 推荐优化路线（分三期）

### Phase A（1-2 周）：稳定性与可回归性

目标：先把系统变成“可稳定迭代”。

任务：

1. 引入测试框架（建议 Vitest）
   - 覆盖：`step-executor`、`tool-runner`、`handle-message` 关键分支
2. 增加取消链路回归用例
   - step timeout、parent abort、run superseded
3. 增加并行只读工具回归用例
   - 空规划、部分成功、超时取消、缓存命中
4. 建立最小 CI 检查脚本
   - `typecheck` + `unit test` + `smoke test`

验收标准：

- 核心路径（任务执行、工具执行、消息处理）有自动化回归。
- 新改动不再只靠手工验证。

### Phase B（1-2 周）：观测与调优闭环

目标：把“能跑”升级为“可量化优化”。

任务：

1. 新增运行指标聚合（先本地/文件级即可）
   - `task_completed_rate`
   - `task_timed_out_rate`
   - `readonly_plan_empty_rate`
   - `tool_call_rate_by_tool`
2. 在 `step-executor` 增加规划命中统计日志
   - 规划为空/非空
   - 并行执行耗时
3. 在 `handle-message` 增加端到端耗时
   - 收到消息到回复完成总耗时
4. 输出每日报告/启动报告
   - 最近 N 次任务状态分布

验收标准：

- 每次 prompt 或策略调整后，能看到指标变化。

### Phase C（2-4 周）：功能扩展

目标：提升真实可用性和用户体验。

任务：

1. 附件能力增强
   - xlsx/pptx 文本提取与结构化摘要
   - 大文件分段处理 + 截断策略
2. 记忆能力增强
   - summary 加版本号与质量检查
   - 失败 summary 回滚机制
3. 任务体验增强
   - 支持“中途进度回推”与“取消反馈文案”细化
   - 最终答案附带可选“执行摘要”开关
4. 工具生态增强
   - 增加可审计的 HTTP 白名单策略（可选）
   - 增加更多只读工具（例如 JSON 提取/文本检索）

验收标准：

- 附件场景成功率明显提升。
- 长任务用户感知更稳定。

### 3. 立刻可做的 5 个高收益改动

1. 增加 `readonly_plan_empty_rate` 指标。
2. 为 `step-executor` 补 3 条测试：空规划、执行超时、缓存命中。
3. 为 `handle-message` 补 3 条测试：run superseded、超时文案、附件不支持文案。
4. 增加 `pnpm` 脚本：`typecheck`、`test:unit`、`test:smoke`。
5. 启动时打印关键配置摘要（去敏）。

### 4. 可新增功能建议（按价值排序）

1. **会话级“任务历史面板”数据结构**
   - 让每次任务的 plan/step/status 可追踪（先落本地 JSON）。
2. **可配置回答风格模板**
   - 简洁/详细/技术向三个档位。
3. **附件摘要缓存**
   - 同一文件重复提问时避免重复解析。
4. **工具调用解释开关**
   - 可选向用户展示“这次调用了哪些工具、为什么调用”。

### 5. 建议暂缓的事项

1. 大规模硬编码规则引擎
   - 维护成本高，扩展性差。
2. 过早引入复杂外部基础设施
   - 在测试与观测闭环未建立前，收益不高。

### 6. 最终建议

先做 Phase A + Phase B，再做 Phase C。当前项目已经具备较好的架构骨架（任务编排、取消链路、工具 runtime、记忆持久化），下一阶段最大收益来自：

- 补测试
- 补指标
- 用数据驱动 prompt/策略优化

这样可以在不大改架构的前提下，持续提升稳定性和体验。
