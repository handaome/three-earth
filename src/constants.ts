/**
 * 全局常量与配置
 * 集中管理数值常量，避免魔法数字散落各处
 */
import * as THREE from "three";

// ==================== 地球基础参数 ====================

/** 地球半径（米） */
export const EARTH_RADIUS = 6371000;

/** 瓦片贴图相对地球表面的偏移量，避免 z-fighting */
export const TILE_SURFACE_OFFSET = EARTH_RADIUS * 0.001;

// ==================== 相机参数 ====================

/**
 * 相机最近距离（瓦片表面 + 20m）
 *
 * 注意：本项目的底图瓦片渲染在 `EARTH_RADIUS + TILE_SURFACE_OFFSET`，
 * 若最小距离仅按 `EARTH_RADIUS` 计算，相机会“钻进瓦片球面内部”，表现为近地不可看且可穿地。
 */
export const MIN_CAMERA_DISTANCE = EARTH_RADIUS + TILE_SURFACE_OFFSET + 20;

/** 相机最远距离（6 倍地球半径） */
export const MAX_CAMERA_DISTANCE = EARTH_RADIUS * 6;

/** 默认相机 FOV（度） */
export const DEFAULT_FOV = 45;

/** 初始相机距离倍率 */
export const INITIAL_CAMERA_DISTANCE_FACTOR = 2.2;

// ==================== 鼠标/滚轮控制参数 ====================

/** 滚轮缩放速度系数 */
export const WHEEL_SPEED_FACTOR = 0.18;

/** 滚轮缩放最小速度 */
export const MIN_WHEEL_SPEED = EARTH_RADIUS * 0.00005;

/** 滚轮缩放最大速度 */
export const MAX_WHEEL_SPEED = EARTH_RADIUS * 0.02;

/** 左键旋转速度 */
export const CAMERA_ROTATE_SPEED = 0.0022;

/** 相机极角最小值（防止翻转） */
export const CAMERA_MIN_POLAR = 0.25;

/** 相机极角最大值 */
export const CAMERA_MAX_POLAR = Math.PI - 0.25;

/** 中键倾斜速度 */
export const MIDDLE_TILT_SPEED = 0.002;

/** 右键缩放系数 */
export const RIGHT_ZOOM_FACTOR = 0.0007;

/** 最小倾斜角度 */
export const MIN_TILT_ANGLE = 0.05;

/** 最大倾斜角度 */
export const MAX_TILT_ANGLE = Math.PI * 0.5 - 0.02;

/** 世界北方向（Cesium ECEF: Z 轴朝北） */
export const WORLD_NORTH = new THREE.Vector3(0, 0, 1);

/** 世界东方向（Cesium ECEF: Y 轴朝东） */
export const WORLD_EAST = new THREE.Vector3(0, 1, 0);

/** 相机 up 向量精度阈值 */
export const CAMERA_UP_EPSILON = 1e-6;

// ==================== 更新间隔 ====================

/** HUD 刷新间隔（ms） */
export const HUD_UPDATE_INTERVAL = 200;

/** 视野检查间隔（ms） */
export const VIEW_CHECK_INTERVAL = 200;

/** 瓦片空闲延迟（ms），拖拽期间不刷新瓦片 */
export const TILE_IDLE_DELAY = 260;

/** 缩放检查间隔（ms） */
export const ZOOM_CHECK_INTERVAL = 300;

// ==================== 天空/大气参数 ====================

/** 天空渐变开始高度 */
export const SKY_FADE_ALTITUDE = EARTH_RADIUS * 0.08;

/** 天空雾近平面 */
export const SKY_FOG_NEAR = EARTH_RADIUS * 0.02;

/** 天空雾远平面 */
export const SKY_FOG_FAR = EARTH_RADIUS * 0.14;

/** 近地 FOV */
export const SKY_FOV_NEAR = 36;

/** 远地 FOV */
export const SKY_FOV_FAR = 50;

/** 太空背景色 */
export const SPACE_COLOR = new THREE.Color(0x02040b);

/** 天空色 */
export const SKY_COLOR = new THREE.Color(0x6fb3ff);

/** 天空雾颜色 */
export const SKY_FOG_COLOR = new THREE.Color(0x9fd1ff);

// ==================== 瓦片系统参数 ====================

/** 瓦片最小缩放级别 */
export const MIN_TILE_ZOOM = 3;

/** 瓦片最大缩放级别 */
export const MAX_TILE_ZOOM = 22;

/** 瓦片细分片段数 */
export const TILE_SEGMENTS = 12;

/** 瓦片目标像素尺寸 */
export const TARGET_TILE_PIXEL = 256;

/** 最大并发瓦片加载数 */
export const MAX_CONCURRENT_TILE_LOADS = 12;

/** 最大可见瓦片数 */
export const MAX_VISIBLE_TILES = 420;

/** 每次更新最大纹理请求数 */
export const MAX_TEXTURE_REQUESTS_PER_UPDATE = 80;

/** 最大待加载队列长度 */
export const MAX_PENDING_LOADS = 120;

/** 纹理缓存最大数量 */
export const MAX_TEXTURE_CACHE = 320;

/** 每次更新最大新建 mesh 数 */
export const MAX_MESHES_PER_UPDATE = 60;

/** 全局最大瓦片 mesh 数 */
export const MAX_TOTAL_TILE_MESHES = 180;

/**
 * 安全最大缩放级别（防止过度加载）
 *
 * 说明：本项目是“按视野估算 + 强上限”的简化策略，不是 Cesium 完整的四叉树 SSE。
 * 若上限过低（例如 11/14），会出现贴近地表但 zoom 上不去；
 * 这里提高到一个更合理的默认值，仍由 MAX_* 预算（并发/缓存/可见瓦片数）约束实际加载。
 */
export const SAFE_MAX_ZOOM = 18;

// ==================== 天地图配置 ====================

/** 天地图 Token（从环境变量读取） */
export const TDT_TOKEN = import.meta.env.VITE_TDT_TOKEN || "";

/** 天地图默认 API 地址（开发环境走 Vite 代理） */
export const DEFAULT_TDT_BASE_URL = import.meta.env.DEV
  ? "/tdt"
  : "https://t0.tianditu.gov.cn";

/** 天地图 API 地址 */
export const TDT_BASE_URL = import.meta.env.VITE_TDT_BASE_URL || DEFAULT_TDT_BASE_URL;

// ==================== 默认位置 ====================

/** 默认定位经纬度（北京） */
export const DEFAULT_LON_LAT = { lon: 116.391, lat: 39.907 };
