/**
 * 格式化工具函数
 * 距离、字节数、内存信息等显示格式化
 */
import type { PerformanceMemory } from "../types";

/**
 * 将米为单位的距离格式化为可读字符串
 */
export function formatDistance(meters: number): string {
  if (meters >= 1_000_000) return `${(meters / 1_000_000).toFixed(2)} Mm`;
  if (meters >= 1_000) return `${(meters / 1_000).toFixed(1)} km`;
  return `${meters.toFixed(0)} m`;
}

/**
 * 将字节数格式化为可读字符串
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes.toFixed(0)} B`;
}

/**
 * 获取 JS 堆内存使用信息（仅 Chrome 支持）
 */
export function getMemoryInfo(): string {
  const memory = (performance as { memory?: PerformanceMemory }).memory;
  if (!memory) return "Memory: n/a";
  const usedMb = memory.usedJSHeapSize / (1024 * 1024);
  const limitMb = memory.jsHeapSizeLimit / (1024 * 1024);
  return `Memory: ${usedMb.toFixed(0)} / ${limitMb.toFixed(0)} MB`;
}
