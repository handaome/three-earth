/**
 * 全局类型定义
 * 集中管理项目中使用的 TypeScript 类型与接口
 */

/** 瓦片坐标 */
export interface TileCoord {
  /** 缩放级别 */
  z: number;
  /** 列号 */
  x: number;
  /** 行号 */
  y: number;
}

/** 瓦片经纬度边界 */
export interface TileBounds {
  /** 最小经度 */
  lonMin: number;
  /** 最大经度 */
  lonMax: number;
  /** 最小纬度 */
  latMin: number;
  /** 最大纬度 */
  latMax: number;
}

/** 带角度排序的可见瓦片 */
export interface VisibleTile extends TileCoord {
  /** 与视线方向的夹角（弧度） */
  angle: number;
}

/** 经纬度坐标 */
export interface LonLat {
  lon: number;
  lat: number;
}

/** 瓦片在网格中的位置 */
export interface TileGridPosition {
  x: number;
  y: number;
  /** 当前级别的瓦片总数（每维） */
  n: number;
}

/** 性能内存信息（Chrome 扩展） */
export interface PerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}
