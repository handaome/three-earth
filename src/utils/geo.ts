/**
 * 地理坐标工具函数
 * 经纬度 ↔ 瓦片坐标 ↔ 世界坐标 的转换
 */
import * as THREE from "three";
import { EARTH_RADIUS, TILE_SURFACE_OFFSET } from "../constants";
import type { TileBounds, TileGridPosition } from "../types";

/** WebMercator 最大可投影纬度（度） */
const WEB_MERCATOR_MAX_LAT = 85.05112878;

/**
 * 经纬度 → 瓦片坐标
 * @param lon 经度（-180~180）
 * @param lat 纬度（-85.05~85.05）
 * @param zoom 缩放级别
 * @returns 瓦片列号 x、行号 y、及当前级别瓦片总数 n
 */
export function lonLatToTile(lon: number, lat: number, zoom: number): TileGridPosition {
  const n = 2 ** zoom;
  const clampedLat = THREE.MathUtils.clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = THREE.MathUtils.degToRad(clampedLat);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y, n };
}

/**
 * ECEF（Cesium/本项目）笛卡尔坐标 → 经纬度（度）
 * 对齐 Cesium Cartographic.fromCartesian：
 * - lon = atan2(y, x)
 * - lat = asin(z / |p|)
 */
export function cartesianToLonLat(cartesian: THREE.Vector3): { lon: number; lat: number } {
  const p = cartesian;
  const mag = p.length();
  if (mag <= 0) return { lon: 0, lat: 0 };
  const lon = THREE.MathUtils.radToDeg(Math.atan2(p.y, p.x));
  const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(p.z / mag, -1, 1)));
  return { lon, lat };
}

/** WebMercator: latitude(rad) -> y (无量纲) */
export function mercatorYFromLatRad(latRad: number): number {
  return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
}

/** WebMercator: y -> latitude(rad) */
export function latRadFromMercatorY(mercatorY: number): number {
  return 2 * Math.atan(Math.exp(mercatorY)) - Math.PI / 2;
}

/**
 * 经纬度 → 三维世界坐标（Cesium 风格 ECEF，Z 朝上）
 * @param lon 经度
 * @param lat 纬度
 * @param radius 球体半径
 * @returns 世界坐标 Vector3
 */
export function lonLatToWorld(lon: number, lat: number, radius: number): THREE.Vector3 {
  const clampedLat = THREE.MathUtils.clamp(lat, -89.999, 89.999);
  const latRad = THREE.MathUtils.degToRad(clampedLat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.cos(lonRad),
    radius * Math.cos(latRad) * Math.sin(lonRad),
    radius * Math.sin(latRad)
  );
}

/**
 * 瓦片坐标 → 经纬度范围
 * @param x 列号
 * @param y 行号
 * @param zoom 缩放级别
 * @returns 经纬度边界
 */
export function tileToLonLatBounds(x: number, y: number, zoom: number): TileBounds {
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

/**
 * 计算瓦片中心点的世界坐标（用于视锥体裁剪）
 */
export function tileCenterWorld(x: number, y: number, zoom: number): THREE.Vector3 {
  const bounds = tileToLonLatBounds(x, y, zoom);
  const lon = (bounds.lonMin + bounds.lonMax) / 2;
  // WebMercator 中点：用 mercatorY 的中点再逆投影回纬度
  const latMinRad = THREE.MathUtils.degToRad(bounds.latMin);
  const latMaxRad = THREE.MathUtils.degToRad(bounds.latMax);
  const mercYMin = mercatorYFromLatRad(latMinRad);
  const mercYMax = mercatorYFromLatRad(latMaxRad);
  const latRad = latRadFromMercatorY((mercYMin + mercYMax) * 0.5);
  const lonRad = THREE.MathUtils.degToRad(lon);
  const r = EARTH_RADIUS + TILE_SURFACE_OFFSET;
  return new THREE.Vector3(
    r * Math.cos(latRad) * Math.cos(lonRad),
    r * Math.cos(latRad) * Math.sin(lonRad),
    r * Math.sin(latRad)
  );
}
