/**
 * Agentic Loop + Tool Calling 示例
 * 独立文件，不影响其他代码
 *
 * 演示：模型自主决定调用哪些工具，SDK 自动驱动多轮循环，直到得出最终答案
 */

import { generateText, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

const provider = createAnthropic({
  apiKey: 'your-api-key',
  baseURL: 'your-base-url',
});

// ---- 工具定义 ----

const tools = {
  // 工具1：网络搜索
  search: tool({
    description: '搜索互联网上的信息',
    parameters: z.object({
      query: z.string().describe('搜索关键词'),
    }),
    execute: async ({ query }) => {
      // 实际项目里接入真实搜索 API
      console.log(`[tool] search: ${query}`);
      return { results: [`关于"${query}"的搜索结果...`] };
    },
  }),

  // 工具2：获取天气
  getWeather: tool({
    description: '获取某个城市的当前天气',
    parameters: z.object({
      city: z.string().describe('城市名称'),
    }),
    execute: async ({ city }) => {
      console.log(`[tool] getWeather: ${city}`);
      return { city, temperature: '22°C', condition: '晴' };
    },
  }),

  // 工具3：计算器
  calculate: tool({
    description: '执行数学计算',
    parameters: z.object({
      expression: z.string().describe('数学表达式，例如 "2 + 3 * 4"'),
    }),
    execute: async ({ expression }) => {
      console.log(`[tool] calculate: ${expression}`);
      // 实际项目里用安全的表达式解析库
      const result = eval(expression);
      return { expression, result };
    },
  }),
};

// ---- Agentic Loop ----

async function runAgent(userMessage: string): Promise<string> {
  const result = await generateText({
    model: provider('claude-3-5-sonnet-20241022'),
    system: '你是一个智能助手，可以使用工具来回答问题。请尽量使用工具获取准确信息。',
    messages: [{ role: 'user', content: userMessage }],
    tools,
    maxSteps: 5, // 最多自主循环 5 轮，防止无限循环
    onStepFinish: ({ stepType, toolCalls, toolResults, text }) => {
      // 每轮结束时的回调，可用于日志/监控
      console.log(`[agent] step: ${stepType}`);
      if (toolCalls?.length) {
        console.log(`[agent] called tools: ${toolCalls.map(t => t.toolName).join(', ')}`);
      }
      if (text) {
        console.log(`[agent] intermediate text: ${text.slice(0, 50)}...`);
      }
    },
  });

  return result.text;
}

// ---- 使用示例 ----

// 模型会自主决定：先调用 getWeather，再调用 calculate，最后给出综合回答
runAgent('北京今天天气怎么样？如果温度是摄氏度，帮我换算成华氏度')
  .then(reply => console.log('\n[最终回答]', reply))
  .catch(console.error);
