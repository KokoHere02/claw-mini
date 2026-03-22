# Phase 4.5 方案：记忆持久化

目标：

- 当前 `MemoryService` 里的 `summary` 和 `recentMessages` 不只存在于进程内存
- 服务重启后仍能恢复会话记忆
- 为后续 `userFacts`、任务状态、长期记忆做持久化基础

这一步建议先做“文件持久化”，不要一开始就上数据库。

## 一、为什么现在不建议直接上数据库

当前项目还在快速演进阶段，Phase 4 / Phase 5 的数据结构还没有完全稳定。

还没完全定下来的内容包括：

- `summary` 刷新策略
- `userFacts` 的结构
- 是否要加入任务状态 `taskState`
- 动态 Prompt 最终要拼哪些字段

如果现在就直接上数据库，会很快遇到：

- schema 频繁变动
- migration 频繁修改
- 还没验证清楚的数据结构先被“固化”

所以这一步更合理的做法是：

- 先用文件持久化验证数据模型
- 等结构稳定后再迁移到 SQLite

## 二、推荐阶段划分

### Phase 4.5-A：文件持久化

先持久化：

- `summary`
- `recentMessages`
- `updatedAt`

### Phase 4.5-B：扩展字段

后续再加入：

- `userFacts`
- `taskState`
- `metadata`

### Phase 4.5-C：迁移到 SQLite

等数据结构稳定后，将文件仓储替换为 SQLite 仓储。

## 三、推荐数据结构

建议先定义一个持久化层专用类型：

```ts
type PersistedSessionMemory = {
  chatId: string;
  summary: string;
  recentMessages: ConversationMessage[];
  updatedAt: number;
};
```

如果想提前兼容后续扩展，可以直接预留：

```ts
type PersistedSessionMemory = {
  chatId: string;
  summary: string;
  recentMessages: ConversationMessage[];
  userFacts: string[];
  updatedAt: number;
};
```

当前阶段即使 `userFacts` 还是空数组，也建议先把字段预留好。

## 四、文件存储目录建议

建议目录：

```txt
data/
  memory/
    <chatId>.json
```

例如：

```txt
data/
  memory/
    oc_a1b2c3d4.json
    oc_xxx_yyy_zzz.json
```

### 文件内容示例

```json
{
  "chatId": "oc_a1b2c3d4",
  "summary": "用户正在重构 Agent 架构，当前已实现 summary 注入和自动摘要。",
  "recentMessages": [
    { "role": "user", "content": "把 summary 拼进 prompt" },
    { "role": "assistant", "content": "已经接上了..." }
  ],
  "updatedAt": 1763810000000
}
```

## 五、推荐模块拆分

建议新增：

### 1. `src/services/memory-repository.ts`

职责：

- 对外提供统一持久化接口
- 隔离底层存储方式
- 后续可以从 file repo 平滑切到 sqlite repo

建议接口：

```ts
import type { SessionMemory } from './memory';

export interface MemoryRepository {
  load(chatId: string): Promise<SessionMemory | null>;
  save(chatId: string, memory: SessionMemory): Promise<void>;
  delete(chatId: string): Promise<void>;
}
```

### 2. `src/services/file-memory-repository.ts`

职责：

- 基于 JSON 文件实现 `MemoryRepository`

建议接口：

```ts
export class FileMemoryRepository implements MemoryRepository {
  load(chatId: string): Promise<SessionMemory | null>;
  save(chatId: string, memory: SessionMemory): Promise<void>;
  delete(chatId: string): Promise<void>;
}
```

### 3. `src/services/memory.ts`

职责保持不变：

- 仍负责内存态读写
- 仍负责业务逻辑
- 但内部增加 repository 同步能力

## 六、MemoryService 应该怎么接持久化

建议不要让 `handle-message.ts` 直接操作文件。

正确做法是：

- `handle-message.ts` 只和 `MemoryService` 打交道
- `MemoryService` 内部决定何时同步到 repository

推荐模式：

### 初始化时

- `getSession(chatId)` 若内存不存在
- 尝试从 repository 加载
- 加载成功后放入内存缓存

### 更新时

以下操作后触发持久化：

- `appendExchange`
- `updateSummary`
- `replaceRecentMessages`
- `resetConversation`

## 七、推荐调用链

```txt
handleMessage
  -> memoryService.getSession(chatId)
    -> memory cache miss
    -> repository.load(chatId)
  -> runAgent
  -> memoryService.appendExchange(...)
    -> repository.save(...)
  -> memoryService.updateSummary(...)
    -> repository.save(...)
```

也就是说：

- 内存缓存负责性能
- repository 负责落盘

## 八、文件仓储实现建议

### 1. chatId 转文件名

建议不要直接裸用所有 chatId 字符，因为有些平台 ID 可能带特殊字符。

可以先做简单安全化：

```ts
function toSafeFileName(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
}
```

### 2. 目录自动创建

第一次保存时自动创建：

- `data/`
- `data/memory/`

### 3. 原子写入

建议写文件时不要直接覆盖目标文件。

更稳的方式：

1. 先写 `<chatId>.json.tmp`
2. 再 rename 成正式文件

这样能降低中途崩溃导致损坏文件的概率。

### 4. 读取容错

如果文件损坏：

- 记录日志
- 返回空 memory
- 不要让主流程崩掉

## 九、是否要同步写还是异步写

建议第一版：

- 更新后异步写盘
- 失败只记录日志

原因：

- 不阻塞主回复链路
- 即使偶发写失败，也不会影响用户回复

但也要注意：

- 异步写盘意味着极少数情况下最后一条消息可能没落盘

如果你更重视一致性，可以在关键节点用同步等待，但第一版我不建议这么重。

## 十、配置建议

建议在 `config.ts` 增加 memory persistence 配置：

```ts
memory: {
  summaryTriggerMessageCount: number;
  summaryKeepRecentMessageCount: number;
  summaryPrompt?: string;
  summaryPromptFile?: string;
  storageDir: string;
}
```

建议环境变量：

```env
MEMORY_STORAGE_DIR=data/memory
```

默认值可以就是：

```txt
data/memory
```

## 十一、为什么文件方案适合你当前阶段

优点：

- 实现成本低
- 不引入额外依赖
- 调试非常方便
- 直接打开文件就能看 summary 是否正常
- 和当前单实例服务非常匹配

缺点：

- 不适合高并发
- 不适合复杂查询
- 不适合多实例共享状态

但这些都不是你当前阶段的主要问题。

## 十二、后续迁移到 SQLite 的路径

等文件方案验证稳定后，可以把底层仓储替换为 SQLite。

建议表结构：

```sql
CREATE TABLE session_memory (
  chat_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  recent_messages_json TEXT NOT NULL,
  user_facts_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

这样迁移时：

- `MemoryService` 基本不动
- `MemoryRepository` 接口不动
- 只替换 repository 实现

这就是为什么现在先抽 `repository` 接口很重要。

## 十三、推荐落地顺序

### Step 1

新增 `MemoryRepository` 接口

### Step 2

新增 `FileMemoryRepository`

### Step 3

给 `MemoryService` 注入 repository

### Step 4

在 `getSession / appendExchange / updateSummary / resetConversation` 里接读写盘

### Step 5

加日志：

- load success/fail
- save success/fail
- file path

## 十四、结论

当前最推荐的持久化方案是：

- 先做文件仓储
- 先落盘 `summary + recentMessages`
- 让 `MemoryService` 继续做统一内存入口
- 后面再平滑迁移到 SQLite

也就是：

```txt
MemoryService
  + in-memory cache
  + FileMemoryRepository
  -> data/memory/<chatId>.json
```

这条路最适合你当前阶段：实现快、调试方便、风险低。
