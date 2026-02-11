/**
 * 星空背景创建
 * 在球壳上随机分布点精灵，模拟太空星空
 */
import * as THREE from "three";

/**
 * 创建星空粒子系统
 * @param count 星星数量
 * @param radius 分布球壳半径
 * @returns Points 对象
 */
export function createStars(count: number, radius: number): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.7 + Math.random() * 0.3);

    const index = i * 3;
    positions[index] = r * Math.sin(phi) * Math.cos(theta);
    positions[index + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[index + 2] = r * Math.cos(phi);
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.2,
    sizeAttenuation: true,
    opacity: 0.8,
    transparent: true,
  });

  return new THREE.Points(geometry, material);
}
