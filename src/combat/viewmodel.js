import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Оружие от первого лица: отдельная сцена + камера с узким FOV, рендерится
// вторым проходом поверх мира (clearDepth) — ствол не втыкается в стены.
// Поддерживает несколько оружий: GLB-модели с анимациями и процедурные
// заглушки из примитивов (пока не нашли модель).

const VM_FOV = 54;

export class ViewModel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(VM_FOV, innerWidth / innerHeight, 0.01, 20);
    this.scene.add(new THREE.HemisphereLight(0xfdf4e3, 0x6a5a44, 1.3));
    const sun = new THREE.DirectionalLight(0xfff1d0, 1.2);
    sun.position.set(1, 2, 1);
    this.scene.add(sun);

    this.root = new THREE.Group(); // на root — bob/sway/kick, общие для всех оружий
    this.scene.add(this.root);

    this.weapons = {};   // id → {group, mixer, actions, opts}
    this.active = null;
    this.activeId = null;
    this.ready = false;

    this.bobT = 0;
    this.kick = 0;
    this.swayYaw = 0;
    this.swayPitch = 0;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.flashT = 0;

    // общая вспышка у ствола (позиция — в opts.muzzle оружия)
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,240,190,1)');
    grad.addColorStop(0.4, 'rgba(255,190,80,0.9)');
    grad.addColorStop(1, 'rgba(255,140,20,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const flashTex = new THREE.CanvasTexture(c);
    flashTex.colorSpace = THREE.SRGBColorSpace;
    this.muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTex, blending: THREE.AdditiveBlending, depthTest: false, transparent: true,
    }));
    this.muzzleFlash.scale.set(0.28, 0.28, 1);
    this.muzzleFlash.visible = false;
    this.root.add(this.muzzleFlash);
  }

  async loadWeapon(id, url, opts = {}, onProgress) {
    const gltf = await new Promise((res, rej) => new GLTFLoader().load(
      url, res,
      e => { if (onProgress) onProgress(e.lengthComputable ? e.loaded / e.total : null); },
      rej
    ));
    const model = gltf.scene;
    // скиннед-меши анимируются за пределы исходного bbox — без этого
    // Three.js отсекает их фрустум-каллингом и оружие «исчезает»
    model.traverse(o => { if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false; });
    if (opts.scale) model.scale.setScalar(opts.scale);
    model.position.fromArray(opts.position ?? [0.14, -0.24, -0.08]);
    model.rotation.set(...(opts.rotation ?? [0, Math.PI, 0]));
    const group = new THREE.Group();
    group.add(model);
    group.visible = false;
    this.root.add(group);

    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    // Некоторые модели несут один общий таймлайн вместо отдельных клипов —
    // opts.subclips = { idle: [сек, сек], shoot: [...], draw: [...] } режет его
    // (границы из разметки исходной игры; кадры = секунды × 30 fps)
    let anims = gltf.animations;
    if (opts.subclips) {
      const master = anims.reduce((a, b) => (b.tracks.length > a.tracks.length ? b : a));
      anims = Object.entries(opts.subclips).map(([name, [t0, t1]]) =>
        THREE.AnimationUtils.subclip(master, name, Math.round(t0 * 30), Math.round(t1 * 30), 30));
    }
    const find = re => anims.find(a => re.test(a.name)) ?? null;
    const clips = {
      // (^|[_|]) — клипы бывают и «idle», и «firstperson_idle», и «Armature|Idle»
      idle: find(/firstperson_idle|(^|[_|])idle/i),
      reload: find(/firstperson_reload|reload/i),
      draw: find(/firstperson_draw|draw|deploy|equip|switch/i),
      shoot: find(/shoot_unsilenced_additive|shoot.*additive/i) ?? find(/shoot|fire|attack|slash/i),
    };
    if (clips.idle) {
      actions.idle = mixer.clipAction(clips.idle);
    }
    // битый клип выстрела (нулевая длительность) хуже, чем его отсутствие
    if (clips.shoot && clips.shoot.duration < 0.05) clips.shoot = null;
    if (clips.shoot) {
      actions.shootAdditive = /additive/i.test(clips.shoot.name);
      if (actions.shootAdditive) {
        const additive = THREE.AnimationUtils.makeClipAdditive(clips.shoot.clone());
        actions.shoot = mixer.clipAction(additive);
        actions.shoot.blendMode = THREE.AdditiveAnimationBlendMode;
      } else {
        actions.shoot = mixer.clipAction(clips.shoot);
      }
      actions.shoot.setLoop(THREE.LoopOnce);
    }
    if (clips.reload) {
      actions.reload = mixer.clipAction(clips.reload);
      actions.reload.setLoop(THREE.LoopOnce);
    }
    if (clips.draw) {
      actions.draw = mixer.clipAction(clips.draw);
      actions.draw.setLoop(THREE.LoopOnce);
    }
    // возврат idle после one-shot клипов (fadeOut навсегда выключает action)
    mixer.addEventListener('finished', e => {
      if (!actions.idle) return;
      if (e.action === actions.reload || e.action === actions.draw) {
        actions.idle.reset().fadeIn(0.15).play();
      } else if (e.action === actions.shoot && !actions.shootAdditive) {
        actions.idle.setEffectiveWeight(1);
      }
    });

    this.weapons[id] = { group, mixer, actions, opts, masterClip: opts.subclips ? gltf.animations.reduce((a, b) => (b.tracks.length > a.tracks.length ? b : a)) : null };
    return this.weapons[id];
  }

  // Отладочная перенарезка клипа из общего таймлайна (подбор границ через __game)
  resubclip(id, name, t0, t1) {
    const w = this.weapons[id];
    if (!w?.masterClip) return false;
    const clip = THREE.AnimationUtils.subclip(w.masterClip, name, Math.round(t0 * 30), Math.round(t1 * 30), 30);
    if (w.actions[name]) {
      w.actions[name].stop();
      w.mixer.uncacheAction(w.actions[name].getClip(), w.group.children[0]);
    }
    const a = w.mixer.clipAction(clip);
    if (name !== 'idle') a.setLoop(THREE.LoopOnce);
    w.actions[name] = a;
    if (name === 'idle' && this.active === w) a.reset().setEffectiveWeight(1).play();
    return true;
  }

  // Процедурная заглушка из примитивов, пока нет модели
  addProcedural(id, group, opts = {}) {
    group.visible = false;
    this.root.add(group);
    this.weapons[id] = { group, mixer: null, actions: {}, opts };
    return this.weapons[id];
  }

  setActive(id) {
    const w = this.weapons[id];
    if (!w) return false;
    if (this.active) {
      this.active.group.visible = false;
      this.active.mixer?.stopAllAction();
    }
    this.active = w;
    this.activeId = id;
    w.group.visible = true;
    this.muzzleFlash.position.fromArray(w.opts.muzzle ?? [0.14, -0.11, -0.95]);
    if (w.actions.idle) w.actions.idle.reset().setEffectiveWeight(1).play();
    if (w.actions.draw) {
      if (w.actions.idle) w.actions.idle.fadeOut(0.05);
      const draw = w.actions.draw;
      draw.reset();
      // родные клипы доставания бывают по 2+ с — ужимаем под deployTime игры
      if (w.opts.drawDuration) draw.timeScale = draw.getClip().duration / w.opts.drawDuration;
      draw.play();
    }
    this.ready = true;
    return true;
  }

  playShoot({ flash = true } = {}) {
    this.kick = 1;
    if (flash) {
      this.flashT = 0.045;
      this.muzzleFlash.visible = true;
      this.muzzleFlash.material.rotation = Math.random() * Math.PI * 2;
    }
    const acts = this.active?.actions;
    if (acts?.shoot) {
      // не-аддитивный клип выстрела перекрывает idle: приглушаем idle на время
      if (!acts.shootAdditive && acts.idle) acts.idle.setEffectiveWeight(0.05);
      acts.shoot.reset().play();
    }
  }

  // duration — целевая длительность (def.reloadTime): клип растягивается или
  // сжимается так, чтобы анимация закончилась ровно к пополнению магазина
  playReload(duration) {
    const w = this.active;
    if (!w || !w.actions.reload) return;
    if (w.actions.idle) w.actions.idle.fadeOut(0.08);
    const a = w.actions.reload;
    a.reset();
    a.timeScale = duration ? a.getClip().duration / duration : 1;
    a.play();
  }

  update(dt, { hspeed, onGround, yaw, pitch }) {
    this.active?.mixer?.update(dt);

    const speedK = onGround ? Math.min(1, hspeed / 6.35) : 0;
    if (speedK > 0.05) this.bobT += dt * (6 + 6 * speedK);
    const bobY = Math.abs(Math.sin(this.bobT)) * 0.012 * speedK;
    const bobX = Math.sin(this.bobT) * 0.008 * speedK;

    const dYaw = yaw - this.lastYaw, dPitch = pitch - this.lastPitch;
    this.lastYaw = yaw; this.lastPitch = pitch;
    this.swayYaw = THREE.MathUtils.clamp(THREE.MathUtils.damp(this.swayYaw, dYaw * 6, 10, dt), -0.05, 0.05);
    this.swayPitch = THREE.MathUtils.clamp(THREE.MathUtils.damp(this.swayPitch, dPitch * 6, 10, dt), -0.05, 0.05);

    this.kick = Math.max(0, this.kick - dt * 14);
    const k = this.kick * this.kick;
    // у ножа «kick» — замах: качаем сильнее и вбок
    const melee = this.active?.opts.melee;
    if (melee) {
      this.root.position.set(bobX - k * 0.06, -bobY - k * 0.02, k * 0.06);
      this.root.rotation.set(this.swayPitch - k * 0.5, this.swayYaw + k * 0.35, k * 0.2);
    } else {
      this.root.position.set(bobX, -bobY, k * 0.035);
      this.root.rotation.set(this.swayPitch - k * 0.03, this.swayYaw, 0);
    }

    this.flashT -= dt;
    if (this.flashT <= 0) this.muzzleFlash.visible = false;
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}

// --- процедурные заглушки (пока не найдены GLB-модели) ---

export function buildProceduralKnife() {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.035, 0.19), steel);
  blade.position.set(0, 0.01, -0.14);
  blade.rotation.x = -0.06;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.017, 0.06, 4), steel);
  tip.rotation.x = -Math.PI / 2;
  tip.scale.set(0.35, 1, 1.6);
  tip.position.set(0, 0.014, -0.26);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.015), dark);
  guard.position.set(0, 0, -0.04);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.11, 8), dark);
  handle.rotation.x = Math.PI / 2 - 0.25;
  handle.position.set(0, -0.012, 0.02);
  group.add(blade, tip, guard, handle);
  group.position.set(0.22, -0.22, -0.35);
  group.rotation.set(0, -0.5, 0.15);
  return group;
}

export function buildProceduralPistol() {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.7, metalness: 0.3 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x3a3428, roughness: 0.95 });
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.045, 0.21), dark);
  slide.position.set(0, 0.015, -0.1);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.05, 8), dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.22);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.11, 0.045), grip);
  handle.rotation.x = 0.3;
  handle.position.set(0, -0.05, -0.015);
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.03, 0.03), dark);
  trigger.position.set(0, -0.012, -0.06);
  group.add(slide, barrel, handle, trigger);
  group.position.set(0.17, -0.19, -0.3);
  group.rotation.set(0, 0.06, 0);
  return group;
}
