import type { CesiumTerrainProviderOptions, TerrainTileData } from "./terrain.types";

const QUANTIZED_RANGE = 32767;
const QUANTIZED_MESH_ACCEPT_HEADER =
  "application/vnd.quantized-mesh;extensions=octvertexnormals,watermask,metadata;q=0.9,*/*;q=0.01";

/**
 * Cesium 风格地形 Provider（quantized-mesh）
 *
 * 设计目标：
 * - 参考 CesiumTerrainProvider / QuantizedMeshTerrainData 的职责拆分
 * - 仅提供“拉取 + 解码”能力，不耦合渲染细节
 */
export class CesiumTerrainProvider {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly scheme: "xyz" | "tms";
  private readonly tilePromiseCache = new Map<string, Promise<TerrainTileData | null>>();

  constructor(options: CesiumTerrainProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.accessToken = options.accessToken ?? "";
    this.scheme = options.scheme ?? "tms";
  }

  /**
   * 拉取并解码一个地形瓦片
   */
  loadTile(z: number, x: number, y: number): Promise<TerrainTileData | null> {
    const key = `${z}/${x}/${y}`;
    const cached = this.tilePromiseCache.get(key);
    if (cached) return cached;

    const promise = this.requestAndDecodeTile(z, x, y)
      .catch((error) => {
        console.warn("[Terrain] load tile failed", { z, x, y, error });
        return null;
      })
      .finally(() => {
        this.tilePromiseCache.delete(key);
      });

    this.tilePromiseCache.set(key, promise);
    return promise;
  }

  private async requestAndDecodeTile(z: number, x: number, y: number): Promise<TerrainTileData | null> {
    const terrainY = this.scheme === "tms" ? (1 << z) - 1 - y : y;
    const url = `${this.baseUrl}/${z}/${x}/${terrainY}.terrain?v=1.2.0`;

    const headers = new Headers();
    headers.set("Accept", QUANTIZED_MESH_ACCEPT_HEADER);
    if (this.accessToken) {
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    }

    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return decodeQuantizedMesh(arrayBuffer, z, x, y);
  }
}

/**
 * 解析 Cesium quantized-mesh 二进制
 *
 * 参考实现：
 * - QuantizedMeshTerrainData
 * - AttributeCompression.zigZagDeltaDecode
 * - TerrainProvider.getRegularGridIndices 相关索引语义
 */
function decodeQuantizedMesh(buffer: ArrayBuffer, z: number, x: number, y: number): TerrainTileData {
  const view = new DataView(buffer);
  let offset = 0;

  // Header（按 spec 顺序读取，未直接使用的字段也要消费偏移）
  offset += 8 * 3; // centerX, centerY, centerZ
  const minHeight = view.getFloat32(offset, true);
  offset += 4;
  const maxHeight = view.getFloat32(offset, true);
  offset += 4;
  offset += 8 * 4; // bounding sphere (x, y, z, radius)
  offset += 8 * 3; // horizon occlusion point (x, y, z)

  const vertexCount = view.getUint32(offset, true);
  offset += 4;

  const encodedU = new Uint16Array(buffer, offset, vertexCount);
  offset += vertexCount * 2;
  const encodedV = new Uint16Array(buffer, offset, vertexCount);
  offset += vertexCount * 2;
  const encodedHeight = new Uint16Array(buffer, offset, vertexCount);
  offset += vertexCount * 2;

  const decodedU16 = zigZagDeltaDecode(encodedU);
  const decodedV16 = zigZagDeltaDecode(encodedV);
  const decodedHeight16 = zigZagDeltaDecode(encodedHeight);

  const u = new Float32Array(vertexCount);
  const v = new Float32Array(vertexCount);
  const heights = new Float32Array(vertexCount);
  const heightRange = maxHeight - minHeight;

  for (let i = 0; i < vertexCount; i += 1) {
    const uNorm = decodedU16[i] / QUANTIZED_RANGE;
    const vNorm = decodedV16[i] / QUANTIZED_RANGE;
    const hNorm = decodedHeight16[i] / QUANTIZED_RANGE;
    u[i] = uNorm;
    v[i] = vNorm;
    heights[i] = minHeight + hNorm * heightRange;
  }

  const triangleCount = view.getUint32(offset, true);
  offset += 4;

  const indexCount = triangleCount * 3;
  const encodedIndices =
    vertexCount > 65535
      ? new Uint32Array(buffer, offset, indexCount)
      : new Uint16Array(buffer, offset, indexCount);

  const indices = highWaterMarkDecode(encodedIndices);

  return {
    z,
    x,
    y,
    u,
    v,
    heights,
    indices,
    minHeight,
    maxHeight,
  };
}

/**
 * Cesium AttributeCompression.zigZagDeltaDecode 对应逻辑
 */
function zigZagDeltaDecode(encoded: Uint16Array): Uint16Array {
  const decoded = new Uint16Array(encoded.length);
  let accumulator = 0;

  for (let i = 0; i < encoded.length; i += 1) {
    const value = encoded[i];
    const delta = (value >> 1) ^ (-(value & 1));
    accumulator += delta;
    decoded[i] = accumulator;
  }

  return decoded;
}

/**
 * Cesium quantized-mesh 高水位索引解码
 */
function highWaterMarkDecode(encoded: Uint16Array | Uint32Array): Uint32Array {
  const decoded = new Uint32Array(encoded.length);
  let highest = 0;

  for (let i = 0; i < encoded.length; i += 1) {
    const code = encoded[i];
    decoded[i] = highest - code;
    if (code === 0) {
      highest += 1;
    }
  }

  return decoded;
}
