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
