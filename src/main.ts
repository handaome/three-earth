import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container.");
}

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

const USE_ORBIT_CONTROLS = true;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.enableZoom = false;
controls.minPolarAngle = 0.25;
controls.maxPolarAngle = Math.PI - 0.25;
controls.minDistance = earthRadius + 20;
controls.maxDistance = earthRadius * 6;
controls.zoomSpeed = 1.5;
controls.enabled = USE_ORBIT_CONTROLS;

const fpControls = new PointerLockControls(camera, renderer.domElement);
const pointerNdc = new THREE.Vector2(0, 0);
const raycaster = new THREE.Raycaster();
const zoomDirection = new THREE.Vector3();

const MIN_CAMERA_DISTANCE = earthRadius + 20;
const MAX_CAMERA_DISTANCE = earthRadius * 6;
const WHEEL_SPEED_FACTOR = 0.18;
const MIN_WHEEL_SPEED = earthRadius * 0.00005;
const MAX_WHEEL_SPEED = earthRadius * 0.02;
const HUD_UPDATE_INTERVAL = 200;
const VIEW_CHECK_INTERVAL = 200;
const TILE_IDLE_DELAY = 260;
const SKY_FADE_ALTITUDE = earthRadius * 0.08;
const SKY_FOG_NEAR = earthRadius * 0.02;
const SKY_FOG_FAR = earthRadius * 0.14;
const SKY_FOV_NEAR = 36;
const SKY_FOV_FAR = 50;
const SPACE_COLOR = new THREE.Color(0x02040b);
const SKY_COLOR = new THREE.Color(0x6fb3ff);
const SKY_FOG_COLOR = new THREE.Color(0x9fd1ff);
const skyBlendColor = new THREE.Color(0x02040b);
const skyFog = new THREE.Fog(SKY_FOG_COLOR, SKY_FOG_NEAR, SKY_FOG_FAR);

let lastHudUpdate = 0;
let visibleTileCount = 0;
let hudVisible = true;
let lastCameraDistance = camera.position.length();
let lastViewCheck = 0;
let lastCameraDir = new THREE.Vector3(0, 0, 1);
let lastGlobeQuat = new THREE.Quaternion();
let lastInteractionTime = performance.now();

function clampCameraDistance() {
  const distance = camera.position.length();
  if (distance < MIN_CAMERA_DISTANCE) {
    camera.position.setLength(MIN_CAMERA_DISTANCE);
  } else if (distance > MAX_CAMERA_DISTANCE) {
    camera.position.setLength(MAX_CAMERA_DISTANCE);
  }
}

renderer.domElement.addEventListener("mousedown", (event: MouseEvent) => {
  if (event.button !== 1) return;
  fpControls.lock();
  lastInteractionTime = performance.now();
});

renderer.domElement.addEventListener("mouseup", (event: MouseEvent) => {
  if (event.button !== 1) return;
  fpControls.unlock();
  lastInteractionTime = performance.now();
});

let isRotatingGlobe = false;
const lastPointer = new THREE.Vector2();
const GLOBE_ROTATE_SPEED = 0.0026;
const MIN_ROTATE_SCALE = 0.1;
const ROTATE_DAMPING = 0.86;
const rotateVelocity = new THREE.Vector2();

renderer.domElement.addEventListener("mousedown", (event: MouseEvent) => {
  if (USE_ORBIT_CONTROLS) return;
  if (event.button !== 0 || fpControls.isLocked) return;
  isRotatingGlobe = true;
  lastPointer.set(event.clientX, event.clientY);
  lastInteractionTime = performance.now();
});

renderer.domElement.addEventListener("mousemove", (event: MouseEvent) => {
  if (!fpControls.isLocked) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }
  if (USE_ORBIT_CONTROLS) return;
  if (!isRotatingGlobe || fpControls.isLocked) return;
  const dx = event.clientX - lastPointer.x;
  const dy = event.clientY - lastPointer.y;
  lastPointer.set(event.clientX, event.clientY);
  const distance = camera.position.length();
  const altitude = Math.max(distance - earthRadius, 1);
  const rotateScale = THREE.MathUtils.clamp(
    altitude / (earthRadius * 0.8),
    MIN_ROTATE_SCALE,
    1
  );
  const rotateSpeed = GLOBE_ROTATE_SPEED * rotateScale;
  rotateVelocity.x += dx * rotateSpeed;
  rotateVelocity.y += dy * rotateSpeed;
  lastInteractionTime = performance.now();
  globeGroup.rotation.x = THREE.MathUtils.clamp(
    globeGroup.rotation.x,
    -Math.PI * 0.5 + 0.15,
    Math.PI * 0.5 - 0.15
  );
});

renderer.domElement.addEventListener("mouseup", (event: MouseEvent) => {
  if (event.button !== 0) return;
  isRotatingGlobe = false;
  lastInteractionTime = performance.now();
});

renderer.domElement.addEventListener("mouseleave", () => {
  isRotatingGlobe = false;
});

const ambient = new THREE.AmbientLight(0x8fb1d6, 0.75);
scene.add(ambient);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(earthRadius * 2.5, earthRadius * 1.2, earthRadius * 2);
scene.add(sunLight);

scene.fog = skyFog;

const overlay = document.createElement("div");
overlay.id = "overlay";
overlay.textContent = "Set VITE_TDT_TOKEN in .env to load Tianditu imagery.";
overlay.hidden = true;
document.body.appendChild(overlay);

const hud = document.createElement("div");
hud.id = "hud";
hud.textContent = "Loading earth...";
document.body.appendChild(hud);

window.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key.toLowerCase() !== "h") return;
  hudVisible = !hudVisible;
  hud.hidden = !hudVisible;
});

globalThis.addEventListener("error", (event: ErrorEvent) => {
  console.error("[Earth] window error", event.error || event.message);
  overlay.textContent = `Error: ${event.message || event.error}`;
  overlay.hidden = false;
});

globalThis.addEventListener(
  "unhandledrejection",
  (event: PromiseRejectionEvent) => {
    console.error("[Earth] unhandled rejection", event.reason);
    overlay.textContent = `Error: ${event.reason || "Unhandled rejection"}`;
    overlay.hidden = false;
  }
);

const TDT_TOKEN = import.meta.env.VITE_TDT_TOKEN || "";
const DEFAULT_TDT_BASE_URL = import.meta.env.DEV
  ? "/tdt"
  : "https://t0.tianditu.gov.cn";
const TDT_BASE_URL = import.meta.env.VITE_TDT_BASE_URL || DEFAULT_TDT_BASE_URL;
const MIN_TILE_ZOOM = 3;
const MAX_TILE_ZOOM = 22;
const ZOOM_CHECK_INTERVAL = 300;
const TILE_SEGMENTS = 12;
const TILE_SURFACE_OFFSET = earthRadius * 0.001;
const TARGET_TILE_PIXEL = 256;
const MAX_CONCURRENT_TILE_LOADS = 12;
const MAX_VISIBLE_TILES = 420;
const MAX_TEXTURE_REQUESTS_PER_UPDATE = 80;
const MAX_PENDING_LOADS = 120;
const MAX_TEXTURE_CACHE = 320;
const MAX_MESHES_PER_UPDATE = 60;
const MAX_TOTAL_TILE_MESHES = 180;
const SAFE_MAX_ZOOM = 11;
let activeTileLoads = 0;
const pendingTileLoads: Array<() => void> = [];

const globeGroup = new THREE.Group();
scene.add(globeGroup);
lastGlobeQuat.copy(globeGroup.quaternion);

const earthGeometry = new THREE.SphereGeometry(earthRadius, 64, 64);
const earthMaterial = new THREE.MeshStandardMaterial({
  color: 0x0f1b2d,
  roughness: 0.85,
  metalness: 0,
  emissive: new THREE.Color(0x05080f),
  emissiveIntensity: 0.35
});
const earthMesh = new THREE.Mesh(earthGeometry, earthMaterial);
globeGroup.add(earthMesh);

const atmosphereGeometry = new THREE.SphereGeometry(earthRadius * 1.02, 64, 64);
const atmosphereMaterial = new THREE.MeshBasicMaterial({
  color: 0x3a76c4,
  transparent: true,
  opacity: 0.15,
  side: THREE.BackSide
});
const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
globeGroup.add(atmosphere);

const glowGeometry = new THREE.SphereGeometry(earthRadius * 1.06, 64, 64);
const glowMaterial = new THREE.ShaderMaterial({
  uniforms: {
    viewVector: { value: camera.position.clone() },
    glowColor: { value: new THREE.Color(0x6aa7ff) },
    c: { value: 0.4 },
    p: { value: 2.7 }
  },
  vertexShader: `
    uniform vec3 viewVector;
    uniform float c;
    uniform float p;
    varying float intensity;
    void main() {
      vec3 vNormal = normalize(normalMatrix * normal);
      vec3 vNormel = normalize(normalMatrix * viewVector);
      intensity = pow(c - dot(vNormal, vNormel), p);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 glowColor;
    varying float intensity;
    void main() {
      vec3 color = glowColor * intensity;
      gl_FragColor = vec4(color, intensity);
    }
  `,
  side: THREE.BackSide,
  blending: THREE.AdditiveBlending,
  transparent: true
});
const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
globeGroup.add(glowMesh);

renderer.domElement.addEventListener(
  "wheel",
  (event: WheelEvent) => {
    event.preventDefault();
    lastInteractionTime = performance.now();
    const direction = event.deltaY > 0 ? -1 : 1;
    const distance = camera.position.length();
    const altitude = Math.max(distance - earthRadius, 1);
    const speed = THREE.MathUtils.clamp(
      altitude * WHEEL_SPEED_FACTOR,
      MIN_WHEEL_SPEED,
      MAX_WHEEL_SPEED
    );
    const moveDistance = speed * Math.abs(direction);

    if (fpControls.isLocked) {
      camera.getWorldDirection(zoomDirection);
    } else {
      zoomDirection.copy(camera.position).normalize();
    }

    camera.position.addScaledVector(zoomDirection, direction * moveDistance);
    clampCameraDistance();
  },
  { passive: false }
);

const stars = createStars(1200, earthRadius * 12);
scene.add(stars);

const tileGroup = new THREE.Group();
globeGroup.add(tileGroup);

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

const tileTextureCache = new Map<string, THREE.Texture>();
const tileTexturePromises = new Map<string, Promise<THREE.Texture | null>>();
const tileTextureBytes = new Map<string, number>();
const tileMeshCache = new Map<string, THREE.Mesh>();
let currentZoom: number | null = null;
let lastZoomCheck = 0;
let tileRequestCount = 0;
let tileSuccessCount = 0;

const tileLoader = new THREE.TextureLoader();
tileLoader.setCrossOrigin("anonymous");

function getTileKey(z: number, x: number, y: number) {
  return `${z}/${x}/${y}`;
}

function touchTextureCache(key: string) {
  const texture = tileTextureCache.get(key);
  if (!texture) return;
  tileTextureCache.delete(key);
  tileTextureCache.set(key, texture);
}

function trimTextureCache(limit: number) {
  for (const key of tileTextureCache.keys()) {
    if (tileTextureCache.size <= limit) break;
    if (tileMeshCache.has(key)) continue;
    const texture = tileTextureCache.get(key);
    if (texture) texture.dispose();
    tileTextureCache.delete(key);
    tileTextureBytes.delete(key);
  }
}

function formatDistance(meters: number) {
  if (meters >= 1000000) return `${(meters / 1000000).toFixed(2)} Mm`;
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${meters.toFixed(0)} m`;
}

function getMemoryInfo() {
  const memory = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (!memory) return "Memory: n/a";
  const usedMb = memory.usedJSHeapSize / (1024 * 1024);
  const limitMb = memory.jsHeapSizeLimit / (1024 * 1024);
  return `Memory: ${usedMb.toFixed(0)} / ${limitMb.toFixed(0)} MB`;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function estimateTextureBytes(texture: THREE.Texture) {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 256;
  const height = image?.height ?? 256;
  const base = width * height * 4;
  const mipFactor = texture.generateMipmaps ? 1.33 : 1;
  return Math.round(base * mipFactor);
}

function getTextureMemoryInfo() {
  let total = 0;
  tileTextureBytes.forEach((bytes) => {
    total += bytes;
  });
  return `GPU textures: ${tileTextureCache.size} | Est: ${formatBytes(total)}`;
}

function updateSkyAndCamera(altitude: number) {
  const t = THREE.MathUtils.clamp(1 - altitude / SKY_FADE_ALTITUDE, 0, 1);
  skyBlendColor.copy(SPACE_COLOR).lerp(SKY_COLOR, t);
  scene.background = skyBlendColor;

  if (t < 0.05) {
    scene.fog = null;
  } else {
    scene.fog = skyFog;
    skyFog.color.copy(SKY_FOG_COLOR).lerp(SPACE_COLOR, 1 - t);
    skyFog.near = SKY_FOG_NEAR * (1 - t) + earthRadius * 0.02 * t;
    skyFog.far = SKY_FOG_FAR * (1 - t) + earthRadius * 0.5 * t;
  }

  const targetFov = THREE.MathUtils.lerp(SKY_FOV_FAR, SKY_FOV_NEAR, t);
  if (Math.abs(camera.fov - targetFov) > 0.1) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }
}

function getTileSegmentsForZoom(zoom: number) {
  if (zoom >= 12) return 6;
  if (zoom >= 10) return 8;
  return TILE_SEGMENTS;
}

function updateHud(now: number) {
  if (!hudVisible) return;
  if (now - lastHudUpdate < HUD_UPDATE_INTERVAL) return;
  lastHudUpdate = now;

  const distance = camera.position.length();
  const altitude = Math.max(distance - earthRadius, 0);
  const zoomLabel = currentZoom === null ? "-" : String(currentZoom);
  const loadStatus =
    pendingTileLoads.length > 0 || activeTileLoads > 0 ? "refining" : "stable";

  hud.textContent = [
    "Cesium-style demo (Three.js)",
    `Zoom: ${zoomLabel} | Visible tiles: ${visibleTileCount} | ${loadStatus}`,
    `Tile loads: ${tileSuccessCount}/${tileRequestCount} | Active: ${activeTileLoads} | Queue: ${pendingTileLoads.length}`,
    `Altitude: ${formatDistance(altitude)} | Distance: ${formatDistance(distance)}`,
    getMemoryInfo(),
    getTextureMemoryInfo(),
    "Left drag: rotate | Middle: fly | Wheel: zoom | H: toggle HUD"
  ].join("\n");
}

function getMaxVisibleTiles(zoom: number) {
  if (zoom >= 13) return 40;
  if (zoom >= 12) return 60;
  if (zoom >= 11) return 80;
  if (zoom >= 10) return 200;
  return MAX_VISIBLE_TILES;
}

function getMaxTextureRequestsPerUpdate(zoom: number) {
  if (zoom >= 13) return 6;
  if (zoom >= 12) return 10;
  if (zoom >= 11) return 14;
  if (zoom >= 10) return 50;
  return MAX_TEXTURE_REQUESTS_PER_UPDATE;
}

/** 处理瓦片加载队列，限制并发数 */
function processTileLoadQueue() {
  while (activeTileLoads < MAX_CONCURRENT_TILE_LOADS && pendingTileLoads.length > 0) {
    const task = pendingTileLoads.shift();
    if (!task) break;
    activeTileLoads += 1;
    task();
  }
}

function loadTileTexture(z: number, x: number, y: number) {
  const key = getTileKey(z, x, y);
  if (tileTextureCache.has(key)) {
    touchTextureCache(key);
    return Promise.resolve(tileTextureCache.get(key) ?? null);
  }
  if (tileTexturePromises.has(key)) {
    return tileTexturePromises.get(key);
  }

  const url =
    `${TDT_BASE_URL}/img_w/wmts?service=wmts&request=GetTile` +
    "&version=1.0.0&layer=img&style=default&tilematrixset=w" +
    `&format=tiles&tilematrix=${z}&tilerow=${y}&tilecol=${x}` +
    `&tk=${TDT_TOKEN}`;

  const promise = new Promise<THREE.Texture | null>((resolve) => {
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
          tileTextureCache.set(key, texture);
          tileTextureBytes.set(key, estimateTextureBytes(texture));
          touchTextureCache(key);
          trimTextureCache(MAX_TEXTURE_CACHE);
          tileTexturePromises.delete(key);
          resolve(texture);
          processTileLoadQueue();
        },
        undefined,
        (error) => {
          activeTileLoads -= 1;
          console.warn("[Earth] tile load failed", { z, x, y, error });
          tileTexturePromises.delete(key);
          resolve(null);
          processTileLoadQueue();
        }
      );
    };
    pendingTileLoads.push(doLoad);
    processTileLoadQueue();
  });

  tileTexturePromises.set(key, promise);
  return promise;
}

function lonLatToTile(lon: number, lat: number, zoom: number) {
  const n = 2 ** zoom;
  const clampedLat = THREE.MathUtils.clamp(lat, -85.05112878, 85.05112878);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = THREE.MathUtils.degToRad(clampedLat);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y, n };
}

function lonLatToWorld(lon: number, lat: number, radius: number) {
  const clampedLat = THREE.MathUtils.clamp(lat, -89.999, 89.999);
  const latRad = THREE.MathUtils.degToRad(clampedLat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.cos(lonRad),
    radius * Math.sin(latRad),
    radius * Math.cos(latRad) * Math.sin(lonRad)
  );
}

function setEarthLocation(lon: number, lat: number, altitude = 0) {
  const radius = earthRadius + TILE_SURFACE_OFFSET + altitude;
  const position = lonLatToWorld(lon, lat, radius);
  markerMesh.position.copy(position);
  markerMesh.visible = true;
  return position.clone();
}

function focusCameraOnLonLat(lon: number, lat: number, altitude = earthRadius * 1.2) {
  const surface = lonLatToWorld(lon, lat, earthRadius + TILE_SURFACE_OFFSET);
  const normal = surface.clone().normalize();
  camera.position.copy(normal.clone().multiplyScalar(earthRadius + altitude));
  controls.target.set(0, 0, 0);
  controls.update();
}

function tileToLonLatBounds(x: number, y: number, zoom: number) {
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

function createTileGeometry(
  bounds: {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
  },
  segments: number
) {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  const widthSegments = segments;
  const heightSegments = segments;
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

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

function ensureTileMesh(z: number, x: number, y: number, shouldLoadTexture: boolean) {
  const key = getTileKey(z, x, y);
  if (tileMeshCache.has(key)) {
    const mesh = tileMeshCache.get(key);
    if (mesh && shouldLoadTexture) {
      const material = mesh.material;
      if (material instanceof THREE.MeshBasicMaterial && !material.map) {
        if (pendingTileLoads.length < MAX_PENDING_LOADS) {
          loadTileTexture(z, x, y).then((texture) => {
            if (!texture) return;
            if (!tileMeshCache.has(key)) return;
            material.map = texture;
            material.color.set(0xffffff);
            material.needsUpdate = true;
          });
        }
      }
    }
    return mesh;
  }

  const bounds = tileToLonLatBounds(x, y, z);
  const geometry = createTileGeometry(bounds, getTileSegmentsForZoom(z));
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

  if (shouldLoadTexture && pendingTileLoads.length < MAX_PENDING_LOADS) {
    loadTileTexture(z, x, y).then((texture) => {
      if (!texture) return;
      if (!tileMeshCache.has(key)) return;
      material.map = texture;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    });
  }

  return mesh;
}

function createStars(count: number, radius: number) {
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

function getZoomForDistance(distance: number) {
  const altitude = Math.max(distance - earthRadius, 1);
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const viewHeight = Math.max(window.innerHeight, 1);
  const projectedPixelAngle = fovRad / viewHeight;
  const tileGroundSize = altitude * projectedPixelAngle * TARGET_TILE_PIXEL;
  const zoom = Math.floor(
    Math.log2((Math.PI * 2 * earthRadius) / Math.max(tileGroundSize, 1))
  );
  return THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, SAFE_MAX_ZOOM);
}

/** 计算瓦片中心点的世界坐标（用于视锥体裁剪） */
function tileCenterWorld(x: number, y: number, zoom: number) {
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

/**
 * 获取当前视角下应加载的瓦片列表
 * 策略：根据视角覆盖角度推算搜索半径，避免高层级全局加载
 */
function getVisibleTiles(zoom: number) {
  const safeZoom = THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, MAX_TILE_ZOOM);
  const n = 2 ** safeZoom;

  const camDir = camera.position.clone().normalize();
  const localCamDir = camDir
    .clone()
    .applyQuaternion(globeGroup.quaternion.clone().invert());
  const centerLat = THREE.MathUtils.radToDeg(Math.asin(localCamDir.y));
  const centerLon = THREE.MathUtils.radToDeg(
    Math.atan2(localCamDir.z, localCamDir.x)
  );
  const { x: cx, y: cy } = lonLatToTile(centerLon, centerLat, safeZoom);

  const safeDistance = Math.max(camera.position.length(), earthRadius + 1);
  const ratio = earthRadius / safeDistance;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const aspect = camera.aspect || window.innerWidth / window.innerHeight;
  const vSpan = 2 * Math.asin(Math.min(1, Math.tan(fovRad / 2) * ratio));
  const hSpan =
    2 * Math.asin(Math.min(1, Math.tan(fovRad / 2) * aspect * ratio));
  const span = Math.max(vSpan, hSpan);
  const maxAngle = Math.min(Math.PI * 0.7, span * 0.6);

  const tileAngle = (Math.PI * 2) / n;
  const tilesAcross = Math.max(3, Math.ceil((maxAngle / tileAngle) * 1.6));
  const searchR = Math.min(Math.ceil(n / 2), tilesAcross);

  const visible: Array<{ z: number; x: number; y: number; angle: number }> = [];

  for (let dy = -searchR; dy <= searchR; dy += 1) {
    const ty = cy + dy;
    if (ty < 0 || ty >= n) continue;
    for (let dx = -searchR; dx <= searchR; dx += 1) {
      const tx = ((cx + dx) % n + n) % n;
      const center = tileCenterWorld(tx, ty, safeZoom);

      const dotVal =
        center.x * localCamDir.x +
        center.y * localCamDir.y +
        center.z * localCamDir.z;
      const normalizedDot = dotVal / (earthRadius + TILE_SURFACE_OFFSET);
      if (normalizedDot < 0) continue;

      const angle = Math.acos(THREE.MathUtils.clamp(normalizedDot, -1, 1));
      if (angle > maxAngle) continue;

      visible.push({ z: safeZoom, x: tx, y: ty, angle });
    }
  }

  visible.sort((a, b) => a.angle - b.angle);
  return visible
    .slice(0, getMaxVisibleTiles(safeZoom))
    .map(({ z, x, y }) => ({ z, x, y }));
}

function updateVisibleTiles(zoom: number) {
  if (!TDT_TOKEN) {
    overlay.textContent = "Set VITE_TDT_TOKEN in .env to load Tianditu imagery.";
    overlay.hidden = false;
    return;
  }

  overlay.hidden = true;
  const safeZoom = THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, MAX_TILE_ZOOM);
  const tiles = getVisibleTiles(safeZoom);
  visibleTileCount = tiles.length;

  const needed = new Set<string>();
  const requestBudget = getMaxTextureRequestsPerUpdate(safeZoom);
  const allowTextureRequests = pendingTileLoads.length < MAX_PENDING_LOADS;
  let createdCount = 0;
  const meshCapReached = tileMeshCache.size >= MAX_TOTAL_TILE_MESHES;
  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i];
    const key = getTileKey(tile.z, tile.x, tile.y);
    needed.add(key);
    const shouldLoadTexture = allowTextureRequests && i < requestBudget;
    const shouldCreateMesh = createdCount < MAX_MESHES_PER_UPDATE;
    const existed = tileMeshCache.has(key);
    if ((shouldCreateMesh && !meshCapReached) || existed) {
      ensureTileMesh(tile.z, tile.x, tile.y, shouldLoadTexture);
      if (shouldCreateMesh && !existed) {
        createdCount += 1;
      }
    }
  }

  const toRemove: string[] = [];
  tileMeshCache.forEach((mesh, key) => {
    if (needed.has(key)) return;
    toRemove.push(key);
  });

  for (const key of toRemove) {
    const mesh = tileMeshCache.get(key);
    if (!mesh) continue;
    tileGroup.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material instanceof THREE.Material && mesh.material.map) {
      mesh.material.map.dispose();
    }
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) {
        if (material.map) material.map.dispose();
        material.dispose();
      }
    } else {
      mesh.material.dispose();
    }
    if (tileTextureCache.has(key)) {
      const texture = tileTextureCache.get(key);
      if (texture) texture.dispose();
      tileTextureCache.delete(key);
      tileTextureBytes.delete(key);
    }
    tileTexturePromises.delete(key);
    tileMeshCache.delete(key);
  }

  tileTextureCache.forEach((_, key) => {
    const z = Number.parseInt(key.split("/")[0], 10);
    if (z !== safeZoom && !needed.has(key)) {
      const texture = tileTextureCache.get(key);
      if (texture) texture.dispose();
      tileTextureCache.delete(key);
      tileTextureBytes.delete(key);
    }
  });

  currentZoom = safeZoom;
}

function animate() {
  const now = performance.now();

  if (rotateVelocity.lengthSq() > 0.0000001) {
    globeGroup.rotation.y += rotateVelocity.x;
    globeGroup.rotation.x += rotateVelocity.y;
    globeGroup.rotation.x = THREE.MathUtils.clamp(
      globeGroup.rotation.x,
      -Math.PI * 0.5 + 0.15,
      Math.PI * 0.5 - 0.15
    );
    rotateVelocity.multiplyScalar(ROTATE_DAMPING);
  }

  if (USE_ORBIT_CONTROLS && !fpControls.isLocked) {
    controls.update();
  }

  const distance = camera.position.length();
  const altitude = Math.max(distance - earthRadius, 0);
  updateSkyAndCamera(altitude);
  const desiredZoom = getZoomForDistance(distance);
  const hasPendingLoads = activeTileLoads > 0 || pendingTileLoads.length > 0;
  let zoom = desiredZoom;
  if (currentZoom !== null) {
    if (hasPendingLoads && desiredZoom > currentZoom) {
      zoom = currentZoom;
    } else if (desiredZoom > currentZoom + 1) {
      zoom = currentZoom + 1;
    }
  }
  const nowCheck = now - lastViewCheck > VIEW_CHECK_INTERVAL;
  if (nowCheck) {
    if (now - lastInteractionTime < TILE_IDLE_DELAY) {
      lastViewCheck = now;
      glowMaterial.uniforms.viewVector.value.copy(camera.position);
      updateHud(now);
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
      return;
    }

    const camDir = camera.position.clone().normalize();
    const dirDelta = camDir.angleTo(lastCameraDir);
    const quatDelta = 1 - Math.abs(lastGlobeQuat.dot(globeGroup.quaternion));

    if (
      zoom !== currentZoom ||
      dirDelta > 0.015 ||
      quatDelta > 0.002 ||
      Math.abs(distance - lastCameraDistance) > earthRadius * 0.002
    ) {
      updateVisibleTiles(zoom);
      lastCameraDistance = distance;
      lastCameraDir.copy(camDir);
      lastGlobeQuat.copy(globeGroup.quaternion);
    }

    lastViewCheck = now;
  }

  glowMaterial.uniforms.viewVector.value.copy(camera.position);
  updateHud(now);

  if (now - lastZoomCheck > ZOOM_CHECK_INTERVAL) {
    const altitude = Math.max(distance - earthRadius, 1);
    camera.near = Math.max(altitude * 0.1, 1);
    camera.far = Math.max(earthRadius * 50, distance * 10);
    camera.updateProjectionMatrix();
    lastZoomCheck = now;
  }

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
updateVisibleTiles(getZoomForDistance(camera.position.length()));

(globalThis as { setEarthLocation?: typeof setEarthLocation }).setEarthLocation =
  setEarthLocation;
(globalThis as { focusCameraOnLonLat?: typeof focusCameraOnLonLat }).focusCameraOnLonLat =
  focusCameraOnLonLat;

animate();
