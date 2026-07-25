export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

export type ToolCall = {
  id: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
};

export type ChatCompletionResponse = {
  message: {
    role: "assistant";
    content: string;
    tool_calls?: ToolCall[];
  };
};
