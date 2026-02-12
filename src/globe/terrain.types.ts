/**
 * Cesium Quantized Mesh 地形相关类型定义
 */

/**
 * 单个地形瓦片的解码结果
 */
export interface TerrainTileData {
  /** 缩放级别 */
  z: number;
  /** 列号 */
  x: number;
  /** 行号（XYZ 行号） */
  y: number;
  /** 顶点经向量化坐标（0..32767）归一化后的 U */
  u: Float32Array;
  /** 顶点纬向量化坐标（0..32767）归一化后的 V */
  v: Float32Array;
  /** 顶点高程（米） */
  heights: Float32Array;
  /** 三角形索引 */
  indices: Uint32Array;
  /** 最小高程（米） */
  minHeight: number;
  /** 最大高程（米） */
  maxHeight: number;
}

/**
 * Cesium Terrain Provider 初始化参数
 */
export interface CesiumTerrainProviderOptions {
  /** 地形服务根地址，例如 https://your-terrain-host */
  baseUrl: string;
  /** 可选访问 Token（Bearer） */
  accessToken?: string;
  /** 行号方案：Cesium quantized-mesh 常见为 tms */
  scheme?: "xyz" | "tms";
}

/**
 * layer.json 元数据（最小子集）
 */
export interface CesiumTerrainLayerJson {
  format?: string;
  projection?: string;
  version?: string;
  scheme?: "tms" | "slippyMap";
  tiles?: string[];
}
