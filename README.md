# Three Earth (Tianditu)

This project renders a rotating Earth in Three.js using Tianditu imagery tiles.

## Cesium-style demo notes

- Adds a subtle atmosphere glow and emissive base to improve limb contrast.
- Shows a lightweight HUD with zoom, tile stats, and camera distance.
- Auto-rotates when idle to keep the globe alive.
- Keeps camera orientation north-up so the globe stays under view without locking rotation.

### Controls

- Left drag: rotate globe
- Middle drag: tilt
- Right drag: zoom
- Wheel: zoom toward cursor
- H: toggle HUD

## Configure Tianditu token

Create a `.env` file in the project root:

```
VITE_TDT_TOKEN=your_tianditu_token
```

Optional overrides:

```
VITE_TDT_BASE_URL=https://t0.tianditu.gov.cn
```

In development, the project uses a Vite proxy at `/tdt` to avoid CORS. See
[docs/tianditu-cors.md](docs/tianditu-cors.md) for details.

## 经纬度定位

页面加载后，你可以在控制台调用以下方法：

```
setEarthLocation(116.391, 39.907);
focusCameraOnLonLat(116.391, 39.907, 2.2);
```

更多说明见 [docs/geo-location.md](docs/geo-location.md)。

## Scripts

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

## 项目结构

```
src/
  main.ts                    # 应用入口，编排各模块
  constants.ts               # 全局常量与配置
  types.d.ts                 # TypeScript 类型定义
  style.css                  # 全局样式
  vite-env.d.ts              # Vite 环境类型声明
  core/
    camera-controls.ts       # CameraController — Cesium 风格相机交互
    sky.ts                   # SkyManager — 天空/大气颜色与雾效
  globe/
    earth.ts                 # EarthBuilder — 地球本体、大气层、辉光、标记点
    tile-manager.ts          # TileManager — 瓦片加载/缓存/可见性管理
  ui/
    hud.ts                   # HudManager — HUD 调试信息与错误 overlay
  utils/
    geo.ts                   # 地理坐标转换（经纬度 ↔ 瓦片 ↔ 世界坐标）
    format.ts                # 格式化工具（距离、字节、内存）
    stars.ts                 # 星空粒子系统
```
