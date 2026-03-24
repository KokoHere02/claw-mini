import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { streamText } from "ai";
import { config } from "@/config"
import { ConversationMessage } from "@/services/memory"

const provider = createOpenAICompatible({
  name: config.model.id,
  apiKey: config.model.apiKey,
  baseURL: config.model.baseURL,
})


export async function generateAssistantReply(messages: ConversationMessage[]): Promise<string> {
  const result = streamText({
    model: provider(config.model.id),
    system: config.systemPrompt,
    messages: messages
  })
  

  let text = ''
  for await (const chunk of result.textStream) {
    text += chunk
  }
  return text.trim()
}
