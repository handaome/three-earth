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
  TILE_SKIRT_DISABLE_UNDER_ZOOM,
  TILE_SKIRT_HEIGHT_LOW_ZOOM,
  TILE_SKIRT_HEIGHT_MID_ZOOM,
  TILE_SKIRT_HEIGHT_HIGH_ZOOM,
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
  ENABLE_CESIUM_TERRAIN,
  CESIUM_TERRAIN_BASE_URL,
  CESIUM_TERRAIN_TOKEN,
  TERRAIN_EXAGGERATION,
} from "../constants";
import type { TileBounds, TileCoord, VisibleTile } from "../types";
import type { TerrainTileData } from "./terrain.types";
import {
  cartesianToLonLat,
  latRadFromMercatorY,
  mercatorYFromLatRad,
  tileToLonLatBounds,
  tileCenterWorld,
} from "../utils/geo";
import { formatBytes } from "../utils/format";
import { CesiumTerrainProvider } from "./cesium-terrain-provider";

const _scratchViewDir = new THREE.Vector3();
const _scratchRaycaster = new THREE.Raycaster();
const _scratchNdc = new THREE.Vector2();
const _scratchPickRay = new THREE.Ray();
const _scratchPickPoint = new THREE.Vector3();
const _scratchTileCenterDir = new THREE.Vector3();
const _scratchFrustum = new THREE.Frustum();
const _scratchProjView = new THREE.Matrix4();
const _scratchSphereCenter = new THREE.Vector3();
const _scratchSphere = new THREE.Sphere();

/** Cesium TerrainProvider.heightmapTerrainQuality */
const HEIGHTMAP_TERRAIN_QUALITY = 0.25;
/** Cesium QuadtreePrimitive.maximumScreenSpaceError 默认值 */
const MAX_SCREEN_SPACE_ERROR = 2;
/** 与 Cesium EllipsoidTerrainProvider 对齐：估算 level 0 最大几何误差 */
const LEVEL_ZERO_TILE_WIDTH = 256;

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
  private readonly tileBoundingSphereCache = new Map<string, THREE.Sphere>();
  private readonly tileLoader = new THREE.TextureLoader();

  /** 渲染器引用（用于获取各向异性过滤等信息） */
  private readonly renderer: THREE.WebGLRenderer;

  /** Cesium 地形 Provider（可选） */
  private readonly terrainProvider: CesiumTerrainProvider | null = null;

  /** overlay 元素引用，用于提示信息 */
  private overlay: HTMLDivElement | null = null;

  /** 纹理请求轮转游标，避免固定前几块瓦片长期独占请求预算 */
  private textureRequestCursor = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.tileLoader.setCrossOrigin("anonymous");

    if (ENABLE_CESIUM_TERRAIN && CESIUM_TERRAIN_BASE_URL) {
      this.terrainProvider = new CesiumTerrainProvider({
        baseUrl: CESIUM_TERRAIN_BASE_URL,
        accessToken: CESIUM_TERRAIN_TOKEN,
        scheme: "tms",
      });
      console.info("[Terrain] Cesium quantized-mesh enabled", {
        baseUrl: CESIUM_TERRAIN_BASE_URL,
      });
    }
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
      return this.texturePromises.get(key);
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
      const mesh = this.meshCache.get(key);
      if (this.terrainProvider && !mesh.userData.terrainApplied && shouldLoadTexture) {
        this.applyTerrainToMesh(mesh, z, x, y, tileToLonLatBounds(x, y, z));
      }
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
    const geometry = createTileGeometry(bounds, getTileSegmentsForZoom(z), getTileSkirtHeight(z));
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

    if (this.terrainProvider && shouldLoadTexture) {
      this.applyTerrainToMesh(mesh, z, x, y, bounds);
    }

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

  /**
   * 拉取地形并替换瓦片几何
   */
  private applyTerrainToMesh(
    mesh: THREE.Mesh,
    z: number,
    x: number,
    y: number,
    bounds: TileBounds,
  ): void {
    if (!this.terrainProvider) return;
    const key = getTileKey(z, x, y);
    if (mesh.userData.terrainApplied) return;

    this.terrainProvider.loadTile(z, x, y).then((terrainData) => {
      if (!terrainData) return;
      const aliveMesh = this.meshCache.get(key);
      if (!aliveMesh) return;
      if (aliveMesh.userData.terrainApplied) return;

      const terrainGeometry = createTerrainGeometry(bounds, terrainData, TERRAIN_EXAGGERATION);
      const oldGeometry = aliveMesh.geometry;
      aliveMesh.geometry = terrainGeometry;
      oldGeometry.dispose();
      aliveMesh.userData.terrainApplied = true;
    });
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

  /** Cesium: getLevelMaximumGeometricError(level) */
  private getLevelMaximumGeometricError(level: number): number {
    const globeRadius = EARTH_RADIUS + TILE_SURFACE_OFFSET;
    const numberOfXTilesAtLevelZero = 1;
    const levelZeroError =
      (globeRadius * 2 * Math.PI * HEIGHTMAP_TERRAIN_QUALITY) /
      (LEVEL_ZERO_TILE_WIDTH * numberOfXTilesAtLevelZero);
    return levelZeroError / (1 << level);
  }

  /** 缓存 tile 的局部包围球（ECEF local） */
  private getTileBoundingSphereLocal(z: number, x: number, y: number): THREE.Sphere {
    const key = getTileKey(z, x, y);
    const cached = this.tileBoundingSphereCache.get(key);
    if (cached) return cached;

    const bounds = tileToLonLatBounds(x, y, z);
    const r = EARTH_RADIUS + TILE_SURFACE_OFFSET;

    const p0 = lonLatToPoint(bounds.lonMin, bounds.latMin, r);
    const p1 = lonLatToPoint(bounds.lonMin, bounds.latMax, r);
    const p2 = lonLatToPoint(bounds.lonMax, bounds.latMin, r);
    const p3 = lonLatToPoint(bounds.lonMax, bounds.latMax, r);
    const pc = tileCenterWorld(x, y, z);

    const sphere = new THREE.Sphere();
    sphere.setFromPoints([p0, p1, p2, p3, pc]);
    this.tileBoundingSphereCache.set(key, sphere);
    return sphere;
  }

  /** 将局部包围球转到世界坐标（仅旋转，无缩放） */
  private toWorldSphere(localSphere: THREE.Sphere, globeQuat: THREE.Quaternion): THREE.Sphere {
    _scratchSphereCenter.copy(localSphere.center).applyQuaternion(globeQuat);
    _scratchSphere.center.copy(_scratchSphereCenter);
    _scratchSphere.radius = localSphere.radius;
    return _scratchSphere;
  }

  private isTilePotentiallyVisible(
    z: number,
    x: number,
    y: number,
    globeQuat: THREE.Quaternion,
  ): boolean {
    const localSphere = this.getTileBoundingSphereLocal(z, x, y);
    const worldSphere = this.toWorldSphere(localSphere, globeQuat);
    return _scratchFrustum.intersectsSphere(worldSphere);
  }

  /** 子瓦片是否已具备可用纹理（用于父级兜底策略） */
  private isTileRenderable(z: number, x: number, y: number): boolean {
    const key = getTileKey(z, x, y);
    if (this.textureCache.has(key)) return true;

    const mesh = this.meshCache.get(key);
    if (!mesh) return false;
    const material = mesh.material;
    return material instanceof THREE.MeshBasicMaterial && Boolean(material.map);
  }

  /** Cesium QuadtreePrimitive.screenSpaceError（3D 近似） */
  private computeTileSse(level: number, distanceToTile: number, camera: THREE.PerspectiveCamera): number {
    const maxGeometricError = this.getLevelMaximumGeometricError(level);
    const height = Math.max(window.innerHeight, 1);
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const sseDenominator = 2 * Math.tan(fovRad * 0.5);
    return (maxGeometricError * height) / (Math.max(distanceToTile, 1) * sseDenominator);
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
    // === Cesium 风格四叉树 SSE 选择 ===
    const maxLevel = THREE.MathUtils.clamp(
      Math.max(zoom, SAFE_MAX_ZOOM),
      MIN_TILE_ZOOM,
      MAX_TILE_ZOOM,
    );
    const globeQuat = globeQuatInverse.clone().invert();
    const cameraPos = camera.position;

    camera.updateMatrixWorld(true);
    _scratchProjView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _scratchFrustum.setFromProjectionMatrix(_scratchProjView);

    const selected: VisibleTile[] = [];

    const visit = (z: number, x: number, y: number): boolean => {
      const localSphere = this.getTileBoundingSphereLocal(z, x, y);
      const worldSphere = this.toWorldSphere(localSphere, globeQuat);

      // frustum culling
      if (!_scratchFrustum.intersectsSphere(worldSphere)) return false;

      const center = worldSphere.center;

      const distanceToTile = Math.max(1, cameraPos.distanceTo(center) - worldSphere.radius);
      const sse = this.computeTileSse(z, distanceToTile, camera);

      const mustRefineToMinZoom = z < MIN_TILE_ZOOM;
      if ((mustRefineToMinZoom || sse > MAX_SCREEN_SPACE_ERROR) && z < maxLevel) {
        const selectionStart = selected.length;
        const childZ = z + 1;
        const x0 = x * 2;
        const y0 = y * 2;

        const children: Array<[number, number]> = [
          [x0, y0],
          [x0 + 1, y0],
          [x0, y0 + 1],
          [x0 + 1, y0 + 1],
        ];

        let allVisibleChildrenReady = true;
        let hasVisibleChild = false;

        for (const [cx, cy] of children) {
          const childVisible = this.isTilePotentiallyVisible(childZ, cx, cy, globeQuat);
          if (!childVisible) {
            continue;
          }

          hasVisibleChild = true;
          const childCovered = visit(childZ, cx, cy);
          if (!childCovered) {
            allVisibleChildrenReady = false;
          }
        }

        // 仅当“可见子级未就绪”时保留父级兜底，避免父子共面重叠导致闪烁/破面
        if (!hasVisibleChild || !allVisibleChildrenReady) {
          // 父级兜底时回滚该分支已经入选的子级，避免同一区域多层瓦片叠加
          selected.length = selectionStart;
          const angle = Math.acos(
            THREE.MathUtils.clamp(
              _scratchTileCenterDir.copy(center).normalize().dot(_scratchViewDir.copy(cameraPos).normalize()),
              -1,
              1,
            ),
          );
          selected.push({ z, x, y, angle });
          return true;
        }
        return true;
      }

      const angle = Math.acos(
        THREE.MathUtils.clamp(
          _scratchTileCenterDir.copy(center).normalize().dot(_scratchViewDir.copy(cameraPos).normalize()),
          -1,
          1,
        ),
      );
      selected.push({ z, x, y, angle });
      return true;
    };

    // WebMercator level-0：1x1 根节点
    visit(0, 0, 0);

    selected.sort((a, b) => a.angle - b.angle || a.z - b.z);
    return selected.map(({ z, x, y }) => ({ z, x, y }));
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

    let maxSelectedZoom = -1;
    for (const tile of tiles) {
      if (tile.z > maxSelectedZoom) maxSelectedZoom = tile.z;
    }

    const needed = new Set<string>();
    const allowTextureRequests = this.pendingTileLoads.length < MAX_PENDING_LOADS;

    let createdCount = 0;

    for (let i = 0; i < tiles.length; i += 1) {
      const tile = tiles[i];
      const key = getTileKey(tile.z, tile.x, tile.y);
      needed.add(key);
      const shouldLoadTexture = allowTextureRequests;
      const shouldCreateMesh = createdCount < MAX_MESHES_PER_UPDATE;
      const existed = this.meshCache.has(key);
      if (shouldCreateMesh || existed) {
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
        (mesh.material as THREE.MeshBasicMaterial).map.dispose();
      }
      if (Array.isArray(mesh.material)) {
        for (const mat of mesh.material) {
          if ((mat as THREE.MeshBasicMaterial).map) (mat as THREE.MeshBasicMaterial).map.dispose();
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

    this.currentZoom = maxSelectedZoom >= 0 ? maxSelectedZoom : safeZoom;
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

/** 参考 Cesium 地形网格：按几何误差估算瓦片裙边高度，减少接缝裂隙 */
function getTileSkirtHeight(zoom: number): number {
  // 影像贴图球面不同于地形网格，不能直接套用 Cesium terrain 的大裙边策略。
  // 否则低层级父瓦片兜底时会出现巨型拉伸三角面。
  if (zoom <= TILE_SKIRT_DISABLE_UNDER_ZOOM) return 0;
  if (zoom <= 5) return TILE_SKIRT_HEIGHT_LOW_ZOOM;
  if (zoom <= 9) return TILE_SKIRT_HEIGHT_MID_ZOOM;
  return TILE_SKIRT_HEIGHT_HIGH_ZOOM;
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
export function createTileGeometry(
  bounds: TileBounds,
  segments: number,
  skirtHeight = 0,
): THREE.BufferGeometry {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  const widthSegments = segments;
  const heightSegments = segments;
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const northEdge: number[] = [];
  const southEdge: number[] = [];
  const westEdge: number[] = [];
  const eastEdge: number[] = [];

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

      const vertexIndex = vertices.length / 3;
      vertices.push(x, y, z);
      // vUv.y：对齐 Three.js flipY 语义（北侧=1，南侧=0），同时按 Mercator Y 映射
      const vUv = (mercY - mercYMin) / mercYRange;
      uvs.push(u, vUv);

      if (iy === 0) northEdge.push(vertexIndex);
      if (iy === heightSegments) southEdge.push(vertexIndex);
      if (ix === 0) westEdge.push(vertexIndex);
      if (ix === widthSegments) eastEdge.push(vertexIndex);
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

  if (skirtHeight > 0) {
    const addSkirtForEdge = (edge: number[]): void => {
      if (edge.length < 2) return;

      const skirtStart = vertices.length / 3;
      for (let i = 0; i < edge.length; i += 1) {
        const topIndex = edge[i];
        const px = vertices[topIndex * 3];
        const py = vertices[topIndex * 3 + 1];
        const pz = vertices[topIndex * 3 + 2];
        const length = Math.sqrt(px * px + py * py + pz * pz) || 1;
        const scaled = Math.max(length - skirtHeight, 1) / length;

        vertices.push(px * scaled, py * scaled, pz * scaled);
        uvs.push(uvs[topIndex * 2], uvs[topIndex * 2 + 1]);
      }

      for (let i = 0; i < edge.length - 1; i += 1) {
        const top0 = edge[i];
        const top1 = edge[i + 1];
        const skirt0 = skirtStart + i;
        const skirt1 = skirtStart + i + 1;
        indices.push(top0, skirt0, top1, skirt0, skirt1, top1);
      }
    };

    addSkirtForEdge(northEdge);
    addSkirtForEdge(eastEdge);
    addSkirtForEdge([...southEdge].reverse());
    addSkirtForEdge([...westEdge].reverse());
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 基于 Cesium quantized-mesh 解码结果创建地形几何
 */
export function createTerrainGeometry(
  bounds: TileBounds,
  terrainData: TerrainTileData,
  exaggeration = 1,
): THREE.BufferGeometry {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  const latMinRad = THREE.MathUtils.degToRad(latMin);
  const latMaxRad = THREE.MathUtils.degToRad(latMax);
  const mercYMin = mercatorYFromLatRad(latMinRad);
  const mercYMax = mercatorYFromLatRad(latMaxRad);

  const vertexCount = terrainData.u.length;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let i = 0; i < vertexCount; i += 1) {
    const uNorm = THREE.MathUtils.clamp(terrainData.u[i], 0, 1);
    const vNorm = THREE.MathUtils.clamp(terrainData.v[i], 0, 1);
    const height = terrainData.heights[i] * exaggeration;

    const lon = THREE.MathUtils.lerp(lonMin, lonMax, uNorm);
    const lonRad = THREE.MathUtils.degToRad(lon);
    const mercY = THREE.MathUtils.lerp(mercYMin, mercYMax, vNorm);
    const latRad = latRadFromMercatorY(mercY);
    const radius = EARTH_RADIUS + TILE_SURFACE_OFFSET + height;

    const pOffset = i * 3;
    positions[pOffset] = radius * Math.cos(latRad) * Math.cos(lonRad);
    positions[pOffset + 1] = radius * Math.cos(latRad) * Math.sin(lonRad);
    positions[pOffset + 2] = radius * Math.sin(latRad);

    const uvOffset = i * 2;
    uvs[uvOffset] = uNorm;
    uvs[uvOffset + 1] = vNorm;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(terrainData.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
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

function lonLatToPoint(lon: number, lat: number, radius: number): THREE.Vector3 {
  const latRad = THREE.MathUtils.degToRad(lat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.cos(lonRad),
    radius * Math.cos(latRad) * Math.sin(lonRad),
    radius * Math.sin(latRad),
  );
}

/** 根据 zoom 获取每次更新最大纹理请求数 */
function getMaxTextureRequestsPerUpdate(zoom: number): number {
  if (zoom >= 14) return 20;
  if (zoom >= 13) return 16;
  if (zoom >= 12) return 12;
  if (zoom >= 11) return 14;
  if (zoom >= 10) return 50;
  return MAX_TEXTURE_REQUESTS_PER_UPDATE;
}
