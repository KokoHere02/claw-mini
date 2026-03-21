# JSONParseError 排查记录

## 现象

用户提问：

```text
列出当前目录
```

运行时报错：

```text
JSONParseError [AI_JSONParseError]: JSON parsing failed: Text: <html>.
Error message: Unexpected token '<', "<html>" is not valid JSON
```

## 根因

这次问题不是 `run_command` 的 `ls` 工具本身报错，而是 agent loop 的执行逻辑和模型网关异常叠加导致的。

### 第一层问题：重复触发同一个规则工具

旧逻辑里，`planNextStep(messages)` 每一轮都会优先调用 `inferToolDecision(messages)`。

而 `inferToolDecision(messages)` 只看“最后一条用户消息”。

对于：

```text
列出当前目录
```

它每一轮都会命中：

- `run_command`
- `command = ls`

即使上一轮已经成功执行过 `ls`，下一轮仍然会继续选 `ls`。

也就是说，旧逻辑没有识别：

- 这条用户消息已经进入过工具执行阶段
- 当前上下文里已经存在工具结果
- 不应该再继续对同一条原始用户请求重复做规则匹配

结果就是 agent loop 会在相同工具上打转，直到达到最大步数，或者进入后续兜底分支。

### 第二层问题：模型网关返回了 HTML 错页

当 loop 没有正确收敛成直接答案时，会进入模型生成文本的路径，例如：

- planner 阶段
- direct fallback 阶段
- max steps 收尾阶段

这些地方都依赖 `streamText(...)` 调模型。

但当前配置的模型网关返回的不是标准 JSON，而是 HTML 页面：

```text
<html>
```

这通常意味着：

- 网关地址错误
- 上游服务异常
- 反代/鉴权失败
- 返回了网页错误页而不是 OpenAI 兼容 JSON

AI SDK 期望解析 JSON，于是抛出了：

```text
AI_JSONParseError
```

## 修复内容

### 修复 1：有工具上下文后，不再重复做同一条用户消息的规则选工具

新增逻辑：

- 找到最后一条用户消息
- 检查它之后是否已经出现：
  - `[tool_result]`
  - `[tool_error]`
  - `{"action":"call_tool"...}`

如果已经存在这些内容，说明这条用户消息已经进入过工具阶段。
此时不再执行 `inferToolDecision(...)`，改为走模型 planner 或后续收尾逻辑。

这样可以避免：

- `列出当前目录`
- 每一轮都继续触发 `ls`
- 导致无限重复

### 修复 2：对单步工具问题直接返回工具结果

新增了工具结果直出逻辑，覆盖这些场景：

- `get_current_time`
- `calculate_expression`
- `run_command`
- `http_request`

例如：

```text
列出当前目录
```

在 `ls` 成功后，会直接把工具结果整理成文本返回，而不是再依赖模型总结。

这样即使模型网关暂时不稳定，这些简单问题仍然能正常工作。

### 修复 3：模型规划/收尾阶段增加异常兜底

在这些位置加了 `try/catch`：

- `planNextStep(...)`
- `decision` 为空后的 direct fallback
- max steps 最终收尾

如果模型接口再次返回 HTML 或其他非预期格式，不再把 SDK 的底层 JSON 解析错误直接抛给用户，而是返回可读提示，例如：

```text
模型服务暂时返回了非预期结果，工具已经执行的话你可以稍后重试，或检查模型网关配置。
```

## 当前行为变化

### 修复前

用户：

```text
列出当前目录
```

可能出现：

1. 第一轮调 `ls`
2. 第二轮继续调 `ls`
3. 重复多轮
4. 最后进入模型收尾
5. 模型网关返回 HTML
6. 抛出 `AI_JSONParseError`

### 修复后

用户：

```text
列出当前目录
```

正常应变成：

1. 第一轮调 `ls`
2. 工具成功
3. 因为这是单步工具问题，直接把目录结果返回
4. 不再依赖模型生成最终答案

## 这类错误的本质判断方法

如果再次看到：

```text
Unexpected token '<'
```

通常优先怀疑：

1. 模型网关返回了 HTML 错页
2. 某段逻辑期待 JSON，但实际拿到了网页内容
3. 上游接口不是 OpenAI 兼容响应

而不是先怀疑本地工具本身坏了。

## 建议下一步

建议继续验证以下问题：

```text
列出当前目录
```

```text
现在几点？
```

```text
计算 `(23 + 19) * 4`
```

如果这些都正常，说明：

- 单步工具直出已经有效
- 不会再因模型网关异常而把基础工具问题拖进 JSON 解析错误

如果后续复杂多轮问题仍报类似错误，就说明还需要进一步加一层：

- 当工具结果已经足够时，优先本地拼装最终答案
- 尽量减少对不稳定模型网关的依赖
