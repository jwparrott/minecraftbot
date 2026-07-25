import mineflayer, { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import pathfinderPackage from "mineflayer-pathfinder";
import type { Entity } from "prismarine-entity";
import type { AppConfig } from "./config.js";

const { pathfinder, Movements, goals } = pathfinderPackage;
const { GoalFollow, GoalNear, GoalBlock } = goals;

const HOSTILE_MOBS = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "creeper",
  "spider",
  "cave_spider",
  "witch",
  "pillager",
  "vindicator",
  "evoker",
  "ravager",
  "enderman",
  "phantom",
  "blaze",
  "ghast",
  "magma_cube",
  "slime",
  "silverfish",
  "endermite",
  "zoglin",
  "hoglin",
  "warden"
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  private attackTimeout?: NodeJS.Timeout;
  private attackInterval?: NodeJS.Timeout;
  private readonly mcData: ReturnType<typeof minecraftData>;

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
    this.mcData = minecraftData(this.bot.version);

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
    this.stopAttack();
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

  public stopAttack(): string {
    if (this.attackTimeout) {
      clearTimeout(this.attackTimeout);
      this.attackTimeout = undefined;
    }
    if (this.attackInterval) {
      clearInterval(this.attackInterval);
      this.attackInterval = undefined;
    }
    return "Stopped attacking.";
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

  public async findEntity(
    target: string,
    maxRadius: number,
    searchSeconds: number
  ): Promise<string> {
    const normalizedTarget = target.trim().toLowerCase();
    if (normalizedTarget.length === 0) {
      throw new Error("Target must be a non-empty string.");
    }

    const immediate = this.findVisibleEntity(normalizedTarget);
    if (immediate) {
      const pos = immediate.position.floored();
      return `Found ${this.describeEntity(immediate)} at ${pos.x}, ${pos.y}, ${pos.z}.`;
    }

    const safeRadius = Math.max(8, Math.floor(maxRadius));
    const safeSeconds = Math.max(5, Math.floor(searchSeconds));
    const found = await this.scoutForEntity(normalizedTarget, safeRadius, safeSeconds);
    if (!found) {
      throw new Error(`Could not find '${target}' within ${safeRadius} blocks.`);
    }

    const pos = found.position.floored();
    return `Found ${this.describeEntity(found)} at ${pos.x}, ${pos.y}, ${pos.z}.`;
  }

  public async findResource(
    blockName: string,
    maxRadius: number,
    searchSeconds: number
  ): Promise<string> {
    const normalizedBlock = blockName.trim().toLowerCase();
    if (normalizedBlock.length === 0) {
      throw new Error("Resource block name must be a non-empty string.");
    }

    const blockData = this.mcData.blocksByName[normalizedBlock];
    if (!blockData) {
      throw new Error(`Unknown block type '${blockName}'.`);
    }

    const safeRadius = Math.max(8, Math.floor(maxRadius));
    const safeSeconds = Math.max(5, Math.floor(searchSeconds));
    const found = await this.scoutForBlock(blockData.id, safeRadius, safeSeconds);
    if (!found) {
      throw new Error(`Could not find block '${normalizedBlock}' within ${safeRadius} blocks.`);
    }

    const pos = found.position.floored();
    return `Found ${normalizedBlock} at ${pos.x}, ${pos.y}, ${pos.z}.`;
  }

  public attackNearestHostile(seconds: number, maxDistance: number): string {
    const safeSeconds = Math.max(2, Math.floor(seconds));
    const safeDistance = Math.max(4, Math.floor(maxDistance));
    const hostile = this.bot.nearestEntity((entity) => this.isHostile(entity, safeDistance));
    if (!hostile) {
      throw new Error(`No hostile mobs visible within ${safeDistance} blocks.`);
    }

    return this.startAttackLoop(
      safeSeconds,
      safeDistance,
      () => this.bot.nearestEntity((entity) => this.isHostile(entity, safeDistance)),
      `nearest hostile mob`
    );
  }

  public attackTarget(target: string, seconds: number, maxDistance: number): string {
    const normalizedTarget = target.trim().toLowerCase();
    if (normalizedTarget.length === 0) {
      throw new Error("Target must be a non-empty string.");
    }

    const safeSeconds = Math.max(2, Math.floor(seconds));
    const safeDistance = Math.max(4, Math.floor(maxDistance));
    const initial = this.bot.nearestEntity((entity) =>
      this.matchesEntityTarget(entity, normalizedTarget, safeDistance)
    );
    if (!initial) {
      throw new Error(`Target '${target}' is not visible within ${safeDistance} blocks.`);
    }

    return this.startAttackLoop(
      safeSeconds,
      safeDistance,
      () =>
        this.bot.nearestEntity((entity) =>
          this.matchesEntityTarget(entity, normalizedTarget, safeDistance)
        ),
      target
    );
  }

  public buildStructure(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    blockName: string,
    hollow: boolean
  ): string {
    this.validateBlockName(blockName);
    const mode = hollow ? "hollow" : "replace";
    const command = `fill ${Math.floor(x1)} ${Math.floor(y1)} ${Math.floor(z1)} ${Math.floor(x2)} ${Math.floor(y2)} ${Math.floor(z2)} ${blockName} ${mode}`;
    this.runServerCommand(command);
    return `Issued build command using block '${blockName}'.`;
  }

  public removeStructure(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number
  ): string {
    const command = `fill ${Math.floor(x1)} ${Math.floor(y1)} ${Math.floor(z1)} ${Math.floor(x2)} ${Math.floor(y2)} ${Math.floor(z2)} minecraft:air replace`;
    this.runServerCommand(command);
    return "Issued remove-structure command.";
  }

  private async scoutForEntity(
    normalizedTarget: string,
    maxRadius: number,
    searchSeconds: number
  ) {
    const deadline = Date.now() + searchSeconds * 1000;
    const start = this.bot.entity.position.floored();
    const waypoints = this.buildScoutWaypoints(start.x, start.y, start.z, maxRadius);
    if (waypoints.length === 0) {
      return undefined;
    }

    this.stopAttack();
    this.clearFollowTimeout();
    for (const waypoint of waypoints) {
      if (Date.now() >= deadline) {
        break;
      }
      const foundBeforeMove = this.findVisibleEntity(normalizedTarget);
      if (foundBeforeMove) {
        return foundBeforeMove;
      }

      const remainingMs = Math.max(1500, deadline - Date.now());
      await this.moveNear(waypoint.x, waypoint.y, waypoint.z, 2, remainingMs);

      const foundAfterMove = this.findVisibleEntity(normalizedTarget);
      if (foundAfterMove) {
        return foundAfterMove;
      }
    }

    return this.findVisibleEntity(normalizedTarget);
  }

  private async scoutForBlock(blockId: number, maxRadius: number, searchSeconds: number) {
    const immediate = this.bot.findBlock({
      matching: blockId,
      maxDistance: maxRadius
    });
    if (immediate) {
      return immediate;
    }

    const deadline = Date.now() + searchSeconds * 1000;
    const start = this.bot.entity.position.floored();
    const waypoints = this.buildScoutWaypoints(start.x, start.y, start.z, maxRadius);

    this.stopAttack();
    this.clearFollowTimeout();
    for (const waypoint of waypoints) {
      if (Date.now() >= deadline) {
        break;
      }
      const remainingMs = Math.max(1500, deadline - Date.now());
      await this.moveNear(waypoint.x, waypoint.y, waypoint.z, 2, remainingMs);
      const found = this.bot.findBlock({
        matching: blockId,
        maxDistance: Math.max(8, Math.floor(maxRadius / 2))
      });
      if (found) {
        return found;
      }
    }

    return this.bot.findBlock({
      matching: blockId,
      maxDistance: maxRadius
    });
  }

  private buildScoutWaypoints(centerX: number, centerY: number, centerZ: number, radius: number) {
    const waypoints: Array<{ x: number; y: number; z: number }> = [];
    const step = 16;
    for (let r = step; r <= radius; r += step) {
      waypoints.push({ x: centerX + r, y: centerY, z: centerZ });
      waypoints.push({ x: centerX - r, y: centerY, z: centerZ });
      waypoints.push({ x: centerX, y: centerY, z: centerZ + r });
      waypoints.push({ x: centerX, y: centerY, z: centerZ - r });
      waypoints.push({ x: centerX + r, y: centerY, z: centerZ + r });
      waypoints.push({ x: centerX + r, y: centerY, z: centerZ - r });
      waypoints.push({ x: centerX - r, y: centerY, z: centerZ + r });
      waypoints.push({ x: centerX - r, y: centerY, z: centerZ - r });
    }
    return waypoints;
  }

  private async moveNear(
    x: number,
    y: number,
    z: number,
    range: number,
    timeoutMs: number
  ): Promise<void> {
    this.bot.pathfinder.setGoal(new GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range));
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const pos = this.bot.entity.position;
      const dx = pos.x - x;
      const dy = pos.y - y;
      const dz = pos.z - z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= range + 0.5) {
        return;
      }
      await sleep(200);
    }
    this.bot.pathfinder.setGoal(null);
    throw new Error(`Timed out moving near ${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}.`);
  }

  private describeEntity(entity: Entity): string {
    return entity.username || entity.name || "entity";
  }

  private findVisibleEntity(normalizedTarget: string) {
    return this.bot.nearestEntity((entity) =>
      this.matchesEntityTarget(entity, normalizedTarget, Number.POSITIVE_INFINITY)
    );
  }

  private matchesEntityTarget(
    entity: Entity,
    normalizedTarget: string,
    maxDistance: number
  ): boolean {
    const label = (entity.username || entity.name || "").toLowerCase();
    if (label.length === 0 || label !== normalizedTarget) {
      return false;
    }
    const distance = entity.position.distanceTo(this.bot.entity.position);
    return Number.isFinite(maxDistance) ? distance <= maxDistance : true;
  }

  private isHostile(
    entity: Entity,
    maxDistance: number
  ): boolean {
    if (entity.type !== "mob") {
      return false;
    }
    const mobName = (entity.name || "").toLowerCase();
    if (!HOSTILE_MOBS.has(mobName)) {
      return false;
    }
    return entity.position.distanceTo(this.bot.entity.position) <= maxDistance;
  }

  private startAttackLoop(
    seconds: number,
    maxDistance: number,
    findTarget: () => Entity | null,
    label: string
  ): string {
    this.stopAttack();
    this.clearFollowTimeout();

    this.attackInterval = setInterval(() => {
      const target = findTarget();
      if (!target) {
        return;
      }
      this.bot.pathfinder.setGoal(new GoalFollow(target, 1), true);
      const distance = target.position.distanceTo(this.bot.entity.position);
      if (distance <= Math.max(4.5, maxDistance / 3)) {
        void this.bot.attack(target);
      }
    }, 600);

    this.attackTimeout = setTimeout(() => {
      this.stopAttack();
      this.bot.pathfinder.setGoal(null);
      this.say(`Stopped attacking ${label}.`);
    }, seconds * 1000);

    return `Attacking ${label} for ${seconds} seconds.`;
  }

  private validateBlockName(blockName: string): void {
    const normalized = blockName.trim().toLowerCase();
    if (!/^[a-z0-9_:\[\]=,]+$/.test(normalized)) {
      throw new Error(`Invalid block name '${blockName}'.`);
    }
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
      this.clearFollowTimeout();
      this.stopAttack();
      console.error("Disconnected from server.");
    });
  }
}
