import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { startLoop } from './core/loop.js';
import { AudioManager } from './core/audio.js';
import { loadMap, loadMapData } from './world/map.js';
import { PlayerController, MOVE } from './world/movement.js';
import { Input, setupPointerLock } from './player/input.js';
import { PointEditor } from './dev/editor.js';
import { WEAPONS, Gun, currentSpread, shotDirection, computeDamage } from './combat/weapons.js';
import { ViewModel } from './combat/viewmodel.js';
import { Effects } from './combat/effects.js';
import { Dummy } from './combat/dummy.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const canvas = document.getElementById('c');
const hudEl = document.getElementById('hud');
const ammoEl = document.getElementById('ammo');
const hitmarkEl = document.getElementById('hitmark');
const hintEl = document.getElementById('hint');
const loadingEl = document.getElementById('loading');
const barFillEl = document.getElementById('barFill');
const loadNoteEl = document.getElementById('loadNote');
const clickToPlayEl = document.getElementById('clickToPlay');
const playBtn = document.getElementById('play');
const editorPanelEl = document.getElementById('editorPanel');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = false; // два прохода: мир, затем оружие поверх (clearDepth)

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xaecfe8); // пыльное небо dust2

const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.05, 600);
camera.rotation.order = 'YXZ';

scene.add(new THREE.HemisphereLight(0xfdf4e3, 0x9a8464, 1.15));
const sun = new THREE.DirectionalLight(0xfff1d0, 1.6);
sun.position.set(60, 120, 40);
scene.add(sun);

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  // devicePixelRatio меняется на лету (зум браузера, перенос окна между
  // retina и обычным монитором) — без обновления картинка мылится или GPU
  // рендерит вчетверо больше пикселей, чем нужно
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  viewmodel.resize();
});

const audio = new AudioManager();
audio.loadAll({
  m4_shot: './assets/sounds/m4_shot.wav',
  m4_boltpull: './assets/sounds/m4_boltpull.wav',
  m4_clipin: './assets/sounds/m4_clipin.wav',
  m4_clipout: './assets/sounds/m4_clipout.wav',
  m4_deploy: './assets/sounds/m4_deploy.wav',
  dryfire: './assets/sounds/dryfire.wav',
  headshot1: './assets/sounds/headshot1.wav',
  headshot2: './assets/sounds/headshot2.wav',
  death1: './assets/sounds/death1.wav',
  death2: './assets/sounds/death2.wav',
});

const input = new Input();
const editor = new PointEditor(scene, editorPanelEl);

let deployPlayed = false;
const lock = setupPointerLock(canvas, input, {
  onLock: () => {
    clickToPlayEl.classList.add('hidden');
    if (!deployPlayed) { deployPlayed = true; audio.play('m4_deploy', { volume: 0.5 }); }
  },
  onUnlock: () => { if (!DEBUG) clickToPlayEl.classList.remove('hidden'); },
});
playBtn.addEventListener('click', () => { audio.init(); lock.request(); });

window.addEventListener('wheel', e => { if (editor.active) editor.changeSpeed(e.deltaY); });

let player = null;
let mapBounds = null;
let spawns = { t: [], ct: [] };
const downRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));

// --- бой ---
const viewmodel = new ViewModel();
const gun = new Gun(WEAPONS.m4a1);
const punch = { pitch: 0, yaw: 0 };   // view-punch от отдачи, затухает
let effects = null;
const dummies = [];
const shotRay = new THREE.Raycaster();
shotRay.far = 400;
shotRay.firstHitOnly = true;
const shotDir = new THREE.Vector3();
const shotOrigin = new THREE.Vector3();
const tracerFrom = new THREE.Vector3();
const numberPos = new THREE.Vector3();
let mapCollider = null;
let hitmarkTimer = null;

function updateAmmoHud() {
  ammoEl.classList.remove('hidden');
  if (gun.reloading) {
    ammoEl.classList.add('reloading');
    ammoEl.textContent = 'перезарядка…';
  } else {
    ammoEl.classList.remove('reloading');
    ammoEl.innerHTML = `${gun.ammo} <span>/ ${gun.reserve}</span>`;
  }
}

function flashHitmark(isHead) {
  hitmarkEl.className = 'show' + (isHead ? ' head' : '');
  clearTimeout(hitmarkTimer);
  hitmarkTimer = setTimeout(() => { hitmarkEl.className = ''; }, 120);
}

const PITCH_LIM = Math.PI / 2 - 0.017;

function fireShot(patternIdx, snap) {
  const def = gun.def;
  const hspeed = Math.hypot(player.velocity.x, player.velocity.z);
  const spread = currentSpread(def, { hspeed, onGround: player.onGround, crouching: player.crouching }, patternIdx);
  const viewPitch = THREE.MathUtils.clamp(input.pitch + punch.pitch, -PITCH_LIM, PITCH_LIM);
  shotDirection(input.yaw + punch.yaw, viewPitch, def, patternIdx, spread, shotDir);
  shotOrigin.set(player.position.x, player.position.y + player.eyeHeight, player.position.z);
  shotRay.set(shotOrigin, shotDir);

  const wallHit = shotRay.intersectObject(mapCollider, false)[0] ?? null;
  const dummyMeshes = dummies.filter(d => !d.dead).flatMap(d => d.meshes);
  const bodyHit = shotRay.intersectObjects(dummyMeshes, false)[0] ?? null;

  let endPoint = null;
  if (bodyHit && (!wallHit || bodyHit.distance < wallHit.distance)) {
    const part = bodyHit.object.userData.part;
    const dummy = bodyHit.object.userData.dummy;
    const dmg = computeDamage(def, bodyHit.distance, part);
    const died = dummy.hit(dmg);
    numberPos.copy(bodyHit.point);
    numberPos.y += 0.25;
    effects.addDamageNumber(numberPos, dmg, part === 'head');
    flashHitmark(part === 'head');
    if (died) audio.playOneOf(['death1', 'death2'], { volume: 0.7 });
    else if (part === 'head') audio.playOneOf(['headshot1', 'headshot2'], { volume: 0.6 });
    endPoint = bodyHit.point;
  } else if (wallHit) {
    effects.addDecal(wallHit.point, wallHit.face.normal);
    endPoint = wallHit.point;
  }

  // трассер из-под ствола (чуть right-down от глаз)
  tracerFrom.copy(shotOrigin)
    .addScaledVector(shotDir, 1.0);
  tracerFrom.y -= 0.12;
  effects.addTracer(tracerFrom, endPoint ?? tracerFrom.clone().addScaledVector(shotDir, 120));

  // отдача: view-punch (частично) — сам паттерн уже вшит в направление пуль
  const [pUp, pSide] = def.recoilPattern[patternIdx];
  const d2r = Math.PI / 180;
  punch.pitch = Math.min(punch.pitch + pUp * 0.35 * d2r, 6 * d2r);
  punch.yaw += pSide * 0.35 * d2r;

  audio.playOneOf(def.sounds.fire, { volume: 0.35, rate: 0.97 + Math.random() * 0.06 });
  viewmodel.playShoot();
  updateAmmoHud();
}

function handleGunEvent(ev, snap) {
  if (ev.type === 'fire') fireShot(ev.patternIdx, snap);
  else if (ev.type === 'dry') audio.play('dryfire', { volume: 0.5 });
  else if (ev.type === 'reload') {
    viewmodel.playReload();
    updateAmmoHud();
  } else if (ev.type === 'reloadSound') {
    for (const name of ev.sounds) audio.play(name, { volume: 0.5 });
  } else if (ev.type === 'reloaded') updateAmmoHud();
}

function findFloor(collider, x, z, fromY) {
  downRay.origin.set(x, fromY, z);
  const hit = collider.geometry.boundsTree.raycastFirst(downRay, THREE.DoubleSide);
  return hit ? hit.point.y : null;
}

function respawn() {
  const pool = spawns.t.length ? spawns.t : spawns.ct;
  if (pool.length) {
    const s = pool[Math.floor(Math.random() * pool.length)];
    player.teleport(s.pos[0], s.pos[1] + 0.1, s.pos[2]);
    input.yaw = (s.yaw ?? 0) * Math.PI / 180;
  } else {
    // Запасной спавн: пробуем точки от центра карты, ищем пол под ними
    const c = mapBounds.getCenter(new THREE.Vector3());
    const probes = [
      [c.x, c.z], [c.x + 10, c.z], [c.x - 10, c.z], [c.x, c.z + 10], [c.x, c.z - 10],
      [c.x + 25, c.z + 25], [c.x - 25, c.z - 25],
    ];
    for (const [x, z] of probes) {
      const y = findFloor(player.collider, x, z, mapBounds.max.y + 5);
      if (y !== null) { player.teleport(x, y + 0.1, z); return; }
    }
    player.teleport(c.x, mapBounds.max.y + 2, c.z); // совсем запасной вариант
  }
}

async function init() {
  const mapData = await loadMapData('./assets/map-data.json'); // 0.5 КБ, мгновенно
  const map = await loadMap(
    './assets/de_dust2.glb',
    p => {
      if (p === null) { loadNoteEl.textContent = 'загрузка de_dust2… (размер неизвестен)'; return; }
      barFillEl.style.width = Math.round(p * 100) + '%';
    },
    async () => {
      // сообщение должно УСПЕТЬ отрисоваться до синхронного построения BVH
      loadNoteEl.textContent = 'построение коллизий…';
      barFillEl.style.width = '100%';
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    mapData?.colliders ?? []
  );

  scene.add(map.scene);
  scene.add(map.collider);
  mapBounds = map.bounds;
  mapCollider = map.collider;
  if (mapData && mapData.spawns) spawns = mapData.spawns;

  player = new PlayerController(map.collider);
  player.killY = mapBounds.min.y - 5;
  respawn();

  // оружие в руки и мишени на карту
  await viewmodel.load('./assets/m4a1.glb');
  effects = new Effects(scene);
  const dummySpots = [
    [-32, 38, 180],  // 10 м к северу от спавна T, лицом к игроку
    [0, -6, 180],    // мид
    [14, -32, 0],    // двор CT
  ];
  for (const [x, z, yawDeg] of dummySpots) {
    const y = findFloor(map.collider, x, z, mapBounds.max.y + 5);
    if (y !== null) dummies.push(new Dummy(scene, x, y, z, yawDeg));
  }
  updateAmmoHud();

  loadingEl.classList.add('hidden');
  if (!DEBUG) clickToPlayEl.classList.remove('hidden');

  startLoop({ tick, render });
  gameApi.ready = true;
}

input.onKeyDown = code => {
  if (!player) return;
  if (!input.pointerLocked && !DEBUG && !editor.active) return; // под оверлеем клавиши не игровые
  if (code === 'Backquote') {
    if (editor.active) {
      editor.exit();
      // выход из редактора: вернуть игрока под камеру редактора
      const y = findFloor(player.collider, editor.position.x, editor.position.z, editor.position.y);
      player.teleport(editor.position.x, (y ?? editor.position.y - 2) + 0.1, editor.position.z);
    } else {
      editor.enter(new THREE.Vector3(player.position.x, player.position.y + player.eyeHeight, player.position.z));
    }
    return;
  }
  if (editor.active) editor.handleKey(code, input);
};

const IDLE_SNAP = { move: { x: 0, y: 0 }, yaw: 0, jump: false, crouch: false, walk: false, fire: false, reload: false };

function tick(dt) {
  // без pointer lock (оверлей «ИГРАТЬ» на экране) ввод не игровой —
  // иначе зажатый W уводит персонажа вслепую
  const active = input.pointerLocked || DEBUG || editor.active;
  const snap = active ? input.snapshot() : { ...IDLE_SNAP, yaw: input.yaw };
  if (editor.active) {
    editor.update(dt, snap);
  } else if (!gameApi.frozen) {
    player.setCrouch(snap.crouch);
    player.update(dt, snap);
    if (player.fellOut) respawn();
  }

  // оружие (в редакторе не стреляем)
  const ev = gun.update(dt, snap.fire && !editor.active, snap.reload && !editor.active);
  if (ev) handleGunEvent(ev, snap);

  // затухание view-punch
  punch.pitch = THREE.MathUtils.damp(punch.pitch, 0, 6, dt);
  punch.yaw = THREE.MathUtils.damp(punch.yaw, 0, 6, dt);

  for (const d of dummies) d.update(dt);
  if (effects) effects.update(dt);
}

let hudTimer = 0;
const camPos = new THREE.Vector3();
function render(delta, fps, alpha) {
  if (editor.active) {
    camera.position.copy(editor.position);
  } else {
    // интерполяция между тиками: позиция прошлого тика → текущего
    camPos.copy(player.prevPosition).lerp(player.position, Math.min(alpha, 1));
    camera.position.set(camPos.x, camPos.y + player.eyeHeight, camPos.z);
  }
  // композитный pitch клампим: punch при стрельбе строго вверх мог перекинуть
  // камеру за зенит (переворот мира)
  camera.rotation.set(
    THREE.MathUtils.clamp(input.pitch + punch.pitch, -PITCH_LIM, PITCH_LIM),
    input.yaw + punch.yaw, 0
  );

  hudTimer += delta;
  if (hudTimer > 0.25) {
    hudTimer = 0;
    const p = editor.active ? editor.position : player.position;
    const hspeed = Math.hypot(player.velocity.x, player.velocity.z);
    hudEl.textContent =
      `fps ${fps}\n` +
      `поз ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
      `скор ${hspeed.toFixed(1)} м/с${player.onGround ? ' · земля' : ''}${player.crouching ? ' · присед' : ''}` +
      (editor.active ? '\n[РЕДАКТОР]' : '');
  }

  renderer.clear();
  renderer.render(scene, camera);
  if (viewmodel.ready && !editor.active) {
    const hspeed = player ? Math.hypot(player.velocity.x, player.velocity.z) : 0;
    viewmodel.update(delta, { hspeed, onGround: player?.onGround, yaw: input.yaw, pitch: input.pitch });
    renderer.clearDepth();
    renderer.render(viewmodel.scene, viewmodel.camera);
  }
}

// Отладочный API — для headless-проверки (Playwright) и подбора точек
const gameApi = {
  ready: false,
  frozen: false,
  freeze: v => { gameApi.frozen = v; },
  teleport: (x, y, z) => player.teleport(x, y, z),
  setLook: (yawDeg, pitchDeg) => {
    input.yaw = yawDeg * Math.PI / 180;
    input.pitch = (pitchDeg ?? 0) * Math.PI / 180;
  },
  press: code => input.keys.add(code),
  release: code => input.keys.delete(code),
  clearKeys: () => input.keys.clear(),
  state: () => ({
    pos: player.position.toArray().map(v => +v.toFixed(3)),
    vel: player.velocity.toArray().map(v => +v.toFixed(3)),
    onGround: player.onGround,
    crouching: player.crouching,
    eye: +player.eyeHeight.toFixed(3),
  }),
  bounds: () => mapBounds ? [mapBounds.min.toArray(), mapBounds.max.toArray()] : null,
  findFloor: (x, z) => findFloor(player.collider, x, z, mapBounds.max.y + 5),
  respawn,
  gun: () => ({ ammo: gun.ammo, reserve: gun.reserve, reloading: gun.reloading }),
  fx: () => effects ? {
    decals: effects.decals.filter(m => m.visible).length,
    tracers: effects.tracers.filter(t => t.life > 0).length,
    numbers: effects.numbers.filter(n => n.life > 0).length,
  } : null,
  dummies: () => dummies.map(d => ({ hp: d.hp, dead: d.dead, pos: d.group.position.toArray() })),
  punch: () => ({ pitch: +punch.pitch.toFixed(4), yaw: +punch.yaw.toFixed(4) }),
};
window.__game = gameApi;

init().catch(err => {
  loadNoteEl.textContent = 'ОШИБКА: ' + err.message;
  console.error(err);
});
