import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { startLoop } from './core/loop.js';
import { AudioManager } from './core/audio.js';
import { loadMap, loadMapData } from './world/map.js';
import { PlayerController, MOVE } from './world/movement.js';
import { Input, setupPointerLock } from './player/input.js';
import { PointEditor } from './dev/editor.js';
import { WEAPONS, Gun, currentSpread, shotDirection, computeDamage } from './combat/weapons.js';
import { ViewModel, buildProceduralKnife, buildProceduralPistol } from './combat/viewmodel.js';
import { Effects } from './combat/effects.js';
import { Dummy } from './combat/dummy.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

// Версия игры: БАМПИТЬ ПРИ КАЖДОМ ДЕПЛОЕ мелкими шагами (v0.71, v0.72, …);
// v1.0 — готовая игра. Выводится сверху экрана из JS — по номеру видно,
// доехало ли обновление или браузер держит старый кэш
const GAME_VERSION = 'v0.71';

// Версия ассетов: GitHub Pages кэширует на 10 минут (max-age=600) — без
// query-параметра после редеплоя браузер подмешивает старые файлы к новым
const ASSET_V = '5';
const av = url => url + '?v=' + ASSET_V;

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

document.getElementById('ver').textContent = 'COPY-STRIKE ' + GAME_VERSION;
document.title = 'COPY-STRIKE ' + GAME_VERSION;

// «Живая» загрузка: забавные статусы сменяют друг друга, процент — честный
const LOAD_QUIPS = [
  'выдаём патроны', 'расставляем коробки', 'протираем прицел',
  'завозим песок', 'подметаем лонг', 'смазываем затворы',
  'будим манекенов', 'прикручиваем мушку', 'заряжаем магазины',
  'проверяем двери на B', 'копаем яму на лонге', 'настраиваем эхо в тоннелях',
];
let quipI = Math.floor(Math.random() * LOAD_QUIPS.length);
let loadPct = null; // null — размер неизвестен, процент не пишем
const paintLoadNote = () => {
  loadNoteEl.textContent = LOAD_QUIPS[quipI] + '…' + (loadPct !== null ? ` ${loadPct}%` : '');
};
const loadTicker = setInterval(() => {
  quipI = (quipI + 1) % LOAD_QUIPS.length;
  paintLoadNote();
}, 1400);

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
const SOUND_FILES = {};
for (const n of [
  'm4_shot', 'm4_boltpull', 'm4_clipin', 'm4_clipout', 'm4_deploy',
  'ak_shot', 'ak_boltpull', 'ak_clipin', 'ak_clipout',
  'glock_shot', 'glock_clipin', 'glock_clipout', 'glock_slideback', 'glock_sliderelease',
  'knife_deploy', 'knife_slash1', 'knife_slash2', 'knife_hit1', 'knife_hit2', 'knife_hitwall', 'knife_stab',
  'dryfire', 'dryfire_pistol', 'headshot1', 'headshot2', 'death1', 'death2',
  'step1', 'step2', 'step3', 'step4',
]) SOUND_FILES[n] = av(`./assets/sounds/${n}.wav`);
audio.loadAll(SOUND_FILES);

const input = new Input();
const editor = new PointEditor(scene, editorPanelEl);

let deployPlayed = false;
const lock = setupPointerLock(canvas, input, {
  onLock: () => {
    clickToPlayEl.classList.add('hidden');
    if (!deployPlayed) {
      deployPlayed = true;
      const d = guns[activeSlot].def.sounds.deploy;
      if (d) audio.play(d, { volume: 0.5 });
    }
  },
  onUnlock: () => { if (!DEBUG) clickToPlayEl.classList.remove('hidden'); },
});
playBtn.addEventListener('click', () => { audio.init(); lock.request(); });

window.addEventListener('wheel', e => {
  if (editor.active) editor.changeSpeed(e.deltaY);
  else if (input.pointerLocked && player) cycleSlot(e.deltaY > 0 ? 1 : -1);
});

let player = null;
let mapBounds = null;
let spawns = { t: [], ct: [] };
const downRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));

// --- бой ---
const viewmodel = new ViewModel();
// арсенал: 1 — AK-47 (основное), 2 — Glock (пистолет с руками; USP вернётся,
// когда найдём его модель с рабочими руками), 3 — нож, 4 — M4A1 (временно)
const guns = {
  1: new Gun(WEAPONS.ak47),
  2: new Gun(WEAPONS.glock),
  3: new Gun(WEAPONS.knife),
  4: new Gun(WEAPONS.m4a1),
};
const SLOT_ORDER = [1, 2, 3, 4];
let activeSlot = 1;
let deployT = 0;                      // достаём оружие — стрелять нельзя
const punch = { pitch: 0, yaw: 0 };   // view-punch от отдачи
let effects = null;
const dummies = [];
const shotRay = new THREE.Raycaster();
shotRay.far = 400;
shotRay.firstHitOnly = true;
const shotDir = new THREE.Vector3();
const shotOrigin = new THREE.Vector3();
const tracerFrom = new THREE.Vector3();
const tracerTo = new THREE.Vector3();
const numberPos = new THREE.Vector3();
let mapCollider = null;
let hitmarkTimer = null;

function activeGun() { return guns[activeSlot]; }

function updateAmmoHud() {
  const gun = activeGun();
  ammoEl.classList.remove('hidden');
  if (gun.def.melee) {
    ammoEl.classList.remove('reloading');
    ammoEl.innerHTML = `<span>${gun.def.name}</span>`;
  } else if (gun.reloading) {
    ammoEl.classList.add('reloading');
    ammoEl.textContent = 'перезарядка…';
  } else {
    ammoEl.classList.remove('reloading');
    ammoEl.innerHTML = `<span>${gun.def.name}</span> ${gun.ammo} <span>/ ${gun.reserve}</span>`;
  }
}

function switchTo(slot) {
  if (!guns[slot] || slot === activeSlot) return;
  activeGun().cancelReload(); // смена оружия отменяет перезарядку (как в CS)
  activeSlot = slot;
  const def = guns[slot].def;
  deployT = def.deployTime;
  viewmodel.setActive(def.id);
  if (def.sounds.deploy) audio.play(def.sounds.deploy, { volume: 0.4, delay: 0.05 });
  updateAmmoHud();
}

function cycleSlot(dir) {
  const i = SLOT_ORDER.indexOf(activeSlot);
  switchTo(SLOT_ORDER[(i + dir + SLOT_ORDER.length) % SLOT_ORDER.length]);
}

function flashHitmark(isHead) {
  hitmarkEl.className = 'show' + (isHead ? ' head' : '');
  clearTimeout(hitmarkTimer);
  hitmarkTimer = setTimeout(() => { hitmarkEl.className = ''; }, 120);
}

const PITCH_LIM = Math.PI / 2 - 0.017;
const D2R = Math.PI / 180;
const MAX_PUNCH_PITCH = 15 * D2R;

// Общая часть прицеливания: направление взгляда с учётом punch
function aimShot(spreadRad) {
  const viewPitch = THREE.MathUtils.clamp(input.pitch + punch.pitch, -PITCH_LIM, PITCH_LIM);
  shotDirection(input.yaw + punch.yaw, viewPitch, spreadRad, shotDir);
  shotOrigin.set(player.position.x, player.position.y + player.eyeHeight, player.position.z);
  shotRay.set(shotOrigin, shotDir);
}

function hitscanTargets() {
  const wallHit = shotRay.intersectObject(mapCollider, false)[0] ?? null;
  const dummyMeshes = dummies.filter(d => !d.dead).flatMap(d => d.meshes);
  const bodyHit = shotRay.intersectObjects(dummyMeshes, false)[0] ?? null;
  if (bodyHit && (!wallHit || bodyHit.distance < wallHit.distance)) return { bodyHit, wallHit: null };
  return { bodyHit: null, wallHit };
}

function applyBodyHit(def, bodyHit) {
  const part = bodyHit.object.userData.part;
  const dummy = bodyHit.object.userData.dummy;
  const dmg = computeDamage(def, bodyHit.distance, part);
  const died = dummy.hit(dmg);
  numberPos.copy(bodyHit.point);
  numberPos.y += 0.25;
  effects.addDamageNumber(numberPos, dmg, part === 'head');
  flashHitmark(part === 'head');
  if (died) audio.playOneOf(['death1', 'death2'], { volume: 0.7 });
  else if (part === 'head' && !def.melee) audio.playOneOf(['headshot1', 'headshot2'], { volume: 0.6 });
  return died;
}

function meleeAttack(def) {
  aimShot(0);
  shotRay.far = def.meleeRange;
  const { bodyHit, wallHit } = hitscanTargets();
  shotRay.far = 400;
  audio.playOneOf(def.sounds.fire, { volume: 0.5 }); // взмах
  if (bodyHit) {
    const died = applyBodyHit(def, bodyHit);
    audio.play(died ? def.sounds.stab : def.sounds.hitFlesh[Math.floor(Math.random() * def.sounds.hitFlesh.length)], { volume: 0.6, delay: 0.04 });
  } else if (wallHit) {
    audio.play(def.sounds.hitWall, { volume: 0.5, delay: 0.04 });
    effects.addDecal(wallHit.point, wallHit.face.normal);
  }
  viewmodel.playShoot({ flash: false });
}

function fireShot(ev) {
  const gun = activeGun();
  const def = gun.def;
  if (def.melee) { meleeAttack(def); return; }

  const hspeed = Math.hypot(player.velocity.x, player.velocity.z);
  const spread = currentSpread(def, { hspeed, onGround: player.onGround, crouching: player.crouching }, ev.burstIdx);
  aimShot(spread);

  const { bodyHit, wallHit } = hitscanTargets();
  let endPoint = null;
  if (bodyHit) {
    applyBodyHit(def, bodyHit);
    endPoint = bodyHit.point;
  } else if (wallHit) {
    effects.addDecal(wallHit.point, wallHit.face.normal);
    endPoint = wallHit.point;
  }

  // Трассер вылетает из дула, а не из центра экрана: смещение дула задано
  // в пространстве камеры оружия (FOV 54) — x/y растягиваем под FOV основной
  // камеры, чтобы точка на экране совпала с видимым стволом, и переводим в мир
  const muzzle = viewmodel.active?.opts.muzzle ?? [0.14, -0.11, -0.5];
  const fovK = Math.tan(camera.fov * 0.5 * D2R) / Math.tan(viewmodel.camera.fov * 0.5 * D2R);
  tracerFrom.set(muzzle[0] * fovK, muzzle[1] * fovK, muzzle[2]).applyMatrix4(camera.matrixWorld);
  effects.addTracer(tracerFrom, endPoint ?? tracerTo.copy(shotOrigin).addScaledVector(shotDir, 120));

  // Отдача CS-стиля: полный «пинок» уходит в punch и НАКАПЛИВАЕТСЯ, пока
  // очередь зажата (затухание во время стрельбы почти нулевое — см. tick).
  // Ствол реально уезжает вверх, компенсация — мышью вниз.
  const [kUp, kSide] = ev.kick;
  punch.pitch = Math.min(punch.pitch + kUp * D2R, MAX_PUNCH_PITCH);
  punch.yaw += kSide * D2R;

  audio.playOneOf(def.sounds.fire, { volume: 0.35, rate: 0.97 + Math.random() * 0.06 });
  viewmodel.playShoot();
  updateAmmoHud();
}

function handleGunEvent(ev) {
  const def = activeGun().def;
  if (ev.type === 'fire') fireShot(ev);
  else if (ev.type === 'dry') audio.play(def.sounds.dry, { volume: 0.5 });
  else if (ev.type === 'reload') {
    viewmodel.playReload(def.reloadTime);
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

// Загрузка не должна молча висеть: любой этап с таймаутом → фолбэк
const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + ms + 'ms')), ms)),
]);

async function init() {
  const mapData = await loadMapData(av('./assets/map-data.json')); // 0.5 КБ, мгновенно
  paintLoadNote();
  const map = await loadMap(
    av('./assets/de_dust2.glb'),
    p => {
      if (p === null) { paintLoadNote(); return; }
      // GH Pages отдаёт gzip: «загружено» считается по распакованным байтам
      // и превышает Content-Length — без клампа прогресс уезжает за 100%
      loadPct = Math.min(100, Math.round(p * 100));
      paintLoadNote();
      barFillEl.style.width = loadPct + '%';
    },
    async () => {
      // сообщение должно УСПЕТЬ отрисоваться до синхронного построения BVH
      loadNoteEl.textContent = 'строим стены…';
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

  // Оружие: все модели ПАРАЛЛЕЛЬНО (время = самый тяжёлый файл, не сумма),
  // с общим прогрессом и таймаутом на каждую — игра стартует в любом случае.
  loadPct = 0;
  paintLoadNote();
  barFillEl.style.width = '0%'; // вторая полоска: оружие
  const wProgress = [0, 0, 0, 0];
  const onWP = i => p => {
    if (p !== null) wProgress[i] = Math.min(1, p);
    loadPct = Math.round(wProgress.reduce((a, b) => a + b, 0) / wProgress.length * 100);
    paintLoadNote();
    barFillEl.style.width = loadPct + '%';
  };
  const WEAPON_TIMEOUT = 60_000;
  const M4_OPTS = { muzzle: [0.14, -0.11, -0.95] };
  const AK_OPTS = { // параметры из исходников fps-threejs-game + разворот к −Z
    position: [0.04, -0.02, 0], rotation: [0, Math.PI, 0], scale: 0.05, muzzle: [0.055, -0.045, -0.42],
  };
  await Promise.all([
    (async () => {
      try { await withTimeout(viewmodel.loadWeapon('m4a1', av('./assets/m4a1.glb'), M4_OPTS, onWP(0)), WEAPON_TIMEOUT); }
      catch { viewmodel.addProcedural('m4a1', buildProceduralPistol(), M4_OPTS); }
      onWP(0)(1);
    })(),
    (async () => {
      try { await withTimeout(viewmodel.loadWeapon('ak47', av('./assets/ak47.glb'), AK_OPTS, onWP(1)), WEAPON_TIMEOUT); }
      catch {
        try { await withTimeout(viewmodel.loadWeapon('ak47', av('./assets/m4a1.glb'), M4_OPTS), WEAPON_TIMEOUT); }
        catch { viewmodel.addProcedural('ak47', buildProceduralPistol(), M4_OPTS); }
      }
      onWP(1)(1);
    })(),
    (async () => {
      try {
        // Poly Pizza «Fps Rig» (J-Toastie): Glock-18 + руки, клипы Armature|Idle/Reload/Shoot
        await withTimeout(viewmodel.loadWeapon('glock', av('./assets/glock.glb'), {
          position: [-0.03, -0.11, -0.03], rotation: [0, 1.62, 0], scale: 0.045,
          muzzle: [0.09, -0.06, -0.45],
        }, onWP(2)), WEAPON_TIMEOUT);
      } catch { viewmodel.addProcedural('glock', buildProceduralPistol(), { muzzle: [0.17, -0.16, -0.5] }); }
      onWP(2)(1);
    })(),
    (async () => {
      try {
        // enari-engine fps_mine_sketch_m9.glb: нож М9 + руки, один таймлайн —
        // границы клипов из fps_mine_sketch_m9.json той же игры (30 fps)
        // удар не нарезаем: в GLB он обрезан на полпути (таймлайн кончается
        // на 10 с из 12.6) — замах делает процедурный swing вьюмодели
        await withTimeout(viewmodel.loadWeapon('knife', av('./assets/knife.glb'), {
          melee: true, position: [-0.05, 0.12, -0.12], rotation: [0, 0, 0], scale: 1,
          subclips: { draw: [0.03, 2.3], idle: [2.35, 2.41] },
          drawDuration: 0.8,
        }, onWP(3)), WEAPON_TIMEOUT);
      } catch { viewmodel.addProcedural('knife', buildProceduralKnife(), { melee: true }); }
      onWP(3)(1);
    })(),
  ]);
  viewmodel.setActive('ak47');
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

  clearInterval(loadTicker);
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
  if (editor.active) { editor.handleKey(code, input); return; }
  const m = /^Digit([1-4])$/.exec(code);
  if (m) switchTo(+m[1]);
};

const IDLE_SNAP = { move: { x: 0, y: 0 }, yaw: 0, jump: false, crouch: false, walk: false, fire: false, reload: false };

let stepAcc = 0;
let wasAirborne = false;

function tick(dt) {
  // без pointer lock (оверлей «ИГРАТЬ» на экране) ввод не игровой —
  // иначе зажатый W уводит персонажа вслепую
  const active = input.pointerLocked || DEBUG || editor.active;
  const snap = active ? input.snapshot() : { ...IDLE_SNAP, yaw: input.yaw };
  const vyBefore = player.velocity.y;
  if (editor.active) {
    editor.update(dt, snap);
  } else if (!gameApi.frozen) {
    player.setCrouch(snap.crouch);
    player.update(dt, snap);
    if (player.fellOut) respawn();
  }

  // шаги: по накопленной дистанции; ходьба (Shift) и присед — бесшумные, как в CS
  if (!editor.active) {
    const hs = Math.hypot(player.velocity.x, player.velocity.z);
    if (player.onGround) {
      if (wasAirborne && vyBefore < -3.5) {
        audio.playOneOf(['step1', 'step2', 'step3', 'step4'], { volume: 0.32 }); // приземление
        stepAcc = 0;
      }
      if (hs > 3.5 && !player.crouching) {
        stepAcc += hs * dt;
        if (stepAcc >= 1.9) {
          stepAcc = 0;
          audio.playOneOf(['step1', 'step2', 'step3', 'step4'], { volume: 0.22 });
        }
      } else stepAcc = 0;
    }
    wasAirborne = !player.onGround;
  }

  // оружие (в редакторе не стреляем; во время доставания — тоже)
  const gun = activeGun();
  deployT -= dt;
  if (deployT <= 0) {
    const ev = gun.update(dt, snap.fire && !editor.active, snap.reload && !editor.active);
    if (ev) handleGunEvent(ev);
  }

  // Затухание view-punch: пока стреляем — почти не возвращается (ствол
  // держится наверху), после отпускания — быстрый возврат (окно удержания
  // 0.12 с задаёт gun.firingRecently; итоговый возврат ≈ 0.35 с как в CS).
  const lambda = gun.firingRecently ? 0.6 : 13;
  punch.pitch = THREE.MathUtils.damp(punch.pitch, 0, lambda, dt);
  punch.yaw = THREE.MathUtils.damp(punch.yaw, 0, lambda, dt);

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
  gun: () => ({ slot: activeSlot, name: activeGun().def.name, ammo: activeGun().ammo, reserve: activeGun().reserve, reloading: activeGun().reloading }),
  switchTo,
  vmAdjust: (id, { position, rotation, scale } = {}) => {
    const w = viewmodel.weapons[id];
    if (!w || !w.group.children[0]) return false;
    const model = w.group.children[0];
    if (position) model.position.fromArray(position);
    if (rotation) model.rotation.set(rotation[0], rotation[1], rotation[2]);
    if (scale) model.scale.setScalar(scale);
    return true;
  },
  vmSubclip: (id, name, t0, t1) => viewmodel.resubclip(id, name, t0, t1),
  vm: viewmodel, // прямой доступ для отладочной примерки моделей
  vmInfo: () => Object.fromEntries(Object.entries(viewmodel.weapons).map(([id, w]) => {
    const b = new THREE.Box3().setFromObject(w.group);
    return [id, { min: b.min.toArray().map(v => +v.toFixed(2)), max: b.max.toArray().map(v => +v.toFixed(2)) }];
  })),
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
  clearInterval(loadTicker); // иначе тикер затирает текст ошибки
  loadNoteEl.textContent = 'ОШИБКА: ' + err.message;
  console.error(err);
});
