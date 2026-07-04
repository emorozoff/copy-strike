import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { startLoop } from './core/loop.js';
import { AudioManager } from './core/audio.js';
import { loadMap, loadMapData } from './world/map.js';
import { PlayerController, MOVE } from './world/movement.js';
import { Input, setupPointerLock } from './player/input.js';
import { PointEditor } from './dev/editor.js';
import { WEAPONS, Gun, currentSpread, shotDirection, computeDamage } from './combat/weapons.js';
import { ViewModel, buildProceduralPistol } from './combat/viewmodel.js';
import { Effects } from './combat/effects.js';
import { Dummy } from './combat/dummy.js';
import { MenuFx } from './ui/fx.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Lobby, makeCode, normalizeCode } from './net/lobby.js';
import { RemotePlayer, buildProcAvatar, buildModelAvatar, pinRootMotion } from './net/remote-player.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

// Версия игры: БАМПИТЬ ПРИ КАЖДОМ ДЕПЛОЕ мелкими шагами (v0.71, v0.72, …);
// v1.0 — готовая игра. Выводится сверху экрана из JS — по номеру видно,
// доехало ли обновление или браузер держит старый кэш
const GAME_VERSION = 'v0.79';

// Версия ассетов: GitHub Pages кэширует на 10 минут (max-age=600) — без
// query-параметра после редеплоя браузер подмешивает старые файлы к новым
const ASSET_V = '7';
const av = url => url + '?v=' + ASSET_V;

const canvas = document.getElementById('c');
const hudEl = document.getElementById('hud');
const ammoEl = document.getElementById('ammo');
const hitmarkEl = document.getElementById('hitmark');
const hintEl = document.getElementById('hint');
const crossEl = document.getElementById('cross');
const editorPanelEl = document.getElementById('editorPanel');
const uiRootEl = document.getElementById('uiRoot');
const loadingEl = document.getElementById('loading');
const menuEl = document.getElementById('menu');
const pauseEl = document.getElementById('pause');
const settingsEl = document.getElementById('settings');
const ldFillEl = document.getElementById('ldFill');
const ldPctEl = document.getElementById('ldPct');
const loadNoteEl = document.getElementById('loadNote');
const hpEl = document.getElementById('hp');
const killfeedEl = document.getElementById('killfeed');
const hurtEl = document.getElementById('hurt');
const deadmsgEl = document.getElementById('deadmsg');

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
  loadNoteEl.textContent = LOAD_QUIPS[quipI] + '…';
  if (loadPct !== null) {
    ldFillEl.style.width = loadPct + '%';
    ldPctEl.textContent = loadPct + '%';
    // подпись процентов едет за краем заливки, у правого края останавливается
    ldPctEl.style.left = `min(calc(${loadPct}% + 12px), calc(100% - 58px))`;
  }
};
const loadTicker = setInterval(() => {
  quipI = (quipI + 1) % LOAD_QUIPS.length;
  paintLoadNote();
}, 1400);

// --- состояния интерфейса: loading → menu → game (+pause/settings поверх) ---
const fx = new MenuFx(document.getElementById('fx'));
fx.start();
let uiState = 'loading';
let settingsReturn = 'menu'; // откуда открыты настройки
const PANELS = {
  loading: loadingEl, menu: menuEl, pause: pauseEl, settings: settingsEl,
  host: document.getElementById('host'), join: document.getElementById('join'),
};

function showUI(state) {
  uiState = state;
  for (const [name, el] of Object.entries(PANELS)) el.classList.toggle('hidden', name !== state);
  const inGame = state === 'game';
  uiRootEl.classList.toggle('hidden', inGame);
  // арт-фон с персонажами — в загрузке, меню и лобби; в паузе за виньеткой живая игра
  uiRootEl.classList.toggle('art',
    state === 'loading' || state === 'menu' || state === 'host' || state === 'join' ||
    (state === 'settings' && settingsReturn === 'menu'));
  for (const el of [hudEl, crossEl, ammoEl, hpEl]) el.classList.toggle('hidden', !inGame);
  if (inGame) fx.stop(); else fx.start();
}

// лёгкий параллакс персонажей за мышью
addEventListener('mousemove', e => {
  uiRootEl.style.setProperty('--pax', (((e.clientX / innerWidth) * 2 - 1) * -10).toFixed(1) + 'px');
  uiRootEl.style.setProperty('--pay', (((e.clientY / innerHeight) * 2 - 1) * -6).toFixed(1) + 'px');
});

// --- настройки: чувствительность и громкость, живут в localStorage ---
const sensRange = document.getElementById('sensRange');
const volRange = document.getElementById('volRange');
const sensOut = document.getElementById('sensOut');
const volOut = document.getElementById('volOut');
const BASE_SENS = 0.0023;

function applySettings(s) {
  input.sensitivity = BASE_SENS * s.sens;
  if (audio.master) audio.master.gain.value = s.vol;
  sensRange.value = s.sens; volRange.value = s.vol;
  sensOut.textContent = '×' + (+s.sens).toFixed(2);
  volOut.textContent = Math.round(s.vol * 100) + '%';
}
function loadSettings() {
  try { return { sens: 1, vol: 0.6, ...JSON.parse(localStorage.getItem('copys-settings') ?? '{}') }; }
  catch { return { sens: 1, vol: 0.6 }; }
}
const settingsState = loadSettings();
const onSettingsInput = () => {
  settingsState.sens = +sensRange.value;
  settingsState.vol = +volRange.value;
  applySettings(settingsState);
  localStorage.setItem('copys-settings', JSON.stringify(settingsState));
};
sensRange.addEventListener('input', onSettingsInput);
volRange.addEventListener('input', onSettingsInput);

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
  'ak_shot', 'ak_boltpull', 'ak_clipin', 'ak_clipout',
  'glock_shot', 'glock_clipin', 'glock_clipout', 'glock_slideback', 'glock_sliderelease',
  'dryfire', 'dryfire_pistol', 'headshot1', 'headshot2', 'death1', 'death2',
  'step1', 'step2', 'step3', 'step4',
]) SOUND_FILES[n] = av(`./assets/sounds/${n}.wav`);
audio.loadAll(SOUND_FILES);

const input = new Input();
const editor = new PointEditor(scene, editorPanelEl);
applySettings(settingsState);

let deployPlayed = false;
const lock = setupPointerLock(canvas, input, {
  onLock: () => {
    showUI('game');
    if (!deployPlayed) {
      deployPlayed = true;
      const d = guns[activeSlot].def.sounds.deploy;
      if (d) audio.play(d, { volume: 0.5 });
    }
  },
  // Esc в игре снимает pointer lock — показываем паузу (в дебаге не мешаем тестам)
  onUnlock: () => { if (!DEBUG && uiState === 'game' && !editor.active) showUI('pause'); },
});

document.getElementById('btnTrain').addEventListener('click', () => {
  audio.init();
  showUI('game');
  lock.request();
});
document.getElementById('btnResume').addEventListener('click', () => {
  // повторный захват мыши браузер разрешает через ~1.3 с после Esc —
  // ранний клик просто ничего не сделает, второй клик сработает
  audio.init();
  lock.request();
});
document.getElementById('btnToMenu').addEventListener('click', () => showUI('menu'));

// --- сетевое лобби (фаза 2, шаг «лобби»): комната по коду, старт у хоста ---
const lobby = new Lobby();
const roomCodeEl = document.getElementById('roomCode');
const hostStatusEl = document.getElementById('hostStatus');
const joinStatusEl = document.getElementById('joinStatus');
const joinCodeEl = document.getElementById('joinCode');
const btnStartMatch = document.getElementById('btnStartMatch');
const startSoonEl = document.getElementById('startSoon');
const copyLblEl = document.getElementById('copyLbl');

function setNetStatus(el, text, cls) {
  el.textContent = text;
  el.className = 'netStatus' + (cls ? ' ' + cls : '');
}

function startNetGame() {
  audio.init();
  ensureRemote();
  showUI('game');
  lock.request(); // у гостя может не сработать без жеста — есть клик по канвасу ниже
}

// --- соперник на карте (шаг 8): снапшоты 20 Гц + интерполяция «на 100 мс назад» ---
let charGltf = null;          // общая GLB-модель бойца (клонируется под каждого)
let CHAR_YAW = Math.PI;       // разворот модели лицом к −Z (калибровка скриншотом)
let CHAR_SCALE = 1.15;        // масштаб модели Quaternius Soldier под рост ~1.8 м (хитбоксы)
let CHAR_YOFF = 0;            // сдвиг ног к y=0
let net = null;               // { remote: RemotePlayer, solo?: bool }
const NET_SEND_EVERY = 3;     // 60 Гц / 3 = 20 снапшотов/с

function makeAvatar(teamColor) {
  return charGltf
    ? buildModelAvatar(charGltf, { scale: CHAR_SCALE, yOffset: CHAR_YOFF, yawOffset: CHAR_YAW, ring: teamColor })
    : buildProcAvatar(teamColor);
}

function ensureRemote() {
  if (net || !lobby.connected) return;
  // цвет = команда СОПЕРНИКА: хост это CT (синий), гость — T (песочный)
  const teamColor = lobby.isHost ? 0xc9a24a : 0x5b8fd6;
  net = { remote: new RemotePlayer(scene, makeAvatar(teamColor)) };
  frags = 0; deaths = 0;
  resetCombat();
}

function teardownNet() {
  if (net) { net.remote.dispose(); net = null; }
  clearCorpses();
  hurtEl.classList.remove('show');
  killfeedEl.replaceChildren();
  updateHpHud();
}

function sendNetSnapshot() {
  const p = player.position;
  const hs = Math.hypot(player.velocity.x, player.velocity.z);
  let flags = 0;
  if (hs > 1.2) flags |= 1;            // движется → анимация бега
  if (player.crouching) flags |= 2;
  if (player.onGround) flags |= 4;
  lobby.sendSnap([
    +p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3),
    +input.yaw.toFixed(4), +input.pitch.toFixed(4), flags,
  ]);
}

// --- HP, урон, режим 1-на-1: мгновенный респавн вне видимости (шаг 9) ---
const HP_MAX = 100;
let hp = HP_MAX;
let frags = 0, deaths = 0;
let invulnUntil = 0;         // после респавна кратко игнорируем добивание очередью
let hurtTimer = null;

function updateHpHud() {
  hpEl.classList.toggle('low', hp <= 25);
  hpEl.innerHTML = `<span>♥</span> <b>${Math.max(0, Math.round(hp))}</b>`;
}

function showHurt() {
  hurtEl.classList.add('show');
  clearTimeout(hurtTimer);
  hurtTimer = setTimeout(() => hurtEl.classList.remove('show'), 150);
}

function addKill(text) {
  const line = document.createElement('div');
  line.textContent = text;
  killfeedEl.appendChild(line);
  setTimeout(() => line.remove(), 4500);
  while (killfeedEl.children.length > 4) killfeedEl.firstChild.remove();
}

function resetCombat() {
  hp = HP_MAX; invulnUntil = 0;
  hurtEl.classList.remove('show');
  killfeedEl.replaceChildren();
  updateHpHud();
}

// команда соперника/жертвы (у обоих одна модель, различаем кольцом)
function foeColor() { return lobby.isHost ? 0xc9a24a : 0x5b8fd6; }

// Пул точек дефматч-респавна: сетка по карте, где помещается стоячая капсула.
let dmSpawns = [];
function buildDmSpawnPool() {
  dmSpawns = [];
  const min = mapBounds.min, max = mapBounds.max;
  for (let x = min.x + 4; x <= max.x - 4; x += 6) {
    for (let z = min.z + 4; z <= max.z - 4; z += 6) {
      const y = findFloor(player.collider, x, z, max.y + 5);
      if (y === null) continue;
      if (player.fitsAt(x, y + 0.1, z)) dmSpawns.push([x, y + 0.1, z]);
    }
  }
}

// Выбор точки респавна: недалеко (14–45 м), но ВНЕ прямой видимости убийцы.
const losRay = new THREE.Ray();
const eyeA = new THREE.Vector3(), eyeB = new THREE.Vector3(), losDir = new THREE.Vector3();
function pickRespawn(killer) {
  if (!dmSpawns.length) { respawn(); return; }
  const EYE = 1.6;
  let best = null, bestScore = -Infinity;
  for (const s of dmSpawns) {
    const d = killer ? Math.hypot(s[0] - killer.x, s[2] - killer.z) : 30;
    let visible = true;
    if (killer) {
      eyeA.set(killer.x, killer.y + EYE, killer.z);
      eyeB.set(s[0], s[1] + EYE, s[2]);
      losDir.copy(eyeB).sub(eyeA);
      const len = losDir.length(); losDir.normalize();
      losRay.origin.copy(eyeA); losRay.direction.copy(losDir);
      const hit = mapCollider.geometry.boundsTree.raycastFirst(losRay, THREE.DoubleSide);
      visible = !(hit && hit.distance < len - 0.5); // стена ближе цели → невидим
    }
    // хотим: невидим + дистанция в вилке; со случайной добавкой для разнообразия
    let score = Math.random() * 3;
    if (!visible) score += 100;
    if (d >= 14 && d <= 45) score += 40;
    else if (d < 14) score -= 60;             // слишком близко — плохо
    if (best === null || score > bestScore) { best = s; bestScore = score; }
  }
  player.teleport(best[0], best[1], best[2]);
  input.pitch = 0;
  if (killer) input.yaw = Math.atan2(best[0] - killer.x, best[2] - killer.z); // лицом к бывшему убийце
}

// «Труп» у убийцы: временный клон модели с анимацией смерти на месте гибели.
const corpses = [];
function spawnCorpse(info) {
  if (!info || !charGltf) return;
  const avatar = buildModelAvatar(charGltf, { scale: CHAR_SCALE, yOffset: CHAR_YOFF, yawOffset: CHAR_YAW, ring: foeColor() });
  avatar.group.position.set(info.x, info.y, info.z);
  avatar.group.rotation.y = (info.yaw ?? 0) + CHAR_YAW;
  scene.add(avatar.group);
  corpses.push({ avatar, t: 0 });
}
function updateCorpses(dt) {
  for (let i = corpses.length - 1; i >= 0; i--) {
    const c = corpses[i];
    c.t += dt;
    c.avatar.update(dt, { dead: true, moving: false, crouching: false });
    if (c.t > 3) { c.avatar.group.position.y -= dt * 0.6; }   // после 3 с уходит в пол
    if (c.t > 4) { scene.remove(c.avatar.group); c.avatar.dispose(); corpses.splice(i, 1); }
  }
}
function clearCorpses() {
  for (const c of corpses) { scene.remove(c.avatar.group); c.avatar.dispose(); }
  corpses.length = 0;
}

function localDie() {
  deaths++;
  // место смерти → убийце для «трупа»; шлём ДО телепорта
  const p = player.position;
  lobby.sendDead({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), yaw: +input.yaw.toFixed(3) });
  audio.playOneOf(['death1', 'death2'], { volume: 0.55 });
  showHurt();
  // мгновенный респавн вне видимости бывшего убийцы (соперник = net.remote)
  const kp = net?.remote ? net.remote.avatar.group.position : null;
  hp = HP_MAX;
  pickRespawn(kp ? { x: kp.x, y: kp.y, z: kp.z } : null);
  invulnUntil = performance.now() + 800; // не даём добить пулями «вдогонку»
  updateHpHud();
}

document.getElementById('btnHost').addEventListener('click', () => {
  const code = makeCode();
  roomCodeEl.textContent = code;
  setNetStatus(hostStatusEl, 'ждём друга… передай ему код');
  btnStartMatch.classList.add('off');
  startSoonEl.classList.remove('hidden');
  showUI('host');
  lobby.join(code, true);
});

document.getElementById('btnJoin').addEventListener('click', () => {
  joinCodeEl.value = '';
  setNetStatus(joinStatusEl, ' ');
  showUI('join');
  setTimeout(() => joinCodeEl.focus(), 50);
});

joinCodeEl.addEventListener('input', () => { joinCodeEl.value = normalizeCode(joinCodeEl.value); });
joinCodeEl.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btnJoinGo').click(); });

document.getElementById('btnJoinGo').addEventListener('click', () => {
  const code = normalizeCode(joinCodeEl.value);
  if (code.length < 5) { setNetStatus(joinStatusEl, 'код — 5 символов', 'bad'); return; }
  setNetStatus(joinStatusEl, 'ищем комнату…');
  lobby.join(code, false);
});

document.getElementById('btnCopyCode').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lobby.code ?? '');
    copyLblEl.textContent = 'СКОПИРОВАНО ✓';
    setTimeout(() => { copyLblEl.textContent = 'СКОПИРОВАТЬ КОД'; }, 1500);
  } catch { /* буфер обмена недоступен без https/жеста — код можно выделить мышью */ }
});

btnStartMatch.addEventListener('click', () => {
  if (!lobby.connected) return;
  lobby.sendStart();
  startNetGame();
});

const leaveLobby = () => { lobby.leave(); teardownNet(); showUI('menu'); };
document.getElementById('btnHostBack').addEventListener('click', leaveLobby);
document.getElementById('btnJoinBack').addEventListener('click', leaveLobby);

lobby.onPeer = connected => {
  if (lobby.isHost) {
    if (connected) {
      setNetStatus(hostStatusEl, 'ИГРОК ПОДКЛЮЧИЛСЯ ✓', 'ok');
      btnStartMatch.classList.remove('off');
      startSoonEl.classList.add('hidden');
    } else {
      setNetStatus(hostStatusEl, 'игрок отключился — ждём снова…', 'bad');
      btnStartMatch.classList.add('off');
      startSoonEl.classList.remove('hidden');
    }
  } else {
    if (connected) setNetStatus(joinStatusEl, 'ПОДКЛЮЧЕНО ✓ — ждём, когда хост начнёт', 'ok');
    else setNetStatus(joinStatusEl, 'соединение потеряно', 'bad');
  }
  if (!connected) net?.remote.hide(); // соперник ушёл — прячем его модель
};
lobby.onStart = () => startNetGame();
lobby.onSnap = data => { net?.remote.push(data, performance.now()); };
lobby.onHit = msg => {                      // соперник попал в нас
  if (!net || !msg || typeof msg.dmg !== 'number') return;
  if (performance.now() < invulnUntil) return; // кратко неуязвимы сразу после респавна
  hp -= msg.dmg;
  showHurt();
  if (hp <= 0) localDie(); else updateHpHud();
};
lobby.onDead = info => {                     // соперник подтвердил, что мы его убили
  frags++;
  addKill('соперник повержен ✓');
  spawnCorpse(info);                         // «труп» на месте гибели
};

// возврат мыши кликом по канвасу (в т.ч. у гостя после автостарта матча)
canvas.addEventListener('click', () => {
  if (uiState === 'game' && !input.pointerLocked) { audio.init(); lock.request(); }
});
document.getElementById('btnSettings').addEventListener('click', () => { settingsReturn = 'menu'; showUI('settings'); });
document.getElementById('btnPauseSettings').addEventListener('click', () => { settingsReturn = 'pause'; showUI('settings'); });
document.getElementById('btnBack').addEventListener('click', () => showUI(settingsReturn));
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' && uiState === 'settings') showUI(settingsReturn);
});

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
// арсенал: 1 — AK-47, 2 — Glock. Нож и M4 убраны (решение игрока 2026-07-04);
// M4/USP вернутся с магазином в фазе 4
const guns = {
  1: new Gun(WEAPONS.ak47),
  2: new Gun(WEAPONS.glock),
};
const SLOT_ORDER = [1, 2];
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
  const bodyMeshes = dummies.filter(d => !d.dead).flatMap(d => d.meshes);
  // хитбоксы сетевого соперника (по его интерполированной позиции — «бьёшь что видишь»)
  if (net && net.remote.canBeHit) bodyMeshes.push(...net.remote.hitboxes);
  const bodyHit = shotRay.intersectObjects(bodyMeshes, false)[0] ?? null;
  if (bodyHit && (!wallHit || bodyHit.distance < wallHit.distance)) return { bodyHit, wallHit: null };
  return { bodyHit: null, wallHit };
}

function applyBodyHit(def, bodyHit) {
  const part = bodyHit.object.userData.part;
  const dmg = computeDamage(def, bodyHit.distance, part);
  numberPos.copy(bodyHit.point);
  numberPos.y += 0.25;
  effects.addDamageNumber(numberPos, dmg, part === 'head');
  flashHitmark(part === 'head');

  if (bodyHit.object.userData.remote) {
    // сетевой игрок: урон применит он у себя, смерть определит и пришлёт 'dead'
    lobby.sendHit({ dmg, part });
    if (part === 'head' && !def.melee) audio.playOneOf(['headshot1', 'headshot2'], { volume: 0.6 });
    return false;
  }

  const dummy = bodyHit.object.userData.dummy;
  const died = dummy.hit(dmg);
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
  if (bodyHit) {
    applyBodyHit(def, bodyHit);
  } else if (wallHit) {
    effects.addDecal(wallHit.point, wallHit.face.normal);
  }
  // Трассер убран по фидбеку игрока (2026-07-04) — остаётся вспышка у ствола,
  // декали, числа урона, звук.

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
    },
    async () => {
      // сообщение должно УСПЕТЬ отрисоваться до синхронного построения BVH
      loadPct = 100;
      paintLoadNote();
      loadNoteEl.textContent = 'строим стены…';
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
  buildDmSpawnPool(); // точки для мгновенного респавна в режиме 1-на-1

  // Оружие: все модели ПАРАЛЛЕЛЬНО (время = самый тяжёлый файл, не сумма),
  // с общим прогрессом и таймаутом на каждую — игра стартует в любом случае.
  loadPct = 0; // вторая полоска: оружие
  paintLoadNote();
  const wProgress = [0, 0];
  const onWP = i => p => {
    if (p !== null) wProgress[i] = Math.min(1, p);
    loadPct = Math.round(wProgress.reduce((a, b) => a + b, 0) / wProgress.length * 100);
    paintLoadNote();
  };
  const WEAPON_TIMEOUT = 60_000;
  const AK_OPTS = { // параметры из исходников fps-threejs-game + разворот к −Z
    position: [0.04, -0.02, 0], rotation: [0, Math.PI, 0], scale: 0.05, muzzle: [0.055, -0.045, -0.42],
  };
  await Promise.all([
    (async () => {
      try { await withTimeout(viewmodel.loadWeapon('ak47', av('./assets/ak47.glb'), AK_OPTS, onWP(0)), WEAPON_TIMEOUT); }
      catch { viewmodel.addProcedural('ak47', buildProceduralPistol(), AK_OPTS); }
      onWP(0)(1);
    })(),
    (async () => {
      try {
        // Poly Pizza «Fps Rig» (J-Toastie): Glock-18 + руки, клипы Armature|Idle/Reload/Shoot
        await withTimeout(viewmodel.loadWeapon('glock', av('./assets/glock.glb'), {
          position: [-0.03, -0.2, -0.28], rotation: [0, 1.62, 0], scale: 0.06,
          muzzle: [0.17, -0.04, -0.6],
        }, onWP(1)), WEAPON_TIMEOUT);
      } catch { viewmodel.addProcedural('glock', buildProceduralPistol(), { muzzle: [0.17, -0.16, -0.5] }); }
      onWP(1)(1);
    })(),
  ]);
  viewmodel.setActive('ak47');

  // модель бойца для соперника по сети (шаг 8): Quaternius «Character Animated»,
  // CC0, клипы Idle/Run/Walk/Death. Не критично — при сбое соперник будет
  // процедурным «человечком» (buildProcAvatar).
  try {
    const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    charGltf = await withTimeout(new Promise((res, rej) =>
      gltfLoader.load(av('./assets/player.glb'), res, undefined, rej)), 20_000);
    if (charGltf) pinRootMotion(charGltf.animations); // убрать съезжание модели при беге/смерти
  } catch { charGltf = null; }

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
  updateHpHud();

  clearInterval(loadTicker);
  // в дебаге (headless-тесты) меню пропускаем — сразу в игру; ?menu вернёт меню
  if (DEBUG && !params.has('menu')) showUI('game');
  else showUI('menu');

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
  const m = /^Digit([1-2])$/.exec(code);
  if (m) switchTo(+m[1]);
};

const IDLE_SNAP = { move: { x: 0, y: 0 }, yaw: 0, jump: false, crouch: false, walk: false, fire: false, reload: false };

let stepAcc = 0;
let wasAirborne = false;

function tick(dt, tickNo) {
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

  // сеть: свой снапшот 20 раз/с — соперник у друга интерполирует его на 100 мс назад
  if (net && !net.solo && lobby.connected && player && tickNo % NET_SEND_EVERY === 0) sendNetSnapshot();
}

let hudTimer = 0;
let crossGap = 4; // текущий раствор прицела, px (сглаживается к цели)
let menuT = Math.random() * 200; // фаза облёта карты в меню
const camPos = new THREE.Vector3();
function render(delta, fps, alpha) {
  // в меню и настройках-из-меню камера медленно облетает карту;
  // в паузе (и настройках из паузы) остаётся вид игрока за виньеткой
  const worldView = uiState === 'game' || uiState === 'pause' ||
    (uiState === 'settings' && settingsReturn === 'pause');

  if (!worldView && !editor.active) {
    menuT += delta;
    const yaw = menuT * 0.045;
    camera.position.set(Math.sin(yaw) * 58, 48, Math.cos(yaw) * 58);
    camera.lookAt(0, -2, 0);
  } else if (editor.active) {
    camera.position.copy(editor.position);
    camera.rotation.set(
      THREE.MathUtils.clamp(input.pitch + punch.pitch, -PITCH_LIM, PITCH_LIM),
      input.yaw + punch.yaw, 0
    );
  } else {
    // интерполяция между тиками: позиция прошлого тика → текущего
    camPos.copy(player.prevPosition).lerp(player.position, Math.min(alpha, 1));
    camera.position.set(camPos.x, camPos.y + player.eyeHeight, camPos.z);
    // композитный pitch клампим: punch при стрельбе строго вверх мог перекинуть
    // камеру за зенит (переворот мира)
    camera.rotation.set(
      THREE.MathUtils.clamp(input.pitch + punch.pitch, -PITCH_LIM, PITCH_LIM),
      input.yaw + punch.yaw, 0
    );
  }

  // динамический прицел: штрихи расходятся по текущему разбросу
  // (бег/воздух/присед/очередь), перевод радиан в пиксели через FOV камеры
  if (uiState === 'game' && player) {
    const gun = activeGun();
    const hspeed = Math.hypot(player.velocity.x, player.velocity.z);
    const spread = currentSpread(gun.def, { hspeed, onGround: player.onGround, crouching: player.crouching },
      gun.firingRecently ? gun.burstIdx : 0);
    const px = spread * (innerHeight / 2) / Math.tan(camera.fov / 2 * D2R);
    crossGap = THREE.MathUtils.damp(crossGap, Math.min(60, 4 + px), 18, delta);
    crossEl.style.setProperty('--gap', crossGap.toFixed(1) + 'px');
  }

  hudTimer += delta;
  if (hudTimer > 0.25) {
    hudTimer = 0;
    const p = editor.active ? editor.position : player.position;
    const hspeed = Math.hypot(player.velocity.x, player.velocity.z);
    hudEl.textContent =
      `fps ${fps}\n` +
      `поз ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
      `скор ${hspeed.toFixed(1)} м/с${player.onGround ? ' · земля' : ''}${player.crouching ? ' · присед' : ''}` +
      (lobby.connected ? `\nпинг ${lobby.rtt ?? '…'} мс` : '') +
      (net ? `\nфраги ${frags} · смерти ${deaths}` : '') +
      (editor.active ? '\n[РЕДАКТОР]' : '');
  }

  // соперник интерполируется по времени приёма снапшотов (реальные мс, не тики)
  if (net) net.remote.update(delta, performance.now());
  if (corpses.length) updateCorpses(delta);

  renderer.clear();
  renderer.render(scene, camera);
  if (viewmodel.ready && !editor.active && worldView) {
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
  // сеть/соперник — для headless-калибровки модели без второй вкладки
  charLoaded: () => !!charGltf,
  netInfo: () => net ? {
    solo: !!net.solo, buffered: net.remote.buffer.length,
    yawOffset: +net.remote.yawOffset.toFixed(3),
    visible: net.remote.avatar.group.visible,
    pos: net.remote.avatar.group.position.toArray().map(v => +v.toFixed(2)),
  } : null,
  spawnRemote: color => {
    if (net) return false;
    net = { remote: new RemotePlayer(scene, makeAvatar(color ?? 0x5b8fd6)), solo: true };
    return true;
  },
  pushRemote: arr => { net?.remote.push(arr, performance.now()); },
  killRemote: () => teardownNet(),
  hbShow: on => { if (net) net.remote._hbMat.visible = on; },
  combat: () => ({ hp, frags, deaths, invuln: performance.now() < invulnUntil, corpses: corpses.length, pool: dmSpawns.length }),
  remoteTop: () => {
    if (!net) return null;
    const g = net.remote.avatar.group;
    g.updateWorldMatrix(true, true);
    let maxY = -Infinity, minY = Infinity;
    g.traverse(o => {
      if (o.isBone) { const y = o.matrixWorld.elements[13]; if (y > maxY) maxY = y; if (y < minY) minY = y; }
    });
    return { headBone: +(maxY - g.position.y).toFixed(3), footBone: +(minY - g.position.y).toFixed(3) };
  },
  testShot: () => {
    aimShot(0);
    const { bodyHit, wallHit } = hitscanTargets();
    return {
      body: bodyHit ? { part: bodyHit.object.userData.part, remote: !!bodyHit.object.userData.remote, dist: +bodyHit.distance.toFixed(2) } : null,
      wall: wallHit ? +wallHit.distance.toFixed(2) : null,
      canBeHit: net ? net.remote.canBeHit : null,
      hbCount: net ? net.remote.hitboxes.length : 0,
    };
  },
  canSee: (ax, ay, az, bx, by, bz) => {
    if (!mapCollider) return null;
    const o = new THREE.Vector3(ax, ay, az), t = new THREE.Vector3(bx, by, bz);
    const dir = t.clone().sub(o); const len = dir.length(); dir.normalize();
    const hit = mapCollider.geometry.boundsTree.raycastFirst(new THREE.Ray(o, dir), THREE.DoubleSide);
    return !(hit && hit.distance < len - 0.5);
  },
  hurtSelf: (dmg, part) => lobby.onHit?.({ dmg, part }),
  setCharYaw: deg => { CHAR_YAW = deg * Math.PI / 180; if (net) net.remote.yawOffset = CHAR_YAW; },
  setCharFit: (scale, yOff) => {
    if (scale != null) CHAR_SCALE = scale;
    if (yOff != null) CHAR_YOFF = yOff;
    if (net) {
      const root = net.remote.avatar.group.children[0];
      if (root) { root.scale.setScalar(CHAR_SCALE); root.position.y = CHAR_YOFF; }
    }
  },
  remoteBounds: () => {
    if (!net) return null;
    const g = net.remote.avatar.group;
    const b = new THREE.Box3().setFromObject(g);
    if (b.isEmpty()) return { empty: true, children: g.children.length };
    return {
      min: b.min.toArray().map(v => +v.toFixed(2)), max: b.max.toArray().map(v => +v.toFixed(2)),
      size: b.getSize(new THREE.Vector3()).toArray().map(v => +v.toFixed(2)),
      children: g.children.length,
    };
  },
};
window.__game = gameApi;

init().catch(err => {
  clearInterval(loadTicker); // иначе тикер затирает текст ошибки
  loadNoteEl.textContent = 'ОШИБКА: ' + err.message;
  console.error(err);
});
