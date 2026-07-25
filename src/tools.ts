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
  execute: (
    name: string,
    rawArgs: string | Record<string, unknown>,
    context: { player: string }
  ) => Promise<string>;
};

function parseArgs(rawArgs: string | Record<string, unknown>): unknown {
  if (typeof rawArgs === "object" && rawArgs !== null) {
    return rawArgs;
  }
  if (!rawArgs || rawArgs.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(rawArgs);
  } catch {
    throw new Error(`Tool arguments could not be parsed as JSON: ${rawArgs.slice(0, 120)}`);
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value as Record<string, unknown>;
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

function optionalNumberField(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool argument '${key}' must be a finite number when provided.`);
  }
  return value;
}

function optionalBooleanField(object: Record<string, unknown>, key: string): boolean | undefined {
  const value = object[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Tool argument '${key}' must be a boolean when provided.`);
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

function resolveTargetPlayer(
  object: Record<string, unknown>,
  contextPlayer: string
): string {
  const aliases = ["player", "target", "username", "name"];
  for (const key of aliases) {
    const value = object[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const normalized = value.trim();
      if (["me", "myself", "self"].includes(normalized.toLowerCase())) {
        return contextPlayer;
      }
      return normalized;
    }
  }
  return contextPlayer;
}

function buildToolCapabilityReport(
  definitions: ToolDefinition[],
  contextPlayer: string,
  adminGuardedTools: Set<string>,
  config: AppConfig,
  includeSchemas: boolean,
  filter: string
): string {
  const normalizedFilter = filter.trim().toLowerCase();
  const tools = definitions
    .filter((definition) => {
      if (normalizedFilter.length === 0) {
        return true;
      }
      const haystack = `${definition.function.name} ${definition.function.description}`.toLowerCase();
      return haystack.includes(normalizedFilter);
    })
    .map((definition) => {
      const name = definition.function.name;
      const adminRequired =
        adminGuardedTools.has(name) &&
        config.guardrails.requireAdminForServerCommands &&
        config.guardrails.adminPlayers.size > 0;
      const usableByPromptingPlayer = adminRequired
        ? config.guardrails.adminPlayers.has(contextPlayer)
        : true;

      return {
        name,
        description: definition.function.description,
        adminRequired,
        usableByPromptingPlayer,
        parameters: includeSchemas ? definition.function.parameters : undefined
      };
    });

  return JSON.stringify(
    {
      player: contextPlayer,
      toolCount: tools.length,
      tools
    },
    null,
    2
  );
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
  const adminGuardedTools = new Set(["run_server_command", "build_structure", "remove_structure"]);
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
              player: {
                type: "string",
                description:
                  "Target player name. Optional; if omitted or set to 'me', follows the prompting player."
              },
              seconds: {
                type: "number",
                description: `How long to follow. If omitted, defaults to ${defaultFollowTimeoutSeconds} seconds.`
              }
            }
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
              player: {
                type: "string",
                description:
                  "Target player name. Optional; if omitted or set to 'me', uses the prompting player."
              }
            }
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
              player: {
                type: "string",
                description:
                  "Target player name. Optional; if omitted or set to 'me', uses the prompting player."
              }
            }
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
    ),
    register(
      {
        type: "function",
        function: {
          name: "find_entity",
          description:
            "Find a player or mob, including scouting nearby areas if it is not currently visible.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "Player name or mob name to find." },
              maxRadius: {
                type: "number",
                description: "Maximum scout radius in blocks. Defaults to 96."
              },
              searchSeconds: {
                type: "number",
                description: "Maximum scan duration in seconds. Defaults to 45."
              }
            },
            required: ["target"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const target = requireStringField(object, "target");
        const maxRadius = optionalNumberField(object, "maxRadius") ?? 96;
        const searchSeconds = optionalNumberField(object, "searchSeconds") ?? 45;
        return minecraft.findEntity(target, maxRadius, searchSeconds);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "find_resource",
          description:
            "Find a resource block by name, scouting nearby areas when it is not currently visible.",
          parameters: {
            type: "object",
            properties: {
              block: { type: "string", description: "Block name, for example iron_ore or oak_log." },
              maxRadius: {
                type: "number",
                description: "Maximum scout radius in blocks. Defaults to 96."
              },
              searchSeconds: {
                type: "number",
                description: "Maximum scan duration in seconds. Defaults to 45."
              }
            },
            required: ["block"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const block = requireStringField(object, "block");
        const maxRadius = optionalNumberField(object, "maxRadius") ?? 96;
        const searchSeconds = optionalNumberField(object, "searchSeconds") ?? 45;
        return minecraft.findResource(block, maxRadius, searchSeconds);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "attack_nearest_hostile",
          description: "Attack the nearest visible hostile mob for a limited time.",
          parameters: {
            type: "object",
            properties: {
              seconds: {
                type: "number",
                description: "Attack duration in seconds. Defaults to 15."
              },
              maxDistance: {
                type: "number",
                description: "Maximum acquisition distance for hostile targets. Defaults to 24."
              }
            }
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const seconds = optionalNumberField(object, "seconds") ?? 15;
        const maxDistance = optionalNumberField(object, "maxDistance") ?? 24;
        return minecraft.attackNearestHostile(seconds, maxDistance);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "attack_target",
          description: "Attack a specific visible target (player or mob) for a limited time.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "Exact player or mob name to attack." },
              seconds: {
                type: "number",
                description: "Attack duration in seconds. Defaults to 15."
              },
              maxDistance: {
                type: "number",
                description: "Maximum acquisition distance for the target. Defaults to 32."
              }
            },
            required: ["target"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const target = requireStringField(object, "target");
        const seconds = optionalNumberField(object, "seconds") ?? 15;
        const maxDistance = optionalNumberField(object, "maxDistance") ?? 32;
        return minecraft.attackTarget(target, seconds, maxDistance);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "stop_attacking",
          description: "Stop active attack behavior.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      async () => minecraft.stopAttack()
    ),
    register(
      {
        type: "function",
        function: {
          name: "build_structure",
          description:
            "Build a cuboid structure using the Minecraft fill command (requires command permissions).",
          parameters: {
            type: "object",
            properties: {
              x1: { type: "number", description: "First corner X." },
              y1: { type: "number", description: "First corner Y." },
              z1: { type: "number", description: "First corner Z." },
              x2: { type: "number", description: "Second corner X." },
              y2: { type: "number", description: "Second corner Y." },
              z2: { type: "number", description: "Second corner Z." },
              block: {
                type: "string",
                description: "Block to use, for example minecraft:stone or oak_planks."
              },
              hollow: {
                type: "boolean",
                description: "Whether to build a hollow shell instead of a solid volume."
              }
            },
            required: ["x1", "y1", "z1", "x2", "y2", "z2", "block"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const x1 = requireNumberField(object, "x1");
        const y1 = requireNumberField(object, "y1");
        const z1 = requireNumberField(object, "z1");
        const x2 = requireNumberField(object, "x2");
        const y2 = requireNumberField(object, "y2");
        const z2 = requireNumberField(object, "z2");
        const block = requireStringField(object, "block");
        const hollow = optionalBooleanField(object, "hollow") ?? false;
        return minecraft.buildStructure(x1, y1, z1, x2, y2, z2, block, hollow);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "remove_structure",
          description: "Remove a cuboid structure by filling the volume with air.",
          parameters: {
            type: "object",
            properties: {
              x1: { type: "number", description: "First corner X." },
              y1: { type: "number", description: "First corner Y." },
              z1: { type: "number", description: "First corner Z." },
              x2: { type: "number", description: "Second corner X." },
              y2: { type: "number", description: "Second corner Y." },
              z2: { type: "number", description: "Second corner Z." }
            },
            required: ["x1", "y1", "z1", "x2", "y2", "z2"]
          }
        }
      },
      async (args) => {
        const object = requireObject(args);
        const x1 = requireNumberField(object, "x1");
        const y1 = requireNumberField(object, "y1");
        const z1 = requireNumberField(object, "z1");
        const x2 = requireNumberField(object, "x2");
        const y2 = requireNumberField(object, "y2");
        const z2 = requireNumberField(object, "z2");
        return minecraft.removeStructure(x1, y1, z1, x2, y2, z2);
      }
    ),
    register(
      {
        type: "function",
        function: {
          name: "scan_tool_capabilities",
          description:
            "Inspect available tools and return a capability report so the model can reason about what it can do.",
          parameters: {
            type: "object",
            properties: {
              includeSchemas: {
                type: "boolean",
                description: "Include full JSON parameter schemas in the response. Defaults to true."
              },
              filter: {
                type: "string",
                description: "Optional case-insensitive text filter by tool name or description."
              }
            }
          }
        }
      },
      async () => "Capability scan complete."
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
        adminGuardedTools.has(name) &&
        config.guardrails.requireAdminForServerCommands &&
        config.guardrails.adminPlayers.size > 0 &&
        !config.guardrails.adminPlayers.has(context.player)
      ) {
        throw new Error(`Player '${context.player}' is not permitted to use '${name}'.`);
      }

      if (name === "run_server_command") {
        const argsObject = parseArgs(rawArgs);
        const object = requireObject(argsObject);
        const command = requireStringField(object, "command");
        validateServerCommand(command, commandMaxLength, allowSet, blockSet);
        return executor(argsObject);
      }

      const args = parseArgs(rawArgs);
      if (name === "scan_tool_capabilities") {
        const object = requireObject(args);
        const includeSchemas = optionalBooleanField(object, "includeSchemas") ?? true;
        const filter = typeof object.filter === "string" ? object.filter : "";
        return buildToolCapabilityReport(
          definitions,
          context.player,
          adminGuardedTools,
          config,
          includeSchemas,
          filter
        );
      }
      if (name === "follow_player" || name === "go_to_player" || name === "look_at_player") {
        const object = requireObject(args);
        object.player = resolveTargetPlayer(object, context.player);
      }
      return executor(args);
    }
  };
}
