import * as THREE from 'three';

// Константы из CS 1.6 (юниты × 0.0254 → метры). Движение в v1 упрощённое:
// на земле скорость задаётся напрямую, в воздухе — ограниченный доворот.
// GoldSrc air-strafe/распрыжка — осознанно отложены (фаза 5).
export const MOVE = {
  runSpeed: 6.35,        // 250 u/s
  walkMult: 0.52,
  crouchMult: 0.34,
  airAccel: 18,          // м/с², доворот к желаемой скорости в воздухе
  gravity: 20.3,         // 800 u/s²
  jumpSpeed: 6.8,
  radius: 0.40,
  standHeight: 1.83,     // 72 юнита
  crouchHeight: 1.37,
  standEye: 1.63,        // 64 юнита
  crouchEye: 1.17,
  eyeLerp: 12,           // 1/с, плавность смены высоты глаз
  physicsSubsteps: 5,
  groundNormalY: 0.69,   // cos(~46°) — предел проходимого уклона (CS ≈ 45.6°)
  snapDistance: 0.15,    // прилипание к полу на спусках/ступенях, м за подшаг
  stepHeight: 0.46,      // автозабег на ступени до 18 юнитов (CS), без прыжка
};

const tmpMat = new THREE.Matrix4();
const tmpSeg = new THREE.Line3();
const tmpBox = new THREE.Box3();
const triPoint = new THREE.Vector3();
const capPoint = new THREE.Vector3();
const tmpDelta = new THREE.Vector3();
const scratch = new THREE.Vector3();
const tmpRay = new THREE.Ray();
const DOWN = new THREE.Vector3(0, -1, 0);
const savePos = new THREE.Vector3();
const saveVel = new THREE.Vector3();

export class PlayerController {
  constructor(collider) {
    this.collider = collider;       // THREE.Mesh с geometry.boundsTree (MeshBVH)
    this.position = new THREE.Vector3(); // ноги
    this.prevPosition = new THREE.Vector3(); // позиция прошлого тика — для интерполяции рендера
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.crouching = false;
    this.height = MOVE.standHeight;
    this.eyeHeight = MOVE.standEye;
    this.killY = -Infinity;         // ниже — респавн (выпал из карты)
    this.fellOut = false;
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.prevPosition.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.fellOut = false;
  }

  setCrouch(want) {
    if (want && !this.crouching) {
      this.crouching = true;
      this.height = MOVE.crouchHeight;
    } else if (!want && this.crouching && this.canStand()) {
      this.crouching = false;
      this.height = MOVE.standHeight;
    }
  }

  canStand() {
    // Хватает ли места встать: тест ОБЪЁМА стоячей капсулы (тонкий луч по оси
    // пропускает козырьки/балки, смещённые от оси до radius, — и игрок встаёт
    // внутрь геометрии).
    const M = MOVE;
    tmpSeg.start.copy(this.position); tmpSeg.start.y += M.radius + 0.02;
    tmpSeg.end.copy(this.position);   tmpSeg.end.y += M.standHeight - M.radius;
    tmpMat.copy(this.collider.matrixWorld).invert();
    tmpSeg.start.applyMatrix4(tmpMat);
    tmpSeg.end.applyMatrix4(tmpMat);
    tmpBox.makeEmpty();
    tmpBox.expandByPoint(tmpSeg.start);
    tmpBox.expandByPoint(tmpSeg.end);
    tmpBox.min.addScalar(-M.radius);
    tmpBox.max.addScalar(M.radius);
    let blocked = false;
    this.collider.geometry.boundsTree.shapecast({
      intersectsBounds: box => box.intersectsBox(tmpBox),
      intersectsTriangle: tri => {
        // порог чуть меньше радиуса: лёгкое касание пола (прижим гравитации)
        // не должно блокировать вставание
        if (tri.closestPointToSegment(tmpSeg, triPoint, capPoint) < M.radius - 0.01) {
          blocked = true;
          return true; // прервать обход BVH
        }
        return false;
      },
    });
    return !blocked;
  }

  // Помещается ли стоячая капсула ногами в точке (x,y,z) — для отбора точек
  // респавна (тот же shapecast, что и canStand, но в произвольном месте).
  fitsAt(x, y, z) {
    const M = MOVE;
    tmpSeg.start.set(x, y + M.radius + 0.02, z);
    tmpSeg.end.set(x, y + M.standHeight - M.radius, z);
    tmpMat.copy(this.collider.matrixWorld).invert();
    tmpSeg.start.applyMatrix4(tmpMat);
    tmpSeg.end.applyMatrix4(tmpMat);
    tmpBox.makeEmpty();
    tmpBox.expandByPoint(tmpSeg.start);
    tmpBox.expandByPoint(tmpSeg.end);
    tmpBox.min.addScalar(-M.radius);
    tmpBox.max.addScalar(M.radius);
    let blocked = false;
    this.collider.geometry.boundsTree.shapecast({
      intersectsBounds: box => box.intersectsBox(tmpBox),
      intersectsTriangle: tri => {
        if (tri.closestPointToSegment(tmpSeg, triPoint, capPoint) < M.radius - 0.01) { blocked = true; return true; }
        return false;
      },
    });
    return !blocked;
  }

  update(dt, input) {
    this.prevPosition.copy(this.position);
    const sub = dt / MOVE.physicsSubsteps;
    for (let i = 0; i < MOVE.physicsSubsteps; i++) this.step(sub, input);
    const targetEye = this.crouching ? MOVE.crouchEye : MOVE.standEye;
    this.eyeHeight = THREE.MathUtils.damp(this.eyeHeight, targetEye, MOVE.eyeLerp, dt);
    if (this.position.y < this.killY) this.fellOut = true;
  }

  step(dt, input) {
    const M = MOVE;

    // Гравитация: на земле — лёгкий прижим, в воздухе — полная.
    if (this.onGround) this.velocity.y = -M.gravity * dt;
    else this.velocity.y -= M.gravity * dt;

    // Желаемая горизонтальная скорость относительно взгляда (yaw).
    const speed = M.runSpeed * (this.crouching ? M.crouchMult : input.walk ? M.walkMult : 1);
    const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
    // forward при yaw=0 → −Z; right → +X
    let wx = -sin * input.move.y + cos * input.move.x;
    let wz = -cos * input.move.y - sin * input.move.x;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx = wx / wl * speed; wz = wz / wl * speed; }

    let jumped = false;
    if (this.onGround) {
      this.velocity.x = wx;
      this.velocity.z = wz;
      if (input.jump) {
        this.velocity.y = M.jumpSpeed;
        this.onGround = false;
        jumped = true;
      }
    } else if (wl > 0) {
      // В воздухе без ввода момент сохраняется; с вводом — ограниченный доворот.
      const ax = wx - this.velocity.x, az = wz - this.velocity.z;
      const al = Math.hypot(ax, az);
      if (al > 1e-6) {
        const a = Math.min(M.airAccel * dt, al);
        this.velocity.x += ax / al * a;
        this.velocity.z += az / al * a;
      }
    }

    const wasGround = this.onGround;
    const px = this.position.x, py = this.position.y, pz = this.position.z;
    const vx = this.velocity.x, vz = this.velocity.z;
    const wantDist = wasGround ? Math.hypot(vx, vz) * dt : 0;
    this.position.addScaledVector(this.velocity, dt);
    this.collide(dt);

    // Прилипание к полу: прижим гравитации опускает капсулу лишь на доли мм за
    // подшаг, а пол на спуске уходит на сантиметры — без снапа игрок «скачет»
    // по рампам (и в эти моменты не может прыгать). Снапаем только на
    // проходимый уклон и только если не прыгали.
    if (wasGround && !this.onGround && !jumped && this.velocity.y <= 0) {
      tmpRay.origin.copy(this.position);
      tmpRay.origin.y += 0.05;
      tmpRay.direction.copy(DOWN);
      const hit = this.collider.geometry.boundsTree.raycastFirst(tmpRay, THREE.DoubleSide);
      if (hit && hit.distance <= 0.05 + M.snapDistance &&
          hit.face && Math.abs(hit.face.normal.y) > M.groundNormalY) {
        this.position.y -= hit.distance - 0.05;
        this.onGround = true;
        this.velocity.y = 0;
      }
    }

    // Автозабег на ступени: если на земле движение упёрлось (продвинулись
    // меньше половины желаемого), пробуем то же движение с позиции, поднятой
    // на stepHeight, и опускаемся на верх ступеньки.
    if (wantDist > 1e-6) {
      const got = Math.hypot(this.position.x - px, this.position.z - pz);
      if (got < wantDist * 0.5) this.tryStepUp(dt, px, py, pz, vx, vz, got);
    }
  }

  // Попытка перешагнуть препятствие до stepHeight. Принимается, только если
  // дала больше горизонтального продвижения И приземлила на проходимый пол —
  // у стен и крутых склонов попытка проваливается и всё откатывается.
  tryStepUp(dt, px, py, pz, vx, vz, gotBefore) {
    const M = MOVE;
    savePos.copy(this.position);
    saveVel.copy(this.velocity);
    const keepGround = this.onGround;

    this.position.set(px, py + M.stepHeight, pz);
    this.velocity.set(vx, 0, vz);
    this.position.addScaledVector(this.velocity, dt);
    this.collide(dt);

    tmpRay.origin.copy(this.position);
    tmpRay.origin.y += 0.05;
    tmpRay.direction.copy(DOWN);
    const hit = this.collider.geometry.boundsTree.raycastFirst(tmpRay, THREE.DoubleSide);
    const gotAfter = Math.hypot(this.position.x - px, this.position.z - pz);

    if (hit && hit.distance <= 0.05 + M.stepHeight + M.snapDistance &&
        hit.face && Math.abs(hit.face.normal.y) > M.groundNormalY &&
        gotAfter > gotBefore + 1e-4) {
      this.position.y -= hit.distance - 0.05;
      this.onGround = true;
      this.velocity.y = 0;
    } else {
      this.position.copy(savePos);
      this.velocity.copy(saveVel);
      this.onGround = keepGround;
    }
  }

  collide(dt) {
    const M = MOVE;
    // Капсула в локальном пространстве коллайдера (у нас matrixWorld = identity,
    // но оставляем преобразование — оно дешёвое и делает код переносимым).
    tmpSeg.start.copy(this.position); tmpSeg.start.y += M.radius;
    tmpSeg.end.copy(this.position);   tmpSeg.end.y += this.height - M.radius;
    tmpMat.copy(this.collider.matrixWorld).invert();
    tmpSeg.start.applyMatrix4(tmpMat);
    tmpSeg.end.applyMatrix4(tmpMat);

    tmpBox.makeEmpty();
    tmpBox.expandByPoint(tmpSeg.start);
    tmpBox.expandByPoint(tmpSeg.end);
    tmpBox.min.addScalar(-M.radius);
    tmpBox.max.addScalar(M.radius);

    // «Земля» — только контакт с проходимым уклоном (по направлению выталкивания
    // ≈ нормали контакта). Иначе любой скошенный обломок регистрируется как пол:
    // можно замирать на 60° скалах и «взбегать» по почти отвесным стенам.
    let groundContactY = -1;
    this.collider.geometry.boundsTree.shapecast({
      intersectsBounds: box => box.intersectsBox(tmpBox),
      intersectsTriangle: tri => {
        // Выталкивание капсулы из каждого пересекающего треугольника —
        // устойчиво к «грязной» геометрии импортированной карты.
        const dist = tri.closestPointToSegment(tmpSeg, triPoint, capPoint);
        if (dist < M.radius) {
          const depth = M.radius - dist;
          const dir = capPoint.sub(triPoint).normalize();
          if (depth > 1e-5 && dir.y > groundContactY) groundContactY = dir.y;
          tmpSeg.start.addScaledVector(dir, depth);
          tmpSeg.end.addScaledVector(dir, depth);
          // расширяем query-бокс с запасом radius, иначе стены в соседних
          // BVH-узлах, куда нас толкнуло, не будут проверены в этом подшаге
          scratch.copy(tmpSeg.start).addScalar(-M.radius); tmpBox.expandByPoint(scratch);
          scratch.copy(tmpSeg.start).addScalar(M.radius);  tmpBox.expandByPoint(scratch);
          scratch.copy(tmpSeg.end).addScalar(-M.radius);   tmpBox.expandByPoint(scratch);
          scratch.copy(tmpSeg.end).addScalar(M.radius);    tmpBox.expandByPoint(scratch);
        }
      },
    });

    triPoint.copy(tmpSeg.start).applyMatrix4(this.collider.matrixWorld);
    triPoint.y -= M.radius; // сегмент начинается на высоте radius от ног
    tmpDelta.subVectors(triPoint, this.position);

    this.onGround = groundContactY > M.groundNormalY &&
      tmpDelta.y > -Math.abs(dt * this.velocity.y);

    const offset = Math.max(0, tmpDelta.length() - 1e-5);
    if (offset > 0) tmpDelta.normalize().multiplyScalar(offset);
    this.position.add(tmpDelta);

    if (!this.onGround) {
      if (offset > 0) {
        tmpDelta.normalize();
        this.velocity.addScaledVector(tmpDelta, -tmpDelta.dot(this.velocity));
      }
    } else {
      this.velocity.y = 0;
    }
  }
}
