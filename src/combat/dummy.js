import * as THREE from 'three';

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
