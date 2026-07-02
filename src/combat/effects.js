import * as THREE from 'three';

// Эффекты стрельбы в мировой сцене: дырки от пуль, трассеры, цифры урона.
// Всё пулами фиксированного размера — ноль аллокаций в бою.

function makeBulletHoleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(10,8,6,0.95)');
  grad.addColorStop(0.35, 'rgba(25,20,15,0.8)');
  grad.addColorStop(0.7, 'rgba(40,32,24,0.35)');
  grad.addColorStop(1, 'rgba(40,32,24,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // --- декали (кольцевой буфер) ---
    this.decalCount = 64;
    this.decalIdx = 0;
    const holeTex = makeBulletHoleTexture();
    const holeGeo = new THREE.PlaneGeometry(0.09, 0.09);
    this.decals = [];
    for (let i = 0; i < this.decalCount; i++) {
      const m = new THREE.Mesh(holeGeo, new THREE.MeshBasicMaterial({
        map: holeTex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      m.visible = false;
      m.renderOrder = 1;
      scene.add(m);
      this.decals.push(m);
    }

    // --- трассеры ---
    this.tracers = [];
    const tracerGeo = new THREE.BoxGeometry(0.012, 0.012, 1);
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({
        color: 0xffd890, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }

    // --- цифры урона ---
    this.numbers = [];
    for (let i = 0; i < 16; i++) {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 64;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      spr.scale.set(0.9, 0.45, 1);
      spr.visible = false;
      spr.renderOrder = 2;
      scene.add(spr);
      this.numbers.push({ sprite: spr, canvas: c, tex, life: 0, vel: 0 });
    }
  }

  addDecal(point, normal) {
    const m = this.decals[this.decalIdx];
    this.decalIdx = (this.decalIdx + 1) % this.decalCount;
    m.position.copy(point).addScaledVector(normal, 0.004);
    m.lookAt(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    m.rotation.z = Math.random() * Math.PI * 2;
    m.visible = true;
  }

  addTracer(from, to) {
    const t = this.tracers.find(t => t.life <= 0);
    if (!t) return;
    const len = from.distanceTo(to);
    if (len < 1.5) return;
    t.mesh.position.lerpVectors(from, to, 0.5);
    t.mesh.lookAt(to);
    t.mesh.scale.set(1, 1, len);
    t.mesh.visible = true;
    t.life = 0.07;
  }

  addDamageNumber(point, value, isHead) {
    const n = this.numbers.find(n => n.life <= 0) || this.numbers[0];
    const g = n.canvas.getContext('2d');
    g.clearRect(0, 0, 128, 64);
    g.font = 'bold 44px "Courier New", monospace';
    g.textAlign = 'center';
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.fillStyle = isHead ? '#ff5b45' : '#ffd34d';
    g.strokeText(String(value), 64, 46);
    g.fillText(String(value), 64, 46);
    n.tex.needsUpdate = true;
    n.sprite.position.copy(point);
    n.sprite.position.x += (Math.random() - 0.5) * 0.2;
    n.sprite.material.opacity = 1;
    n.sprite.visible = true;
    n.life = 0.7;
    n.vel = 1.1;
  }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        if (t.life <= 0) t.mesh.visible = false;
      }
    }
    for (const n of this.numbers) {
      if (n.life > 0) {
        n.life -= dt;
        n.sprite.position.y += n.vel * dt;
        n.vel *= 0.92;
        n.sprite.material.opacity = Math.min(1, n.life / 0.35);
        if (n.life <= 0) n.sprite.visible = false;
      }
    }
  }
}
