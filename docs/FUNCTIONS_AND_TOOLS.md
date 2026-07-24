# Functions and Tools Reference

This document describes all important functions, classes, tools, and scripts in this project and how to use them.

## 1) Runtime entrypoint

File: `src/index.ts`

### `main(): Promise<void>`
- Loads config with `loadConfig()`
- Creates:
  - `MinecraftController`
  - Tool registry (`createToolRegistry`)
  - `OllamaToolAgent`
- Applies guardrails:
  - max prompt length
  - queue limit
  - per-player cooldown
  - max chat reply length
- Queues chat prompts and processes them serially.

### Queue processing behavior
- Calls `agent.runPrompt(prompt, player)`
- Sends reply to Minecraft chat
- Truncates reply to `MAX_CHAT_REPLY_CHARS`
- Reports failures to the player in chat

## 2) Configuration functions

File: `src/config.ts`

### `required(name: string): string`
Reads required env vars. Throws if missing/blank.

### `optional(name: string, fallback: string): string`
Reads env var or returns fallback.

### `optionalNumber(name: string, fallback: number): number`
Reads numeric env var or fallback. Throws on invalid number.

### `optionalBoolean(name: string, fallback: boolean): boolean`
Reads boolean env var (`true/false/1/0/yes/no`) or fallback.

### `parseCsvList(raw: string): string[]`
Parses comma-separated values into trimmed string array.

### `parseAllowedPlayers(): Set<string>`
Reads `ALLOWED_PLAYERS` and returns a player set.

### `loadConfig(): AppConfig`
Builds and validates full app config:
- Ollama settings
- Minecraft connection settings
- prompt prefix/system prompt
- allowlist
- follow timeout
- guardrail settings

## 3) Minecraft controller class

File: `src/minecraftBot.ts`

### Type: `PromptEvent`
- `player`: prompt sender
- `prompt`: parsed prompt without prefix
- `rawMessage`: original chat message

### Class: `MinecraftController`

#### `constructor(config: AppConfig)`
Creates Mineflayer bot, loads pathfinder plugin, registers event handlers.

#### `onPrompt(callback: (event: PromptEvent) => Promise<void> | void): void`
Registers callback used when a valid in-game prompt is seen.

#### `getBot(): Bot`
Returns raw Mineflayer bot instance.

#### `say(message: string): void`
Sends chat text.

#### `runServerCommand(command: string): void`
Sends a command (adds `/` prefix if missing).

#### `listPlayers(): string[]`
Returns known online players excluding bot username.

#### `followPlayer(playerName: string, seconds: number): string`
Starts follow goal and auto-stops after timeout.

#### `stopFollowing(): string`
Stops follow/path goals.

#### `goToPlayer(playerName: string): string`
Pathfinds near target player.

#### `goToCoordinates(x: number, y: number, z: number): string`
Pathfinds to exact block coordinates.

#### `lookAtPlayer(playerName: string): string`
Turns bot to face a player.

#### Internal helpers
- `clearFollowTimeout()`
- `resolvePlayerEntity(playerName)`
- `registerEvents()`:
  - on spawn: pathfinder movement setup
  - on chat: prompt prefix filter + allowlist filter
  - on kicked/error/end: logs errors

## 4) Ollama agent class

File: `src/ollamaAgent.ts`

### Class: `OllamaToolAgent`

#### `constructor(options)`
Options:
- `ollamaUrl`
- `model`
- `tools`
- `systemPrompt`
- `maxToolCallsPerPrompt`

#### `runPrompt(prompt: string, player: string): Promise<string>`
Runs a tool-capable chat loop:
1. Builds system+user messages
2. Calls Ollama `/api/chat`
3. Executes tool calls (if returned)
4. Appends tool results
5. Repeats until final assistant text or max iterations

#### `executeToolCall(call, player): Promise<string>` (private)
Executes one tool and captures tool errors as text result.

#### `chat(messages): Promise<ChatCompletionResponse>` (private)
POSTs chat request to Ollama and returns assistant message payload.

## 5) Tool registry and tool functions

File: `src/tools.ts`

### `createToolRegistry(minecraft, config): ToolRegistry`
Builds tool schema definitions for Ollama + function executors.

### `ToolRegistry`
- `definitions`: function-tool schema list passed to Ollama
- `execute(name, rawArgs, context)`: validates and executes tool call

### Argument validation helpers
- `parseArgs(rawArgs)`
- `requireObject(value)`
- `requireStringField(object, key)`
- `requireNumberField(object, key)`
- `validateServerCommand(command, commandMaxLength, allowSet, blockSet)`

### Available LLM tools and usage

#### 1) `say_in_chat`
Purpose: send normal NPC chat.

Arguments:
```json
{ "message": "Hello players!" }
```

#### 2) `run_server_command`
Purpose: run Minecraft command as bot.

Arguments:
```json
{ "command": "time set day" }
```

Guardrails applied:
- optional admin-only access
- command length limit
- blocked command roots
- allowlist command roots

#### 3) `list_players`
Purpose: list online players.

Arguments:
```json
{}
```

#### 4) `follow_player`
Purpose: follow player for N seconds.

Arguments:
```json
{ "player": "Steve", "seconds": 20 }
```

#### 5) `stop_following`
Purpose: stop movement/follow.

Arguments:
```json
{}
```

#### 6) `go_to_player`
Purpose: walk near player.

Arguments:
```json
{ "player": "Alex" }
```

#### 7) `look_at_player`
Purpose: turn to face player.

Arguments:
```json
{ "player": "Alex" }
```

#### 8) `go_to_coordinates`
Purpose: path to block coordinates.

Arguments:
```json
{ "x": 100, "y": 64, "z": -25 }
```

## 6) Type definitions

File: `src/types.ts`

### `ChatRole`
`"system" | "user" | "assistant" | "tool"`

### `ChatMessage`
Role + content with optional tool metadata.

### `ToolCall`
Tool-call id + function name + serialized argument JSON.

### `ChatCompletionResponse`
Expected Ollama assistant message shape.

## 7) Setup/start script functions

File: `scripts/setup-and-start.ps1`

### Parameters
- `-ServerDir` (optional)
- `-Model` (default: `gemma2:2b`)
- `-BotUsername` (default: `AdminNPC`)
- `-AdminPlayers` (optional CSV)
- `-SkipServerStart` (switch)

### Functions
- `Write-Step`: formatted step output
- `Save-State`: writes runtime state JSON (`.runtime/process-state.json`)
- `Test-CommandAvailable`: checks command availability
- `Install-WithWinget`: installs missing dependencies
- `Set-OrAppendEnvLine`: updates/adds env lines
- `Resolve-ServerDirectory`: server folder detection
- `Get-ServerPort`: parses `server.properties`
- `Find-ServerJar`: chooses server jar
- `Ensure-OllamaReady`: starts Ollama if needed and pulls model

### What it does
1. Installs Node/Java/Ollama (if missing)
2. Ensures Ollama API available
3. Pulls selected model
4. Creates/updates `.env`
5. Runs `npm install` and `npm run check`
6. Optionally starts Minecraft server
7. Starts bot process
8. Stores PIDs/state for stop script

## 8) Stop script functions

File: `scripts/stop-system.ps1`

### Parameters
- `-StopAnyOllama` (switch): force-stop all `ollama serve` processes

### Functions
- `Write-Step`: formatted output
- `Stop-ByIdIfRunning`: stop by PID
- `Stop-BotByScan`: fallback scan for bot process
- `Stop-ServerByScan`: fallback scan for Java server process
- `Stop-OllamaByScan`: fallback scan for Ollama serve

### What it does
1. Reads `.runtime/process-state.json` if present
2. Stops tracked bot process
3. Stops tracked Minecraft server process
4. Stops tracked Ollama process (or all with `-StopAnyOllama`)
5. Removes runtime state file

## 9) NPM script commands

File: `package.json`

- `npm run dev`: run bot directly from TypeScript
- `npm run build`: compile to `dist/`
- `npm run start`: run compiled build
- `npm run check`: TypeScript typecheck
- `npm run setup:start -- [args]`: run setup/start PowerShell script
- `npm run setup:stop`: run stop PowerShell script

## 10) Environment variable quick reference

Main env file template: `.env.example`

- Ollama:
  - `OLLAMA_URL`
  - `OLLAMA_MODEL`
- Minecraft:
  - `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_PASSWORD`, `MC_AUTH`, `MC_VERSION`
- Prompting:
  - `PROMPT_PREFIX`, `SYSTEM_PROMPT`, `ALLOWED_PLAYERS`
- NPC:
  - `FOLLOW_TIMEOUT_SECONDS`
- Guardrails:
  - `ADMIN_PLAYERS`
  - `REQUIRE_ADMIN_FOR_SERVER_COMMANDS`
  - `MAX_PROMPT_CHARS`
  - `MAX_PENDING_PROMPTS`
  - `PER_PLAYER_COOLDOWN_SECONDS`
  - `MAX_TOOL_CALLS_PER_PROMPT`
  - `MAX_CHAT_REPLY_CHARS`
  - `COMMAND_MAX_LENGTH`
  - `ALLOWED_COMMAND_PREFIXES`
  - `BLOCKED_COMMAND_PREFIXES`
