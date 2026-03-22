# Phase 4 方案：记忆管理

目标：

- 会话不再只依赖最近几轮原始消息
- 引入会话摘要 `summary`
- 引入用户稳定事实 `userFacts`
- 将摘要和事实动态注入 Prompt

这一步不追求一步到位做“长期记忆系统”，而是先做一个最小可落地版本，确保对当前 Agent 架构改动可控。

## 一、当前现状

当前项目里的记忆能力主要在：

- `src/services/memory.ts`

它现在做的是：

- 按 `chatId` 保存最近几轮消息
- 控制轮数上限
- 做事件去重

它还没有：

- 会话摘要
- 用户事实提取
- 动态 Prompt 注入
- 持久化存储

所以目前的“记忆”其实更接近短期上下文缓存，不是完整的记忆管理。

## 二、Phase 4 的目标拆分

建议把 Phase 4 拆成三块：

### 1. 会话摘要 `conversationSummary`

作用：

- 压缩旧对话
- 保留任务背景
- 减少上下文长度

适合保存的信息：

- 当前用户在做什么
- 当前任务推进到了哪一步
- 已确认的技术决策
- 已完成/未完成的事项

不适合放：

- 短暂寒暄
- 工具执行原始输出
- 细碎的逐字对话

### 2. 用户事实 `userFacts`

作用：

- 保存跨轮稳定信息
- 提高回复一致性

适合保存的信息：

- 用户偏好中文
- 用户偏好小步重构
- 用户当前主要在做 Agent 项目
- 用户不希望过度抽象

不适合放：

- 临时任务步骤
- 当前一轮才出现且未确认的信息
- 会快速变化的短期上下文

### 3. 动态 Prompt `dynamicPrompt`

作用：

- 在每次调用模型前组装上下文
- 把 `summary + userFacts + recentMessages` 一起交给模型

目标：

- 保留近期对话细节
- 保留长期背景
- 控制 Prompt 长度

## 三、推荐数据结构

第一版建议保持简单，不要一开始设计得太重。

```ts
type SessionMemory = {
  recentMessages: ConversationMessage[];
  summary: string;
  userFacts: string[];
};
```

如果想再多留一点任务信息，可以扩成：

```ts
type SessionMemory = {
  recentMessages: ConversationMessage[];
  summary: string;
  userFacts: string[];
  lastUpdatedAt: number;
};
```

当前阶段不建议一开始就上复杂嵌套结构或数据库 schema。

## 四、推荐模块拆分

建议新增以下模块：

### 1. `src/services/memory-store.ts`

职责：

- 管理 `SessionMemory`
- 读写某个 `chatId` 的 memory
- 提供 `get / update / reset`

建议接口：

```ts
type SessionMemory = {
  recentMessages: ConversationMessage[];
  summary: string;
  userFacts: string[];
};

class MemoryStore {
  get(chatId: string): SessionMemory;
  appendRecentMessages(chatId: string, messages: ConversationMessage[]): void;
  updateSummary(chatId: string, summary: string): void;
  updateUserFacts(chatId: string, facts: string[]): void;
  reset(chatId: string): void;
}
```

### 2. `src/services/memory-summarizer.ts`

职责：

- 根据旧摘要 + 最近消息生成新摘要

建议接口：

```ts
async function refreshConversationSummary(input: {
  currentSummary: string;
  recentMessages: ConversationMessage[];
}): Promise<string>
```

### 3. `src/services/fact-extractor.ts`

职责：

- 从最近消息里提取稳定事实
- 去重
- 保留高置信度信息

建议接口：

```ts
async function extractUserFacts(input: {
  existingFacts: string[];
  recentMessages: ConversationMessage[];
}): Promise<string[]>
```

### 4. `src/agent/dynamic-prompt.ts`

职责：

- 动态拼接系统 Prompt
- 将 `summary / userFacts / recentMessages` 注入模型上下文

建议接口：

```ts
function buildDynamicPrompt(input: {
  systemPrompt: string;
  summary: string;
  userFacts: string[];
}): string
```

## 五、调用链建议

建议把主流程改成下面这样：

```txt
handleMessage
  -> 读取 session memory
  -> 拼 dynamic prompt
  -> runAgent
  -> 更新 recentMessages
  -> 按条件刷新 summary
  -> 按条件提取 userFacts
```

更具体一点：

```txt
用户消息
  -> memoryStore.get(chatId)
  -> buildDynamicPrompt(systemPrompt, summary, userFacts)
  -> runAgent(messages + dynamicPrompt)
  -> appendRecentMessages
  -> maybeRefreshSummary
  -> maybeExtractFacts
```

## 六、摘要刷新策略

不要每轮都做摘要。

建议触发条件：

- `recentMessages` 超过阈值，例如 8 到 12 条
- 或本轮是一次明显的任务收束

推荐策略：

- 保留最近 4 到 6 条消息原文
- 更早的消息压进 `summary`

这样模型能同时看到：

- 当前轮次的细节
- 历史任务背景

推荐流程：

1. 取旧 `summary`
2. 取最近一批较旧消息
3. 调摘要模型生成新 `summary`
4. 清理已被摘要吸收的旧消息
5. 保留最近几条原始消息

## 七、用户事实提取策略

用户事实比摘要更敏感，所以要更保守。

建议原则：

- 只提取“稳定信息”
- 只保留用户明确表达过的偏好
- 不要从一次性任务里过度推断

事实提取建议输出格式：

```ts
type FactExtractionResult = {
  facts: string[];
};
```

第一版不要做太复杂的增删改，只做：

- 提取
- 去重
- 保留最多 10 到 20 条

## 八、动态 Prompt 结构建议

建议最终拼出来的 Prompt 长这样：

```txt
[SYSTEM]
你是当前系统设定的 Agent

[USER_FACTS]
- 用户偏好中文
- 用户偏好小步重构

[CONVERSATION_SUMMARY]
用户当前在重构 Agent 架构，重点关注工具调用和多轮 Loop...

[INSTRUCTION]
结合用户事实、会话摘要和最近消息回答当前问题。
优先遵循最新用户消息。
```

注意点：

- `userFacts` 只放稳定事实
- `summary` 只放任务背景
- 永远以最近消息优先

## 九、最小可落地版本

如果要尽快推进，我建议先做 MVP：

### 第一步只做摘要

先实现：

- `summary`
- `dynamicPrompt`

先不要做 `userFacts`

原因：

- 摘要最直接有效
- 事实提取更容易误判
- 先验证 Prompt 注入是否有效更重要

MVP 版本的数据结构可以先是：

```ts
type SessionMemory = {
  recentMessages: ConversationMessage[];
  summary: string;
};
```

## 十、推荐落地顺序

建议按下面顺序推进：

### Step 1

扩展 memory store：

- 为每个 `chatId` 增加 `summary`

### Step 2

新增 `dynamic-prompt.ts`：

- 把 `summary` 拼进系统 Prompt

### Step 3

新增 `memory-summarizer.ts`：

- 允许定期刷新摘要

### Step 4

验证效果后再加 `userFacts`

### Step 5

最后再考虑持久化

## 十一、和当前阶段的关系

当前项目大致处于：

- Phase 1 已完成
- Phase 2 大体具备
- Phase 3 正在成型

Phase 4 最合理的切入点不是“做数据库”，而是：

- 先把上下文组织方式升级
- 让 Agent 真正用上摘要和事实

所以这一步本质上是：

“从短期消息缓存，升级到可压缩、可注入、可长期演进的记忆模型”

## 十二、结论

最推荐的做法：

- 先做 `summary`
- 再做 `dynamicPrompt`
- `userFacts` 作为第二阶段增强
- 持久化放到后面

也就是先打通这条最短链路：

```txt
recent messages
  + summary
  -> dynamic prompt
  -> agent reply
```

这条链路打通后，再往上叠 `userFacts` 和持久化，风险最低，也最容易看出效果。
