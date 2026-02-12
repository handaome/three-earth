/**
 * 瓦片管理器
 * 负责瓦片纹理加载、缓存、几何体创建、可见区域计算与更新
 * 严格参考 Cesium 的 QuadtreeTile / ImageryLayer 分层思想
 */
import * as THREE from "three";
import {
  EARTH_RADIUS,
  TILE_SURFACE_OFFSET,
  MIN_TILE_ZOOM,
  MAX_TILE_ZOOM,
  SAFE_MAX_ZOOM,
  TILE_SEGMENTS,
  TARGET_TILE_PIXEL,
  MAX_CONCURRENT_TILE_LOADS,
  MAX_VISIBLE_TILES,
  MAX_TEXTURE_REQUESTS_PER_UPDATE,
  MAX_PENDING_LOADS,
  MAX_TEXTURE_CACHE,
  MAX_MESHES_PER_UPDATE,
  MAX_TOTAL_TILE_MESHES,
  TDT_TOKEN,
  TDT_BASE_URL,
} from "../constants";
import type { TileBounds, TileCoord, VisibleTile } from "../types";
import {
  cartesianToLonLat,
  latRadFromMercatorY,
  lonLatToTile,
  mercatorYFromLatRad,
  tileToLonLatBounds,
  tileCenterWorld,
} from "../utils/geo";
import { formatBytes } from "../utils/format";

const _scratchViewDir = new THREE.Vector3();
const _scratchRaycaster = new THREE.Raycaster();
const _scratchNdc = new THREE.Vector2();
const _scratchPickRay = new THREE.Ray();
const _scratchPickPoint = new THREE.Vector3();
const _scratchTileCenterDir = new THREE.Vector3();

function getPickRayAtNdc(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  outRay: THREE.Ray,
): THREE.Ray {
  _scratchNdc.set(ndcX, ndcY);
  camera.updateMatrixWorld(true);
  _scratchRaycaster.setFromCamera(_scratchNdc, camera);
  outRay.origin.copy(_scratchRaycaster.ray.origin);
  outRay.direction.copy(_scratchRaycaster.ray.direction);
  return outRay;
}

/** 射线-球体求交（返回最近的正向交点） */
function raySphereIntersection(ray: THREE.Ray, radius: number, out: THREE.Vector3): THREE.Vector3 | null {
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
  return out.copy(origin).addScaledVector(direction, t);
}

/**
 * TileManager 管理瓦片的生命周期：加载、创建、显示、回收。
 */
export class TileManager {
  /** 瓦片 mesh 所在的 Group */
  readonly tileGroup = new THREE.Group();

  /** 当前缩放级别 */
  currentZoom: number | null = null;

  /** 当前可见瓦片数量 */
  visibleTileCount = 0;

  /** 瓦片请求总数 */
  tileRequestCount = 0;

  /** 瓦片加载成功总数 */
  tileSuccessCount = 0;

  /** 当前正在加载的瓦片数 */
  activeTileLoads = 0;

  /** 待加载队列 */
  readonly pendingTileLoads: Array<() => void> = [];

  // ---------- 缓存 ----------
  private readonly textureCache = new Map<string, THREE.Texture>();
  private readonly texturePromises = new Map<string, Promise<THREE.Texture | null>>();
  private readonly textureBytes = new Map<string, number>();
  private readonly meshCache = new Map<string, THREE.Mesh>();
  private readonly tileLoader = new THREE.TextureLoader();

  /** 渲染器引用（用于获取各向异性过滤等信息） */
  private readonly renderer: THREE.WebGLRenderer;

  /** overlay 元素引用，用于提示信息 */
  private overlay: HTMLDivElement | null = null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.tileLoader.setCrossOrigin("anonymous");
  }

  /** 设置 overlay 元素引用 */
  setOverlay(el: HTMLDivElement): void {
    this.overlay = el;
  }

  // ==================== 纹理加载 ====================

  /** 处理瓦片加载队列，限制并发数 */
  processTileLoadQueue(): void {
    while (this.activeTileLoads < MAX_CONCURRENT_TILE_LOADS && this.pendingTileLoads.length > 0) {
      const task = this.pendingTileLoads.shift();
      if (!task) break;
      this.activeTileLoads += 1;
      task();
    }
  }

  /** 加载单个瓦片纹理 */
  loadTileTexture(z: number, x: number, y: number): Promise<THREE.Texture | null> {
    const key = getTileKey(z, x, y);

    // 命中缓存
    if (this.textureCache.has(key)) {
      this.touchTextureCache(key);
      return Promise.resolve(this.textureCache.get(key) ?? null);
    }

    // 正在加载中
    if (this.texturePromises.has(key)) {
      return this.texturePromises.get(key)!;
    }

    const url =
      `${TDT_BASE_URL}/img_w/wmts?service=wmts&request=GetTile` +
      "&version=1.0.0&layer=img&style=default&tilematrixset=w" +
      `&format=tiles&tilematrix=${z}&tilerow=${y}&tilecol=${x}` +
      `&tk=${TDT_TOKEN}`;

    const promise = new Promise<THREE.Texture | null>((resolve) => {
      const doLoad = () => {
        this.tileRequestCount += 1;
        this.tileLoader.load(
          url,
          (texture) => {
            this.tileSuccessCount += 1;
            this.activeTileLoads -= 1;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
            texture.needsUpdate = true;
            this.textureCache.set(key, texture);
            this.textureBytes.set(key, estimateTextureBytes(texture));
            this.touchTextureCache(key);
            this.trimTextureCache(MAX_TEXTURE_CACHE);
            this.texturePromises.delete(key);
            resolve(texture);
            this.processTileLoadQueue();
          },
          undefined,
          (error) => {
            this.activeTileLoads -= 1;
            console.warn("[Earth] tile load failed", { z, x, y, error });
            this.texturePromises.delete(key);
            resolve(null);
            this.processTileLoadQueue();
          }
        );
      };
      this.pendingTileLoads.push(doLoad);
      this.processTileLoadQueue();
    });

    this.texturePromises.set(key, promise);
    return promise;
  }

  // ==================== 瓦片 Mesh ====================

  /** 确保指定瓦片的 Mesh 已创建，按需加载纹理 */
  ensureTileMesh(z: number, x: number, y: number, shouldLoadTexture: boolean): THREE.Mesh | undefined {
    const key = getTileKey(z, x, y);

    if (this.meshCache.has(key)) {
      const mesh = this.meshCache.get(key)!;
      if (shouldLoadTexture) {
        const material = mesh.material;
        if (material instanceof THREE.MeshBasicMaterial && !material.map) {
          if (this.pendingTileLoads.length < MAX_PENDING_LOADS) {
            this.loadTileTexture(z, x, y).then((texture) => {
              if (!texture || !this.meshCache.has(key)) return;
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
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    mesh.userData.tileKey = key;
    mesh.userData.tileZoom = z;
    this.tileGroup.add(mesh);
    this.meshCache.set(key, mesh);

    if (shouldLoadTexture && this.pendingTileLoads.length < MAX_PENDING_LOADS) {
      this.loadTileTexture(z, x, y).then((texture) => {
        if (!texture || !this.meshCache.has(key)) return;
        material.map = texture;
        material.color.set(0xffffff);
        material.needsUpdate = true;
      });
    }

    return mesh;
  }

  // ==================== 可见瓦片计算 ====================

  /**
   * 根据相机距离计算合适的 zoom 级别
   */
  getZoomForDistance(distance: number, camera: THREE.PerspectiveCamera): number {
    // 对齐 Cesium 语义：LOD 应以“到地表”的距离为准。
    // 本项目地表瓦片在 EARTH_RADIUS + TILE_SURFACE_OFFSET，因此用 surfaceAltitude。
    const surfaceRadius = EARTH_RADIUS + TILE_SURFACE_OFFSET;
    const altitude = Math.max(distance - surfaceRadius, 1);
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const viewHeight = Math.max(window.innerHeight, 1);
    const projectedPixelAngle = fovRad / viewHeight;
    const tileGroundSize = altitude * projectedPixelAngle * TARGET_TILE_PIXEL;
    const zoom = Math.floor(
      Math.log2((Math.PI * 2 * surfaceRadius) / Math.max(tileGroundSize, 1))
    );
    return THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, Math.min(MAX_TILE_ZOOM, SAFE_MAX_ZOOM));
  }

  /**
   * 获取当前视角下应加载的瓦片列表
   */
  getVisibleTiles(
    zoom: number,
    camera: THREE.PerspectiveCamera,
    globeQuatInverse: THREE.Quaternion,
    pickGlobeTarget: () => THREE.Vector3 | null
  ): TileCoord[] {
    const safeZoom = THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, MAX_TILE_ZOOM);
    const n = 2 ** safeZoom;

    // 对齐 Cesium：将视线落点/相机位置转换到“globe local(ECEF)”后再求经纬度
    // Cartographic.fromCartesian: lon=atan2(y,x), lat=asin(z/|p|)
    const viewTarget = pickGlobeTarget();
    const viewLocal = (viewTarget ?? camera.position)
      .clone()
      .applyQuaternion(globeQuatInverse);
    const { lon: centerLon, lat: centerLat } = cartesianToLonLat(viewLocal);

    const viewDir = _scratchViewDir.copy(viewLocal).normalize();
    const { x: cx, y: cy } = lonLatToTile(centerLon, centerLat, safeZoom);

    const safeDistance = Math.max(camera.position.length(), EARTH_RADIUS + 1);
    const globeRadius = EARTH_RADIUS + TILE_SURFACE_OFFSET;

    // === Cesium 风格：用视锥射线与球体求交，估算当前帧实际可见的地表中心角范围 ===
    // 远距离时，经验公式会把 maxAngle 压得过小，导致只加载中心附近的少量瓦片。
    // 这里采样屏幕四角+边中点，取交点相对 viewDir 的最大角度作为 maxAngle。
    const ndcSamples: Array<[number, number]> = [
      [-1, -1], [1, -1], [-1, 1], [1, 1],
      [0, -1], [0, 1], [-1, 0], [1, 0],
    ];

    let maxAngle = 0;
    let hitCount = 0;
    for (const [nx, ny] of ndcSamples) {
      const ray = getPickRayAtNdc(camera, nx, ny, _scratchPickRay);
      const hit = raySphereIntersection(ray, globeRadius, _scratchPickPoint);
      if (!hit) continue;
      hitCount += 1;
      const hitLocal = _scratchTileCenterDir.copy(hit).applyQuaternion(globeQuatInverse).normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(hitLocal.dot(viewDir), -1, 1));
      if (angle > maxAngle) maxAngle = angle;
    }

    // 如果边界射线没命中（例如地球很小/仅中心射线命中），用“可见地平线中心角”作为保底
    // 该角度满足：cos(theta) = R / d
    if (hitCount === 0 || maxAngle < 1e-6) {
      maxAngle = Math.acos(THREE.MathUtils.clamp(globeRadius / safeDistance, -1, 1));
    }

    // 给一点余量，避免边缘缺瓦（近似 Cesium 的 bounding volume 余量）
    const tileAngle = (Math.PI * 2) / n;
    maxAngle = Math.min(Math.PI / 2, maxAngle + tileAngle * 0.75);

    // 以 maxAngle 推导搜索半径（至少覆盖整个可见范围）
    const searchR = Math.min(Math.ceil(n / 2), Math.max(2, Math.ceil(maxAngle / tileAngle) + 2));

    const visible: VisibleTile[] = [];

    for (let dy = -searchR; dy <= searchR; dy += 1) {
      const ty = cy + dy;
      if (ty < 0 || ty >= n) continue;
      for (let dx = -searchR; dx <= searchR; dx += 1) {
        const tx = ((cx + dx) % n + n) % n;
        // tileCenterWorld 返回的是 ECEF 世界坐标，需转换到 globe local 再与 viewLocal 比较
        const center = tileCenterWorld(tx, ty, safeZoom).applyQuaternion(globeQuatInverse);

        const dotVal = center.x * viewDir.x + center.y * viewDir.y + center.z * viewDir.z;
        const normalizedDot = dotVal / (EARTH_RADIUS + TILE_SURFACE_OFFSET);
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

  /**
   * 更新可见瓦片：创建新瓦片、回收不可见瓦片
   */
  updateVisibleTiles(
    zoom: number,
    camera: THREE.PerspectiveCamera,
    globeQuatInverse: THREE.Quaternion,
    pickGlobeTarget: () => THREE.Vector3 | null
  ): void {
    if (!TDT_TOKEN) {
      if (this.overlay) {
        this.overlay.textContent = "Set VITE_TDT_TOKEN in .env to load Tianditu imagery.";
        this.overlay.hidden = false;
      }
      return;
    }

    if (this.overlay) this.overlay.hidden = true;

    const safeZoom = THREE.MathUtils.clamp(zoom, MIN_TILE_ZOOM, MAX_TILE_ZOOM);
    const tiles = this.getVisibleTiles(safeZoom, camera, globeQuatInverse, pickGlobeTarget);
    this.visibleTileCount = tiles.length;

    const needed = new Set<string>();
    const requestBudget = getMaxTextureRequestsPerUpdate(safeZoom);
    const allowTextureRequests = this.pendingTileLoads.length < MAX_PENDING_LOADS;
    let createdCount = 0;
    const meshCapReached = this.meshCache.size >= MAX_TOTAL_TILE_MESHES;

    for (let i = 0; i < tiles.length; i += 1) {
      const tile = tiles[i];
      const key = getTileKey(tile.z, tile.x, tile.y);
      needed.add(key);
      const shouldLoadTexture = allowTextureRequests && i < requestBudget;
      const shouldCreateMesh = createdCount < MAX_MESHES_PER_UPDATE;
      const existed = this.meshCache.has(key);
      if ((shouldCreateMesh && !meshCapReached) || existed) {
        this.ensureTileMesh(tile.z, tile.x, tile.y, shouldLoadTexture);
        if (shouldCreateMesh && !existed) {
          createdCount += 1;
        }
      }
    }

    // 回收不可见的 mesh
    const toRemove: string[] = [];
    this.meshCache.forEach((_, key) => {
      if (!needed.has(key)) toRemove.push(key);
    });

    for (const key of toRemove) {
      const mesh = this.meshCache.get(key);
      if (!mesh) continue;
      this.tileGroup.remove(mesh);
      mesh.geometry.dispose();
      if (mesh.material instanceof THREE.Material && (mesh.material as THREE.MeshBasicMaterial).map) {
        (mesh.material as THREE.MeshBasicMaterial).map!.dispose();
      }
      if (Array.isArray(mesh.material)) {
        for (const mat of mesh.material) {
          if ((mat as THREE.MeshBasicMaterial).map) (mat as THREE.MeshBasicMaterial).map!.dispose();
          mat.dispose();
        }
      } else {
        mesh.material.dispose();
      }
      if (this.textureCache.has(key)) {
        const texture = this.textureCache.get(key);
        if (texture) texture.dispose();
        this.textureCache.delete(key);
        this.textureBytes.delete(key);
      }
      this.texturePromises.delete(key);
      this.meshCache.delete(key);
    }

    // 清理非当前级别的纹理缓存
    this.textureCache.forEach((_, key) => {
      const z = Number.parseInt(key.split("/")[0], 10);
      if (z !== safeZoom && !needed.has(key)) {
        const texture = this.textureCache.get(key);
        if (texture) texture.dispose();
        this.textureCache.delete(key);
        this.textureBytes.delete(key);
      }
    });

    this.currentZoom = safeZoom;
  }

  /** 获取 GPU 纹理内存信息字符串 */
  getTextureMemoryInfo(): string {
    let total = 0;
    this.textureBytes.forEach((bytes) => {
      total += bytes;
    });
    return `GPU textures: ${this.textureCache.size} | Est: ${formatBytes(total)}`;
  }

  // ==================== 私有缓存管理 ====================

  /** LRU：将访问过的 key 移到 Map 末尾 */
  private touchTextureCache(key: string): void {
    const texture = this.textureCache.get(key);
    if (!texture) return;
    this.textureCache.delete(key);
    this.textureCache.set(key, texture);
  }

  /** 裁剪纹理缓存至指定数量 */
  private trimTextureCache(limit: number): void {
    for (const key of this.textureCache.keys()) {
      if (this.textureCache.size <= limit) break;
      if (this.meshCache.has(key)) continue;
      const texture = this.textureCache.get(key);
      if (texture) texture.dispose();
      this.textureCache.delete(key);
      this.textureBytes.delete(key);
    }
  }
}

// ==================== 模块级工具函数 ====================

/** 生成瓦片唯一键 */
export function getTileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** 根据 zoom 级别获取瓦片细分段数 */
function getTileSegmentsForZoom(zoom: number): number {
  if (zoom >= 12) return 6;
  if (zoom >= 10) return 8;
  return TILE_SEGMENTS;
}

/** 估算纹理 GPU 占用字节数 */
function estimateTextureBytes(texture: THREE.Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 256;
  const height = image?.height ?? 256;
  const base = width * height * 4;
  const mipFactor = texture.generateMipmaps ? 1.33 : 1;
  return Math.round(base * mipFactor);
}

/** 创建瓦片曲面几何体 */
export function createTileGeometry(bounds: TileBounds, segments: number): THREE.BufferGeometry {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  const widthSegments = segments;
  const heightSegments = segments;
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // === 关键：WebMercator 影像瓦片不能按“纬度线性插值”直接贴到球面 ===
  // Cesium 的 WebMercatorTilingScheme 本质上是在 Mercator Y 上均匀分割。
  // 这里按 Mercator Y 采样，然后逆墨卡托得到纬度，确保底图不发生投影错位。
  const latMinRad = THREE.MathUtils.degToRad(latMin);
  const latMaxRad = THREE.MathUtils.degToRad(latMax);
  const mercYMin = mercatorYFromLatRad(latMinRad);
  const mercYMax = mercatorYFromLatRad(latMaxRad);
  const mercYRange = mercYMax - mercYMin || 1;

  for (let iy = 0; iy <= heightSegments; iy += 1) {
    const v = iy / heightSegments;
    // north->south：mercY 从 max 到 min
    const mercY = THREE.MathUtils.lerp(mercYMax, mercYMin, v);
    const latRad = latRadFromMercatorY(mercY);

    for (let ix = 0; ix <= widthSegments; ix += 1) {
      const u = ix / widthSegments;
      const lon = THREE.MathUtils.lerp(lonMin, lonMax, u);
      const lonRad = THREE.MathUtils.degToRad(lon);
      const radius = EARTH_RADIUS + TILE_SURFACE_OFFSET;

      const x = radius * Math.cos(latRad) * Math.cos(lonRad);
      const y = radius * Math.cos(latRad) * Math.sin(lonRad);
      const z = radius * Math.sin(latRad);

      vertices.push(x, y, z);
      // vUv.y：对齐 Three.js flipY 语义（北侧=1，南侧=0），同时按 Mercator Y 映射
      const vUv = (mercY - mercYMin) / mercYRange;
      uvs.push(u, vUv);
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
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** 根据 zoom 获取最大可见瓦片数 */
function getMaxVisibleTiles(zoom: number): number {
  if (zoom >= 13) return 40;
  if (zoom >= 12) return 60;
  if (zoom >= 11) return 80;
  if (zoom >= 10) return 200;
  return MAX_VISIBLE_TILES;
}

/** 根据 zoom 获取每次更新最大纹理请求数 */
function getMaxTextureRequestsPerUpdate(zoom: number): number {
  if (zoom >= 13) return 6;
  if (zoom >= 12) return 10;
  if (zoom >= 11) return 14;
  if (zoom >= 10) return 50;
  return MAX_TEXTURE_REQUESTS_PER_UPDATE;
}
