# agent2 ESM 兼容说明

## 问题

启动时报错：

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined ... @mariozechner/pi-ai/package.json
```

## 根因

`@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 是 ESM-only 包。

`@mariozechner/pi-ai` 的 `exports` 只提供了 `import`，没有 `require`。当前项目运行链路在加载这些包时落到了 CJS 侧，于是报错。

## 当前处理

在 `src/agent2/index.ts` 中不再使用顶层静态导入：

- `import { Agent } from '@mariozechner/pi-agent-core'`
- `import { Type, getModel } from '@mariozechner/pi-ai'`

改为运行时动态导入它们的 `dist/index.js`：

- `node_modules/@mariozechner/pi-agent-core/dist/index.js`
- `node_modules/@mariozechner/pi-ai/dist/index.js`

这样可以绕过当前项目模块制式与包 `exports` 的冲突。

## 影响

这是一个可运行的 workaround，不是长期最优结构。

长期更好的做法是：

1. 整个项目切到一致的 ESM 运行方式
2. 或者单独把 `agent2` 放到明确的 ESM 子包里

## 现在的状态

当前 `agent2` 已采用动态导入 workaround，可以继续开发最小可运行版本。
