import type { MinecraftController } from "./minecraftBot.js";
import type { AppConfig } from "./config.js";

type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

type ToolExecutor = (args: unknown) => Promise<string>;

export type ToolRegistry = {
  definitions: ToolDefinition[];
  execute: (name: string, rawArgs: string, context: { player: string }) => Promise<string>;
};

function parseArgs(rawArgs: string): unknown {
  if (!rawArgs || rawArgs.trim().length === 0) {
    return {};
  }
  return JSON.parse(rawArgs);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value;
}

function requireStringField(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Tool argument '${key}' must be a non-empty string.`);
  }
  return value;
}

function requireNumberField(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool argument '${key}' must be a finite number.`);
  }
  return value;
}

function validateServerCommand(
  command: string,
  commandMaxLength: number,
  allowSet: Set<string>,
  blockSet: Set<string>
): void {
  const normalized = command.startsWith("/") ? command.slice(1) : command;
  if (normalized.length > commandMaxLength) {
    throw new Error(`Command exceeds ${commandMaxLength} characters.`);
  }
  const firstToken = normalized.split(/\s+/)[0]?.toLowerCase();
  if (!firstToken) {
    throw new Error("Command must include a command name.");
  }
  if (blockSet.has(firstToken)) {
    throw new Error(`Command '${firstToken}' is blocked by guardrails.`);
  }
  if (allowSet.size > 0 && !allowSet.has(firstToken)) {
    throw new Error(`Command '${firstToken}' is not on the allowlist.`);
  }
}

export function createToolRegistry(
  minecraft: MinecraftController,
  config: AppConfig
): ToolRegistry {
  const defaultFollowTimeoutSeconds = Math.max(1, Math.floor(config.followTimeoutSeconds));
  const commandMaxLength = Math.max(1, Math.floor(config.guardrails.commandMaxLength));
  const maxChatReplyChars = Math.max(1, Math.floor(config.guardrails.maxChatReplyChars));
  const allowSet = new Set(config.guardrails.allowedCommandPrefixes.map((c) => c.toLowerCase()));
  const blockSet = new Set(config.guardrails.blockedCommandPrefixes.map((c) => c.toLowerCase()));
  const executors = new Map<string, ToolExecutor>();

  const register = (definition: ToolDefinition, executor: ToolExecutor): ToolDefinition => {
    executors.set(definition.function.name, executor);
    return definition;
  };

  const definitions: ToolDefinition[] = [
    register(
      {
        type: "function",
        function: {
          name: "say_in_chat",
          description: "Send a normal chat message from the NPC bot.",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "Message to send in Minecraft chat." }
            },
            required: ["message"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const message = requireStringField(object, "message");
        if (message.length > maxChatReplyChars) {
          throw new Error(`Chat message exceeds ${maxChatReplyChars} characters.`);
        }
        minecraft.say(message);
        return `Sent message: ${message}`;
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "run_server_command",
          description:
            "Run a server command as the bot (requires bot account permissions/op). Provide without leading slash if preferred.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Minecraft command text." }
            },
            required: ["command"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const command = requireStringField(object, "command");
        minecraft.runServerCommand(command);
        return `Executed command: ${command}`;
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "list_players",
          description: "List currently known online players.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      async () => {
        const players = minecraft.listPlayers();
        return players.length > 0 ? `Players online: ${players.join(", ")}` : "No players online.";
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "follow_player",
          description: "Have the NPC follow a player for a number of seconds.",
          parameters: {
            type: "object",
            properties: {
              player: { type: "string", description: "Target player name." },
              seconds: {
                type: "number",
                description: `How long to follow. If omitted, defaults to ${defaultFollowTimeoutSeconds} seconds.`
              }
            },
            required: ["player"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const player = requireStringField(object, "player");
        const seconds =
          typeof object.seconds === "number" && Number.isFinite(object.seconds)
            ? object.seconds
            : defaultFollowTimeoutSeconds;
        return minecraft.followPlayer(player, seconds);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "stop_following",
          description: "Stop active follow/path goals.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      async () => minecraft.stopFollowing()
    ),
    register(
      {
        type: "function",
        function: {
          name: "go_to_player",
          description: "Walk near a target player.",
          parameters: {
            type: "object",
            properties: {
              player: { type: "string", description: "Target player name." }
            },
            required: ["player"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const player = requireStringField(object, "player");
        return minecraft.goToPlayer(player);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "look_at_player",
          description: "Turn and look at a target player.",
          parameters: {
            type: "object",
            properties: {
              player: { type: "string", description: "Target player name." }
            },
            required: ["player"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const player = requireStringField(object, "player");
        return minecraft.lookAtPlayer(player);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "go_to_coordinates",
          description: "Walk to a specific block coordinate.",
          parameters: {
            type: "object",
            properties: {
              x: { type: "number", description: "X coordinate." },
              y: { type: "number", description: "Y coordinate." },
              z: { type: "number", description: "Z coordinate." }
            },
            required: ["x", "y", "z"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const x = requireNumberField(object, "x");
        const y = requireNumberField(object, "y");
        const z = requireNumberField(object, "z");
        return minecraft.goToCoordinates(x, y, z);
      }
    )
  ];

  return {
    definitions,
    execute: async (name, rawArgs, context) => {
      const executor = executors.get(name);
      if (!executor) {
        throw new Error(`Unknown tool: ${name}`);
      }
      if (
        name === "run_server_command" &&
        config.guardrails.requireAdminForServerCommands &&
        config.guardrails.adminPlayers.size > 0 &&
        !config.guardrails.adminPlayers.has(context.player)
      ) {
        throw new Error(`Player '${context.player}' is not permitted to run server commands.`);
      }

      if (name === "run_server_command") {
        const argsObject = parseArgs(rawArgs);
        const object = requireObject(argsObject);
        const command = requireStringField(object, "command");
        validateServerCommand(command, commandMaxLength, allowSet, blockSet);
        return executor(argsObject);
      }

      const args = parseArgs(rawArgs);
      return executor(args);
    }
  };
}
