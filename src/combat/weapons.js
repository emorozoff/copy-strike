import * as THREE from 'three';
import { MOVE } from '../world/movement.js';

// ОТДАЧА (модель как в CS): каждый выстрел даёт «пинок» камере [вверх°, вбок°].
// Пока очередь зажата, punch почти не затухает — ствол реально уезжает вверх
// (~12° за первые 10 пуль АК) и его нужно компенсировать мышью вниз.
// После отпускания кнопки punch быстро возвращается к нулю.
// Пули летят по текущему (увёдённому) взгляду + случайный конус разброса.

const AK_KICK = [
  [0.5, 0.0], [1.1, 0.12], [1.5, -0.2], [1.6, 0.28], [1.6, -0.35],
  [1.55, 0.42], [1.45, -0.5], [1.3, 0.55], [1.1, -0.55], [0.9, 0.6],
  [0.5, -1.0], [0.3, 1.05], [0.25, -1.1], [0.2, 1.1], [0.2, -1.1],
  [0.2, 1.1], [0.2, -1.1], [0.2, 1.1], [0.2, -1.1], [0.2, 1.1],
  [0.2, -1.1], [0.2, 1.1], [0.2, -1.1], [0.2, 1.1], [0.2, -1.1],
  [0.2, 1.1], [0.2, -1.1], [0.2, 1.1], [0.2, -1.1], [0.2, 1.1],
];
const M4_KICK = AK_KICK.map(([u, s]) => [+(u * 0.78).toFixed(3), +(s * 0.8).toFixed(3)]);
const USP_KICK = [[1.35, 0.15]];
const KNIFE_KICK = [[0.25, 0]];

export const WEAPONS = {
  ak47: {
    id: 'ak47', name: 'AK-47', slotLabel: '1',
    damage: 36, rpm: 600, magSize: 30, reserveMax: 90,
    reloadTime: 2.43, deployTime: 1.0,
    headMult: 4, legMult: 0.75,
    rangeModifier: 0.98, rangeUnit: 12.7,
    baseSpread: 0.0018, sprayGrowth: 0.0011, movePenalty: 7, airPenalty: 0.025, crouchBonus: 0.6,
    kick: AK_KICK,
    sounds: { fire: ['ak_shot'], dry: 'dryfire', deploy: 'ak_boltpull' },
    reloadSounds: [[0.45, 'ak_clipout'], [1.4, 'ak_clipin'], [2.05, 'ak_boltpull']],
  },
  m4a1: {
    id: 'm4a1', name: 'M4A1', slotLabel: '4',
    damage: 33, rpm: 666, magSize: 30, reserveMax: 90,
    reloadTime: 3.1, deployTime: 0.9,
    headMult: 4, legMult: 0.75,
    rangeModifier: 0.97, rangeUnit: 12.7,
    baseSpread: 0.0016, sprayGrowth: 0.0009, movePenalty: 6, airPenalty: 0.02, crouchBonus: 0.55,
    kick: M4_KICK,
    sounds: { fire: ['m4_shot'], dry: 'dryfire', deploy: 'm4_deploy' },
    reloadSounds: [[0.6, 'm4_clipout'], [1.7, 'm4_clipin'], [2.5, 'm4_boltpull']],
  },
  usp: {
    id: 'usp', name: 'USP', slotLabel: '2',
    damage: 35, rpm: 352, magSize: 12, reserveMax: 24,
    reloadTime: 2.2, deployTime: 0.7,
    semiAuto: true, // стреляет только по клику, не по зажатию
    headMult: 4, legMult: 0.75,
    rangeModifier: 0.79, rangeUnit: 12.7, // пистолет быстро теряет урон
    baseSpread: 0.0022, sprayGrowth: 0.002, movePenalty: 4, airPenalty: 0.03, crouchBonus: 0.7,
    kick: USP_KICK,
    sounds: { fire: ['usp_shot'], dry: 'dryfire_pistol', deploy: 'usp_slide' },
    reloadSounds: [[0.5, 'usp_clipout'], [1.2, 'usp_clipin'], [1.75, 'usp_slide']],
  },
  knife: {
    id: 'knife', name: 'НОЖ', slotLabel: '3',
    melee: true, meleeRange: 1.1,
    damage: 40, rpm: 88, magSize: Infinity, reserveMax: 0,
    reloadTime: 0, deployTime: 0.6,
    headMult: 1.5, legMult: 1, // ножом в голову — не хедшот из CS, лёгкий бонус
    rangeModifier: 1, rangeUnit: 1,
    baseSpread: 0, sprayGrowth: 0, movePenalty: 0, airPenalty: 0, crouchBonus: 1,
    kick: KNIFE_KICK,
    sounds: {
      fire: ['knife_slash1', 'knife_slash2'], dry: null, deploy: 'knife_deploy',
      hitFlesh: ['knife_hit1', 'knife_hit2'], hitWall: 'knife_hitwall', stab: 'knife_stab',
    },
    reloadSounds: [],
  },
};

// Состояние одного оружия: патроны, темп, перезарядка, индекс очереди.
export class Gun {
  constructor(def) {
    this.def = def;
    this.ammo = def.magSize;
    this.reserve = def.reserveMax;
    this.cooldown = 0;
    this.burstIdx = 0;
    this.burstReset = 0;
    this.reloadT = -1;
    this.dryCooldown = 0;
    this.prevWantFire = false;
  }

  get reloading() { return this.reloadT >= 0; }
  get firingRecently() { return this.burstReset > 0; }

  cancelReload() { this.reloadT = -1; }

  startReload() {
    if (this.def.melee) return false;
    if (this.reloading || this.ammo >= this.def.magSize || this.reserve <= 0) return false;
    this.reloadT = 0;
    this.burstIdx = 0;
    return true;
  }

  // null | {type:'fire', kick:[up,side], burstIdx} | {type:'dry'} | {type:'reload'} | {type:'reloadSound', sounds} | {type:'reloaded'}
  update(dt, wantFire, wantReload) {
    this.cooldown -= dt;
    this.dryCooldown -= dt;
    this.burstReset -= dt;
    if (this.burstReset <= 0) this.burstIdx = 0;

    const firePressed = this.def.semiAuto ? (wantFire && !this.prevWantFire) : wantFire;
    this.prevWantFire = wantFire;

    if (this.reloading) {
      const prev = this.reloadT;
      this.reloadT += dt;
      if (this.reloadT >= this.def.reloadTime) {
        const take = Math.min(this.def.magSize - this.ammo, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        this.reloadT = -1;
        return { type: 'reloaded' };
      }
      // звуки перезарядки привязаны к сим-времени (не wall-clock)
      const sounds = this.def.reloadSounds
        .filter(([t]) => t > prev && t <= this.reloadT)
        .map(([, name]) => name);
      if (sounds.length) return { type: 'reloadSound', sounds };
      return null;
    }

    if (wantReload && this.startReload()) return { type: 'reload' };

    if (firePressed && this.cooldown <= 0) {
      if (this.ammo <= 0) {
        if (this.dryCooldown <= 0 && this.def.sounds.dry) { this.dryCooldown = 0.35; return { type: 'dry' }; }
        return null;
      }
      if (!this.def.melee) this.ammo--;
      // накапливаем остаток кулдауна — квантование по тикам не режет темп
      if (this.cooldown < -dt) this.cooldown = 0;
      this.cooldown += 60 / this.def.rpm;
      const idx = Math.min(this.burstIdx, this.def.kick.length - 1);
      this.burstIdx++;
      this.burstReset = 0.45;
      return { type: 'fire', kick: this.def.kick[idx], burstIdx: idx };
    }
    return null;
  }
}

// Текущий разброс в радианах с учётом стойки/движения/воздуха/очереди
export function currentSpread(def, { hspeed, onGround, crouching }, burstIdx) {
  let s = def.baseSpread;
  s *= 1 + (hspeed / MOVE.runSpeed) * def.movePenalty;
  if (!onGround) s += def.airPenalty;
  if (crouching) s *= def.crouchBonus;
  s += Math.min(burstIdx, 12) * def.sprayGrowth;
  return s;
}

const tmpDir = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const eulerYXZ = new THREE.Euler(0, 0, 0, 'YXZ');

// Направление выстрела: текущий взгляд (уже с punch) + случайный конус.
// Паттерн отдачи НЕ добавляется к пуле отдельно — он уже увёл сам взгляд.
export function shotDirection(yaw, pitch, spreadRad, out) {
  eulerYXZ.set(pitch, yaw, 0);
  tmpDir.set(0, 0, -1).applyEuler(eulerYXZ);
  tmpRight.set(1, 0, 0).applyEuler(eulerYXZ);
  tmpUp.crossVectors(tmpRight, tmpDir).negate();
  const g = () => (Math.random() + Math.random() + Math.random()) / 1.5 - 1; // ~гаусс [-1,1]
  out.copy(tmpDir)
    .addScaledVector(tmpRight, g() * spreadRad)
    .addScaledVector(tmpUp, g() * spreadRad)
    .normalize();
  return out;
}

// Урон с падением по дистанции и множителем части тела
export function computeDamage(def, distance, part) {
  let dmg = def.damage * Math.pow(def.rangeModifier, distance / def.rangeUnit);
  if (part === 'head') dmg *= def.headMult;
  else if (part === 'legs') dmg *= def.legMult;
  return Math.max(1, Math.round(dmg));
}
