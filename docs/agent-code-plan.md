# Agent 代码方案（简版）

基于 [docs/agent.md](/D:/ts/claw-mini/docs/agent.md) 的目标：

- 用户输入
- Agent Router
- Agent Loop
- 不同能力 Agent（chat / code / operate）
- 工具执行层

结合当前仓库现状，建议不要直接重写，而是在现有 `src/agent` 基础上做一次“分层重构”，把现在的单体 `runAgent` 拆成 Router、Loop、Agent Profile、Tool Runtime 四层。

## 一、当前现状判断

当前仓库里已经有可运行的雏形：

- `src/services/handle-message.ts` 负责消息入口
- `src/agent/index.ts` 同时承担了路由、规划、工具调用、结果收敛
- `src/agent/tools/*` 已有工具实现
- `src/agent2/index.ts` 还处于草稿状态

问题是：

- 路由逻辑、执行循环、工具编排全部耦合在一个文件里
- 现在并没有真正的 `chatAgent` / `codeAgent` / `operateAgent`
- Agent 的“差异化能力”目前主要靠 prompt 和少量规则判断，后续会越来越难扩展
- `agent2` 和 `agent` 有重复方向，容易分叉

所以更合适的方案不是“再加一个 agent2”，而是把 `src/agent` 重构成真正的 Agent Runtime。

## 二、建议目标结构

建议目录：

```txt
src
  agent
    index.ts
    router.ts
    loop.ts
    context.ts
    message-utils.ts
    prompt-builder.ts
    types.ts
    profiles
      chat-agent.ts
      code-agent.ts
      operate-agent.ts
      index.ts
    tools
      index.ts
      calculate-expression.ts
      get-current-time.ts
      http-request.ts
      run-command.ts
    tool-runtime
      registry.ts
      runner.ts
      types.ts
```

说明：

- `index.ts` 只做总入口，负责串起 router + loop
- `router.ts` 负责把用户请求映射到具体 agent profile
- `loop.ts` 负责通用的规划-执行-恢复循环
- `profiles/*` 定义不同 Agent 的能力差异
- `tool-runtime/*` 负责工具注册、参数校验、执行超时、结果序列化
- `tools/*` 继续放具体工具实现

## 三、核心分层设计

### 1. Agent Router

职责：

- 读取最后一条用户消息
- 判断这是闲聊、代码类请求、操作类请求
- 选择对应 profile

建议先只支持三类：

- `chat`
  - 闲聊、问答、解释说明
- `code`
  - 写代码、改代码、分析仓库、生成方案
- `operate`
  - 执行命令、读文件、抓网页、系统操作

路由输出建议统一成：

```ts
type AgentRoute = {
  agentType: 'chat' | 'code' | 'operate';
  reason: string;
};
```

第一阶段不需要把 Router 做得很复杂，可以先用：

- 规则优先
- 模型判断兜底

这样能降低误判成本，也方便调试。

### 2. Agent Profile

这是这次架构里最关键的一层。

每个 profile 不直接负责跑循环，而是负责定义“这个 Agent 应该怎么工作”：

- 系统提示词
- 可用工具集合
- 是否允许执行命令
- 是否偏向直接回答
- 结果整理风格

建议定义统一接口：

```ts
type AgentProfile = {
  type: 'chat' | 'code' | 'operate';
  description: string;
  systemPrompt: string;
  plannerPrompt?: string;
  allowedTools: string[];
  maxSteps?: number;
};
```

三个 profile 的建议边界：

- `chat-agent`
  - 默认不开放危险工具
  - 优先直接回答
  - 只开放时间、计算、有限网页读取这类轻量工具

- `code-agent`
  - 面向仓库分析、代码方案、修改建议
  - 可开放读文件、列目录、有限命令
  - 后续如果要做“自动改代码”，就从这里扩展

- `operate-agent`
  - 面向操作类请求
  - 工具权限最大
  - 强调执行反馈、错误处理、结果总结

### 3. Agent Loop

Loop 是通用执行器，不关心当前是 chat 还是 code，只关心：

1. 当前 profile 是谁
2. 有哪些工具可用
3. 下一步是回答还是调工具

建议保留你现在已有的主循环思路：

```txt
plan -> call tool -> append tool result -> re-plan -> final answer
```

但要从 `src/agent/index.ts` 里拆出来，成为独立模块。

Loop 输入建议：

```ts
type RunAgentInput = {
  messages: ModelMessage[];
  profile: AgentProfile;
};
```

Loop 输出：

```ts
type RunAgentResult = {
  answer: string;
  agentType: 'chat' | 'code' | 'operate';
  stepsUsed: number;
};
```

### 4. Tool Runtime

这部分你已经有基础实现，建议继续保留，只做结构整理：

- `tool-registry.ts` -> 移到 `tool-runtime/registry.ts`
- `tool-runner.ts` -> 移到 `tool-runtime/runner.ts`
- `tool-types.ts` -> 移到 `tool-runtime/types.ts`

后续可以在这层逐步补：

- 工具按 profile 过滤
- 权限控制
- 风险命令白名单
- 工具调用日志
- 工具结果截断策略

## 四、推荐调用链

完整调用链建议变成：

```txt
handle-message
  -> runAgent
    -> routeAgent
    -> loadAgentProfile
    -> runAgentLoop
      -> planner
      -> tool runtime
      -> final answer
```

其中：

- `handle-message` 不再关心内部是哪个 Agent
- `runAgent` 只负责组装，不承担具体规划细节
- 具体能力差异由 `profile` 注入到 loop 中

## 五、和当前代码的映射关系

建议这样迁移，而不是推倒重来：

### 保留

- `src/services/handle-message.ts`
- `src/services/memory.ts`
- `src/agent/tools/*`
- `src/agent/prompt-builder.ts` 的大部分思路
- `src/agent/tool-registry.ts`
- `src/agent/tool-runner.ts`
- `src/agent/tool-types.ts`

### 拆分

- `src/agent/index.ts`
  - 拆成 `index.ts + router.ts + loop.ts + message-utils.ts`

### 废弃或合并

- `src/agent2/index.ts`
  - 不建议继续单独发展
  - 里面如果有可用思路，合并回新的 `src/agent` 架构

## 六、最小落地步骤

建议按 3 个阶段推进。

### 阶段 1：先完成结构拆分

目标：

- 不改变外部行为
- 只是把现有 `runAgent` 拆层

产出：

- `router.ts`
- `loop.ts`
- `profiles/*`
- `tool-runtime/*`

这样做的好处是风险最低，现有功能还能继续跑。

### 阶段 2：补齐三类 Agent Profile

目标：

- 真正形成 `chat/code/operate` 三个可区分的 Agent
- 不同 Agent 使用不同 prompt 和工具白名单

产出：

- 三个 profile 文件
- Router 分类规则
- profile 到 tool 的映射

### 阶段 3：增强 code-agent

这是后续扩展重点。

可以继续加：

- 仓库分析模式
- 修改计划输出
- 多步骤文件阅读
- 更安全的命令执行约束

如果后面要做“自动改代码 Agent”，也应该在这一层增强，而不是另起一套 `agent3`。

## 七、我建议你先这样定

如果目标是“先把架构搭正”，最合适的方案是：

- 只保留一个 `agent runtime`
- 在 runtime 内引入 `router + profile + loop`
- 用 profile 模拟不同 Agent，而不是每个 Agent 各写一套流程

原因很直接：

- 共用执行循环，维护成本低
- 工具体系可以复用
- 后面加新 Agent 类型更容易
- 不会出现 `agent` / `agent2` 两套实现长期并存

## 八、下一步建议

如果你认可这个方向，下一步我建议直接做：

1. 先把 `src/agent` 目录重构成上述结构
2. 保持 `runAgent(messages)` 外部接口不变
3. 先实现 `chat/code/operate` 三个 profile 的骨架
4. 再把当前 prompt 和工具配置逐步迁进去

这样可以确保重构过程可控，不会一下子把现有链路打散。
