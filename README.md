# Minecraft Ollama Admin Bot

This project runs a Minecraft bot (NPC-like account) that:
- Reads prompts from in-game chat
- Sends prompts to an Ollama model
- Lets the model call tools to administer the server and control bot behavior

## Features
- Chat trigger prefix (default: `!admin`)
- Optional player allowlist
- Built-in guardrails (cooldowns, queue limits, command filtering, admin-only command tool)
- Tool-enabled LLM loop via Ollama `/api/chat`
- Server/admin action tool:
  - `run_server_command`
  - `say_in_chat`
  - `list_players`
- NPC interaction tools:
  - `follow_player`
  - `stop_following`
  - `go_to_player`
  - `look_at_player`
  - `go_to_coordinates`

## Requirements
- Node.js 20+
- A running Minecraft server
- Ollama running locally or remotely with your chosen model pulled

## Setup
1. Copy [.env.example](C:/Users/Admin/Documents/minecraftbot/.env.example) to `.env`.
2. Fill in server and model values.
3. Install dependencies:
   ```bash
   npm install
   ```

## Run
- Development:
  ```bash
  npm run dev
  ```
- Build + start:
  ```bash
  npm run build
  npm start
  ```

## In-game usage
In chat:
```text
!admin say hello to everyone
!admin set time to day
!admin follow Steve for 20 seconds
```

The model will decide when to call tools and the bot will execute them.

## Important notes
- `run_server_command` requires permissions for the bot account (operator/admin).
- Movement tools require the target player to be loaded and visible to the bot.
- Keep your `SYSTEM_PROMPT` strict so the model does not run destructive commands.

## Guardrails
You can tune these in [.env.example](C:/Users/Admin/Documents/minecraftbot/.env.example):
- `ADMIN_PLAYERS`: comma-separated players allowed to use `run_server_command` (when enabled).
- `REQUIRE_ADMIN_FOR_SERVER_COMMANDS`: enforce admin-only command execution.
- `MAX_PROMPT_CHARS`, `MAX_PENDING_PROMPTS`, `PER_PLAYER_COOLDOWN_SECONDS`: anti-spam controls.
- `MAX_TOOL_CALLS_PER_PROMPT`: hard cap on tool loop depth.
- `MAX_CHAT_REPLY_CHARS`: truncates long LLM output before chat send.
- `ALLOWED_COMMAND_PREFIXES`: allowlist for command root words (for example `time`, `tp`).
- `BLOCKED_COMMAND_PREFIXES`: always-denied command roots (for example `stop`, `op`).
