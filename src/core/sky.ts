/**
 * 天空/大气渐变管理
 * 根据相机高度动态调整背景色、雾效、FOV
 */
import * as THREE from "three";
import {
  EARTH_RADIUS,
  SKY_FADE_ALTITUDE,
  SKY_FOG_NEAR,
  SKY_FOG_FAR,
  SKY_FOV_NEAR,
  SKY_FOV_FAR,
  SPACE_COLOR,
  SKY_COLOR,
  SKY_FOG_COLOR,
} from "../constants";

/**
 * SkyManager 管理天空背景色与雾效的动态过渡
 */
export class SkyManager {
  /** 过渡混合颜色（可复用对象） */
  private readonly blendColor = new THREE.Color(0x02040b);

  /** 天空雾 */
  private readonly fog = new THREE.Fog(SKY_FOG_COLOR.clone(), SKY_FOG_NEAR, SKY_FOG_FAR);

  constructor(scene: THREE.Scene) {
    scene.fog = this.fog;
  }

  /**
   * 根据海拔高度更新天空颜色、雾效和 FOV
   * @param altitude 相机海拔（米）
   * @param scene 场景引用
   * @param camera 相机引用
   */
  update(altitude: number, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const t = THREE.MathUtils.clamp(1 - altitude / SKY_FADE_ALTITUDE, 0, 1);

    // 背景颜色过渡：太空 → 天空蓝
    this.blendColor.copy(SPACE_COLOR).lerp(SKY_COLOR, t);
    scene.background = this.blendColor;

    // 雾效
    if (t < 0.05) {
      scene.fog = null;
    } else {
      scene.fog = this.fog;
      this.fog.color.copy(SKY_FOG_COLOR).lerp(SPACE_COLOR, 1 - t);
      this.fog.near = SKY_FOG_NEAR * (1 - t) + EARTH_RADIUS * 0.02 * t;
      this.fog.far = SKY_FOG_FAR * (1 - t) + EARTH_RADIUS * 0.5 * t;
    }

    // FOV 动态调整
    const targetFov = THREE.MathUtils.lerp(SKY_FOV_FAR, SKY_FOV_NEAR, t);
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }
  }
}
