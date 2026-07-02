import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { startLoop } from './core/loop.js';
import { loadMap, loadMapData } from './world/map.js';
import { PlayerController, MOVE } from './world/movement.js';
import { Input, setupPointerLock } from './player/input.js';
import { PointEditor } from './dev/editor.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const canvas = document.getElementById('c');
const hudEl = document.getElementById('hud');
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
});

const input = new Input();
const editor = new PointEditor(scene, editorPanelEl);

const lock = setupPointerLock(canvas, input, {
  onLock: () => clickToPlayEl.classList.add('hidden'),
  onUnlock: () => { if (!DEBUG) clickToPlayEl.classList.remove('hidden'); },
});
playBtn.addEventListener('click', () => lock.request());

window.addEventListener('wheel', e => { if (editor.active) editor.changeSpeed(e.deltaY); });

let player = null;
let mapBounds = null;
let spawns = { t: [], ct: [] };
const downRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));

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
  if (mapData && mapData.spawns) spawns = mapData.spawns;

  player = new PlayerController(map.collider);
  player.killY = mapBounds.min.y - 5;
  respawn();

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

const IDLE_SNAP = { move: { x: 0, y: 0 }, yaw: 0, jump: false, crouch: false, walk: false };

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
  camera.rotation.set(input.pitch, input.yaw, 0);

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

  renderer.render(scene, camera);
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
};
window.__game = gameApi;

init().catch(err => {
  loadNoteEl.textContent = 'ОШИБКА: ' + err.message;
  console.error(err);
});
