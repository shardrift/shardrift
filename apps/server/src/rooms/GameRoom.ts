import { Room, Client } from "colyseus";
import { Schema, MapSchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "Hero";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("number") rotationY: number = 0;
  @type("number") hp: number = 100;
  @type("number") maxHp: number = 100;
  @type("boolean") alive: boolean = true;
  @type("number") stunnedUntil: number = 0;
  @type("number") slowedUntil: number = 0;
  @type("number") wins: number = 0;
}

export class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

interface MoveMessage {
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

const AUTO_RANGE = 4.0;
const AUTO_CONE_HALF = Math.PI / 6;
const AUTO_DAMAGE = 10;
const AUTO_COOLDOWN_MS = 800;

const AOE_RANGE = 3.0;
const AOE_CHANNEL_DURATION_MS = 3000;
const AOE_TICK_INTERVAL_MS = 500;
const AOE_TICK_DAMAGE = 10;
const AOE_COOLDOWN_MS = 0;

const LEAP_RANGE = 10.0;
const LEAP_RADIUS = 3.0;
const LEAP_DAMAGE = 25;
const LEAP_STUN_MS = 1500;
const LEAP_COOLDOWN_MS = 0;

const PULL_RANGE = 12.0;
const PULL_HALF_WIDTH = 0.8;
const PULL_DAMAGE = 10;
const PULL_SLOW_MS = 3000;
const PULL_COOLDOWN_MS = 0;
const PULL_STOP_DIST = 2.0;

const RESPAWN_DELAY_MS = 3000;
const ARENA_HALF = 9;
const WINS_REQUIRED = 5;
const MATCH_END_DISCONNECT_MS = 6000;

interface AbilityMessage {
  id: string;
  x?: number;
  z?: number;
}

function spawnForIndex(index: number): {
  x: number;
  z: number;
  rotationY: number;
} {
  const side = index === 0 ? -1 : 1;
  const zJitter = (Math.random() - 0.5) * 2;
  return {
    x: side * ARENA_HALF,
    z: zJitter,
    rotationY: side < 0 ? Math.PI / 2 : -Math.PI / 2,
  };
}

export class GameRoom extends Room<GameState> {
  maxClients = 2;
  private matchOver = false;
  private spawnIndex = new Map<string, number>();
  private lastAutoAt = new Map<string, number>();
  private lastAoeAt = new Map<string, number>();
  private lastLeapAt = new Map<string, number>();
  private lastPullAt = new Map<string, number>();
  private moveLockUntil = new Map<string, number>();
  private aoeChannelUntil = new Map<string, number>();
  private aoeChannelNextTick = new Map<string, number>();

  private killAndRespawn(targetId: string, killerId: string) {
    if (this.matchOver) return;
    const target = this.state.players.get(targetId);
    if (!target) return;
    target.alive = false;
    this.broadcast("death", { victimId: targetId, killerId });

    const killer = this.state.players.get(killerId);
    if (killer && killerId !== targetId) {
      killer.wins += 1;
      if (killer.wins >= WINS_REQUIRED) {
        this.matchOver = true;
        const scores: Record<string, number> = {};
        this.state.players.forEach((p, id) => {
          scores[id] = p.wins;
        });
        this.broadcast("match_over", {
          winnerId: killerId,
          scores,
          winsRequired: WINS_REQUIRED,
        });
        this.clock.setTimeout(() => {
          this.disconnect();
        }, MATCH_END_DISCONNECT_MS);
        return;
      }
    }

    this.clock.setTimeout(() => {
      if (this.matchOver) return;
      const p = this.state.players.get(targetId);
      if (!p) return;
      const idx = this.spawnIndex.get(targetId) ?? 0;
      const spawn = spawnForIndex(idx);
      p.x = spawn.x;
      p.z = spawn.z;
      p.rotationY = spawn.rotationY;
      p.hp = p.maxHp;
      p.alive = true;
    }, RESPAWN_DELAY_MS);
  }

  onCreate() {
    this.setState(new GameState());
    this.setPatchRate(50);

    this.onMessage<MoveMessage>("move", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !player.alive) return;
      if (Date.now() < player.stunnedUntil) return;
      if (Date.now() < (this.moveLockUntil.get(client.sessionId) ?? 0)) return;
      if (!Number.isFinite(data.x) || !Number.isFinite(data.z)) return;
      player.x = data.x;
      player.y = data.y;
      player.z = data.z;
      player.rotationY = data.rotationY;
    });

    this.onMessage<AbilityMessage>("ability", (client, { id, x, z }) => {
      const attacker = this.state.players.get(client.sessionId);
      if (!attacker || !attacker.alive) return;
      if (Date.now() < attacker.stunnedUntil) return;
      if ((this.aoeChannelUntil.get(client.sessionId) ?? 0) > Date.now())
        return;

      if (id === "aoe") {
        const now = Date.now();
        const last = this.lastAoeAt.get(client.sessionId) ?? 0;
        if (now - last < AOE_COOLDOWN_MS) return;
        this.lastAoeAt.set(client.sessionId, now);
        this.aoeChannelUntil.set(
          client.sessionId,
          now + AOE_CHANNEL_DURATION_MS
        );
        this.aoeChannelNextTick.set(
          client.sessionId,
          now + AOE_TICK_INTERVAL_MS
        );

        this.broadcast("aoe_start", {
          attackerId: client.sessionId,
          x: attacker.x,
          z: attacker.z,
          range: AOE_RANGE,
          duration: AOE_CHANNEL_DURATION_MS,
        });
      } else if (id === "leap") {
        if (typeof x !== "number" || typeof z !== "number") return;
        if (!Number.isFinite(x) || !Number.isFinite(z)) return;
        const now = Date.now();
        const last = this.lastLeapAt.get(client.sessionId) ?? 0;
        if (now - last < LEAP_COOLDOWN_MS) return;

        const dxc = x - attacker.x;
        const dzc = z - attacker.z;
        const castDist = Math.hypot(dxc, dzc);
        let tx = x;
        let tz = z;
        if (castDist > LEAP_RANGE) {
          const f = LEAP_RANGE / castDist;
          tx = attacker.x + dxc * f;
          tz = attacker.z + dzc * f;
        }
        this.lastLeapAt.set(client.sessionId, now);

        const sourceX = attacker.x;
        const sourceZ = attacker.z;
        attacker.x = tx;
        attacker.z = tz;
        this.moveLockUntil.set(client.sessionId, now + 300);

        const hits: {
          targetId: string;
          damage: number;
          stunnedUntil: number;
        }[] = [];
        this.state.players.forEach((target, targetId) => {
          if (targetId === client.sessionId) return;
          if (!target.alive) return;
          const dx = tx - target.x;
          const dz = tz - target.z;
          if (Math.hypot(dx, dz) > LEAP_RADIUS) return;
          target.hp = Math.max(0, target.hp - LEAP_DAMAGE);
          target.stunnedUntil = now + LEAP_STUN_MS;
          hits.push({
            targetId,
            damage: LEAP_DAMAGE,
            stunnedUntil: target.stunnedUntil,
          });
          if (target.hp === 0) this.killAndRespawn(targetId, client.sessionId);
        });

        this.broadcast("leap_cast", {
          attackerId: client.sessionId,
          sourceX,
          sourceZ,
          targetX: tx,
          targetZ: tz,
          radius: LEAP_RADIUS,
          stunDuration: LEAP_STUN_MS,
          hits,
        });
      } else if (id === "pull") {
        const now = Date.now();
        const last = this.lastPullAt.get(client.sessionId) ?? 0;
        if (now - last < PULL_COOLDOWN_MS) return;

        let fwdX = Math.sin(attacker.rotationY);
        let fwdZ = Math.cos(attacker.rotationY);
        if (
          typeof x === "number" &&
          typeof z === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(z)
        ) {
          const d = Math.hypot(x, z);
          if (d > 0.01) {
            fwdX = x / d;
            fwdZ = z / d;
            attacker.rotationY = Math.atan2(fwdX, fwdZ);
          }
        }
        let bestId: string | null = null;
        let bestProj = Infinity;
        this.state.players.forEach((target, targetId) => {
          if (targetId === client.sessionId) return;
          if (!target.alive) return;
          const dxt = target.x - attacker.x;
          const dzt = target.z - attacker.z;
          const proj = fwdX * dxt + fwdZ * dzt;
          if (proj <= 0 || proj > PULL_RANGE) return;
          const perpX = dxt - fwdX * proj;
          const perpZ = dzt - fwdZ * proj;
          const perp = Math.hypot(perpX, perpZ);
          if (perp > PULL_HALF_WIDTH) return;
          if (proj < bestProj) {
            bestProj = proj;
            bestId = targetId;
          }
        });
        if (!bestId) return;
        this.lastPullAt.set(client.sessionId, now);

        const target = this.state.players.get(bestId)!;
        const origX = target.x;
        const origZ = target.z;
        target.x = attacker.x + fwdX * PULL_STOP_DIST;
        target.z = attacker.z + fwdZ * PULL_STOP_DIST;
        target.hp = Math.max(0, target.hp - PULL_DAMAGE);
        target.slowedUntil = now + PULL_SLOW_MS;
        this.moveLockUntil.set(bestId, now + 300);
        if (target.hp === 0) this.killAndRespawn(bestId, client.sessionId);

        this.broadcast("pull_cast", {
          attackerId: client.sessionId,
          targetId: bestId,
          sourceX: origX,
          sourceZ: origZ,
          landX: target.x,
          landZ: target.z,
          damage: PULL_DAMAGE,
          slowDuration: PULL_SLOW_MS,
        });
      }
    });

    this.setSimulationInterval(() => {
      this.autoAttackTick();
      this.aoeChannelTick();
    }, 100);

    console.log("[game_room] created");
  }

  private autoAttackTick() {
    const now = Date.now();
    this.state.players.forEach((attacker, attackerId) => {
      if (!attacker.alive) return;
      if (now < attacker.stunnedUntil) return;
      if ((this.aoeChannelUntil.get(attackerId) ?? 0) > now) return;
      const last = this.lastAutoAt.get(attackerId) ?? 0;
      if (now - last < AUTO_COOLDOWN_MS) return;

      const fwdX = Math.sin(attacker.rotationY);
      const fwdZ = Math.cos(attacker.rotationY);

      let bestId: string | null = null;
      let bestDist = Infinity;

      this.state.players.forEach((target, targetId) => {
        if (targetId === attackerId) return;
        if (!target.alive) return;
        const dx = target.x - attacker.x;
        const dz = target.z - attacker.z;
        const dist = Math.hypot(dx, dz);
        if (dist > AUTO_RANGE || dist < 0.01) return;
        const dot = (fwdX * dx + fwdZ * dz) / dist;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (angle > AUTO_CONE_HALF) return;
        if (dist < bestDist) {
          bestDist = dist;
          bestId = targetId;
        }
      });

      if (!bestId) return;
      const target = this.state.players.get(bestId)!;
      target.hp = Math.max(0, target.hp - AUTO_DAMAGE);
      this.lastAutoAt.set(attackerId, now);
      this.broadcast("auto_hit", {
        attackerId,
        targetId: bestId,
        damage: AUTO_DAMAGE,
      });
      if (target.hp === 0) this.killAndRespawn(bestId, attackerId);
    });
  }

  private aoeChannelTick() {
    const now = Date.now();
    this.aoeChannelUntil.forEach((endAt, attackerId) => {
      const attacker = this.state.players.get(attackerId);
      const interrupted =
        !attacker || !attacker.alive || now < attacker.stunnedUntil;
      if (now >= endAt || interrupted) {
        this.aoeChannelUntil.delete(attackerId);
        this.aoeChannelNextTick.delete(attackerId);
        this.broadcast("aoe_end", { attackerId });
        return;
      }
      const nextTick = this.aoeChannelNextTick.get(attackerId) ?? 0;
      if (now < nextTick) return;
      this.aoeChannelNextTick.set(attackerId, now + AOE_TICK_INTERVAL_MS);

      const hits: { targetId: string; damage: number }[] = [];
      this.state.players.forEach((target, targetId) => {
        if (targetId === attackerId) return;
        if (!target.alive) return;
        const dx = attacker!.x - target.x;
        const dz = attacker!.z - target.z;
        if (Math.hypot(dx, dz) > AOE_RANGE) return;
        target.hp = Math.max(0, target.hp - AOE_TICK_DAMAGE);
        hits.push({ targetId, damage: AOE_TICK_DAMAGE });
        if (target.hp === 0) this.killAndRespawn(targetId, attackerId);
      });

      this.broadcast("aoe_tick", {
        attackerId,
        x: attacker!.x,
        z: attacker!.z,
        range: AOE_RANGE,
        hits,
      });
    });
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    const player = new Player();
    player.id = client.sessionId;
    player.name = options.name ?? `Hero-${client.sessionId.slice(0, 4)}`;
    const index = this.state.players.size;
    this.spawnIndex.set(client.sessionId, index);
    const spawn = spawnForIndex(index);
    player.x = spawn.x;
    player.z = spawn.z;
    player.rotationY = spawn.rotationY;
    this.state.players.set(client.sessionId, player);
    console.log(
      `[game_room] ${player.name} joined (${client.sessionId}) at side ${index}`
    );
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.lastAutoAt.delete(client.sessionId);
    this.lastAoeAt.delete(client.sessionId);
    this.lastLeapAt.delete(client.sessionId);
    this.lastPullAt.delete(client.sessionId);
    this.aoeChannelUntil.delete(client.sessionId);
    this.aoeChannelNextTick.delete(client.sessionId);
    this.spawnIndex.delete(client.sessionId);
    console.log(`[game_room] ${client.sessionId} left`);
  }

  onDispose() {
    console.log("[game_room] disposed");
  }
}
