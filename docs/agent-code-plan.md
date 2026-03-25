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

## 九、Phase 5 方案：任务编排

目标：

- 支持多步任务分解
- 支持按步骤顺序执行
- 支持执行中的进度反馈
- 支持最终结果合成

这一步的重点不是再把 `runAgent` 写得更复杂，而是把“单轮工具调用循环”升级成“可观测、可控的任务执行流程”。

当前项目已经有：

- 消息入口
- 会话 memory
- agent planner
- tool runtime
- 最终回复

Phase 5 要补的是：

- 任务计划 `plan`
- 执行步骤 `steps`
- 进度事件 `progress`
- 最终汇总 `synthesis`

也就是让系统从：

```txt
用户问题 -> 想一步 -> 调一次工具/回答
```

升级到：

```txt
用户问题 -> 生成任务计划 -> 顺序执行多个步骤 -> 持续反馈进度 -> 汇总最终结果
```

### 1. 当前现状

当前核心执行逻辑在：

- `src/agent/index.ts`

它现在已经有 loop，但本质仍然是：

1. 根据当前上下文决定下一步
2. 回答，或者调用一个工具
3. 把工具结果塞回上下文
4. 继续下一轮直到结束

这个模型有几个限制：

- 没有显式任务计划
- 没有“当前执行到哪一步”的结构化状态
- 没有进度反馈协议
- 工具结果只是上下文的一部分，不是任务结果的一部分
- 最终答案依赖模型自己临场整理，不是基于明确执行产物做合成

所以它更像“多轮工具推理”，还不是“任务编排”。

### 2. Phase 5 的目标拆分

建议把 Phase 5 拆成四块。

#### 2.1 多步任务分解

在真正执行前，先产出一个结构化计划。

计划至少回答四个问题：

- 这次任务要做什么
- 需要几步
- 每一步要产出什么
- 哪一步依赖前一步

第一版不做并行，只做顺序任务。

#### 2.2 顺序执行

计划生成后，不再让主 loop 完全自由跳转，而是改成：

- 选中当前步骤
- 为当前步骤生成具体动作
- 执行动作
- 记录结果
- 标记步骤状态
- 进入下一步骤

也就是从“自由 agent loop”变成“计划驱动 loop”。

#### 2.3 进度反馈

执行过程中需要有结构化进度。

至少要支持：

- 计划已生成
- 正在执行第 N 步
- 某一步完成
- 某一步失败
- 全部完成

进度反馈第一版可以先只做服务端内部事件和日志；
如果你希望飞书侧也能感知，再加“处理中”文本更新策略。

#### 2.4 结果合成

最终回答不应该只基于最后一轮上下文生成，而应该基于：

- 原始用户目标
- 任务计划
- 各步骤结果
- 错误与限制

也就是先形成结构化执行报告，再让模型做最后整理。

### 3. 推荐数据结构

第一版建议显式引入任务状态对象。

```ts
type TaskRunStatus =
  | 'planning'
  | 'running'
  | 'completed'
  | 'failed';

type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

type TaskStep = {
  id: string;
  title: string;
  goal: string;
  expectedOutput: string;
  status: TaskStepStatus;
  result?: string;
  error?: string;
};

type TaskPlan = {
  goal: string;
  steps: TaskStep[];
};

type TaskRun = {
  status: TaskRunStatus;
  plan: TaskPlan | null;
  currentStepIndex: number;
  progressText?: string;
  finalAnswer?: string;
};
```

如果想给后续扩展留口子，可以在 `TaskStep` 上补：

```ts
toolCalls?: Array<{
  tool: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}>;
```

但第一版不建议一开始塞太多字段。

### 4. 推荐模块拆分

建议新增以下模块。

#### 4.1 `src/agent/task-types.ts`

职责：

- 定义 `TaskPlan`
- 定义 `TaskStep`
- 定义 `TaskRun`
- 定义进度事件类型

#### 4.2 `src/agent/task-planner.ts`

职责：

- 根据用户请求和上下文生成结构化多步计划

建议接口：

```ts
async function buildTaskPlan(messages: ModelMessage[]): Promise<TaskPlan>
```

这里建议使用结构化输出，不再用脆弱的 JSON 文本解析。

#### 4.3 `src/agent/task-orchestrator.ts`

职责：

- 接收 `TaskPlan`
- 逐步执行
- 维护步骤状态
- 发出进度事件
- 收集所有步骤结果

建议接口：

```ts
async function runTaskOrchestration(input: {
  messages: ModelMessage[];
  onProgress?: (event: TaskProgressEvent) => Promise<void> | void;
}): Promise<{
  answer: string;
  taskRun: TaskRun;
}>
```

#### 4.4 `src/agent/step-executor.ts`

职责：

- 面向单个步骤执行
- 决定当前步骤需要直接回答还是调用工具
- 将步骤结果返回给 orchestrator

建议接口：

```ts
async function executeTaskStep(input: {
  step: TaskStep;
  messages: ModelMessage[];
  previousStepResults: string[];
}): Promise<{
  result: string;
  toolActivity?: unknown[];
}>
```

#### 4.5 `src/agent/result-synthesizer.ts`

职责：

- 基于整个计划和步骤结果，生成最终对用户可读的回答

建议接口：

```ts
async function synthesizeTaskResult(input: {
  goal: string;
  plan: TaskPlan;
  stepResults: TaskStep[];
  messages: ModelMessage[];
}): Promise<string>
```

### 5. 推荐执行状态机

建议状态机保持简单。

#### 5.1 TaskRun 状态

```txt
planning -> running -> completed
planning -> failed
running -> failed
```

#### 5.2 TaskStep 状态

```txt
pending -> running -> completed
pending -> running -> failed
pending -> skipped
```

第一版建议：

- 某一步失败后，默认停止整个任务
- 不做自动重试
- 不做步骤回滚

这样更容易把链路先跑通。

### 6. 推荐调用链

建议主流程改成下面这样：

```txt
handleMessage
  -> 构造 conversation
  -> runAgentTask
    -> buildTaskPlan
    -> emit progress: planned
    -> for each step
      -> emit progress: step_started
      -> executeTaskStep
      -> emit progress: step_completed / step_failed
    -> synthesizeTaskResult
    -> emit progress: completed
  -> 发送最终回复
  -> 更新 memory
```

为了兼容当前代码，推荐保留一个统一入口：

```ts
export async function runAgent(messages: ModelMessage[]): Promise<string>
```

只是内部不再直接跑旧 loop，而是逐步演进成：

```txt
runAgent
  -> runTaskOrchestration
  -> return final answer
```

这样对外接口不变，风险最低。

### 7. 任务计划生成建议

任务计划阶段的目标不是“把所有细节都规划完”，而是做一个足够稳定的粗计划。

建议规则：

- 步骤数限制在 `2 ~ 5` 步
- 每一步必须有明确目标
- 每一步描述必须面向用户任务，不要写内部 prompt 术语
- 不允许空步骤
- 不允许重复步骤

计划输出建议格式：

```ts
type TaskPlan = {
  goal: string;
  steps: Array<{
    id: string;
    title: string;
    goal: string;
    expectedOutput: string;
  }>;
};
```

可以把约束写进 planner prompt：

- 优先生成最小必要步骤
- 如果任务足够简单，可只生成 1 步
- 步骤之间默认顺序依赖
- 不要把“总结结果”单独拆成过多空洞步骤

### 8. 单步骤执行策略

每个步骤的执行建议分两层。

#### 8.1 步骤级规划

让模型基于：

- 用户总目标
- 当前步骤目标
- 已完成步骤结果
- 当前上下文

决定当前步骤应该：

- 直接产出结果
- 调一个工具
- 调多个工具后整理结果

#### 8.2 步骤内小循环

保留当前项目已有的工具循环能力，但作用域缩小到“当前步骤内部”。

也就是说：

- 旧 `runAgent` 的 loop 不要完全废弃
- 而是转成 `runStepAgentLoop`
- 只服务于某个步骤的执行

建议接口类似：

```ts
async function runStepAgentLoop(input: {
  step: TaskStep;
  messages: ModelMessage[];
  maxSteps: number;
}): Promise<string>
```

这样可以最大化复用现有：

- planner prompt
- tool registry
- tool runner
- recovery prompt

### 9. 进度反馈设计

进度反馈建议先做成结构化事件，而不是一开始就和飞书消息更新深度耦合。

建议事件类型：

```ts
type TaskProgressEvent =
  | { type: 'planned'; plan: TaskPlan }
  | { type: 'step_started'; stepId: string; index: number; total: number; title: string }
  | { type: 'step_completed'; stepId: string; index: number; total: number; title: string; result: string }
  | { type: 'step_failed'; stepId: string; index: number; total: number; title: string; error: string }
  | { type: 'completed'; answer: string }
  | { type: 'failed'; error: string };
```

#### 9.1 为什么先做内部事件

因为当前飞书链路是：

- 收到消息
- 最后统一回复一次

如果一开始就强行做“多次发消息更新进度”，会引入新的问题：

- 飞书消息风暴
- 同一个会话的中间状态噪音
- 失败时用户看到一堆半成品进度

更稳妥的做法是分两阶段。

#### 9.2 第一阶段

先做：

- 结构化进度事件
- 详细日志
- 本地可观测

#### 9.3 第二阶段

再评估是否增加：

- 飞书侧“开始处理/完成某步”的中间提示
- 或者把执行摘要折叠到最终回复里

### 10. 结果合成设计

结果合成是 Phase 5 的关键，因为真正给用户看的不是步骤日志，而是最终答案。

建议把结果合成分成两层。

#### 10.1 执行报告

先组装一个结构化对象：

```ts
type TaskExecutionReport = {
  goal: string;
  status: 'completed' | 'failed';
  steps: Array<{
    title: string;
    status: TaskStepStatus;
    result?: string;
    error?: string;
  }>;
};
```

#### 10.2 最终答案生成

再基于这个报告让模型生成最终回答。

这样最终回答会更稳定，因为模型面对的是：

- 已经整理好的执行产物

而不是：

- 一堆混杂的 `tool_result`、`system message`、`assistant JSON`

建议最终输出策略：

- 先回答最终结论
- 再简要说明完成了哪些步骤
- 如果失败，明确失败点和限制

### 11. 和当前代码的映射关系

建议这样迁移。

#### 11.1 保留

- `src/services/handle-message.ts`
- `src/services/memory.ts`
- `src/agent/tools/*`
- `src/agent/tool-registry.ts`
- `src/agent/tool-runner.ts`
- `src/agent/prompt-builder.ts` 的基础能力

#### 11.2 改造

- `src/agent/index.ts`
  - 从“单体 loop”改成“任务编排入口”

#### 11.3 新增

- `src/agent/task-types.ts`
- `src/agent/task-planner.ts`
- `src/agent/task-orchestrator.ts`
- `src/agent/step-executor.ts`
- `src/agent/result-synthesizer.ts`

#### 11.4 可复用旧逻辑

旧逻辑里这几块很适合保留：

- 工具推断
- planner prompt
- answer/recovery prompt
- tool result 注入

但它们的作用域要收缩到“步骤执行器”里，而不是继续承担整个任务生命周期。

### 12. 最小可落地版本

如果目标是尽快落地，我建议先做 MVP。

#### 12.1 MVP 范围

- 只支持顺序步骤
- 不支持并行
- 不支持步骤自动重试
- 不支持任务暂停/恢复
- 进度反馈只做内部事件和日志
- 最终只给用户发一次消息

#### 12.2 MVP 能力

- 先生成 1 份任务计划
- 逐步执行每个步骤
- 为每个步骤记录结果
- 最后合成回答

这已经足够覆盖你说的：

- 多步任务分解
- 顺序执行
- 进度反馈
- 结果合成

### 13. 推荐落地顺序

建议按下面顺序推进。

#### Step 1

定义任务编排核心类型：

- `TaskPlan`
- `TaskStep`
- `TaskRun`
- `TaskProgressEvent`

#### Step 2

实现 `task-planner.ts`：

- 基于当前对话生成结构化任务计划

#### Step 3

把当前 `runAgent` loop 收缩成步骤执行器：

- `runStepAgentLoop`

#### Step 4

实现 `task-orchestrator.ts`：

- 顺序执行所有步骤
- 维护状态
- 发出进度事件

#### Step 5

实现 `result-synthesizer.ts`：

- 基于执行报告生成最终答案

#### Step 6

把 `handle-message.ts` 接到新编排入口

#### Step 7

增加日志和调试命令

建议新增调试命令：

- `#plan`
- `#task`

方便观察：

- 当前生成的计划是什么
- 每一步执行结果是什么

### 14. 未来扩展点

Phase 5 的设计最好给后面留出扩展空间。

后面可以继续加：

- 并行步骤
- 步骤依赖图，而不只是线性顺序
- 失败重试
- 中断/恢复
- 任务持久化
- 飞书中的实时进度更新
- 更细的 run telemetry

但这些都不建议塞进第一版。

第一版最重要的是先把“任务计划 -> 步骤执行 -> 结果合成”这条主链路跑通。

### 15. 结论

最推荐的 Phase 5 路线是：

- 不推翻现有 agent loop
- 把现有 loop 下沉为“步骤执行器”
- 在它上面增加“任务计划 + 顺序编排 + 进度事件 + 结果合成”

也就是从：

```txt
自由循环的单体 agent
```

升级为：

```txt
计划驱动的任务编排 runtime
```

如果按这个方向做，当前项目会从“可工作的最小 agent executor”进一步进化成“具备任务执行能力的轻量 runtime”，这也是最接近 Phase 5 目标的实现路径。
