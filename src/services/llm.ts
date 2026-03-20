import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { config } from "@/config"
import { ConversationMessage } from "./memory"

const provider = createAnthropic({
  apiKey: config.model.apiKey,
  baseURL: config.model.baseURL,
})


export async function generateAssistantReply(messages: ConversationMessage[]): Promise<string> {
  const result = await generateText({
    model: provider(config.model.id),
    system: "你是 CLAW-MINI 一个之说中文的人工智能助手",
    messages: messages
  })
  return result.text.trim()
}