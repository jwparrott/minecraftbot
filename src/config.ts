import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
}

export type AppConfig = {
  ollamaUrl: string;
  ollamaModel: string;
  ollamaTimeoutSeconds: number;
  minecraft: {
    host: string;
    port: number;
    username: string;
    password?: string;
    auth: "offline" | "microsoft" | "mojang";
    version?: string;
  };
  promptPrefix: string;
  systemPrompt: string;
  allowedPlayers: Set<string>;
  followTimeoutSeconds: number;
  guardrails: {
    adminPlayers: Set<string>;
    requireAdminForServerCommands: boolean;
    maxPromptChars: number;
    maxPendingPrompts: number;
    perPlayerCooldownSeconds: number;
    maxToolCallsPerPrompt: number;
    maxChatReplyChars: number;
    commandMaxLength: number;
    allowedCommandPrefixes: string[];
    blockedCommandPrefixes: string[];
  };
};

function parseAllowedPlayers(): Set<string> {
  return new Set(parseCsvList(optional("ALLOWED_PLAYERS", "")));
}

function parseCsvList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`Environment variable ${name} must be a boolean`);
}

export function loadConfig(): AppConfig {
  const authRaw = optional("MC_AUTH", "offline");
  if (authRaw !== "offline" && authRaw !== "microsoft" && authRaw !== "mojang") {
    throw new Error("MC_AUTH must be one of: offline, microsoft, mojang");
  }

  return {
    ollamaUrl: optional("OLLAMA_URL", "http://127.0.0.1:11434"),
    ollamaModel: optional("OLLAMA_MODEL", "llama3.1"),
    ollamaTimeoutSeconds: optionalNumber("OLLAMA_TIMEOUT_SECONDS", 120),
    minecraft: {
      host: required("MC_HOST"),
      port: optionalNumber("MC_PORT", 25565),
      username: required("MC_USERNAME"),
      password: optional("MC_PASSWORD", "") || undefined,
      auth: authRaw,
      version: optional("MC_VERSION", "") || undefined
    },
    promptPrefix: optional("PROMPT_PREFIX", "!admin"),
    systemPrompt: optional(
      "SYSTEM_PROMPT",
      "You are a Minecraft server admin assistant controlling a bot. Use tools for actions."
    ),
    allowedPlayers: parseAllowedPlayers(),
    followTimeoutSeconds: optionalNumber("FOLLOW_TIMEOUT_SECONDS", 30),
    guardrails: {
      adminPlayers: new Set(parseCsvList(optional("ADMIN_PLAYERS", ""))),
      requireAdminForServerCommands: optionalBoolean("REQUIRE_ADMIN_FOR_SERVER_COMMANDS", true),
      maxPromptChars: optionalNumber("MAX_PROMPT_CHARS", 300),
      maxPendingPrompts: optionalNumber("MAX_PENDING_PROMPTS", 20),
      perPlayerCooldownSeconds: optionalNumber("PER_PLAYER_COOLDOWN_SECONDS", 3),
      maxToolCallsPerPrompt: optionalNumber("MAX_TOOL_CALLS_PER_PROMPT", 6),
      maxChatReplyChars: optionalNumber("MAX_CHAT_REPLY_CHARS", 220),
      commandMaxLength: optionalNumber("COMMAND_MAX_LENGTH", 160),
      allowedCommandPrefixes: parseCsvList(optional("ALLOWED_COMMAND_PREFIXES", "say,time,weather,tp,gamemode,gamerule")),
      blockedCommandPrefixes: parseCsvList(
        optional("BLOCKED_COMMAND_PREFIXES", "stop,reload,op,deop,ban,ban-ip,pardon,pardon-ip,debug")
      )
    }
  };
}
