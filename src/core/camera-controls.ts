/**
 * 相机控制器
 * 封装 Cesium 风格的鼠标交互：左键旋转、中键倾斜、右键缩放、滚轮缩放
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import {
  EARTH_RADIUS,
  TILE_SURFACE_OFFSET,
  MIN_CAMERA_DISTANCE,
  MAX_CAMERA_DISTANCE,
  WHEEL_SPEED_FACTOR,
  MIN_WHEEL_SPEED,
  MAX_WHEEL_SPEED,
  CAMERA_ROTATE_SPEED,
  CAMERA_MIN_POLAR,
  CAMERA_MAX_POLAR,
  MIDDLE_TILT_SPEED,
  RIGHT_ZOOM_FACTOR,
  MIN_TILT_ANGLE,
  MAX_TILT_ANGLE,
  WORLD_NORTH,
  WORLD_EAST,
  CAMERA_UP_EPSILON,
} from "../constants";

/** 相机控制器选项 */
interface CameraControlsOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLCanvasElement;
  /** 是否启用 OrbitControls（默认 false，使用自定义控制） */
  useOrbitControls?: boolean;
}

/**
 * CameraController 封装了 Cesium 风格的相机交互逻辑。
 * - 左键拖拽：绕目标点旋转
 * - 中键拖拽：倾斜视角
 * - 右键拖拽：推拉缩放
 * - 滚轮：朝视线方向缩放
 */
export class CameraController {
  /** Three.js 相机 */
  readonly camera: THREE.PerspectiveCamera;

  /** OrbitControls（用于备选模式） */
  readonly orbitControls: OrbitControls;

  /** PointerLockControls（第一人称备用） */
  readonly fpControls: PointerLockControls;

  /** 当前相机注视目标点 */
  readonly cameraTarget = new THREE.Vector3();

  /** 最后一次交互时间戳 */
  lastInteractionTime = performance.now();

  // ---------- 内部状态 ----------
  private isRotating = false;
  private isTilting = false;
  private isZooming = false;
  private readonly lastPointer = new THREE.Vector2();
  private readonly interactionTarget = new THREE.Vector3();
  private readonly targetOffset = new THREE.Vector3();
  private readonly cameraSpherical = new THREE.Spherical();
  private readonly pointerNdc = new THREE.Vector2(0, 0);
  private readonly zoomDirection = new THREE.Vector3();

  // 临时计算向量（避免频繁分配）
  private readonly _cameraDirection = new THREE.Vector3();
  private readonly _cameraRight = new THREE.Vector3();
  private readonly _cameraUp = new THREE.Vector3();
  private readonly _tiltNormal = new THREE.Vector3();
  private readonly _tiltDirection = new THREE.Vector3();
  private readonly _tiltRight = new THREE.Vector3();
  private readonly _tiltQuat = new THREE.Quaternion();

  private readonly domElement: HTMLCanvasElement;
  private readonly useOrbitControls: boolean;

  constructor(options: CameraControlsOptions) {
    this.camera = options.camera;
    this.domElement = options.domElement;
    this.useOrbitControls = options.useOrbitControls ?? false;

    // 初始化 OrbitControls
    this.orbitControls = new OrbitControls(this.camera, this.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.enablePan = false;
    this.orbitControls.enableZoom = false;
    this.orbitControls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.orbitControls.minPolarAngle = CAMERA_MIN_POLAR;
    this.orbitControls.maxPolarAngle = CAMERA_MAX_POLAR;
    this.orbitControls.minDistance = MIN_CAMERA_DISTANCE;
    this.orbitControls.maxDistance = MAX_CAMERA_DISTANCE;
    this.orbitControls.zoomSpeed = 1.5;
    this.orbitControls.enabled = this.useOrbitControls;
    this.orbitControls.target.set(0, 0, 0);

    // 初始化 PointerLockControls
    this.fpControls = new PointerLockControls(this.camera, this.domElement);

    this._bindEvents();
  }

  /** 获取当前 NDC 坐标（用于射线拾取等） */
  get ndc(): THREE.Vector2 {
    return this.pointerNdc;
  }

  /** 将相机距离限制在有效范围内 */
  clampCameraDistance(): void {
    const distance = this.camera.position.length();
    if (distance < MIN_CAMERA_DISTANCE) {
      this.camera.position.setLength(MIN_CAMERA_DISTANCE);
    } else if (distance > MAX_CAMERA_DISTANCE) {
      this.camera.position.setLength(MAX_CAMERA_DISTANCE);
    }
  }

  /**
   * 保持 Cesium 风格：north-up，但允许 tilt
   */
  alignCameraToGlobe(): void {
    this.camera.getWorldDirection(this._cameraDirection);
    this._cameraRight.crossVectors(this._cameraDirection, WORLD_NORTH);
    if (this._cameraRight.lengthSq() < CAMERA_UP_EPSILON) {
      this._cameraRight.crossVectors(this._cameraDirection, WORLD_EAST);
    }
    this._cameraRight.normalize();
    this._cameraUp.crossVectors(this._cameraRight, this._cameraDirection).normalize();
    this.camera.up.copy(this._cameraUp);
  }

  /**
   * 射线与地球求交，获取相机注视点
   * @returns 交点世界坐标，若无交点返回 null
   */
  pickGlobeTarget(): THREE.Vector3 | null {
    const radius = EARTH_RADIUS + TILE_SURFACE_OFFSET;
    const origin = this.camera.position;
    this.camera.getWorldDirection(this._cameraDirection);
    const b = origin.dot(this._cameraDirection);
    const c = origin.dot(origin) - radius * radius;
    const d = b * b - c;
    if (d < 0) return null;
    const sqrtD = Math.sqrt(d);
    let t = -b - sqrtD;
    if (t < 0) t = -b + sqrtD;
    if (t < 0) return null;
    return origin.clone().addScaledVector(this._cameraDirection, t);
  }

  /**
   * 每帧调用：更新 OrbitControls、lookAt、对齐
   */
  update(): void {
    const shouldAlign = !this.fpControls.isLocked;
    if (this.useOrbitControls && shouldAlign) {
      this.orbitControls.update();
    }
    if (shouldAlign) {
      this.camera.lookAt(this.cameraTarget);
      this.alignCameraToGlobe();
    }
  }

  // ==================== 私有方法 ====================

  /** 设置交互目标点（鼠标按下时调用） */
  private setInteractionTarget(): void {
    const picked = this.pickGlobeTarget();
    if (picked) {
      this.interactionTarget.copy(picked);
    } else {
      this.interactionTarget
        .copy(this.camera.position)
        .normalize()
        .multiplyScalar(EARTH_RADIUS);
    }
    this.cameraTarget.copy(this.interactionTarget);
    this.targetOffset.copy(this.camera.position).sub(this.interactionTarget);
    this.cameraSpherical.setFromVector3(this.targetOffset);
  }

  /** 围绕目标点执行旋转 + 倾斜 */
  private rotateAroundTarget(dx: number, dy: number): void {
    this._tiltNormal.copy(this.interactionTarget).normalize();
    this.targetOffset.copy(this.camera.position).sub(this.interactionTarget);
    this._tiltDirection.copy(this.targetOffset).normalize().negate();
    this._tiltRight.crossVectors(this._tiltNormal, this._tiltDirection);
    if (this._tiltRight.lengthSq() < CAMERA_UP_EPSILON) return;
    this._tiltRight.normalize();

    // 水平旋转（绕法线）
    this._tiltQuat.setFromAxisAngle(this._tiltNormal, -dx * CAMERA_ROTATE_SPEED);
    this.targetOffset.applyQuaternion(this._tiltQuat);

    // 垂直倾斜
    this._tiltQuat.setFromAxisAngle(this._tiltRight, dy * MIDDLE_TILT_SPEED);
    this.targetOffset.applyQuaternion(this._tiltQuat);

    // 限制俯仰角
    this._tiltDirection.copy(this.targetOffset).normalize().negate();
    const pitch = Math.acos(
      THREE.MathUtils.clamp(this._tiltDirection.dot(this._tiltNormal), -1, 1)
    );
    const clampedPitch = THREE.MathUtils.clamp(pitch, MIN_TILT_ANGLE, MAX_TILT_ANGLE);
    const pitchDelta = clampedPitch - pitch;
    if (Math.abs(pitchDelta) > 1e-5) {
      this._tiltQuat.setFromAxisAngle(this._tiltRight, pitchDelta);
      this.targetOffset.applyQuaternion(this._tiltQuat);
    }

    this.camera.position.copy(this.interactionTarget).add(this.targetOffset);
    this.cameraTarget.copy(this.interactionTarget);
  }

  /** 绑定所有鼠标/键盘事件 */
  private _bindEvents(): void {
    const el = this.domElement;

    el.addEventListener("mousedown", this._onMouseDown);
    el.addEventListener("mousemove", this._onMouseMove);
    el.addEventListener("mouseup", this._onMouseUp);
    el.addEventListener("mouseleave", this._onMouseLeave);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", this._onWheel, { passive: false });
  }

  private _onMouseDown = (event: MouseEvent): void => {
    if (this.fpControls.isLocked) return;
    if (event.button === 1) {
      event.preventDefault();
      this.isTilting = true;
    } else if (event.button === 2) {
      event.preventDefault();
      this.isZooming = true;
    } else if (event.button === 0) {
      this.isRotating = true;
    } else {
      return;
    }
    this.lastPointer.set(event.clientX, event.clientY);
    this.setInteractionTarget();
    this.lastInteractionTime = performance.now();
  };

  private _onMouseMove = (event: MouseEvent): void => {
    // 更新 NDC 指针坐标
    if (!this.fpControls.isLocked) {
      const rect = this.domElement.getBoundingClientRect();
      this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer.set(event.clientX, event.clientY);

    // 中键倾斜
    if (this.isTilting && !this.fpControls.isLocked) {
      this.rotateAroundTarget(dx, dy);
      this.lastInteractionTime = performance.now();
      return;
    }

    // 右键推拉缩放
    if (this.isZooming && !this.fpControls.isLocked) {
      const altitude = Math.max(this.cameraSpherical.radius - EARTH_RADIUS, 1);
      const zoomSpeed = THREE.MathUtils.clamp(
        altitude * RIGHT_ZOOM_FACTOR,
        MIN_WHEEL_SPEED * 0.2,
        MAX_WHEEL_SPEED * 0.9
      );
      this.cameraSpherical.radius = THREE.MathUtils.clamp(
        this.cameraSpherical.radius + dy * zoomSpeed,
        MIN_CAMERA_DISTANCE,
        MAX_CAMERA_DISTANCE
      );
      this.camera.position
        .setFromSpherical(this.cameraSpherical)
        .add(this.interactionTarget);
      this.cameraTarget.copy(this.interactionTarget);
      this.lastInteractionTime = performance.now();
      return;
    }

    // 左键旋转
    if (!this.isRotating || this.fpControls.isLocked) return;
    this.cameraSpherical.theta -= dx * CAMERA_ROTATE_SPEED;
    this.cameraSpherical.phi = THREE.MathUtils.clamp(
      this.cameraSpherical.phi - dy * CAMERA_ROTATE_SPEED,
      CAMERA_MIN_POLAR,
      CAMERA_MAX_POLAR
    );
    this.camera.position
      .setFromSpherical(this.cameraSpherical)
      .add(this.interactionTarget);
    this.cameraTarget.copy(this.interactionTarget);
    this.lastInteractionTime = performance.now();
  };

  private _onMouseUp = (event: MouseEvent): void => {
    if (event.button === 1) this.isTilting = false;
    else if (event.button === 2) this.isZooming = false;
    else if (event.button === 0) this.isRotating = false;
    this.lastInteractionTime = performance.now();
  };

  private _onMouseLeave = (): void => {
    this.isRotating = false;
    this.isTilting = false;
    this.isZooming = false;
  };

  private _onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.lastInteractionTime = performance.now();

    const direction = event.deltaY > 0 ? -1 : 1;
    const distance = this.camera.position.length();
    const altitude = Math.max(distance - EARTH_RADIUS, 1);
    const speed = THREE.MathUtils.clamp(
      altitude * WHEEL_SPEED_FACTOR,
      MIN_WHEEL_SPEED,
      MAX_WHEEL_SPEED
    );
    const moveDistance = speed * Math.abs(direction);

    if (this.fpControls.isLocked) {
      this.camera.getWorldDirection(this.zoomDirection);
    } else {
      this.zoomDirection
        .copy(this.cameraTarget)
        .sub(this.camera.position)
        .normalize();
      if (this.zoomDirection.lengthSq() < 1e-6) {
        this.zoomDirection.copy(this.camera.position).normalize();
      }
    }

    this.camera.position.addScaledVector(this.zoomDirection, direction * moveDistance);
    this.clampCameraDistance();
  };
}
