import * as THREE from 'three';
import { MOVE } from '../world/movement.js';

// Паттерн отдачи: [подъём°, увод вбок°] на каждый выстрел очереди.
// Первые ~9 пуль вверх с затуханием, дальше «маятник» вбок — упрощённый CS.
const M4_PATTERN = [
  [0.0, 0.0], [1.4, 0.05], [1.8, -0.1], [2.1, 0.2], [2.3, -0.25],
  [2.4, 0.35], [2.4, -0.45], [2.3, 0.55], [2.1, -0.6], [1.8, 0.65],
  [1.2, -0.7], [0.8, 0.75], [0.5, -0.8], [0.3, 0.8], [0.2, -0.8],
  // хвост очереди — маятник влево-вправо на весь магазин (30 пуль),
  // иначе кламп последней записи даёт постоянный увод в одну сторону
  [0.15, 0.8], [0.1, -0.8], [0.1, 0.8], [0.1, -0.8], [0.1, 0.8],
  [0.1, -0.8], [0.1, 0.8], [0.1, -0.8], [0.1, 0.8], [0.1, -0.8],
  [0.1, 0.8], [0.1, -0.8], [0.1, 0.8], [0.1, -0.8], [0.1, 0.8],
];

export const WEAPONS = {
  m4a1: {
    id: 'm4a1',
    name: 'M4A1',
    damage: 33,
    rpm: 666,
    magSize: 30,
    reserveMax: 90,
    reloadTime: 3.1,          // синхронизировано с анимацией firstperson_reload
    headMult: 4,
    legMult: 0.75,
    rangeModifier: 0.97,      // урон ×0.97 за каждые rangeUnit метров
    rangeUnit: 12.7,          // 500 юнитов
    baseSpread: 0.0016,       // рад: стоя, первый выстрел (~0.09°)
    sprayGrowth: 0.0009,      // рост конуса за выстрел очереди
    movePenalty: 6,           // множитель к разбросу на полной скорости
    airPenalty: 0.02,         // добавка в воздухе, рад
    crouchBonus: 0.55,
    recoilPattern: M4_PATTERN,
    sounds: { fire: ['m4_shot'], dry: 'dryfire', deploy: 'm4_deploy' },
    reloadSounds: [ // [время с, имя]
      [0.6, 'm4_clipout'],
      [1.7, 'm4_clipin'],
      [2.5, 'm4_boltpull'],
    ],
  },
};

// Состояние одного оружия: патроны, темп, перезарядка, индекс очереди.
export class Gun {
  constructor(def) {
    this.def = def;
    this.ammo = def.magSize;
    this.reserve = def.reserveMax;
    this.cooldown = 0;
    this.burstIdx = 0;       // номер выстрела в очереди (для паттерна)
    this.burstReset = 0;
    this.reloadT = -1;       // -1 = не перезаряжаемся
    this.dryCooldown = 0;
  }

  get reloading() { return this.reloadT >= 0; }

  startReload() {
    if (this.reloading || this.ammo >= this.def.magSize || this.reserve <= 0) return false;
    this.reloadT = 0;
    this.burstIdx = 0;
    return true;
  }

  // Возвращает событие тика: null | {type:'fire', patternIdx} | {type:'dry'} | {type:'reloaded'}
  update(dt, wantFire, wantReload) {
    this.cooldown -= dt;
    this.dryCooldown -= dt;
    this.burstReset -= dt;
    if (this.burstReset <= 0) this.burstIdx = 0;

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
      // звуки перезарядки привязаны к сим-времени, а не к wall-clock —
      // иначе при свёрнутой вкладке звук уезжает от состояния
      const sounds = this.def.reloadSounds
        .filter(([t]) => t > prev && t <= this.reloadT)
        .map(([, name]) => name);
      if (sounds.length) return { type: 'reloadSound', sounds };
      return null;
    }

    if (wantReload && this.startReload()) return { type: 'reload' };

    if (wantFire && this.cooldown <= 0) {
      if (this.ammo <= 0) {
        if (this.dryCooldown <= 0) { this.dryCooldown = 0.35; return { type: 'dry' }; }
        return null;
      }
      this.ammo--;
      // накапливаем остаток кулдауна — иначе квантование по тикам режет
      // фактический темп (666 rpm превращались в 600)
      if (this.cooldown < -dt) this.cooldown = 0;
      this.cooldown += 60 / this.def.rpm;
      const patternIdx = Math.min(this.burstIdx, this.def.recoilPattern.length - 1);
      this.burstIdx++;
      this.burstReset = 0.4;
      return { type: 'fire', patternIdx };
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
  s += burstIdx * def.sprayGrowth;
  return s;
}

const tmpDir = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const eulerYXZ = new THREE.Euler(0, 0, 0, 'YXZ');

// Направление выстрела: взгляд (yaw/pitch с учётом view-punch) + паттерн + случайный конус
export function shotDirection(yaw, pitch, def, patternIdx, spreadRad, out) {
  const [pUp, pSide] = def.recoilPattern[patternIdx];
  const d2r = Math.PI / 180;
  eulerYXZ.set(pitch + pUp * d2r, yaw + pSide * d2r, 0);
  tmpDir.set(0, 0, -1).applyEuler(eulerYXZ);
  // случайный конус: два нормальных распределения по right/up
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
