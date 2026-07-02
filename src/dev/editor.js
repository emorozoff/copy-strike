import * as THREE from 'three';

// Дев-режим: летающая камера + запись точек разметки карты в map-data.json.
// GLB — голый меш, всю игровую разметку (спавны, зоны бомбы/закупки) делаем сами.
const LABELS = {
  Digit1: ['spawn_t', 0xd8a13a],
  Digit2: ['spawn_ct', 0x4a90d9],
  Digit3: ['bombsite_a', 0xd94a4a],
  Digit4: ['bombsite_b', 0xd94ad9],
  Digit5: ['buyzone_t', 0x8a6a2a],
  Digit6: ['buyzone_ct', 0x2a5a8a],
};

export class PointEditor {
  constructor(scene, panelEl) {
    this.scene = scene;
    this.panel = panelEl;
    this.active = false;
    this.position = new THREE.Vector3();
    this.speed = 12; // м/с
    this.points = [];
    this.markers = new THREE.Group();
    scene.add(this.markers);
  }

  enter(fromPosition) {
    this.active = true;
    this.position.copy(fromPosition);
    this.panel.classList.remove('hidden');
    this.refreshPanel();
  }

  exit() {
    this.active = false;
    this.panel.classList.add('hidden');
  }

  handleKey(code, input) {
    if (LABELS[code]) {
      const [label] = LABELS[code];
      this.record(label, input.yaw);
      return true;
    }
    if (code === 'KeyE') { this.export(); return true; }
    return false;
  }

  record(label, yaw) {
    const p = { label, pos: [+this.position.x.toFixed(2), +this.position.y.toFixed(2), +this.position.z.toFixed(2)], yaw: +((yaw * 180 / Math.PI) % 360).toFixed(1) };
    this.points.push(p);
    const color = Object.values(LABELS).find(([l]) => l === label)[1];
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 12, 8),
      new THREE.MeshBasicMaterial({ color })
    );
    m.position.copy(this.position);
    this.markers.add(m);
    this.refreshPanel();
    console.log('точка:', JSON.stringify(p));
  }

  refreshPanel() {
    const counts = {};
    for (const p of this.points) counts[p.label] = (counts[p.label] || 0) + 1;
    this.panel.textContent =
      'РЕДАКТОР ТОЧЕК\n' +
      '1 спавн T · 2 спавн CT\n' +
      '3 плент A · 4 плент B\n' +
      '5 закуп T · 6 закуп CT\n' +
      'E — экспорт · ` — выход\n' +
      'колесо — скорость (' + this.speed.toFixed(0) + ' м/с)\n\n' +
      Object.entries(counts).map(([l, n]) => l + ': ' + n).join('\n');
  }

  update(dt, input) {
    const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
    const pitchSin = Math.sin(input.pitch), pitchCos = Math.cos(input.pitch);
    const speed = this.speed * (input.walk ? 3 : 1);
    // полёт в направлении взгляда (включая вертикаль)
    const fx = -sin * pitchCos, fy = pitchSin, fz = -cos * pitchCos;
    const rx = cos, rz = -sin;
    this.position.x += (fx * input.move.y + rx * input.move.x) * speed * dt;
    this.position.y += (fy * input.move.y + (input.jump ? 1 : 0) - (input.crouch ? 1 : 0)) * speed * dt;
    this.position.z += (fz * input.move.y + rz * input.move.x) * speed * dt;
  }

  changeSpeed(deltaY) {
    this.speed = Math.max(2, Math.min(60, this.speed * (deltaY > 0 ? 0.8 : 1.25)));
    this.refreshPanel();
  }

  export() {
    const data = {
      spawns: { t: [], ct: [] },
      bombsites: { a: [], b: [] },
      buyzones: { t: [], ct: [] },
    };
    for (const p of this.points) {
      const entry = { pos: p.pos, yaw: p.yaw };
      if (p.label === 'spawn_t') data.spawns.t.push(entry);
      else if (p.label === 'spawn_ct') data.spawns.ct.push(entry);
      else if (p.label === 'bombsite_a') data.bombsites.a.push(entry);
      else if (p.label === 'bombsite_b') data.bombsites.b.push(entry);
      else if (p.label === 'buyzone_t') data.buyzones.t.push(entry);
      else if (p.label === 'buyzone_ct') data.buyzones.ct.push(entry);
    }
    const json = JSON.stringify(data, null, 2);
    console.log('=== map-data.json ===\n' + json);
    if (navigator.clipboard) navigator.clipboard.writeText(json).catch(() => {});
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'map-data.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
