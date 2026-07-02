import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Оружие от первого лица: отдельная сцена + камера с узким FOV, рендерится
// вторым проходом поверх мира (clearDepth) — ствол не втыкается в стены.
// Модель M4A1 из decentraland/cs-1.6 — CS2-виевмодель со скелетными анимациями.

const VM_FOV = 54;

export class ViewModel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(VM_FOV, innerWidth / innerHeight, 0.01, 20);
    this.scene.add(new THREE.HemisphereLight(0xfdf4e3, 0x6a5a44, 1.3));
    const sun = new THREE.DirectionalLight(0xfff1d0, 1.2);
    sun.position.set(1, 2, 1);
    this.scene.add(sun);

    this.root = new THREE.Group();   // сюда кладём модель; на root — bob/sway/kick
    this.scene.add(this.root);

    this.mixer = null;
    this.actions = {};
    this.ready = false;

    this.bobT = 0;
    this.kick = 0;          // процедурный откат ствола при выстреле
    this.swayYaw = 0;       // отставание оружия за мышью
    this.swayPitch = 0;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.muzzleFlash = null;
    this.flashT = 0;
  }

  async load(url) {
    const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
    const model = gltf.scene;
    // позиция подобрана по скриншотам: чуть вправо-вниз от камеры
    model.position.set(0.14, -0.24, -0.08);
    model.rotation.y = Math.PI; // glTF-модель смотрит на камеру — разворачиваем от себя
    this.root.add(model);

    this.mixer = new THREE.AnimationMixer(model);
    const byName = Object.fromEntries(gltf.animations.map(a => [a.name, a]));
    const pick = n => byName[n] ?? null;

    const idleClip = pick('firstperson_idle');
    if (idleClip) {
      this.actions.idle = this.mixer.clipAction(idleClip);
      this.actions.idle.play();
    }
    const shootClip = pick('firstperson_shoot_unsilenced_additive');
    if (shootClip) {
      const additive = THREE.AnimationUtils.makeClipAdditive(shootClip.clone());
      this.actions.shoot = this.mixer.clipAction(additive);
      this.actions.shoot.blendMode = THREE.AdditiveAnimationBlendMode;
      this.actions.shoot.setLoop(THREE.LoopOnce);
    }
    const reloadClip = pick('firstperson_reload');
    if (reloadClip) {
      this.actions.reload = this.mixer.clipAction(reloadClip);
      this.actions.reload.setLoop(THREE.LoopOnce);
    }
    const drawClip = pick('firstperson_draw');
    if (drawClip) {
      this.actions.draw = this.mixer.clipAction(drawClip);
      this.actions.draw.setLoop(THREE.LoopOnce);
    }

    // Возврат idle после one-shot клипов: затухший fadeOut выключает action
    // (enabled=false) навсегда — без этого после первой перезарядки оружие
    // замирает в бинд-позе до конца сессии.
    this.mixer.addEventListener('finished', e => {
      if (this.actions.idle && (e.action === this.actions.reload || e.action === this.actions.draw)) {
        this.actions.idle.reset().fadeIn(0.15).play();
      }
    });

    // вспышка у ствола: additive-спрайт, живёт 1-2 кадра
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
    this.muzzleFlash.position.set(0.14, -0.11, -0.95); // примерно у дула
    this.muzzleFlash.visible = false;
    this.root.add(this.muzzleFlash);

    this.ready = true;
    this.playDraw();
  }

  playDraw() {
    if (!this.actions.draw) return;
    if (this.actions.idle) this.actions.idle.fadeOut(0.05);
    this.actions.draw.reset().play();
  }

  playShoot() {
    this.kick = 1;
    this.flashT = 0.045;
    if (this.muzzleFlash) {
      this.muzzleFlash.visible = true;
      this.muzzleFlash.material.rotation = Math.random() * Math.PI * 2;
    }
    if (this.actions.shoot) this.actions.shoot.reset().play();
  }

  playReload() {
    if (!this.actions.reload) return;
    if (this.actions.idle) this.actions.idle.fadeOut(0.08);
    this.actions.reload.reset().play();
  }

  update(dt, { hspeed, onGround, yaw, pitch }) {
    if (this.mixer) this.mixer.update(dt);

    // покачивание при движении
    const speedK = onGround ? Math.min(1, hspeed / 6.35) : 0;
    if (speedK > 0.05) this.bobT += dt * (6 + 6 * speedK);
    const bobY = Math.abs(Math.sin(this.bobT)) * 0.012 * speedK;
    const bobX = Math.sin(this.bobT) * 0.008 * speedK;

    // отставание за мышью (sway)
    const dYaw = yaw - this.lastYaw, dPitch = pitch - this.lastPitch;
    this.lastYaw = yaw; this.lastPitch = pitch;
    this.swayYaw = THREE.MathUtils.clamp(THREE.MathUtils.damp(this.swayYaw, dYaw * 6, 10, dt), -0.05, 0.05);
    this.swayPitch = THREE.MathUtils.clamp(THREE.MathUtils.damp(this.swayPitch, dPitch * 6, 10, dt), -0.05, 0.05);

    // процедурный откат при выстреле (поверх скелетной анимации)
    this.kick = Math.max(0, this.kick - dt * 14);
    const k = this.kick * this.kick;

    this.root.position.set(bobX, -bobY, k * 0.035);
    this.root.rotation.set(this.swayPitch - k * 0.03, this.swayYaw, 0);

    this.flashT -= dt;
    if (this.muzzleFlash && this.flashT <= 0) this.muzzleFlash.visible = false;
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
