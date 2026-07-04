import * as THREE from 'three';
import { buildModelAvatar } from '../net/remote-player.js';

// Мишень-боец из GLB-модели солдата (стоит с автоматом, idle-анимация).
// Невидимые хитбоксы голова/торс/ноги — по ним рейкаст стрелка. При смерти
// проигрывает Death-анимацию, затем воскресает. userData.part/dummy как у Dummy,
// чтобы hitscan в main.js работал одинаково для обоих типов мишеней.
export class ModelDummy {
  constructor(scene, gltf, x, y, z, facingRad = 0, opts = {}) {
    this.avatar = buildModelAvatar(gltf, { scale: opts.scale ?? 1, yOffset: opts.yOffset ?? 0 });
    this.group = this.avatar.group;
    this.group.position.set(x, y, z);
    this.group.rotation.y = facingRad;
    scene.add(this.group);

    // хитбоксы (material.visible=false — не рисуются, но рейкаст их видит),
    // размеры/высоты те же, что у сетевого игрока (модель откалибрована на рост ~1.8 м)
    const mat = new THREE.MeshBasicMaterial({ visible: false });
    this._mat = mat;
    const hb = (geo, hy, part) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.y = hy;
      m.frustumCulled = false;
      m.userData.part = part;
      m.userData.dummy = this;
      this.group.add(m);
      return m;
    };
    this.meshes = [
      hb(new THREE.BoxGeometry(0.42, 0.9, 0.32), 0.45, 'legs'),
      hb(new THREE.BoxGeometry(0.52, 0.66, 0.34), 1.22, 'torso'),
      hb(new THREE.SphereGeometry(0.17, 10, 8), 1.70, 'head'),
    ];

    this.maxHp = 100;
    this.hp = this.maxHp;
    this.dead = false;
    this.deadT = 0;
    this.respawnAfter = 3.5;
    this._state = { dead: false, moving: false, crouching: false };
  }

  hit(damage) {
    if (this.dead) return false;
    this.hp -= damage;
    if (this.hp <= 0) {
      this.dead = true;
      this._state.dead = true; // авто-запуск Death в avatar.update
      this.deadT = 0;
      return true;
    }
    return false;
  }

  update(dt) {
    this.avatar.update(dt, this._state);
    if (!this.dead) return;
    this.deadT += dt;
    if (this.deadT >= this.respawnAfter) {
      this.dead = false;
      this._state.dead = false; // вернётся в idle
      this.hp = this.maxHp;
    }
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
    this._mat.dispose();
    this.group.parent?.remove(this.group);
    this.avatar.dispose();
  }
}

// Манекен-мишень: примитивный человечек с тремя зонами урона.
// Каждый меш несёт userData.part ('head'|'torso'|'legs') — по нему считается множитель.

const MAT_BODY = new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 1 });
const MAT_HEAD = new THREE.MeshStandardMaterial({ color: 0xd8b088, roughness: 1 });
const MAT_LEGS = new THREE.MeshStandardMaterial({ color: 0x5a5142, roughness: 1 });
const MAT_DEAD = new THREE.MeshStandardMaterial({ color: 0x7a3a30, roughness: 1 });

export class Dummy {
  constructor(scene, x, y, z, yawDeg = 0) {
    this.group = new THREE.Group();
    this.group.position.set(x, y, z);
    this.group.rotation.y = yawDeg * Math.PI / 180;

    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.9, 0.28), MAT_LEGS);
    legs.position.y = 0.45;
    legs.userData.part = 'legs';

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.64, 0.3), MAT_BODY);
    torso.position.y = 1.22;
    torso.userData.part = 'torso';

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), MAT_HEAD);
    head.position.y = 1.7;
    head.userData.part = 'head';

    this.group.add(legs, torso, head);
    scene.add(this.group);

    this.meshes = [legs, torso, head];
    for (const m of this.meshes) m.userData.dummy = this;

    this.maxHp = 100;
    this.hp = this.maxHp;
    this.dead = false;
    this.deadT = 0;
    this.fallT = -1;
    this.respawnAfter = 2.5;
  }

  // возвращает true, если этим попаданием убит
  hit(damage) {
    if (this.dead) return false;
    this.hp -= damage;
    if (this.hp <= 0) {
      this.dead = true;
      this.deadT = 0;
      this.fallT = 0;
      for (const m of this.meshes) m.userData.liveMat = m.material, m.material = MAT_DEAD;
      return true;
    }
    return false;
  }

  update(dt) {
    if (!this.dead) return;
    if (this.fallT >= 0) { // падение: поворот на бок за 0.35 с
      this.fallT += dt;
      const k = Math.min(1, this.fallT / 0.35);
      this.group.rotation.x = -k * Math.PI / 2;
      if (k >= 1) this.fallT = -1;
    }
    this.deadT += dt;
    if (this.deadT >= this.respawnAfter) {
      this.dead = false;
      this.hp = this.maxHp;
      this.group.rotation.x = 0;
      for (const m of this.meshes) m.material = m.userData.liveMat;
    }
  }
}
