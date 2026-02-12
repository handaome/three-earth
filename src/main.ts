/**
 * 应用入口
 * 负责初始化各模块并启动渲染循环，不包含具体业务逻辑
 */
import * as THREE from "three";
import "./style.css";

import {
  EARTH_RADIUS,
  TILE_SURFACE_OFFSET,
  DEFAULT_FOV,
  INITIAL_CAMERA_DISTANCE_FACTOR,
  VIEW_CHECK_INTERVAL,
  TILE_IDLE_DELAY,
  ZOOM_CHECK_INTERVAL,
  DEFAULT_LON_LAT,
} from "./constants";
import { CameraController } from "./core/camera-controls";
import { SkyManager } from "./core/sky";
import { EarthBuilder } from "./globe/earth";
import { TileManager } from "./globe/tile-manager";
import { HudManager } from "./ui/hud";
import { createStars } from "./utils/stars";
import { lonLatToWorld } from "./utils/geo";

// ==================== 容器校验 ====================

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container.");
}

console.info("[Earth] init", {
  devicePixelRatio: window.devicePixelRatio,
  userAgent: navigator.userAgent,
});

// ==================== 渲染器与相机 ====================

const camera = new THREE.PerspectiveCamera(
  DEFAULT_FOV,
  window.innerWidth / window.innerHeight,
  100,
  EARTH_RADIUS * 50
);
camera.position.set(0, 0, EARTH_RADIUS * INITIAL_CAMERA_DISTANCE_FACTOR);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

console.info("[Earth] renderer", {
  size: { width: window.innerWidth, height: window.innerHeight },
  maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
});

// ==================== 场景 ====================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02040b);

// 光照
const ambient = new THREE.AmbientLight(0x8fb1d6, 0.75);
scene.add(ambient);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(EARTH_RADIUS * 2.5, EARTH_RADIUS * 1.2, EARTH_RADIUS * 2);
scene.add(sunLight);

// 星空
const stars = createStars(1200, EARTH_RADIUS * 12);
scene.add(stars);

// ==================== 模块初始化 ====================

// 天空管理器
const skyManager = new SkyManager(scene);

// 相机控制器
const cameraController = new CameraController({
  camera,
  domElement: renderer.domElement,
});

// 地球构建器
const earthBuilder = new EarthBuilder();
scene.add(earthBuilder.globeGroup);

// 瓦片管理器
const tileManager = new TileManager(renderer);
earthBuilder.globeGroup.add(tileManager.tileGroup);

// HUD
const hudManager = new HudManager();
tileManager.setOverlay(hudManager.overlay);
hudManager.startTileFailureCheck(tileManager);

// ==================== 状态变量 ====================

let lastCameraDistance = camera.position.length();
let lastViewCheck = 0;
const lastCameraDir = new THREE.Vector3(0, 0, 1);
const lastGlobeQuat = new THREE.Quaternion();
let lastZoomCheck = 0;

// ==================== 公共方法 ====================

/**
 * 在地球表面设置标记点
 */
function setEarthLocation(lon: number, lat: number, altitude = 0): THREE.Vector3 {
  return earthBuilder.setEarthLocation(lon, lat, altitude);
}

/**
 * 将相机聚焦到指定经纬度
 * 直接设置相机位置并朝向球心（对应 Cesium Camera.setView 的简化版）
 */
function focusCameraOnLonLat(lon: number, lat: number, altitude = EARTH_RADIUS * 1.2): void {
  const surface = lonLatToWorld(lon, lat, EARTH_RADIUS + TILE_SURFACE_OFFSET);
  const normal = surface.clone().normalize();
  camera.position.copy(normal.clone().multiplyScalar(EARTH_RADIUS + altitude));
  // lookAt 球心，让相机朝向地球中心
  camera.lookAt(0, 0, 0);
  // 保持 up 向量与约束轴一致（北向朝上）
  camera.up.set(0, 0, 1);
}

// ==================== 渲染循环 ====================

function animate(): void {
  const now = performance.now();

  // 更新相机控制
  cameraController.update();

  // 计算距离与高度
  // 注意：底图瓦片渲染在 EARTH_RADIUS + TILE_SURFACE_OFFSET，近地体验/裁剪必须以“瓦片表面高度”为准
  const distance = camera.position.length();
  const surfaceRadius = EARTH_RADIUS + TILE_SURFACE_OFFSET;
  const altitude = Math.max(distance - EARTH_RADIUS, 0);
  const surfaceAltitude = Math.max(distance - surfaceRadius, 0);

  // 更新天空（更贴近地表时用 surfaceAltitude，避免 TILE_SURFACE_OFFSET 带来的高度偏差）
  skyManager.update(surfaceAltitude, scene, camera);

  // 瓦片 zoom 级别计算
  const desiredZoom = tileManager.getZoomForDistance(distance, camera);
  const hasPendingLoads =
    tileManager.activeTileLoads > 0 || tileManager.pendingTileLoads.length > 0;
  let zoom = desiredZoom;
  if (tileManager.currentZoom !== null) {
    if (hasPendingLoads && desiredZoom > tileManager.currentZoom) {
      zoom = tileManager.currentZoom;
    } else if (desiredZoom > tileManager.currentZoom + 1) {
      zoom = tileManager.currentZoom + 1;
    }
  }

  // 定时检查视野变化，按需更新瓦片
  const shouldCheckView = now - lastViewCheck > VIEW_CHECK_INTERVAL;
  if (shouldCheckView) {
    // 拖拽期间跳过瓦片更新
    if (now - cameraController.lastInteractionTime < TILE_IDLE_DELAY) {
      lastViewCheck = now;
      earthBuilder.updateGlow(camera.position);
      hudManager.update(now, distance, tileManager);
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
      return;
    }

    const camDir = camera.position.clone().normalize();
    const dirDelta = camDir.angleTo(lastCameraDir);
    const quatDelta =
      1 - Math.abs(lastGlobeQuat.dot(earthBuilder.globeGroup.quaternion));

    if (
      zoom !== tileManager.currentZoom ||
      dirDelta > 0.015 ||
      quatDelta > 0.002 ||
      Math.abs(distance - lastCameraDistance) > EARTH_RADIUS * 0.002
    ) {
      const globeQuatInverse = earthBuilder.globeGroup.quaternion.clone().invert();
      tileManager.updateVisibleTiles(zoom, camera, globeQuatInverse, () =>
        cameraController.pickGlobeTarget()
      );
      lastCameraDistance = distance;
      lastCameraDir.copy(camDir);
      lastGlobeQuat.copy(earthBuilder.globeGroup.quaternion);
    }

    lastViewCheck = now;
  }

  // 辉光更新
  earthBuilder.updateGlow(camera.position);

  // HUD 更新
  hudManager.update(now, distance, tileManager);

  // 动态 near/far 调整
  if (now - lastZoomCheck > ZOOM_CHECK_INTERVAL) {
    // Cesium 风格：near 不能大于“相机到最近地表”的量级，否则会把地球表面切掉
    const alt = Math.max(surfaceAltitude, 1);
    camera.near = Math.max(alt * 0.1, 0.5);
    camera.far = Math.max(EARTH_RADIUS * 50, distance * 10);
    camera.updateProjectionMatrix();
    lastZoomCheck = now;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// ==================== 初始化 ====================

// 响应式
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// 默认位置
setEarthLocation(DEFAULT_LON_LAT.lon, DEFAULT_LON_LAT.lat);
focusCameraOnLonLat(DEFAULT_LON_LAT.lon, DEFAULT_LON_LAT.lat);
tileManager.updateVisibleTiles(
  tileManager.getZoomForDistance(camera.position.length(), camera),
  camera,
  earthBuilder.globeGroup.quaternion.clone().invert(),
  () => cameraController.pickGlobeTarget()
);

// 确保初始相机距离在有效范围内
cameraController.clampCameraDistance();

// 暴露全局 API（供控制台调用）
(globalThis as { setEarthLocation?: typeof setEarthLocation }).setEarthLocation =
  setEarthLocation;
(globalThis as { focusCameraOnLonLat?: typeof focusCameraOnLonLat }).focusCameraOnLonLat =
  focusCameraOnLonLat;

// 启动渲染循环
animate();
