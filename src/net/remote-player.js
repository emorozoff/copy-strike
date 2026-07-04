// Соперник на карте: приём снапшотов, буфер, интерполяция «на 100 мс назад».
// Снапшот — компактный массив [x, y, z, yaw, pitch, flags]:
//   flags бит0 movement, бит1 crouch, бит2 onGround, бит3 dead.
// Аватар — либо процедурный «человечек» (гарантированно работает без ассета),
// либо анимированная GLB-модель (drop-in, тот же интерфейс).
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const INTERP_MS = 100; // рендерим соперника на 100 мс в прошлом — сглаживает джиттер и 20 Гц апдейтов
const MAX_BUFFER = 60; // ~3 c истории при 20 Гц

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class RemotePlayer {
  constructor(scene, avatar) {
    this.scene = scene;
    this.avatar = avatar;         // { group, update(dt, state), dispose() }
    this.yawOffset = avatar.yawOffset ?? 0;
    this.buffer = [];             // { t, x, y, z, yaw, pitch, flags }
    this._state = { moving: false, crouching: false, onGround: true, dead: false };

    // Невидимые хитбоксы (ноги/торс/голова) — по ним стрелок делает рейкаст.
    // material.visible=false убирает отрисовку, но object.visible остаётся true,
    // поэтому рейкаст их видит. Едут вместе с интерполированной моделью (дети group).
    const hbMat = new THREE.MeshBasicMaterial({ visible: false });
    this._hbMat = hbMat;
    const hb = (geo, y, part) => {
      const m = new THREE.Mesh(geo, hbMat);
      m.position.y = y;
      m.frustumCulled = false;
      m.userData.part = part;
      m.userData.remote = true;
      avatar.group.add(m);
      return m;
    };
    this.hitboxes = [
      hb(new THREE.BoxGeometry(0.42, 0.9, 0.32), 0.45, 'legs'),
      hb(new THREE.BoxGeometry(0.52, 0.66, 0.34), 1.22, 'torso'),
      hb(new THREE.SphereGeometry(0.17, 10, 8), 1.70, 'head'),
    ];

    avatar.group.visible = false;
    scene.add(avatar.group);
  }

  get dead() { return this._state.dead; }
  // можно ли попасть: соперник виден на карте и ещё жив
  get canBeHit() { return this.avatar.group.visible && !this._state.dead; }

  hide() { this.avatar.group.visible = false; }

  // arr — снапшот от соперника; nowMs — локальное время приёма (performance.now)
  push(arr, nowMs) {
    if (!Array.isArray(arr) || arr.length < 6) return;
    // Большой скачок позиции (респавн-телепорт) нельзя интерполировать — иначе
    // враг «проезжает» через карту за 100 мс. Чистим буфер → мгновенный снап.
    const last = this.buffer[this.buffer.length - 1];
    if (last) {
      const dx = arr[0] - last.x, dy = arr[1] - last.y, dz = arr[2] - last.z;
      if (dx * dx + dy * dy + dz * dz > 16) this.buffer.length = 0; // > 4 м за снапшот
    }
    this.buffer.push({ t: nowMs, x: arr[0], y: arr[1], z: arr[2], yaw: arr[3], pitch: arr[4], flags: arr[5] | 0 });
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    this.avatar.group.visible = true;
  }

  update(dt, nowMs) {
    const buf = this.buffer;
    if (buf.length === 0) { this.avatar.update(dt, this._state); return; }

    const renderT = nowMs - INTERP_MS;
    // держим ровно одну точку до renderT впереди буфера
    while (buf.length >= 2 && buf[1].t <= renderT) buf.shift();

    const a = buf[0];
    const b = buf[1] ?? buf[0];
    let s = 0;
    if (b !== a && renderT > a.t) s = Math.min(1, (renderT - a.t) / (b.t - a.t));

    const g = this.avatar.group;
    g.position.set(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, a.z + (b.z - a.z) * s);
    g.rotation.y = a.yaw + shortestAngle(a.yaw, b.yaw) * s + this.yawOffset;

    const f = b.flags;
    this._state.moving = !!(f & 1);
    this._state.crouching = !!(f & 2);
    this._state.onGround = !!(f & 4);
    this._state.dead = !!(f & 8);
    this.avatar.update(dt, this._state);
  }

  dispose() {
    for (const h of this.hitboxes) h.geometry.dispose();
    this._hbMat.dispose();
    this.scene.remove(this.avatar.group);
    this.avatar.dispose();
  }
}

// --- процедурный человечек (feet at y=0, лицом к −Z = «вперёд») ----------------
export function buildProcAvatar(teamColor = 0x9aa0a6) {
  const group = new THREE.Group();
  const mat = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.05 });
  const teamMat = mat(teamColor);
  const skinMat = mat(0xcf9c72);
  const darkMat = mat(0x2b2f36);

  const box = (w, h, d, m, y = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.y = y;
    return mesh;
  };

  // ноги качаются от бедра (пивот на y=0.9, сам «сапог» свисает вниз)
  const legLen = 0.9;
  const mkLeg = x => {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, legLen, 0);
    const leg = box(0.17, legLen, 0.19, teamMat, -legLen / 2);
    pivot.add(leg);
    group.add(pivot);
    return pivot;
  };
  const legL = mkLeg(-0.12);
  const legR = mkLeg(0.12);

  // верх тела — в «бёдрах», их и качаем/приседаем
  const hips = new THREE.Object3D();
  hips.position.y = legLen;
  group.add(hips);

  hips.add(box(0.44, 0.62, 0.27, teamMat, 0.31));        // торс
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), skinMat);
  head.position.y = 0.78;
  hips.add(head);
  // «козырёк» спереди (−Z) — сразу видно, куда смотрит
  const visor = box(0.2, 0.08, 0.06, darkMat, 0.78);
  visor.position.z = -0.13;
  hips.add(visor);

  // руки от плеча
  const armLen = 0.58;
  const mkArm = x => {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, 0.58, 0);
    const arm = box(0.13, armLen, 0.15, teamMat, -armLen / 2);
    pivot.add(arm);
    hips.add(pivot);
    return pivot;
  };
  const armL = mkArm(-0.29);
  const armR = mkArm(0.29);

  // ствол в руках (−Z), чтобы силуэт читался как боец с оружием
  const gun = box(0.07, 0.07, 0.5, darkMat);
  gun.position.set(0.2, 0.42, -0.24);
  hips.add(gun);

  for (const o of group.children) o.frustumCulled = false;

  const state = { phase: 0, swing: 0, t: 0, crouch: 0, dead: 0 };
  const RUN_FREQ = 9;

  return {
    group,
    yawOffset: 0,
    update(dt, st) {
      state.t += dt;
      // мягко наводим амплитуду бега и присед — без рывков на смене флагов
      const wantSwing = st.moving ? 1 : 0;
      state.swing += (wantSwing - state.swing) * Math.min(1, dt * 10);
      state.crouch += ((st.crouching ? 1 : 0) - state.crouch) * Math.min(1, dt * 10);
      state.dead += ((st.dead ? 1 : 0) - state.dead) * Math.min(1, dt * 8);

      if (st.moving) state.phase += dt * RUN_FREQ;
      const sw = Math.sin(state.phase) * 0.8 * state.swing;
      legL.rotation.x = sw;
      legR.rotation.x = -sw;
      armL.rotation.x = -sw * 0.7;
      armR.rotation.x = sw * 0.7;

      // лёгкое покачивание корпуса при беге + «дыхание» в покое
      const bob = Math.abs(Math.sin(state.phase)) * 0.05 * state.swing
        + Math.sin(state.t * 1.6) * 0.01 * (1 - state.swing);
      // присед — приземистее (сжимаем по вертикали)
      const crouchScale = 1 - 0.28 * state.crouch;
      group.scale.y = crouchScale;
      hips.position.y = legLen + bob;

      // смерть — заваливаемся на бок
      group.rotation.z = state.dead * (Math.PI / 2 - 0.1);
    },
    dispose() {
      group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    },
  };
}

// Убираем «root motion»: клипы Quaternius несут горизонтальное смещение таза
// (нода «Body») — при беге/смерти модель уезжает от своей сетевой позиции.
// Позицию в мире задаёт снапшот, поэтому горизонталь таза фиксируем на старте
// клипа, вертикаль (подпрыгивание/дыхание) оставляем. Мутируем клипы один раз.
export function pinRootMotion(clips) {
  for (const clip of clips) {
    if (clip.userData?.pinned) continue;
    for (const track of clip.tracks) {
      if (track.name.endsWith('Body.position')) {
        const v = track.values; // [x,y,z, x,y,z, …]
        const x0 = v[0], z0 = v[2];
        for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
      }
    }
    clip.userData = { ...(clip.userData || {}), pinned: true };
  }
}

// --- аватар из анимированной GLB (drop-in, когда появится модель) --------------
// gltf — результат GLTFLoader; opts.height задаёт рост (авто-масштаб), opts.yawOffset
// разворачивает модель лицом к −Z, opts.ring — цвет команды под ногами.
// Клипы Quaternius дублируются с префиксом «CharacterArmature|» — берём по точному
// имени (idle/run/death) с запасными вариантами.
export function buildModelAvatar(gltf, opts = {}) {
  const root = cloneSkinned(gltf.scene);
  root.traverse(o => { o.frustumCulled = false; if (o.isMesh) o.castShadow = false; });
  // FBX2glTF-модели (наш случай) рендерятся скиннингом в верном размере/позе,
  // но bind-поза меша (то, что видит Box3) лежит на боку и огромная — авто-масштаб
  // по ней врёт. Поэтому масштаб/сдвиг задаём явно и калибруем скриншотом.
  root.scale.setScalar(opts.scale ?? 1);
  root.position.y = opts.yOffset ?? 0;

  const group = new THREE.Group();
  group.add(root);

  // цветное кольцо команды — иначе двух одинаковых человечков не различить
  if (opts.ring != null) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.5, 28),
      new THREE.MeshBasicMaterial({ color: opts.ring, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.frustumCulled = false;
    ring.userData.unique = true; // геометрия/материал кольца свои — их и чистим при dispose
    group.add(ring);
  }

  const mixer = new THREE.AnimationMixer(root);
  const clips = gltf.animations ?? [];
  // точное имя (с учётом префикса «Rig|Name») в приоритете, потом мягкий поиск
  const exact = name => clips.find(c => new RegExp('(^|\\|)' + name + '$', 'i').test(c.name));
  const loose = re => clips.find(c => re.test(c.name));
  const idleClip = exact('idle') ?? loose(/idle|stand/i) ?? clips[0] ?? null;
  const runClip = exact('run') ?? loose(/run|jog|sprint/i) ?? exact('walk') ?? loose(/walk/i) ?? idleClip;
  const deathClip = exact('death') ?? loose(/death|die|dead/i) ?? null;

  const actions = {};
  const mkAction = (clip, autoplay = true) => {
    if (!clip) return null;
    const a = mixer.clipAction(clip);
    a.enabled = true;
    if (autoplay) { a.setEffectiveWeight(1); a.play(); a.setEffectiveWeight(0); }
    return a;
  };
  actions.idle = mkAction(idleClip);
  actions.run = mkAction(runClip);
  // death НЕ играем на старте: LoopOnce-клип успел бы «доиграться» в нулевом
  // весе и застрять клампом — тогда при триггере он не воспроизводится.
  // Заводим его свежим при входе в смерть (fadeTo → reset+play).
  actions.death = mkAction(deathClip, false);
  if (actions.death) { actions.death.setLoop(THREE.LoopOnce, 1); actions.death.clampWhenFinished = true; }

  let current = actions.idle;
  if (current) current.setEffectiveWeight(1);

  const fadeTo = next => {
    if (!next || next === current) return;
    next.reset(); next.play();
    if (current) current.crossFadeTo(next, 0.18, false);
    else next.setEffectiveWeight(1);
    current = next;
  };

  return {
    group,
    yawOffset: opts.yawOffset ?? 0,
    update(dt, st) {
      if (st.dead && actions.death) fadeTo(actions.death);
      else if (st.moving && actions.run) fadeTo(actions.run);
      else if (actions.idle) fadeTo(actions.idle);
      mixer.update(dt);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      // геометрию/материалы модели НЕ трогаем: SkeletonUtils.clone шарит их с
      // исходным gltf и следующими клонами — dispose сломал бы будущие спавны.
      // Чистим только уникальное кольцо команды.
      group.traverse(o => {
        if (o.userData.unique) { o.geometry?.dispose(); o.material?.dispose(); }
      });
    },
  };
}
