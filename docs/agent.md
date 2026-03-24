# Agent架构

用户输入 -> Agent Router -> Agent Loop （编排Agent执行流程，包含通用工具，上网工具，数据计算）（Agent 的具体能力（编写代码 ？ 闲聊 ？ 下载文件 ？ ） -> 工具执行 ）

包结构
src
-- Agent
    -- chatAgent.ts
    -- codeAgent.ts
    -- operateAgent.ts
    -- tool
      -- xxxtool.ts