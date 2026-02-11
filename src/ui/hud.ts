/**
 * HUD 和 Overlay 管理
 * 负责屏幕上的调试信息显示和错误提示
 */
import { EARTH_RADIUS, HUD_UPDATE_INTERVAL, TDT_TOKEN } from "../constants";
import { formatDistance, getMemoryInfo } from "../utils/format";
import type { TileManager } from "../globe/tile-manager";

/**
 * HudManager 管理 HUD 与 overlay DOM 元素
 */
export class HudManager {
  /** HUD 元素 */
  readonly hud: HTMLDivElement;

  /** Overlay 提示元素 */
  readonly overlay: HTMLDivElement;

  /** HUD 可见状态 */
  private hudVisible = true;

  /** 上次 HUD 更新时间 */
  private lastHudUpdate = 0;

  constructor() {
    // 创建 overlay
    this.overlay = document.createElement("div");
    this.overlay.id = "overlay";
    this.overlay.textContent = "Set VITE_TDT_TOKEN in .env to load Tianditu imagery.";
    this.overlay.hidden = true;
    document.body.appendChild(this.overlay);

    // 创建 HUD
    this.hud = document.createElement("div");
    this.hud.id = "hud";
    this.hud.textContent = "Loading earth...";
    document.body.appendChild(this.hud);

    // 按 H 切换 HUD 显示
    window.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "h") return;
      this.hudVisible = !this.hudVisible;
      this.hud.hidden = !this.hudVisible;
    });

    // 全局错误捕获
    globalThis.addEventListener("error", (event: ErrorEvent) => {
      console.error("[Earth] window error", event.error || event.message);
      this.overlay.textContent = `Error: ${event.message || event.error}`;
      this.overlay.hidden = false;
    });

    globalThis.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      console.error("[Earth] unhandled rejection", event.reason);
      this.overlay.textContent = `Error: ${event.reason || "Unhandled rejection"}`;
      this.overlay.hidden = false;
    });
  }

  /**
   * 每帧更新 HUD 信息
   * @param now 当前时间戳
   * @param distance 相机到原点的距离
   * @param tileManager 瓦片管理器引用
   */
  update(now: number, distance: number, tileManager: TileManager): void {
    if (!this.hudVisible) return;
    if (now - this.lastHudUpdate < HUD_UPDATE_INTERVAL) return;
    this.lastHudUpdate = now;

    const altitude = Math.max(distance - EARTH_RADIUS, 0);
    const zoomLabel = tileManager.currentZoom === null ? "-" : String(tileManager.currentZoom);
    const loadStatus =
      tileManager.pendingTileLoads.length > 0 || tileManager.activeTileLoads > 0
        ? "refining"
        : "stable";

    this.hud.textContent = [
      "Cesium-style demo (Three.js)",
      `Zoom: ${zoomLabel} | Visible tiles: ${tileManager.visibleTileCount} | ${loadStatus}`,
      `Tile loads: ${tileManager.tileSuccessCount}/${tileManager.tileRequestCount} | Active: ${tileManager.activeTileLoads} | Queue: ${tileManager.pendingTileLoads.length}`,
      `Altitude: ${formatDistance(altitude)} | Distance: ${formatDistance(distance)}`,
      getMemoryInfo(),
      tileManager.getTextureMemoryInfo(),
      "Left drag: rotate | Middle drag: tilt | Right drag: zoom | Wheel: zoom | H: toggle HUD",
    ].join("\n");
  }

  /**
   * 启动瓦片加载失败检测定时器
   */
  startTileFailureCheck(tileManager: TileManager): void {
    setInterval(() => {
      if (!TDT_TOKEN) return;
      if (tileManager.tileRequestCount > 0 && tileManager.tileSuccessCount === 0) {
        this.overlay.textContent =
          "Tianditu tiles failed. Check token/CORS/network in console.";
        this.overlay.hidden = false;
      }
    }, 3000);
  }
}
