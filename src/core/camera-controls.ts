/**
 * 相机控制器 — 严格复现 Cesium ScreenSpaceCameraController + Camera 源码
 *
 * Cesium 核心交互模式 (3D Globe):
 * - LEFT_DRAG  → spin3D → pan3D / rotate3D（拾取地球表面拖拽旋转）
 * - RIGHT_DRAG + WHEEL → zoom3D（距离比例缩放）
 * - MIDDLE_DRAG → tilt3D → tilt3DOnEllipsoid（ENU 变换 + rotate3D）
 * - SHIFT + LEFT_DRAG → look3D（射线方向夹角驱动自由观察）
 *
 * 关键实现参考:
 * - Camera.prototype.rotate(axis, angle): 绕任意轴旋转 position/direction/up（Camera.js:2027）
 * - Camera.prototype.look(axis, angle): 仅旋转 direction/up/right（Camera.js:1965）
 * - rotateVertical(camera, angle): 带 constrainedAxis 极点保护（Camera.js:2082）
 * - rotateHorizontal(camera, angle): 绕 constrainedAxis 旋转（Camera.js:2168）
 * - rotate3D: rotateRate × windowRatio × π 系数（SSCC.js:2025）
 * - pan3D: pickEllipsoid 两点 → worldToCameraCoordinates → 叉积旋转（SSCC.js:2102）
 * - tilt3DOnEllipsoid: eastNorthUpToFixedFrame → rotate3D(UNIT_Z)（SSCC.js:2454）
 * - look3D: getPickRay → acos(dot(startDir, endDir))（SSCC.js:2737）
 * - handleZoom: zoomRate = zoomFactor × (distance - minHeight)（SSCC.js:559）
 * - maintainInertia: decay(t) = exp(-(1-coeff)*25*t)（SSCC.js:356）
 */
import * as THREE from "three";
import {
  EARTH_RADIUS,
  TILE_SURFACE_OFFSET,
  MIN_CAMERA_DISTANCE,
  MAX_CAMERA_DISTANCE,
} from "../constants";

// ==================== 常量（严格对应 Cesium ScreenSpaceCameraController 源码值） ====================

/** 球体半径（用于射线求交） */
const GLOBE_RADIUS = EARTH_RADIUS + TILE_SURFACE_OFFSET;

/**
 * 惯性衰减系数 — Cesium 默认值
 * @see SSCC.js:106 inertiaSpin = 0.9
 * @see SSCC.js:114 inertiaZoom = 0.8
 */
const INERTIA_SPIN = 0.9;
const INERTIA_ZOOM = 0.8;

/** 惯性最大点击时间阈值（秒）— SSCC.js:377 inertiaMaxClickTimeThreshold */
const INERTIA_MAX_CLICK_TIME = 0.4;

/** 最大移动比率 — SSCC.js:120 maximumMovementRatio = 0.1 */
const MAXIMUM_MOVEMENT_RATIO = 0.1;

/** 缩放因子 — SSCC.js:147 zoomFactor = 5.0 */
const ZOOM_FACTOR = 5.0;

/** 旋转速度最大值 — SSCC.js:348 _maximumRotateRate = 1.77 */
const MAXIMUM_ROTATE_RATE = 1.77;

/** 旋转速度最小值 — SSCC.js:349 _minimumRotateRate = 1.0 / 5000.0 */
const MINIMUM_ROTATE_RATE = 1.0 / 5000.0;

/** 最小缩放速率 — SSCC.js:350 _minimumZoomRate = 20.0 */
const MINIMUM_ZOOM_RATE = 20.0;

/** 高轨道切换到 look 的高度阈值 — SSCC.js:265 minimumTrackBallHeight */
const MINIMUM_TRACKBALL_HEIGHT = EARTH_RADIUS * 1.175;

/** 约束轴 — 对应 Cesium constrainedAxis = Cartesian3.UNIT_Z（Cesium 用 Z 朝上） */
const CONSTRAINED_AXIS = new THREE.Vector3(0, 1, 0);

/** 数值精度 — 对应 Cesium CesiumMath.EPSILONX */
const EPSILON2 = 1e-2;
const EPSILON3 = 1e-3;
const EPSILON4 = 1e-4;
const EPSILON6 = 1e-6;
const EPSILON14 = 1e-14;

// ==================== 类型定义 ====================

/** 惯性运动状态 — 对应 Cesium movementState（SSCC.js:384-389） */
interface InertiaState {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  motionX: number;
  motionY: number;
  active: boolean;
}

/** 鼠标 movement — 对应 Cesium aggregator.getMovement */
interface Movement {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/** 相机控制器配置 */
interface CameraControllerOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLCanvasElement;
}

// ==================== scratch 对象（对应 Cesium scratchXxx 模式） ====================

const _rotateQuat = new THREE.Quaternion();
const _rotateMat3 = new THREE.Matrix3();
const _scratchVec3A = new THREE.Vector3();
const _scratchVec3B = new THREE.Vector3();
const _scratchVec3C = new THREE.Vector3();
const _scratchVec3D = new THREE.Vector3();

// ==================== Camera 原子操作（严格对应 Camera.js） ====================

/**
 * Camera.prototype.rotate(axis, angle)
 * @see Camera.js:2027-2046
 *
 * 使用四元数同时旋转 position/direction/up，然后重建正交基。
 * Cesium 用 Matrix3.multiplyByVector，这里等价用 THREE.Matrix3.
 */
function cameraRotate(
  camera: THREE.PerspectiveCamera,
  axis: THREE.Vector3,
  angle: number,
): void {
  // Cesium: Quaternion.fromAxisAngle(axis, -turnAngle)
  _rotateQuat.setFromAxisAngle(axis, -angle);
  _rotateMat3.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(_rotateQuat));

  // Cesium: Matrix3.multiplyByVector(rotation, this.position)
  camera.position.applyMatrix3(_rotateMat3);

  // Cesium: Matrix3.multiplyByVector(rotation, this.direction)
  // Three.js 没有独立的 direction，用 getWorldDirection 获取
  const direction = _scratchVec3A.set(0, 0, 0);
  camera.getWorldDirection(direction);
  direction.applyMatrix3(_rotateMat3);

  // Cesium: Matrix3.multiplyByVector(rotation, this.up)
  camera.up.applyMatrix3(_rotateMat3);

  // Cesium: right = cross(direction, up); up = cross(right, direction)
  const right = _scratchVec3B.crossVectors(direction, camera.up);
  camera.up.crossVectors(right, direction).normalize();

  // Three.js 适配: Cesium 可直接设置 direction 属性，Three.js 需通过 lookAt 更新四元数
  const lookTarget = _scratchVec3C.addVectors(camera.position, direction);
  camera.lookAt(lookTarget);
}

/**
 * rotateHorizontal(camera, angle)
 * @see Camera.js:2168-2172
 *
 * Cesium: if constrainedAxis → camera.rotate(constrainedAxis, angle)
 */
function rotateHorizontal(camera: THREE.PerspectiveCamera, angle: number): void {
  cameraRotate(camera, CONSTRAINED_AXIS, angle);
}

/**
 * rotateVertical(camera, angle)
 * @see Camera.js:2082-2140
 *
 * 带 constrainedAxis 的极点保护。
 * Cesium 用 Cartesian3.equalsEpsilon 判断是否在极点附近。
 */
function rotateVertical(camera: THREE.PerspectiveCamera, angle: number): void {
  const position = camera.position;
  const p = _scratchVec3A.copy(position).normalize();

  // Cesium: equalsEpsilon(p, constrainedAxis, EPSILON2)
  const northParallel = p.distanceTo(CONSTRAINED_AXIS) < EPSILON2;
  const negAxis = _scratchVec3B.copy(CONSTRAINED_AXIS).negate();
  const southParallel = p.distanceTo(negAxis) < EPSILON2;

  if (!northParallel && !southParallel) {
    const constrainedAxis = _scratchVec3C.copy(CONSTRAINED_AXIS).normalize();

    // Cesium: dot = dot(p, constrainedAxis); angleToAxis = acosClamped(dot)
    let dot = p.dot(constrainedAxis);
    let angleToAxis = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
    if (angle > 0 && angle > angleToAxis) {
      angle = angleToAxis - EPSILON4;
    }

    // Cesium: dot = dot(p, negate(constrainedAxis)); ...
    dot = p.dot(negAxis);
    angleToAxis = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
    if (angle < 0 && -angle > angleToAxis) {
      angle = -angleToAxis + EPSILON4;
    }

    // Cesium: tangent = cross(constrainedAxis, p); camera.rotate(tangent, angle)
    const tangent = _scratchVec3D.crossVectors(constrainedAxis, p);
    if (tangent.lengthSq() > EPSILON14) {
      tangent.normalize();
      cameraRotate(camera, tangent, angle);
    }
  } else if ((northParallel && angle < 0) || (southParallel && angle > 0)) {
    // Cesium: camera.rotate(camera.right, angle)
    camera.getWorldDirection(_scratchVec3A);
    const right = _scratchVec3B.crossVectors(_scratchVec3A, camera.up).normalize();
    cameraRotate(camera, right, angle);
  }
}

/**
 * Camera.prototype.look(axis, angle)
 * @see Camera.js:1965-1985
 *
 * 仅旋转 direction/up/right，不移动 position。
 */
function cameraLook(
  camera: THREE.PerspectiveCamera,
  axis: THREE.Vector3,
  angle: number,
): void {
  _rotateQuat.setFromAxisAngle(axis, -angle);
  _rotateMat3.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(_rotateQuat));

  camera.getWorldDirection(_scratchVec3A);
  _scratchVec3A.applyMatrix3(_rotateMat3);
  camera.up.applyMatrix3(_rotateMat3);

  // 重建正交基
  const right = _scratchVec3B.crossVectors(_scratchVec3A, camera.up);
  camera.up.crossVectors(right, _scratchVec3A).normalize();

  // Three.js 适配: 通过 lookAt 将新 direction 写入相机四元数
  const lookTarget = _scratchVec3C.addVectors(camera.position, _scratchVec3A);
  camera.lookAt(lookTarget);
}

/**
 * 惯性衰减 — 严格对应 Cesium decay(time, coefficient)
 * @see SSCC.js:356-362
 */
function decay(time: number, coefficient: number): number {
  if (time < 0) return 0.0;
  const tau = (1.0 - coefficient) * 25.0;
  return Math.exp(-tau * time);
}

/**
 * 射线发射工具 — 对应 Cesium camera.getPickRay
 */
function getPickRay(camera: THREE.PerspectiveCamera, ndcX: number, ndcY: number): THREE.Ray {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  return raycaster.ray;
}

/**
 * 射线-球面求交 — 对应 Cesium IntersectionTests.rayEllipsoid
 * @returns 交点世界坐标，无交点返回 null
 */
function rayEllipsoid(ray: THREE.Ray, radius: number): THREE.Vector3 | null {
  const origin = ray.origin;
  const direction = ray.direction;
  const b = origin.dot(direction);
  const c = origin.dot(origin) - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const sqrtD = Math.sqrt(discriminant);
  let t = -b - sqrtD;
  if (t < 0) t = -b + sqrtD;
  if (t < 0) return null;
  return origin.clone().addScaledVector(direction, t);
}

/**
 * 从 NDC 坐标拾取球面 — 对应 Cesium camera.pickEllipsoid
 */
function pickEllipsoidAtNdc(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  radius: number,
): THREE.Vector3 | null {
  const ray = getPickRay(camera, ndcX, ndcY);
  return rayEllipsoid(ray, radius);
}

/**
 * 像素坐标转 NDC
 */
function pixelToNdc(x: number, y: number, canvas: HTMLCanvasElement): THREE.Vector2 {
  return new THREE.Vector2(
    (x / canvas.clientWidth) * 2 - 1,
    -(y / canvas.clientHeight) * 2 + 1,
  );
}

/**
 * 世界坐标变换到相机坐标 — 对应 Cesium camera.worldToCameraCoordinates
 * 用于 pan3D 中的叉积旋转计算
 */
function worldToCameraCoordinates(camera: THREE.PerspectiveCamera, point: THREE.Vector3): THREE.Vector3 {
  return point.clone().applyMatrix4(camera.matrixWorldInverse);
}

// ==================== CameraController 主类 ====================

/**
 * CameraController — 严格复现 Cesium ScreenSpaceCameraController 的 3D 模式
 *
 * 输入事件绑定（对应 Cesium 事件类型）：
 * - 左键拖拽 → spin3D（SSCC.js:1906） → pan3D / rotate3D
 * - 右键拖拽 + 滚轮 → zoom3D（SSCC.js:2318） → handleZoom
 * - 中键拖拽 → tilt3D（SSCC.js:2409） → tilt3DOnEllipsoid
 * - Shift+左键 → look3D（SSCC.js:2737）
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLCanvasElement;

  // ==================== 公共配置（SSCC.js 构造函数属性） ====================

  /** @see SSCC.js:55 enableInputs = true */
  enableInputs = true;
  /** @see SSCC.js:78 enableRotate = true */
  enableRotate = true;
  /** @see SSCC.js:68 enableZoom = true */
  enableZoom = true;
  /** @see SSCC.js:88 enableTilt = true */
  enableTilt = true;
  /** @see SSCC.js:97 enableLook = true */
  enableLook = true;
  /** @see SSCC.js:134 minimumZoomDistance = 1.0 */
  minimumZoomDistance = 1.0;
  /** @see SSCC.js:141 maximumZoomDistance = Infinity */
  maximumZoomDistance = MAX_CAMERA_DISTANCE;
  /** 最后一次用户交互时间戳 */
  lastInteractionTime = performance.now();

  // ==================== 内部状态（对应 SSCC.js 构造函数内部变量） ====================

  private _isLeftDown = false;
  private _isMiddleDown = false;
  private _isRightDown = false;
  private _isShiftDown = false;

  private readonly _lastPosition = { x: 0, y: 0 };

  private _buttonPressTime = 0;
  private _buttonReleaseTime = 0;
  private _lastMovement: Movement | null = null;

  /**
   * spin3D 状态 — 对应 SSCC.js:329-332
   * _rotating / _strafing / _looking 标志 + _rotateMousePosition / _rotateStartPosition
   */
  private _spinning = false;
  private _spinRotating = false;
  private readonly _rotateMousePosition = { x: -1, y: -1 };
  private readonly _rotateStartPosition = new THREE.Vector3();

  /**
   * tilt3D 状态 — 对应 SSCC.js:326-327
   */
  private readonly _tiltCenterMousePosition = { x: -1, y: -1 };

  /**
   * rotateFactor / rotateRateRangeAdjustment — SSCC.js:345-346
   * update3D 中计算: rotateFactor = 1.0 / radius; rotateRateRangeAdjustment = radius
   */
  private _rotateFactor = 1.0 / EARTH_RADIUS;
  private _rotateRateRangeAdjustment = EARTH_RADIUS;

  /** 惯性状态 */
  private _spinInertia: InertiaState | null = null;
  private _zoomInertia: InertiaState | null = null;
  private _tiltInertia: InertiaState | null = null;

  /** 当前活动的拖拽操作 */
  private _activeAction: "spin" | "zoom" | "tilt" | "look" | null = null;

  constructor(options: CameraControllerOptions) {
    this.camera = options.camera;
    this.domElement = options.domElement;
    this._bindEvents();
  }

  // ==================== 公共方法 ====================

  /** 射线与地球求交 */
  pickGlobeTarget(): THREE.Vector3 | null {
    const ray = getPickRay(this.camera, 0, 0);
    return rayEllipsoid(ray, GLOBE_RADIUS);
  }

  /** 获取相机注视目标点 */
  getCameraTarget(): THREE.Vector3 {
    const picked = this.pickGlobeTarget();
    if (picked) return picked;
    return this.camera.position.clone().normalize().multiplyScalar(EARTH_RADIUS);
  }

  /** 限制相机距离 */
  clampCameraDistance(): void {
    const distance = this.camera.position.length();
    if (distance < MIN_CAMERA_DISTANCE) {
      this.camera.position.setLength(MIN_CAMERA_DISTANCE);
    } else if (distance > MAX_CAMERA_DISTANCE) {
      this.camera.position.setLength(MAX_CAMERA_DISTANCE);
    }
  }

  /**
   * 每帧调用 — 对应 SSCC.prototype.update → update3D
   * @see SSCC.js:2998
   */
  update(): void {
    // 对应 update3D 中的 rotateFactor 计算（SSCC.js:2860 之前）
    // Cesium 在 ScreenSpaceCameraController.prototype.update 的 adjustHeightForTerrain 之前
    // 调用 update3D，其中会设置 _rotateFactor
    this._rotateFactor = 1.0 / EARTH_RADIUS;
    this._rotateRateRangeAdjustment = EARTH_RADIUS;

    this._processInertia();
    this._maintainUpVector();
  }

  // ==================== spin3D — 左键拖拽（SSCC.js:1906-2023） ====================

  /**
   * spin3D 严格复现
   *
   * Cesium 逻辑:
   * 1. 如果 startPosition == _rotateMousePosition → 继续上次操作（pan/rotate/look）
   * 2. 否则尝试 pickEllipsoid → 成功则 pan3D + 记录 _rotateStartPosition
   * 3. 否则 height > minimumTrackBallHeight → rotate3D
   * 4. 否则 → look3D
   *
   * @see SSCC.js:1906
   */
  private _spin3D(movement: Movement): void {
    if (!this.enableRotate || !this.enableInputs) return;

    const camera = this.camera;
    const canvas = this.domElement;

    // 判断是否延续上次操作 — 对应 Cesium Cartesian2.equals 检查
    const sameStart =
      Math.abs(movement.startX - this._rotateMousePosition.x) < 1 &&
      Math.abs(movement.startY - this._rotateMousePosition.y) < 1;

    if (sameStart && this._spinning) {
      // 延续上次操作
      if (this._spinRotating) {
        this._rotate3D(movement);
      } else {
        // 继续 pan3D：使用记录的 _rotateStartPosition 构建等球体
        this._pan3D(movement);
      }
      return;
    }

    // 新的拖拽开始 — 重置状态
    this._spinning = true;
    this._spinRotating = false;

    // 尝试 pickEllipsoid — 对应 SSCC.js:2005-2010
    const startNdc = pixelToNdc(movement.startX, movement.startY, canvas);
    const picked = pickEllipsoidAtNdc(camera, startNdc.x, startNdc.y, GLOBE_RADIUS);

    if (picked) {
      // pan3D 路径
      this._rotateStartPosition.copy(picked);
      this._pan3D(movement);
    } else {
      // 检查高度决定 rotate3D 还是 look3D
      const height = camera.position.length() - EARTH_RADIUS;
      if (height > MINIMUM_TRACKBALL_HEIGHT) {
        this._spinRotating = true;
        this._rotate3D(movement);
      } else {
        // 低轨道无交点 → look3D（Cesium 在此处 fallback 到 look3D）
        this._look3D(movement);
      }
    }

    this._rotateMousePosition.x = movement.startX;
    this._rotateMousePosition.y = movement.startY;
  }

  /**
   * pan3D — 严格对应 Cesium pan3D（constrainedAxis 分支）
   * @see SSCC.js:2102-2316
   *
   * Cesium 核心逻辑（有 constrainedAxis 时）:
   * 1. p0 = pickEllipsoid(startPos, ellipsoid)
   * 2. p1 = pickEllipsoid(endPos, ellipsoid)
   * 3. 无法拾取 → fallback 到 rotate3D
   * 4. 在 Cesium 3D 模式中 _actualTransform = IDENTITY，
   *    worldToCameraCoordinates 实际上是 no-op，所有计算在世界坐标下进行
   * 5. 分解为球坐标系下 deltaPhi/deltaTheta
   * 6. camera.rotateRight(deltaPhi); camera.rotateUp(deltaTheta)
   */
  private _pan3D(movement: Movement): void {
    const camera = this.camera;
    const canvas = this.domElement;

    const startNdc = pixelToNdc(movement.startX, movement.startY, canvas);
    const endNdc = pixelToNdc(movement.endX, movement.endY, canvas);

    // 使用 _rotateStartPosition 的大小构建等球体半径
    // 对应 Cesium: radii.x = radii.y = radii.z = magnitude
    const magnitude = this._rotateStartPosition.length();
    const ellipsoidRadius = magnitude > 0 ? magnitude : GLOBE_RADIUS;

    // Cesium: p0 = pickEllipsoid(startPos, ellipsoid); p1 = pickEllipsoid(endPos, ellipsoid)
    const p0 = pickEllipsoidAtNdc(camera, startNdc.x, startNdc.y, ellipsoidRadius);
    const p1 = pickEllipsoidAtNdc(camera, endNdc.x, endNdc.y, ellipsoidRadius);

    if (!p0 || !p1) {
      // Cesium: controller._rotating = true; rotate3D(controller, ...)
      this._spinRotating = true;
      this._rotate3D(movement);
      return;
    }

    // 注意: 在 Cesium 3D 模式下 _actualTransform = IDENTITY，
    // 因此 worldToCameraCoordinates 实际上不做任何变换，
    // 所有计算直接在世界坐标下进行

    // === constrainedAxis 分支（SSCC.js:2244-2314）===
    const basis0 = CONSTRAINED_AXIS; // Cesium: camera.constrainedAxis（世界坐标）

    // basis1 = mostOrthogonalAxis(basis0); basis1 = cross(basis1, basis0); normalize
    const basis1 = _scratchVec3A.set(0, 0, 0);
    // Cesium Cartesian3.mostOrthogonalAxis: 选择绝对值最小的分量对应的轴
    const absX = Math.abs(basis0.x);
    const absY = Math.abs(basis0.y);
    const absZ = Math.abs(basis0.z);
    if (absX <= absY && absX <= absZ) {
      basis1.set(1, 0, 0);
    } else if (absY <= absX && absY <= absZ) {
      basis1.set(0, 1, 0);
    } else {
      basis1.set(0, 0, 1);
    }
    basis1.crossVectors(basis1, basis0).normalize();
    const basis2 = _scratchVec3B.crossVectors(basis0, basis1);

    // startTheta/endTheta — 使用世界坐标下的 p0/p1
    const startRho = p0.length();
    const startDot = basis0.dot(p0);
    const startTheta = Math.acos(THREE.MathUtils.clamp(startDot / startRho, -1, 1));
    const startRej = _scratchVec3C.copy(basis0).multiplyScalar(startDot);
    startRej.subVectors(p0, startRej).normalize();

    const endRho = p1.length();
    const endDot = basis0.dot(p1);
    const endTheta = Math.acos(THREE.MathUtils.clamp(endDot / endRho, -1, 1));
    const endRej = _scratchVec3D.copy(basis0).multiplyScalar(endDot);
    endRej.subVectors(p1, endRej).normalize();

    // startPhi/endPhi
    let startPhi = Math.acos(THREE.MathUtils.clamp(startRej.dot(basis1), -1, 1));
    if (startRej.dot(basis2) < 0) startPhi = Math.PI * 2 - startPhi;

    let endPhi = Math.acos(THREE.MathUtils.clamp(endRej.dot(basis1), -1, 1));
    if (endRej.dot(basis2) < 0) endPhi = Math.PI * 2 - endPhi;

    const deltaPhi = startPhi - endPhi;

    // deltaTheta 方向判断 — SSCC.js:2290-2310
    // Cesium: east = equalsEpsilon(basis0, camera.position) ? camera.right : cross(basis0, camera.position)
    // 注意: 在 Cesium 中 camera.position 和 camera.right 都是世界坐标
    const cameraPos = camera.position;
    let east: THREE.Vector3;
    if (cameraPos.clone().normalize().distanceTo(basis0) < EPSILON2) {
      // camera.right in world space = cross(direction, up)
      camera.getWorldDirection(_scratchVec3A);
      east = _scratchVec3A.crossVectors(_scratchVec3A, camera.up).normalize();
    } else {
      east = _scratchVec3A.crossVectors(basis0, cameraPos);
    }

    const planeNormal = _scratchVec3B.crossVectors(basis0, east);
    const side0 = planeNormal.dot(_scratchVec3C.copy(p0).sub(basis0.clone()));
    const side1 = planeNormal.dot(_scratchVec3D.copy(p1).sub(basis0.clone()));

    let deltaTheta: number;
    if (side0 > 0 && side1 > 0) {
      deltaTheta = endTheta - startTheta;
    } else if (side0 > 0 && side1 <= 0) {
      // Cesium: Cartesian3.dot(camera.position, basis0) > 0
      if (cameraPos.dot(basis0) > 0) {
        deltaTheta = -startTheta - endTheta;
      } else {
        deltaTheta = startTheta + endTheta;
      }
    } else {
      deltaTheta = startTheta - endTheta;
    }

    // Cesium: camera.rotateRight(deltaPhi); camera.rotateUp(deltaTheta);
    // rotateRight → rotateHorizontal(camera, -angle) → camera.rotate(constrainedAxis, -angle)
    // rotateUp → rotateVertical(camera, -angle)
    rotateHorizontal(camera, -deltaPhi);
    rotateVertical(camera, -deltaTheta);
  }

  /**
   * rotate3D — 严格对应 Cesium rotate3D（SSCC.js:2025-2099）
   *
   * deltaPhi = rotateRate × phiWindowRatio × Math.PI × 2.0
   * deltaTheta = rotateRate × thetaWindowRatio × Math.PI
   * camera.rotateRight(deltaPhi); camera.rotateUp(deltaTheta);
   *
   * 注意 Cesium rotateRight → rotateHorizontal(camera, -angle)
   *              rotateUp → rotateVertical(camera, -angle)
   */
  private _rotate3D(movement: Movement): void {
    const camera = this.camera;
    const canvas = this.domElement;

    // Cesium: rotateRate = rotateFactor * (rho - rotateRateRangeAdjustment)
    const rho = camera.position.length();
    let rotateRate =
      this._rotateFactor * (rho - this._rotateRateRangeAdjustment);
    rotateRate = THREE.MathUtils.clamp(
      rotateRate,
      MINIMUM_ROTATE_RATE,
      MAXIMUM_ROTATE_RATE,
    );

    // Cesium 窗口比率（SSCC.js:2058-2066）
    let phiWindowRatio =
      (movement.startX - movement.endX) / canvas.clientWidth;
    let thetaWindowRatio =
      (movement.startY - movement.endY) / canvas.clientHeight;
    phiWindowRatio = Math.min(phiWindowRatio, MAXIMUM_MOVEMENT_RATIO);
    thetaWindowRatio = Math.min(thetaWindowRatio, MAXIMUM_MOVEMENT_RATIO);

    // Cesium: deltaPhi = rotateRate * phiWindowRatio * Math.PI * 2.0
    // Cesium: deltaTheta = rotateRate * thetaWindowRatio * Math.PI
    const deltaPhi = rotateRate * phiWindowRatio * Math.PI * 2.0;
    const deltaTheta = rotateRate * thetaWindowRatio * Math.PI;

    // Cesium: camera.rotateRight(deltaPhi) → rotateHorizontal(camera, -deltaPhi)
    // Cesium: camera.rotateUp(deltaTheta) → rotateVertical(camera, -deltaTheta)
    rotateHorizontal(camera, -deltaPhi);
    rotateVertical(camera, -deltaTheta);
  }

  // ==================== zoom3D（SSCC.js:2318-2395）→ handleZoom（SSCC.js:559-642）====================

  /**
   * zoom3D → handleZoom 严格复现
   *
   * @see SSCC.js:2318（zoom3D: 计算 distanceMeasure）
   * @see SSCC.js:559（handleZoom: 核心缩放计算）
   */
  private _zoom3D(movement: Movement): void {
    if (!this.enableZoom || !this.enableInputs) return;

    const camera = this.camera;
    const canvas = this.domElement;

    // === zoom3D 部分: 计算 distanceMeasure ===
    // Cesium: 优先用 pickPosition 的距离，否则用 height
    const height = camera.position.length() - EARTH_RADIUS;
    let distanceMeasure: number;

    const ray = getPickRay(camera, 0, 0);
    const intersection = rayEllipsoid(ray, GLOBE_RADIUS);
    if (intersection) {
      distanceMeasure = camera.position.distanceTo(intersection);
    } else {
      distanceMeasure = height;
    }

    // === handleZoom 部分（SSCC.js:559-642）===
    // Cesium: percentage = clamp(abs(unitPositionDotDirection), 0.25, 1.0)
    const unitPosition = _scratchVec3A.copy(camera.position).normalize();
    camera.getWorldDirection(_scratchVec3B);
    const unitPositionDotDirection = unitPosition.dot(_scratchVec3B);
    const percentage = THREE.MathUtils.clamp(
      Math.abs(unitPositionDotDirection),
      0.25,
      1.0,
    );

    // Cesium: diff = endPosition.y - startPosition.y
    const diff = movement.endY - movement.startY;
    const approachingSurface = diff > 0;
    const minHeight = approachingSurface
      ? this.minimumZoomDistance * percentage
      : 0;
    const maxHeight = this.maximumZoomDistance;

    // Cesium: zoomRate = zoomFactor * minDistance
    const minDistance = distanceMeasure - minHeight;
    let zoomRate = ZOOM_FACTOR * minDistance;
    zoomRate = THREE.MathUtils.clamp(zoomRate, MINIMUM_ZOOM_RATE, MAX_CAMERA_DISTANCE);

    // Cesium: rangeWindowRatio = diff / canvas.clientHeight
    let rangeWindowRatio = diff / canvas.clientHeight;
    rangeWindowRatio = Math.min(rangeWindowRatio, MAXIMUM_MOVEMENT_RATIO);
    let distance = zoomRate * rangeWindowRatio;

    // Cesium 边界检查（SSCC.js:605-618）
    if (distance > 0.0 && Math.abs(distanceMeasure - minHeight) < 1.0) return;
    if (distance < 0.0 && Math.abs(distanceMeasure - maxHeight) < 1.0) return;
    if (distanceMeasure - distance < minHeight) {
      distance = distanceMeasure - minHeight - 1.0;
    } else if (distanceMeasure - distance > maxHeight) {
      distance = distanceMeasure - maxHeight;
    }

    // Cesium: camera.moveForward(distance) ≈ camera.move(direction, distance)
    camera.getWorldDirection(_scratchVec3A);
    camera.position.addScaledVector(_scratchVec3A, distance);
    this.clampCameraDistance();
  }

  // ==================== tilt3D → tilt3DOnEllipsoid（SSCC.js:2454-2530）====================

  /**
   * tilt3DOnEllipsoid 严格复现
   *
   * Cesium 核心逻辑:
   * 1. 从屏幕中心射线求交 → center
   * 2. transform = Transforms.eastNorthUpToFixedFrame(center, ellipsoid)
   * 3. 临时设置 rotateFactor=1.0, rotateRateRangeAdjustment=1.0
   * 4. camera._setTransform(transform)
   * 5. rotate3D(controller, ..., Cartesian3.UNIT_Z)
   * 6. 恢复 transform 和参数
   *
   * 由于 Three.js 没有 camera._setTransform，我们通过等价的矩阵变换实现。
   * 关键洞察: tilt3DOnEllipsoid 本质上是在 ENU 局部坐标系下执行 rotate3D，
   * 约束轴是 UNIT_Z（即 ENU 的 Up 方向）。
   *
   * @see SSCC.js:2454
   */
  private _tilt3D(movement: Movement): void {
    if (!this.enableTilt || !this.enableInputs) return;

    const camera = this.camera;
    const canvas = this.domElement;

    // Cesium: height < minHeight check（SSCC.js:2462-2469）
    const height = camera.position.length() - EARTH_RADIUS;
    const minHeight = this.minimumZoomDistance * 0.25;
    if (
      height - minHeight - 1.0 < EPSILON3 &&
      movement.endY - movement.startY < 0
    ) {
      return;
    }

    // Cesium: ray = getPickRay(screenCenter); intersection = rayEllipsoid(ray, ellipsoid)
    const ray = getPickRay(camera, 0, 0);
    const center = rayEllipsoid(ray, GLOBE_RADIUS);

    if (!center) {
      // Cesium: height > minimumTrackBallHeight → grazingAltitude 回退
      // 简化: 使用 rotate3D 回退
      if (height > MINIMUM_TRACKBALL_HEIGHT) {
        this._rotate3D(movement);
      }
      return;
    }

    // === 等价 Cesium 的 camera._setTransform(enuTransform) + rotate3D(UNIT_Z) ===
    //
    // Cesium 在 tilt3DOnEllipsoid 中:
    // 1. 设置 _rotateFactor = 1.0; _rotateRateRangeAdjustment = 1.0
    // 2. camera._setTransform(enuTransform) — 将相机位置/方向转到 ENU 局部坐标系
    // 3. rotate3D(..., Cartesian3.UNIT_Z) — 在 ENU 下做受约束旋转
    // 4. 恢复 transform
    //
    // 等价实现: 在 center 处构建 ENU，将相机状态变换到 ENU 下，
    // 执行 rotate3D 等价计算，再变换回世界坐标系。

    // 构建 ENU 基向量（对应 Cesium Transforms.eastNorthUpToFixedFrame）
    const centerNormal = _scratchVec3A.copy(center).normalize();
    // East = CONSTRAINED_AXIS × Up（这里 Up 是球面法线方向 centerNormal）
    const east = _scratchVec3B.crossVectors(CONSTRAINED_AXIS, centerNormal);
    if (east.lengthSq() < EPSILON6) {
      east.set(1, 0, 0);
    }
    east.normalize();
    // North = Up × East
    const north = _scratchVec3C.crossVectors(centerNormal, east);

    // 构建 ENU → World 变换矩阵和逆矩阵
    const enuToWorld = new THREE.Matrix4().makeBasis(east, north, centerNormal);
    enuToWorld.setPosition(center);
    const worldToEnu = enuToWorld.clone().invert();

    // 保存当前相机状态
    const savedPosition = camera.position.clone();
    const savedUp = camera.up.clone();
    camera.getWorldDirection(_scratchVec3D);
    const savedDirection = _scratchVec3D.clone();

    // 变换到 ENU 局部坐标系 — 对应 camera._setTransform(enuTransform)
    const localPos = savedPosition.clone().applyMatrix4(worldToEnu);
    const localDir = savedDirection.clone().transformDirection(worldToEnu);
    const localUp = savedUp.clone().transformDirection(worldToEnu);

    // 在 ENU 下计算 rotate3D — 对应 SSCC rotate3D(controller, ..., UNIT_Z)
    // 临时使用 rotateFactor=1, rotateRateRangeAdjustment=1
    const rho = localPos.length();
    let rotateRate = 1.0 * (rho - 1.0);
    rotateRate = THREE.MathUtils.clamp(rotateRate, MINIMUM_ROTATE_RATE, MAXIMUM_ROTATE_RATE);

    let phiWindowRatio = (movement.startX - movement.endX) / canvas.clientWidth;
    let thetaWindowRatio = (movement.startY - movement.endY) / canvas.clientHeight;
    phiWindowRatio = Math.min(phiWindowRatio, MAXIMUM_MOVEMENT_RATIO);
    thetaWindowRatio = Math.min(thetaWindowRatio, MAXIMUM_MOVEMENT_RATIO);

    const deltaPhi = rotateRate * phiWindowRatio * Math.PI * 2.0;
    const deltaTheta = rotateRate * thetaWindowRatio * Math.PI;

    // 在 ENU 下，约束轴是 Z 轴（Up 方向）— 对应 Cesium UNIT_Z
    const enuConstrainedAxis = new THREE.Vector3(0, 0, 1);

    // rotateRight(deltaPhi) 在 ENU 下 → rotate(constrainedAxis=Z, -deltaPhi)
    _rotateQuat.setFromAxisAngle(enuConstrainedAxis, deltaPhi);
    _rotateMat3.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(_rotateQuat));
    localPos.applyMatrix3(_rotateMat3);
    localDir.applyMatrix3(_rotateMat3);
    localUp.applyMatrix3(_rotateMat3);

    // rotateUp(deltaTheta) 在 ENU 下 → 绕 tangent = cross(Z, normalize(localPos)) 旋转
    const localPNorm = localPos.clone().normalize();
    const tangent = _scratchVec3A.crossVectors(enuConstrainedAxis, localPNorm);
    if (tangent.lengthSq() > EPSILON14) {
      tangent.normalize();

      // 极点保护
      let dot = localPNorm.dot(enuConstrainedAxis);
      let angleToAxis = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      let clampedTheta = -deltaTheta;
      if (clampedTheta > 0 && clampedTheta > angleToAxis) {
        clampedTheta = angleToAxis - EPSILON4;
      }
      const negZ = _scratchVec3B.copy(enuConstrainedAxis).negate();
      dot = localPNorm.dot(negZ);
      angleToAxis = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      if (clampedTheta < 0 && -clampedTheta > angleToAxis) {
        clampedTheta = -angleToAxis + EPSILON4;
      }

      _rotateQuat.setFromAxisAngle(tangent, -clampedTheta);
      _rotateMat3.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(_rotateQuat));
      localPos.applyMatrix3(_rotateMat3);
      localDir.applyMatrix3(_rotateMat3);
      localUp.applyMatrix3(_rotateMat3);
    }

    // 变换回世界坐标系 — 对应 camera._setTransform(oldTransform)
    camera.position.copy(localPos.applyMatrix4(enuToWorld));
    camera.up.copy(localUp.transformDirection(enuToWorld.clone().setPosition(0, 0, 0))).normalize();

    // 重建正交基
    const right = _scratchVec3A.crossVectors(
      localDir.transformDirection(enuToWorld.clone().setPosition(0, 0, 0)),
      camera.up,
    );
    camera.up.crossVectors(right, localDir).normalize();

    // Three.js 适配: 将 ENU 变换后的 direction 应用到相机四元数
    _scratchVec3D.addVectors(camera.position, localDir);
    camera.lookAt(_scratchVec3D);
  }

  // ==================== look3D（SSCC.js:2737-2857）====================

  /**
   * look3D 严格复现
   *
   * Cesium 的 look3D 不是简单的 diff/canvas*PI，而是:
   * 1. 将 movement 拆分为水平(x)和垂直(y)两段
   * 2. 对每段: 用 getPickRay 获取射线方向 → acos(dot(startDir, endDir)) 得到角度
   * 3. 水平: camera.look(rotationAxis, -angle)
   * 4. 垂直: camera.look(tangent, angle) 带极点保护
   *
   * @see SSCC.js:2737
   */
  private _look3D(movement: Movement): void {
    if (!this.enableLook || !this.enableInputs) return;

    const camera = this.camera;
    const canvas = this.domElement;

    // === 水平分量（SSCC.js:2741-2785）===
    // Cesium: startPos = (movement.startPosition.x, 0); endPos = (movement.endPosition.x, 0)
    const hStartNdc = pixelToNdc(movement.startX, canvas.clientHeight / 2, canvas);
    const hEndNdc = pixelToNdc(movement.endX, canvas.clientHeight / 2, canvas);

    const hStartRay = getPickRay(camera, hStartNdc.x, hStartNdc.y);
    const hEndRay = getPickRay(camera, hEndNdc.x, hEndNdc.y);

    // Cesium: dot = cross(start, end); angle = dot < 1 ? acos(dot) : 0
    let hDot = hStartRay.direction.dot(hEndRay.direction);
    let hAngle = 0;
    if (hDot < 1.0) {
      hAngle = Math.acos(THREE.MathUtils.clamp(hDot, -1, 1));
    }
    hAngle = movement.startX > movement.endX ? -hAngle : hAngle;

    // Cesium: camera.look(rotationAxis, -angle) — rotationAxis 就是 constrainedAxis
    cameraLook(camera, CONSTRAINED_AXIS, -hAngle);

    // === 垂直分量（SSCC.js:2789-2857）===
    // Cesium: startPos = (0, movement.startPosition.y); endPos = (0, movement.endPosition.y)
    const vStartNdc = pixelToNdc(canvas.clientWidth / 2, movement.startY, canvas);
    const vEndNdc = pixelToNdc(canvas.clientWidth / 2, movement.endY, canvas);

    const vStartRay = getPickRay(camera, vStartNdc.x, vStartNdc.y);
    const vEndRay = getPickRay(camera, vEndNdc.x, vEndNdc.y);

    let vDot = vStartRay.direction.dot(vEndRay.direction);
    let vAngle = 0;
    if (vDot < 1.0) {
      vAngle = Math.acos(THREE.MathUtils.clamp(vDot, -1, 1));
    }
    vAngle = movement.startY > movement.endY ? -vAngle : vAngle;

    // Cesium 的极点保护（SSCC.js:2825-2857）
    camera.getWorldDirection(_scratchVec3A);
    const direction = _scratchVec3A;
    const negAxis = _scratchVec3B.copy(CONSTRAINED_AXIS).negate();
    const northParallel = direction.distanceTo(CONSTRAINED_AXIS) < EPSILON2;
    const southParallel = direction.distanceTo(negAxis) < EPSILON2;

    if (!northParallel && !southParallel) {
      let dot = direction.dot(CONSTRAINED_AXIS);
      let angleToAxis = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      if (vAngle > 0 && vAngle > angleToAxis) {
        vAngle = angleToAxis - EPSILON4;
      }
      dot = direction.dot(negAxis);
      angleToAxis = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
      if (vAngle < 0 && -vAngle > angleToAxis) {
        vAngle = -angleToAxis + EPSILON4;
      }

      // Cesium: tangent = cross(rotationAxis, direction); camera.look(tangent, angle)
      const tangent = _scratchVec3C.crossVectors(CONSTRAINED_AXIS, direction);
      if (tangent.lengthSq() > EPSILON14) {
        tangent.normalize();
        cameraLook(camera, tangent, vAngle);
      }
    } else if ((northParallel && vAngle < 0) || (southParallel && vAngle > 0)) {
      // Cesium: camera.look(camera.right, -angle)
      camera.getWorldDirection(_scratchVec3A);
      const right = _scratchVec3C.crossVectors(_scratchVec3A, camera.up).normalize();
      cameraLook(camera, right, -vAngle);
    }
  }

  // ==================== 惯性系统（SSCC.js:379-457）====================

  /** 每帧处理惯性 — 对应 Cesium maintainInertia */
  private _processInertia(): void {
    const now = performance.now() / 1000;
    if (this._isLeftDown || this._isMiddleDown || this._isRightDown) return;

    this._applyInertia(this._spinInertia, INERTIA_SPIN, now, (m) => this._spin3D(m));
    this._applyInertia(this._zoomInertia, INERTIA_ZOOM, now, (m) => this._zoom3D(m));
    this._applyInertia(this._tiltInertia, INERTIA_SPIN, now, (m) => this._tilt3D(m));
  }

  /** 应用单个惯性 */
  private _applyInertia(
    state: InertiaState | null,
    coefficient: number,
    nowSeconds: number,
    action: (m: Movement) => void,
  ): void {
    if (!state || !state.active) return;

    const releaseTime = this._buttonReleaseTime / 1000;
    const pressTime = this._buttonPressTime / 1000;
    const threshold = releaseTime - pressTime;
    const fromNow = nowSeconds - releaseTime;

    if (threshold >= INERTIA_MAX_CLICK_TIME) {
      state.active = false;
      return;
    }

    const d = decay(fromNow, coefficient);
    const endX = state.startX + state.motionX * d;
    const endY = state.startY + state.motionY * d;

    const dist = Math.sqrt(
      (endX - state.startX) ** 2 + (endY - state.startY) ** 2,
    );
    if (dist < 0.5 || isNaN(endX) || isNaN(endY)) {
      state.active = false;
      return;
    }

    action({
      startX: state.startX,
      startY: state.startY,
      endX,
      endY,
    });
  }

  /** 在 mouseup 时记录惯性 */
  private _recordInertia(action: "spin" | "zoom" | "tilt"): void {
    if (!this._lastMovement) return;
    const m = this._lastMovement;
    const motion: InertiaState = {
      startX: m.startX,
      startY: m.startY,
      endX: m.endX,
      endY: m.endY,
      motionX: (m.endX - m.startX) * 0.5,
      motionY: (m.endY - m.startY) * 0.5,
      active: true,
    };
    if (action === "spin") this._spinInertia = motion;
    else if (action === "zoom") this._zoomInertia = motion;
    else if (action === "tilt") this._tiltInertia = motion;
  }

  /**
   * 维护 up 向量 — 确保北向朝上
   * 对应 Cesium 在 update 结束时的正交基重建
   */
  private _maintainUpVector(): void {
    const camera = this.camera;
    camera.getWorldDirection(_scratchVec3A);
    const direction = _scratchVec3A;
    const right = _scratchVec3B.crossVectors(direction, CONSTRAINED_AXIS);
    if (right.lengthSq() < EPSILON6) {
      right.crossVectors(direction, new THREE.Vector3(1, 0, 0));
    }
    right.normalize();
    camera.up.crossVectors(right, direction).normalize();

    // Three.js 适配: up 改变后需通过 lookAt 刷新相机四元数
    const lookTarget = _scratchVec3C.addVectors(camera.position, direction);
    camera.lookAt(lookTarget);
  }

  // ==================== 事件绑定（对应 Cesium CameraEventAggregator） ====================

  private _bindEvents(): void {
    const el = this.domElement;
    el.addEventListener("mousedown", this._onMouseDown);
    el.addEventListener("mousemove", this._onMouseMove);
    el.addEventListener("mouseup", this._onMouseUp);
    el.addEventListener("mouseleave", this._onMouseLeave);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", this._onWheel, { passive: false });
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
  }

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this._isShiftDown = true;
  };
  private _onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this._isShiftDown = false;
  };

  private _onMouseDown = (event: MouseEvent): void => {
    if (!this.enableInputs) return;
    this.lastInteractionTime = performance.now();
    this._buttonPressTime = performance.now();

    if (event.button === 0) {
      this._isLeftDown = true;
      this._activeAction = this._isShiftDown ? "look" : "spin";
    } else if (event.button === 1) {
      event.preventDefault();
      this._isMiddleDown = true;
      this._activeAction = "tilt";
    } else if (event.button === 2) {
      event.preventDefault();
      this._isRightDown = true;
      this._activeAction = "zoom";
    }

    this._lastPosition.x = event.clientX;
    this._lastPosition.y = event.clientY;

    // 新拖拽开始时重置对应状态
    if (this._activeAction === "spin") {
      this._spinInertia = null;
      this._spinning = false;
      this._spinRotating = false;
      this._rotateMousePosition.x = -1;
      this._rotateMousePosition.y = -1;
    } else if (this._activeAction === "zoom") {
      this._zoomInertia = null;
    } else if (this._activeAction === "tilt") {
      this._tiltInertia = null;
      this._tiltCenterMousePosition.x = -1;
      this._tiltCenterMousePosition.y = -1;
    }
  };

  private _onMouseMove = (event: MouseEvent): void => {
    if (!this._activeAction) return;
    this.lastInteractionTime = performance.now();

    const movement: Movement = {
      startX: this._lastPosition.x,
      startY: this._lastPosition.y,
      endX: event.clientX,
      endY: event.clientY,
    };

    this._lastPosition.x = event.clientX;
    this._lastPosition.y = event.clientY;
    this._lastMovement = movement;

    switch (this._activeAction) {
      case "spin":
        this._spin3D(movement);
        break;
      case "zoom":
        this._zoom3D(movement);
        break;
      case "tilt":
        this._tilt3D(movement);
        break;
      case "look":
        this._look3D(movement);
        break;
    }
  };

  private _onMouseUp = (event: MouseEvent): void => {
    this.lastInteractionTime = performance.now();
    this._buttonReleaseTime = performance.now();

    if (
      this._activeAction === "spin" ||
      this._activeAction === "zoom" ||
      this._activeAction === "tilt"
    ) {
      this._recordInertia(this._activeAction);
    }

    if (event.button === 0) this._isLeftDown = false;
    else if (event.button === 1) this._isMiddleDown = false;
    else if (event.button === 2) this._isRightDown = false;

    if (!this._isLeftDown && !this._isMiddleDown && !this._isRightDown) {
      this._activeAction = null;
    }
  };

  private _onMouseLeave = (): void => {
    this._isLeftDown = false;
    this._isMiddleDown = false;
    this._isRightDown = false;
    this._activeAction = null;
  };

  /**
   * 滚轮缩放 — 对应 Cesium zoomEventTypes 中的 WHEEL
   *
   * Cesium 将滚轮 delta 转换为像素级 movement，然后调用 zoom3D。
   * 这里等价转换: delta ≈ scroll 步长 × 合理的像素比率
   */
  private _onWheel = (event: WheelEvent): void => {
    if (!this.enableInputs || !this.enableZoom) return;
    event.preventDefault();
    this.lastInteractionTime = performance.now();

    // Cesium CameraEventAggregator 对 wheel 的处理:
    // wheelDelta 映射到 startPosition/endPosition 的 y 差值
    // 标准 delta 约 ±120，Cesium 将其转换为像素差
    const canvas = this.domElement;
    const delta = -Math.sign(event.deltaY) * canvas.clientHeight * 0.05;

    const movement: Movement = {
      startX: canvas.clientWidth / 2,
      startY: canvas.clientHeight / 2,
      endX: canvas.clientWidth / 2,
      endY: canvas.clientHeight / 2 + delta,
    };

    this._zoom3D(movement);
  };
}
