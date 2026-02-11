/**
 * 地球模型构建
 * 包含地球本体、大气层、辉光效果和标记点
 */
import * as THREE from "three";
import { EARTH_RADIUS, TILE_SURFACE_OFFSET } from "../constants";
import { lonLatToWorld } from "../utils/geo";

/**
 * 辉光 Shader 的 uniforms 类型
 */
interface GlowUniforms {
  viewVector: { value: THREE.Vector3 };
  glowColor: { value: THREE.Color };
  c: { value: number };
  p: { value: number };
}

/** 辉光顶点着色器 */
const GLOW_VERTEX_SHADER = `
  uniform vec3 viewVector;
  uniform float c;
  uniform float p;
  varying float intensity;
  void main() {
    vec3 vNormal = normalize(normalMatrix * normal);
    vec3 vNormel = normalize(normalMatrix * viewVector);
    intensity = pow(c - dot(vNormal, vNormel), p);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** 辉光片元着色器 */
const GLOW_FRAGMENT_SHADER = `
  uniform vec3 glowColor;
  varying float intensity;
  void main() {
    vec3 color = glowColor * intensity;
    gl_FragColor = vec4(color, intensity);
  }
`;

/**
 * EarthBuilder 负责创建地球相关的所有 3D 对象
 */
export class EarthBuilder {
  /** 地球 Group（包含地球本体、大气、瓦片等） */
  readonly globeGroup = new THREE.Group();

  /** 地球本体 Mesh */
  readonly earthMesh: THREE.Mesh;

  /** 大气层 Mesh */
  readonly atmosphere: THREE.Mesh;

  /** 辉光 Mesh */
  readonly glowMesh: THREE.Mesh;

  /** 辉光材质（需要每帧更新 viewVector） */
  readonly glowMaterial: THREE.ShaderMaterial;

  /** 标记点组 */
  readonly markerGroup = new THREE.Group();

  /** 默认标记点 Mesh */
  readonly markerMesh: THREE.Mesh;

  constructor() {
    // 地球本体
    const earthGeometry = new THREE.SphereGeometry(EARTH_RADIUS, 64, 64);
    const earthMaterial = new THREE.MeshStandardMaterial({
      color: 0x0f1b2d,
      roughness: 0.85,
      metalness: 0,
      emissive: new THREE.Color(0x05080f),
      emissiveIntensity: 0.35,
    });
    this.earthMesh = new THREE.Mesh(earthGeometry, earthMaterial);
    this.globeGroup.add(this.earthMesh);

    // 大气层
    const atmosphereGeometry = new THREE.SphereGeometry(EARTH_RADIUS * 1.02, 64, 64);
    const atmosphereMaterial = new THREE.MeshBasicMaterial({
      color: 0x3a76c4,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide,
    });
    this.atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    this.globeGroup.add(this.atmosphere);

    // 辉光效果
    const glowGeometry = new THREE.SphereGeometry(EARTH_RADIUS * 1.06, 64, 64);
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        viewVector: { value: new THREE.Vector3() },
        glowColor: { value: new THREE.Color(0x6aa7ff) },
        c: { value: 0.4 },
        p: { value: 2.7 },
      } as Record<string, THREE.IUniform>,
      vertexShader: GLOW_VERTEX_SHADER,
      fragmentShader: GLOW_FRAGMENT_SHADER,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
    this.glowMesh = new THREE.Mesh(glowGeometry, this.glowMaterial);
    this.globeGroup.add(this.glowMesh);

    // 标记点
    const markerMaterial = new THREE.MeshStandardMaterial({
      color: 0xffc34d,
      roughness: 0.35,
      metalness: 0.1,
      emissive: new THREE.Color(0xff8c00),
      emissiveIntensity: 0.4,
    });
    const markerGeometry = new THREE.SphereGeometry(EARTH_RADIUS * 0.01, 24, 24);
    this.markerMesh = new THREE.Mesh(markerGeometry, markerMaterial);
    this.markerMesh.visible = false;
    this.markerGroup.add(this.markerMesh);
    this.earthMesh.add(this.markerGroup);
  }

  /**
   * 在地球表面设置标记点
   * @param lon 经度
   * @param lat 纬度
   * @param altitude 海拔高度（默认 0）
   * @returns 标记点在世界坐标系中的位置
   */
  setEarthLocation(lon: number, lat: number, altitude = 0): THREE.Vector3 {
    const radius = EARTH_RADIUS + TILE_SURFACE_OFFSET + altitude;
    const position = lonLatToWorld(lon, lat, radius);
    this.markerMesh.position.copy(position);
    this.markerMesh.visible = true;
    return position.clone();
  }

  /**
   * 每帧更新辉光效果的视角向量
   */
  updateGlow(cameraPosition: THREE.Vector3): void {
    this.glowMaterial.uniforms.viewVector.value.copy(cameraPosition);
  }
}
