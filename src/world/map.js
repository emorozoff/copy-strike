import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

// карта сжата EXT_meshopt_compression — декодер обязателен
const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

// GoldSrc: 1 юнит = 1 дюйм. Карта в оригинальных юнитах CS 1.6 → метры.
export const UNIT = 0.0254;

// Сырая геометрия GLB — в юнитах GoldSrc (bbox 4480×608×5312), но Sketchfab-экспорт
// добавляет корневому узлу свой нормализующий масштаб. Поэтому масштабируем не
// константой, а по фактическому bbox к известному размеру: 5312 юнитов ≈ 134.9 м.
const DUST2_LONGEST_METERS = 5312 * UNIT;

export async function loadMap(url, onProgress, onBeforeCollider, extraColliders = []) {
  const gltf = await new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      resolve,
      e => { if (onProgress) onProgress(e.lengthComputable ? e.loaded / e.total : null); },
      reject
    );
  });

  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(scene);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const scale = DUST2_LONGEST_METERS / Math.max(rawSize.x, rawSize.y, rawSize.z);
  scene.scale.multiplyScalar(scale);
  scene.updateMatrixWorld(true);

  // Центрируем: GoldSrc-карты лежат далеко от нуля (тысячи метров) — это портит
  // точность float32 и даёт неудобные координаты в map-data.json.
  const scaledBox = new THREE.Box3().setFromObject(scene);
  const center = scaledBox.getCenter(new THREE.Vector3());
  scene.position.x -= center.x;
  scene.position.y -= scaledBox.min.y;
  scene.position.z -= center.z;
  scene.updateMatrixWorld(true);

  scene.traverse(obj => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      // Sketchfab-экспорт может выставить metalness — на ретро-текстурах это даёт черноту
      if ('metalness' in m) m.metalness = 0;
      if ('roughness' in m) m.roughness = 1;
      if (m.map) m.map.anisotropy = 8;
    }
  });

  // Пауза перед тяжёлой синхронной работой (merge + BVH) — чтобы UI успел
  // отрисовать «построение коллизий…» до фриза главного потока.
  if (onBeforeCollider) await onBeforeCollider();

  // Единый статичный коллайдер: вся геометрия в мировых координатах (метрах),
  // только позиции — одна BVH обслуживает движение, hitscan и всё остальное.
  const geoms = [];
  scene.traverse(obj => {
    if (!obj.isMesh) return;
    let g = obj.geometry.clone();
    g.applyMatrix4(obj.matrixWorld);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position') g.deleteAttribute(name);
    }
    if (g.index) g = g.toNonIndexed();
    geoms.push(g);
  });

  // Невидимые коллайдеры из map-data.json: у GLB нет playerclip-браней
  // оригинала, дыры в пустоту запечатываем AABB-боксами (только коллизии,
  // в рендер не попадают — collider-меш невидим).
  for (const c of extraColliders) {
    const sx = c.max[0] - c.min[0], sy = c.max[1] - c.min[1], sz = c.max[2] - c.min[2];
    let g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(c.min[0] + sx / 2, c.min[1] + sy / 2, c.min[2] + sz / 2);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position') g.deleteAttribute(name);
    }
    g = g.toNonIndexed();
    geoms.push(g);
  }

  const merged = mergeGeometries(geoms, false);
  merged.boundsTree = new MeshBVH(merged);
  // DoubleSide обязателен: у декомпилированной карты обмотка треугольников
  // ненадёжна, а raycast (пули) уважает material.side — иначе «изнаночные»
  // стены останавливают игрока, но простреливаются насквозь
  const collider = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ wireframe: true, side: THREE.DoubleSide }));
  collider.visible = false;

  const bounds = new THREE.Box3().setFromObject(scene);
  return { scene, collider, bounds };
}

export async function loadMapData(url) {
  try {
    // no-cache: GitHub Pages отдаёт max-age=600 — после редеплоя разметки
    // свежие спавны иначе приедут только через 10 минут
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
