import type { ChatCompletionResponse, ChatMessage, ToolCall } from "./types.js";
import type { ToolRegistry } from "./tools.js";

type OllamaChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools: ToolRegistry["definitions"];
};

export class OllamaToolAgent {
  private ollamaUrl: string;
  private model: string;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private maxToolCallsPerPrompt: number;
  private timeoutMs: number;

  public constructor(options: {
    ollamaUrl: string;
    model: string;
    tools: ToolRegistry;
    systemPrompt: string;
    maxToolCallsPerPrompt: number;
    timeoutMs: number;
  }) {
    this.ollamaUrl = options.ollamaUrl;
    this.model = options.model;
    this.tools = options.tools;
    this.systemPrompt = options.systemPrompt;
    this.maxToolCallsPerPrompt = Math.max(1, Math.floor(options.maxToolCallsPerPrompt));
    this.timeoutMs = Math.max(1000, options.timeoutMs);
  }

  public async runPrompt(prompt: string, player: string): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `${this.systemPrompt}\n\nYou are responding to Minecraft player '${player}'. Keep responses concise in chat.`
      },
      {
        role: "user",
        content: prompt
      }
    ];

    const maxIterations = this.maxToolCallsPerPrompt;
    for (let i = 0; i < maxIterations; i += 1) {
      const response = await this.chat(messages);
      const assistant = response.message;
      messages.push({
        role: "assistant",
        content: assistant.content ?? "",
        tool_calls: assistant.tool_calls
      });

      if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
        return assistant.content?.trim() || "Done.";
      }

      for (const call of assistant.tool_calls) {
        const result = await this.executeToolCall(call, player);
        messages.push({
          role: "tool",
          name: call.function.name,
          tool_call_id: call.id,
          content: result
        });
      }
    }

    return "I reached the tool-call limit for this request.";
  }

  private async executeToolCall(call: ToolCall, player: string): Promise<string> {
    try {
      return await this.tools.execute(call.function.name, call.function.arguments || "{}", { player });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Tool execution failed (${call.function.name}): ${message}`;
    }
  }

  private async chat(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    const body: OllamaChatRequest = {
      model: this.model,
      messages,
      stream: false,
      tools: this.tools.definitions
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError";
      throw new Error(
        isTimeout
          ? `Ollama request timed out after ${this.timeoutMs / 1000}s`
          : `Ollama request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const details = await response.text();
      const detailText = details.trim();
      throw new Error(
        detailText.length > 0
          ? `Ollama API error: ${response.status} ${response.statusText} - ${detailText}`
          : `Ollama API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    if (!data?.message) {
      throw new Error("Ollama response did not include an assistant message.");
    }
    return data;
  }
}
