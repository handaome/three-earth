# Three Earth (Tianditu)

This project renders a rotating Earth in Three.js using Tianditu imagery tiles.

## Cesium-style demo notes

- Adds a subtle atmosphere glow and emissive base to improve limb contrast.
- Shows a lightweight HUD with zoom, tile stats, and camera distance.
- Auto-rotates when idle to keep the globe alive.

### Controls

- Left drag: rotate globe
- Middle mouse: pointer-lock fly
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
