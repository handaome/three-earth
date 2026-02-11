# Three Earth (Tianditu)

本项目使用 Three.js 与天地图影像瓦片渲染一个可旋转的地球。

## Cesium 风格演示说明

- 添加了轻微的大气辉光与自发光底色，提升地球边缘对比度。
- 显示轻量 HUD，包含缩放级别、瓦片统计与相机距离。
- 空闲时自动旋转，让地球保持“活跃”。
- 保持相机北向朝上，既能围绕地球观察又不锁死旋转。
- pan3D 遵循 Cesium 3D 行为：角度分解在世界坐标系完成。

### 控制方式

- 左键拖拽：旋转地球
- 中键拖拽：倾斜视角
- 滚轮：朝向鼠标位置缩放
- H：切换 HUD

## 配置天地图 Token

在项目根目录创建 `.env` 文件：

```
VITE_TDT_TOKEN=your_tianditu_token
```

可选覆盖配置：

```
VITE_TDT_BASE_URL=https://t0.tianditu.gov.cn
```

开发环境使用 Vite 代理 `/tdt` 以避免 CORS。详情见
[docs/tianditu-cors.md](docs/tianditu-cors.md)。

## 经纬度定位

页面加载后，你可以在控制台调用以下方法：

```
setEarthLocation(116.391, 39.907);
focusCameraOnLonLat(116.391, 39.907, 2.2);
```

更多说明见 [docs/geo-location.md](docs/geo-location.md)。

## 脚本

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
