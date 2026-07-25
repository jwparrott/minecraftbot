import mineflayer, { Bot } from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";
import type { AppConfig } from "./config.js";

const { pathfinder, Movements, goals } = pathfinderPackage;
const { GoalFollow, GoalNear, GoalBlock } = goals;

export type PromptEvent = {
  player: string;
  prompt: string;
  rawMessage: string;
};

type ChatCallback = (event: PromptEvent) => Promise<void> | void;

export class MinecraftController {
  private bot: Bot;
  private config: AppConfig;
  private callback?: ChatCallback;
  private movements?: InstanceType<typeof Movements>;
  private followTimeout?: NodeJS.Timeout;

  public constructor(config: AppConfig) {
    this.config = config;
    this.bot = mineflayer.createBot({
      host: config.minecraft.host,
      port: config.minecraft.port,
      username: config.minecraft.username,
      password: config.minecraft.password,
      auth: config.minecraft.auth,
      version: config.minecraft.version
    });

    this.bot.loadPlugin(pathfinder);
    this.registerEvents();
  }

  public onPrompt(callback: ChatCallback): void {
    this.callback = callback;
  }

  public getBot(): Bot {
    return this.bot;
  }

  public say(message: string): void {
    this.bot.chat(message);
  }

  public runServerCommand(command: string): void {
    const text = command.startsWith("/") ? command : `/${command}`;
    this.bot.chat(text);
  }

  public listPlayers(): string[] {
    return Object.keys(this.bot.players).filter((p) => p !== this.bot.username);
  }

  public followPlayer(playerName: string, seconds: number): string {
    const entity = this.resolvePlayerEntity(playerName);
    const safeSeconds = Math.max(1, Math.floor(seconds));
    this.clearFollowTimeout();
    this.bot.pathfinder.setGoal(new GoalFollow(entity, 1), true);
    this.followTimeout = setTimeout(() => {
      this.bot.pathfinder.setGoal(null);
      this.say(`Stopped following ${playerName}.`);
    }, safeSeconds * 1000);
    return `Following ${playerName} for ${safeSeconds} seconds.`;
  }

  public stopFollowing(): string {
    this.clearFollowTimeout();
    this.bot.pathfinder.setGoal(null);
    return "Stopped following.";
  }

  public goToPlayer(playerName: string): string {
    const entity = this.resolvePlayerEntity(playerName);
    const pos = entity.position;
    this.bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 1));
    return `Moving near ${playerName}.`;
  }

  public goToCoordinates(x: number, y: number, z: number): string {
    this.bot.pathfinder.setGoal(new GoalBlock(x, y, z));
    return `Moving to coordinates ${x}, ${y}, ${z}.`;
  }

  public lookAtPlayer(playerName: string): string {
    const entity = this.resolvePlayerEntity(playerName);
    void this.bot.lookAt(entity.position.offset(0, entity.height, 0), true);
    return `Looking at ${playerName}.`;
  }

  private clearFollowTimeout(): void {
    if (this.followTimeout) {
      clearTimeout(this.followTimeout);
      this.followTimeout = undefined;
    }
  }

  private resolvePlayerEntity(playerName: string) {
    const direct = this.bot.players[playerName];
    if (direct?.entity) {
      return direct.entity;
    }

    const targetLower = playerName.toLowerCase();
    const canonicalName = Object.keys(this.bot.players).find(
      (name) => name.toLowerCase() === targetLower
    );
    const player = canonicalName ? this.bot.players[canonicalName] : undefined;
    if (player?.entity) {
      return player.entity;
    }

    const knownPlayers = this.listPlayers();
    const known = knownPlayers.length > 0 ? knownPlayers.join(", ") : "none";
    throw new Error(
      `Player '${playerName}' is not currently visible to the bot. Players currently visible: ${known}`
    );
  }

  private registerEvents(): void {
    this.bot.once("spawn", () => {
      this.movements = new Movements(this.bot);
      this.bot.pathfinder.setMovements(this.movements);
      console.log("Bot spawned and pathfinder initialized.");
    });

    this.bot.on("chat", (username, message) => {
      if (username === this.bot.username) {
        return;
      }
      if (this.config.allowedPlayers.size > 0 && !this.config.allowedPlayers.has(username)) {
        return;
      }
      if (!message.startsWith(this.config.promptPrefix)) {
        return;
      }

      const prompt = message.slice(this.config.promptPrefix.length).trim();
      if (prompt.length === 0) {
        this.say(`Usage: ${this.config.promptPrefix} <request>`);
        return;
      }

      if (!this.callback) {
        console.error("Prompt callback was not configured.");
        return;
      }

      void this.callback({
        player: username,
        prompt,
        rawMessage: message
      });
    });

    this.bot.on("kicked", (reason) => {
      console.error("Kicked from server:", reason);
    });

    this.bot.on("error", (error) => {
      console.error("Bot error:", error);
    });

    this.bot.on("end", () => {
      console.error("Disconnected from server.");
    });
  }
}
