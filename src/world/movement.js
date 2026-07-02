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
};

const tmpMat = new THREE.Matrix4();
const tmpSeg = new THREE.Line3();
const tmpBox = new THREE.Box3();
const triPoint = new THREE.Vector3();
const capPoint = new THREE.Vector3();
const tmpDelta = new THREE.Vector3();
const upRay = new THREE.Ray();
const UP = new THREE.Vector3(0, 1, 0);

export class PlayerController {
  constructor(collider) {
    this.collider = collider;       // THREE.Mesh с geometry.boundsTree (MeshBVH)
    this.position = new THREE.Vector3(); // ноги
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
    this.velocity.set(0, 0, 0);
    this.fellOut = false;
  }

  setCrouch(want) {
    if (want && !this.crouching) {
      this.crouching = true;
      this.height = MOVE.crouchHeight;
    } else if (!want && this.crouching && this.headroomClear()) {
      this.crouching = false;
      this.height = MOVE.standHeight;
    }
  }

  headroomClear() {
    // Хватает ли места встать: луч вверх от макушки текущей капсулы.
    upRay.origin.copy(this.position);
    upRay.origin.y += this.height;
    upRay.direction.copy(UP);
    const hit = this.collider.geometry.boundsTree.raycastFirst(upRay, THREE.DoubleSide);
    const need = MOVE.standHeight - this.height + 0.02;
    return !hit || hit.distance > need;
  }

  update(dt, input) {
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

    if (this.onGround) {
      this.velocity.x = wx;
      this.velocity.z = wz;
      if (input.jump) {
        this.velocity.y = M.jumpSpeed;
        this.onGround = false;
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

    this.position.addScaledVector(this.velocity, dt);
    this.collide(dt);
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

    this.collider.geometry.boundsTree.shapecast({
      intersectsBounds: box => box.intersectsBox(tmpBox),
      intersectsTriangle: tri => {
        // Выталкивание капсулы из каждого пересекающего треугольника —
        // устойчиво к «грязной» геометрии импортированной карты.
        const dist = tri.closestPointToSegment(tmpSeg, triPoint, capPoint);
        if (dist < M.radius) {
          const depth = M.radius - dist;
          const dir = capPoint.sub(triPoint).normalize();
          tmpSeg.start.addScaledVector(dir, depth);
          tmpSeg.end.addScaledVector(dir, depth);
          tmpBox.expandByPoint(tmpSeg.start);
          tmpBox.expandByPoint(tmpSeg.end);
        }
      },
    });

    triPoint.copy(tmpSeg.start).applyMatrix4(this.collider.matrixWorld);
    triPoint.y -= M.radius; // сегмент начинается на высоте radius от ног
    tmpDelta.subVectors(triPoint, this.position);

    this.onGround = tmpDelta.y > Math.abs(dt * this.velocity.y * 0.25);

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
