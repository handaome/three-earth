import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import "./style.css";

const app = document.querySelector("#app");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02040b);

console.info("[Earth] init", {
  devicePixelRatio: window.devicePixelRatio,
  userAgent: navigator.userAgent
});

const earthRadius = 6371000;

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  100,
  earthRadius * 50
);
camera.position.set(0, 0, earthRadius * 2.2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

console.info("[Earth] renderer", {
  size: { width: window.innerWidth, height: window.innerHeight },
  maxAnisotropy: renderer.capabilities.getMaxAnisotropy()
});

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 50;
controls.maxDistance = earthRadius * 6;
controls.zoomSpeed = 1.5;

const ambient = new THREE.AmbientLight(0x8fb1d6, 0.75);
scene.add(ambient);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(earthRadius * 2.5, earthRadius * 1.2, earthRadius * 2);
scene.add(sunLight);

const overlay = document.createElement("div");
overlay.id = "overlay";
overlay.textContent =
  "Set VITE_TDT_TOKEN in .env to load Tianditu imagery.";
overlay.hidden = true;
document.body.appendChild(overlay);

window.addEventListener("error", (event) => {
  console.error("[Earth] window error", event.error || event.message);
  overlay.textContent = `Error: ${event.message || event.error}`;
  overlay.hidden = false;
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[Earth] unhandled rejection", event.reason);
  overlay.textContent = `Error: ${event.reason || "Unhandled rejection"}`;
  overlay.hidden = false;
});

const TDT_TOKEN = import.meta.env.VITE_TDT_TOKEN || "";
const DEFAULT_TDT_BASE_URL = import.meta.env.DEV
  ? "/tdt"
  : "https://t0.tianditu.gov.cn";
const TDT_BASE_URL =
  import.meta.env.VITE_TDT_BASE_URL || DEFAULT_TDT_BASE_URL;
const MIN_TILE_ZOOM = 3;
const MAX_TILE_ZOOM = 22;
const ZOOM_CHECK_INTERVAL = 300;
const TILE_SEGMENTS = 12;
const TILE_SURFACE_OFFSET = earthRadius * 0.001;
const ZOOM_CONSTANT = 16 * (earthRadius * 6);
const MAX_CONCURRENT_TILE_LOADS = 12;
let activeTileLoads = 0;
const pendingTileLoads = [];
const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();

const earthGeometry = new THREE.SphereGeometry(earthRadius, 64, 64);
const earthMaterial = new THREE.MeshStandardMaterial({
  color: 0x0f1b2d,
  roughness: 0.85,
  metalness: 0.0
});
const earthMesh = new THREE.Mesh(earthGeometry, earthMaterial);
scene.add(earthMesh);

const atmosphereGeometry = new THREE.SphereGeometry(earthRadius * 1.02, 64, 64);
const atmosphereMaterial = new THREE.MeshBasicMaterial({
  color: 0x3a76c4,
  transparent: true,
  opacity: 0.15,
  side: THREE.BackSide
});
const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
scene.add(atmosphere);

const stars = createStars(1200, earthRadius * 12);
scene.add(stars);

const tileGroup = new THREE.Group();
scene.add(tileGroup);

const markerGroup = new THREE.Group();
earthMesh.add(markerGroup);

const markerMaterial = new THREE.MeshStandardMaterial({
  color: 0xffc34d,
  roughness: 0.35,
  metalness: 0.1,
  emissive: new THREE.Color(0xff8c00),
  emissiveIntensity: 0.4
});
const markerGeometry = new THREE.SphereGeometry(earthRadius * 0.01, 24, 24);
const markerMesh = new THREE.Mesh(markerGeometry, markerMaterial);
markerMesh.visible = false;
markerGroup.add(markerMesh);

const tileTextureCache = new Map();
const tileMeshCache = new Map();
let currentZoom = null;
let lastZoomCheck = 0;
let tileRequestCount = 0;
let tileSuccessCount = 0;

const tileLoader = new THREE.TextureLoader();
tileLoader.setCrossOrigin("anonymous");

function getTileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

/** 处理瓦片加载队列，限制并发数 */
function processTileLoadQueue() {
  while (activeTileLoads < MAX_CONCURRENT_TILE_LOADS && pendingTileLoads.length > 0) {
    const task = pendingTileLoads.shift();
    activeTileLoads += 1;
    task();
  }
}

function loadTileTexture(z, x, y) {
  const key = getTileKey(z, x, y);
  if (tileTextureCache.has(key)) {
    return tileTextureCache.get(key);
  }

  const url =
    `${TDT_BASE_URL}/img_w/wmts?service=wmts&request=GetTile` +
    "&version=1.0.0&layer=img&style=default&tilematrixset=w" +
    `&format=tiles&tilematrix=${z}&tilerow=${y}&tilecol=${x}` +
    `&tk=${TDT_TOKEN}`;

  const promise = new Promise((resolve) => {
    const doLoad = () => {
      tileRequestCount += 1;
      tileLoader.load(
        url,
        (texture) => {
          tileSuccessCount += 1;
          activeTileLoads -= 1;
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
          texture.needsUpdate = true;
          resolve(texture);
          processTileLoadQueue();
        },
        undefined,
        (error) => {
          activeTileLoads -= 1;
          console.warn("[Earth] tile load failed", { z, x, y, error });
          resolve(null);
          processTileLoadQueue();
        }
      );
    };
    pendingTileLoads.push(doLoad);
    processTileLoadQueue();
  });

  tileTextureCache.set(key, promise);
  return promise;
}

function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom;
  const clampedLat = THREE.MathUtils.clamp(lat, -85.05112878, 85.05112878);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = THREE.MathUtils.degToRad(clampedLat);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y, n };
}

function lonLatToWorld(lon, lat, radius) {
  const clampedLat = THREE.MathUtils.clamp(lat, -89.999, 89.999);
  const latRad = THREE.MathUtils.degToRad(clampedLat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.cos(lonRad),
    radius * Math.sin(latRad),
    radius * Math.cos(latRad) * Math.sin(lonRad)
  );
}

function setEarthLocation(lon, lat, altitude = 0) {
  const radius = earthRadius + TILE_SURFACE_OFFSET + altitude;
  const position = lonLatToWorld(lon, lat, radius);
  markerMesh.position.copy(position);
  markerMesh.visible = true;
  return position.clone();
}

function focusCameraOnLonLat(lon, lat, altitude = earthRadius * 1.2) {
  const surface = lonLatToWorld(lon, lat, earthRadius + TILE_SURFACE_OFFSET);
  const normal = surface.clone().normalize();
  camera.position.copy(normal.clone().multiplyScalar(earthRadius + altitude));
  controls.target.set(0, 0, 0);
  controls.update();
}

function tileToLonLatBounds(x, y, zoom) {
  const n = 2 ** zoom;
  const lonMin = (x / n) * 360 - 180;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latMax =
    (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latMin =
    (180 / Math.PI) *
    Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return { lonMin, lonMax, latMin, latMax };
}

function createTileGeometry(bounds) {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  const widthSegments = TILE_SEGMENTS;
  const heightSegments = TILE_SEGMENTS;
  const vertices = [];
  const uvs = [];
  const indices = [];

  for (let iy = 0; iy <= heightSegments; iy += 1) {
    const v = iy / heightSegments;
    const lat = THREE.MathUtils.lerp(latMax, latMin, v);
    const latRad = THREE.MathUtils.degToRad(lat);

    for (let ix = 0; ix <= widthSegments; ix += 1) {
      const u = ix / widthSegments;
      const lon = THREE.MathUtils.lerp(lonMin, lonMax, u);
      const lonRad = THREE.MathUtils.degToRad(lon);
      const radius = earthRadius + TILE_SURFACE_OFFSET;

      const x = radius * Math.cos(latRad) * Math.cos(lonRad);
      const y = radius * Math.sin(latRad);
      const z = radius * Math.cos(latRad) * Math.sin(lonRad);

      vertices.push(x, y, z);
      uvs.push(u, 1 - v);
    }
  }

  const row = widthSegments + 1;
  for (let iy = 0; iy < heightSegments; iy += 1) {
    for (let ix = 0; ix < widthSegments; ix += 1) {
      const a = ix + row * iy;
      const b = ix + row * (iy + 1);
      const c = ix + 1 + row * (iy + 1);
      const d = ix + 1 + row * iy;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function ensureTileMesh(z, x, y) {
  const key = getTileKey(z, x, y);
  if (tileMeshCache.has(key)) {
    return tileMeshCache.get(key);
  }

  const bounds = tileToLonLatBounds(x, y, z);
  const geometry = createTileGeometry(bounds);
  const material = new THREE.MeshBasicMaterial({
    color: 0x1a2b46,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  mesh.userData.tileKey = key;
  mesh.userData.tileZoom = z;
  tileGroup.add(mesh);
  tileMeshCache.set(key, mesh);

  loadTileTexture(z, x, y).then((texture) => {
    if (!texture) return;
    // 砰认 mesh 未被销毁
    if (!tileMeshCache.has(key)) return;
    material.map = texture;
    material.color.set(0xffffff);
    material.needsUpdate = true;
  });

  return mesh;
}

function createStars(count, radius) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.7 + Math.random() * 0.3);

    const index = i * 3;
    positions[index] = r * Math.sin(phi) * Math.cos(theta);
    positions[index + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[index + 2] = r * Math.cos(phi);
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.2,
    sizeAttenuation: true,
    opacity: 0.8,
    transparent: true
  });

  return new THREE.Points(geometry, material);
}

function getZoomForDistance(distance) {
  const altitude = Math.max(distance - earthRadius, 1);
  const zoom = Math.floor(Math.log2(ZOOM_CONSTANT / altitude));
  return THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, MAX_TILE_ZOOM);
}

/** 计算瓦片中心点的世界坐标（用于视锥体裁剪） */
function tileCenterWorld(x, y, zoom) {
  const bounds = tileToLonLatBounds(x, y, zoom);
  const lat = (bounds.latMin + bounds.latMax) / 2;
  const lon = (bounds.lonMin + bounds.lonMax) / 2;
  const latRad = THREE.MathUtils.degToRad(lat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  const r = earthRadius + TILE_SURFACE_OFFSET;
  return new THREE.Vector3(
    r * Math.cos(latRad) * Math.cos(lonRad),
    r * Math.sin(latRad),
    r * Math.cos(latRad) * Math.sin(lonRad)
  );
}

/** 估算瓦片在球面上的包围球半径 */
function tileApproxRadius(zoom) {
  const n = 2 ** zoom;
  const angularSpan = (Math.PI * 2) / n;
  return earthRadius * angularSpan * 1.1;
}

/**
 * 获取当前视角下应加载的瓦片列表
 * 策略：从相机正下方开始，向外搜索直到超出可见半球
 */
function getVisibleTiles(zoom) {
  const safeZoom = THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, MAX_TILE_ZOOM);
  const n = 2 ** safeZoom;

  // 相机方向 → 中心瓦片
  const camDir = camera.position.clone().normalize();
  const centerLat = THREE.MathUtils.radToDeg(Math.asin(camDir.y));
  const centerLon = THREE.MathUtils.radToDeg(Math.atan2(camDir.z, camDir.x));
  const { x: cx, y: cy } = lonLatToTile(centerLon, centerLat, safeZoom);

  // 搜索半径：低层级搜整个半球，高层级限制范围以保性能
  const searchR = Math.min(Math.ceil(n / 2), Math.max(8, Math.ceil(n * 0.3)));

  const visible = [];

  for (let dy = -searchR; dy <= searchR; dy += 1) {
    const ty = cy + dy;
    if (ty < 0 || ty >= n) continue;
    for (let dx = -searchR; dx <= searchR; dx += 1) {
      const tx = ((cx + dx) % n + n) % n;
      const center = tileCenterWorld(tx, ty, safeZoom);

      // 背面剔除：瓦片法线与相机方向点积 < 阈值 则跳过
      const dotVal = center.x * camDir.x + center.y * camDir.y + center.z * camDir.z;
      // center 长度约为 earthRadius，归一化后比较
      const normalizedDot = dotVal / (earthRadius + TILE_SURFACE_OFFSET);
      if (normalizedDot < -0.2) continue;

      visible.push({ z: safeZoom, x: tx, y: ty });
    }
  }

  return visible;
}

function updateVisibleTiles(zoom) {
  if (!TDT_TOKEN) {
    overlay.textContent = "Set VITE_TDT_TOKEN in .env to load Tianditu imagery.";
    overlay.hidden = false;
    return;
  }

  overlay.hidden = true;
  const safeZoom = THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, MAX_TILE_ZOOM);
  const tiles = getVisibleTiles(safeZoom);

  const needed = new Set();
  for (const tile of tiles) {
    const key = getTileKey(tile.z, tile.x, tile.y);
    needed.add(key);
    ensureTileMesh(tile.z, tile.x, tile.y);
  }

  // 只清理不同 zoom 层级的瓦片，保留当前层级已加载的
  const toRemove = [];
  tileMeshCache.forEach((mesh, key) => {
    if (needed.has(key)) return;
    // 只移除不同 zoom 的瓦片，当前 zoom 的留着以备旋转时复用
    if (mesh.userData.tileZoom !== safeZoom) {
      toRemove.push(key);
    }
  });

  for (const key of toRemove) {
    const mesh = tileMeshCache.get(key);
    tileGroup.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material.map) mesh.material.map.dispose();
    mesh.material.dispose();
    tileMeshCache.delete(key);
  }

  // 纹理缓存只清理不同 zoom 的，避免重复下载
  tileTextureCache.forEach((_, key) => {
    const z = parseInt(key.split('/')[0], 10);
    if (z !== safeZoom && !needed.has(key)) {
      tileTextureCache.delete(key);
    }
  });

  currentZoom = safeZoom;
}

function animate() {
  const now = performance.now();
  if (now - lastZoomCheck > ZOOM_CHECK_INTERVAL) {
    const distance = camera.position.length();
    const altitude = Math.max(distance - earthRadius, 1);
    camera.near = Math.max(altitude * 0.1, 1);
    camera.far = Math.max(earthRadius * 50, distance * 10);
    camera.updateProjectionMatrix();
    const zoom = getZoomForDistance(distance);
    updateVisibleTiles(zoom);
    lastZoomCheck = now;
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

setInterval(() => {
  if (!TDT_TOKEN) return;
  if (tileRequestCount > 0 && tileSuccessCount === 0) {
    overlay.textContent =
      "Tianditu tiles failed. Check token/CORS/network in console.";
    overlay.hidden = false;
  }
}, 3000);

function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

window.addEventListener("resize", handleResize);

const DEFAULT_LON_LAT = { lon: 116.391, lat: 39.907 };
setEarthLocation(DEFAULT_LON_LAT.lon, DEFAULT_LON_LAT.lat);
focusCameraOnLonLat(DEFAULT_LON_LAT.lon, DEFAULT_LON_LAT.lat);

window.setEarthLocation = setEarthLocation;
window.focusCameraOnLonLat = focusCameraOnLonLat;

animate();
