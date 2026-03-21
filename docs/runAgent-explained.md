# runAgent 执行逻辑说明

## 函数位置

- `src/agent/index.ts`
- 导出函数: `runAgent(messages)`

## 总体作用

`runAgent` 是整个 agent loop 的主控函数。

它接收一组对话消息 `messages`，然后反复执行以下流程：

1. 判断下一步是直接回答，还是调用工具
2. 如果要调用工具，就执行工具
3. 把工具结果或错误写回上下文
4. 基于新的上下文继续下一轮判断
5. 直到得到最终答案，或者达到最大步数上限

它不是“模型只调用一次”的单轮流程，而是多轮循环。

## 主流程

### 1. 初始化上下文

```ts
const workingMessages = [...messages];
const maxSteps = config.agent.maxSteps;
```

说明：

- `workingMessages` 是循环内部使用的上下文副本
- 后续工具调用结果、错误、planner 反馈都会被追加到这里
- `maxSteps` 是最大循环步数，用来防止死循环

### 2. 进入循环

```ts
for (let step = 1; step <= maxSteps; step += 1)
```

每一轮代表一次 agent 决策。

### 3. 规划下一步

```ts
const decision = await planNextStep(workingMessages);
```

`planNextStep` 只会返回两类结构：

```ts
type AgentDecision =
  | { action: 'respond'; answer: string }
  | { action: 'call_tool'; tool: string; arguments?: Record<string, unknown> };
```

也就是说，当前轮只允许两种行为：

- 直接回答
- 调一个工具

### 4. 如果 planner 没给出合法结果

```ts
if (!decision) {
  const fallback = await collectText(workingMessages, makeDirectAnswerSystemPrompt());
  return fallback;
}
```

说明：

- 如果 planner 输出不可解析
- 就不继续 agent loop
- 直接退回普通回答模式

这是兜底逻辑。

### 5. 如果已经可以直接回答

```ts
if (decision.action === 'respond') {
  return decision.answer;
}
```

说明：

- 当前上下文已经足够
- 不需要再调用工具
- 直接结束整个 `runAgent`

### 6. 如果要调用工具，先检查工具是否存在

```ts
const toolDefinition = registry.get(decision.tool);
```

如果工具不存在，不会立刻报错退出，而是：

```ts
workingMessages.push({
  role: 'system',
  content: [
    '[planner_feedback]',
    `Tool "${decision.tool}" is unavailable.`,
    'Choose a different tool or respond directly.',
  ].join('\n'),
});
continue;
```

说明：

- agent 会把“工具不存在”写回上下文
- 然后进入下一轮
- 让 planner 重新选工具或者直接回答

这也是 loop 的关键点。

### 7. 执行工具

```ts
const toolResult = await runner.run(toolDefinition, toolArgs);
```

这里会：

- 校验参数
- 执行具体工具实现
- 获取 JSON 可序列化结果

### 8. 工具成功后，把结果写回上下文

```ts
workingMessages.push(
  {
    role: 'assistant',
    content: JSON.stringify({
      action: 'call_tool',
      tool: toolDefinition.name,
      arguments: toolArgs,
    }),
  },
  makeToolContextMessage(toolDefinition.name, toolDefinition.description, toolArgs, toolResult),
);
continue;
```

这里追加了两条消息：

1. assistant 消息
   - 记录本轮调用了什么工具

2. system 消息
   - 由 `makeToolContextMessage(...)` 生成
   - 内容包括：
     - 工具名
     - 工具描述
     - 输入参数
     - 工具结果

然后 `continue` 进入下一轮。

注意：

- 工具成功后并不会立刻给用户自然语言答复
- 而是把结果喂回上下文
- 让下一轮 planner 决定是否继续调工具，或者直接回答

### 9. 工具失败后，把错误写回上下文

```ts
workingMessages.push(
  {
    role: 'assistant',
    content: JSON.stringify({
      action: 'call_tool',
      tool: toolDefinition.name,
      arguments: toolArgs,
    }),
  },
  makeToolErrorMessage(toolDefinition.name, error),
);
```

说明：

- 失败时不会直接退出
- 会把错误作为 `[tool_error]` system 消息追加进去
- 下一轮 planner 能看到刚才失败的原因
- 然后自己决定：
  - 换别的工具
  - 或者直接回答
  - 或者承认限制

### 10. 达到最大步数后强制收尾

```ts
const fallback = await collectText(
  workingMessages,
  [
    makeDirectAnswerSystemPrompt(),
    `You have reached the maximum tool/planning steps (${maxSteps}).`,
    'Use the information already gathered and provide the best final answer now.',
  ].join('\n'),
);
return fallback;
```

说明：

- 如果跑满 `maxSteps` 还没有结束
- agent 就停止继续规划
- 强制基于当前已有上下文输出最终答案

这是防死循环机制。

## 这个函数的真实行为

`runAgent` 的本质不是：

- 模型答一次
- 或者最多调一个工具

而是：

- 多轮规划
- 多次工具调用
- 工具结果持续回填上下文
- 直到 planner 判断“现在可以回答了”

## 用伪代码概括

```ts
runAgent(messages):
  workingMessages = copy(messages)
  maxSteps = config.agent.maxSteps

  for step in 1..maxSteps:
    decision = planNextStep(workingMessages)

    if decision is invalid:
      return directAnswer(workingMessages)

    if decision.action == 'respond':
      return decision.answer

    if decision.action == 'call_tool':
      if tool not found:
        append planner feedback
        continue

      try:
        result = run tool
        append tool result to workingMessages
        continue
      catch error:
        append tool error to workingMessages
        continue

  return finalAnswerFromCurrentContext(workingMessages)
```

## 关键理解

你如果只抓一句话，可以理解为：

`runAgent = 一个会反复做“决策 -> 调工具 -> 把结果塞回上下文 -> 再决策”的循环执行器。`

## 建议继续看的函数

如果你要继续顺着理解，下一步最值得看的是：

1. `planNextStep`
2. `inferToolDecision`
3. `makeToolContextMessage`
4. `runner.run`
