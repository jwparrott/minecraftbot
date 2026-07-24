import { loadConfig } from "./config.js";
import { MinecraftController, type PromptEvent } from "./minecraftBot.js";
import { OllamaToolAgent } from "./ollamaAgent.js";
import { createToolRegistry } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const minecraft = new MinecraftController(config);
  const tools = createToolRegistry(minecraft, config);
  const agent = new OllamaToolAgent({
    ollamaUrl: config.ollamaUrl,
    model: config.ollamaModel,
    tools,
    systemPrompt: config.systemPrompt,
    maxToolCallsPerPrompt: config.guardrails.maxToolCallsPerPrompt
  });

  const queue: PromptEvent[] = [];
  let processing = false;
  const cooldownByPlayer = new Map<string, number>();
  const maxPromptChars = Math.max(1, Math.floor(config.guardrails.maxPromptChars));
  const maxPendingPrompts = Math.max(1, Math.floor(config.guardrails.maxPendingPrompts));
  const cooldownMs = Math.max(0, Math.floor(config.guardrails.perPlayerCooldownSeconds)) * 1000;
  const maxChatReplyChars = Math.max(1, Math.floor(config.guardrails.maxChatReplyChars));

  const processQueue = async () => {
    if (processing) {
      return;
    }
    processing = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) {
          continue;
        }

        console.log(`Prompt from ${item.player}: ${item.prompt}`);
        try {
          const reply = await agent.runPrompt(item.prompt, item.player);
          if (reply.trim().length > 0) {
            const safeReply =
              reply.length > maxChatReplyChars
                ? maxChatReplyChars > 3
                  ? `${reply.slice(0, maxChatReplyChars - 3)}...`
                  : reply.slice(0, maxChatReplyChars)
                : reply;
            minecraft.say(safeReply);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("Failed to process prompt:", message);
          minecraft.say(`@${item.player} I failed to process that request: ${message}`);
        }
      }
    } finally {
      processing = false;
    }
  };

  minecraft.onPrompt((event) => {
    if (event.prompt.length > maxPromptChars) {
      minecraft.say(
        `@${event.player} Prompt is too long. Max allowed length is ${maxPromptChars} characters.`
      );
      return;
    }
    if (queue.length >= maxPendingPrompts) {
      minecraft.say(`@${event.player} Bot is busy. Please try again in a few seconds.`);
      return;
    }
    if (cooldownMs > 0) {
      const now = Date.now();
      const nextAllowedAt = cooldownByPlayer.get(event.player) ?? 0;
      if (now < nextAllowedAt) {
        const remaining = Math.ceil((nextAllowedAt - now) / 1000);
        minecraft.say(
          `@${event.player} Please wait ${remaining}s before sending another admin request.`
        );
        return;
      }
      cooldownByPlayer.set(event.player, now + cooldownMs);
    }

    queue.push(event);
    void processQueue();
  });

  console.log("Minecraft Ollama admin bot started.");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error("Fatal startup error:", message);
  process.exitCode = 1;
});
