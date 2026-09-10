import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { executableSource } from '../shared/source.mjs';

// All trusted state stays in this closure, including the private RPC port.
let port, renderer, canvas, scene, camera, root, grid, settings, stats;
const target = new THREE.Vector3();
let radius = 3,
  theta = Math.PI / 4,
  phi = Math.PI / 3,
  extent = 1;
const addons = Object.freeze({ BufferGeometryUtils, RoundedBoxGeometry, ConvexGeometry });
const originals = new Map();
const defaultBeforeRender = THREE.Object3D.prototype.onBeforeRender;
const defaultCompile = THREE.Material.prototype.onBeforeCompile;

function inspect(model, budget) {
  let meshes = 0,
    triangles = 0,
    bytes = 0;
  const materials = new Set(),
    geometries = new Set(),
    textures = new Set(),
    warnings = new Set();
  model.updateMatrixWorld(true);
  model.traverse((obj) => {
    if (obj.isCamera || obj.isLight || /Helper$/.test(obj.type))
      warnings.add('モデル内のカメラ・ライト・補助線はGLBの対象外です。コードから除いてください。');
    if (obj.isSkinnedMesh)
      warnings.add(
        'スキニングされたモデルは静的モデルの検証対象外です。CPU側の静的メッシュに確定してください。',
      );
    if (!obj.visible)
      warnings.add(
        '非表示の部品があります。表示と保存結果の違いを避けるため、不要な部品は削除してください。',
      );
    if (obj.onBeforeRender !== defaultBeforeRender)
      warnings.add('onBeforeRender の独自処理はGLBへ保存できません。');
    if (obj.geometry) {
      meshes++;
      const g = obj.geometry,
        pos = g.getAttribute('position');
      if (!pos || pos.itemSize !== 3)
        throw new Error(`${obj.name || 'Geometry'}: 3成分のposition属性が必要です。`);
      if (obj.isMesh)
        triangles +=
          ((g.index ? g.index.count : pos.count) / 3) * (obj.isInstancedMesh ? obj.count : 1);
      if (!geometries.has(g)) {
        geometries.add(g);
        for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
        if (g.index) bytes += g.index.array.byteLength;
        if (bytes > 256 * 1024 * 1024) throw new Error('Geometry の合計が256MBを超えました。');
        for (let i = 0; i < pos.count; i++)
          if (![pos.getX(i), pos.getY(i), pos.getZ(i)].every(Number.isFinite))
            throw new Error('頂点座標にNaN/Infinityがあります。');
        if (g.index)
          for (let i = 0; i < g.index.count; i++)
            if (g.index.getX(i) >= pos.count) throw new Error('頂点インデックスが範囲外です。');
      }
    }
    for (const mat of obj.material
      ? Array.isArray(obj.material)
        ? obj.material
        : [obj.material]
      : []) {
      materials.add(mat);
      if (
        !(
          mat.isMeshStandardMaterial ||
          mat.isMeshBasicMaterial ||
          mat.isLineBasicMaterial ||
          mat.isPointsMaterial
        )
      )
        warnings.add(
          `${mat.type} はそのままGLBへ保存できません。標準PBR/Basicマテリアルへの変換が必要です。`,
        );
      if (mat.onBeforeCompile !== defaultCompile)
        warnings.add('独自シェーダー処理 onBeforeCompile はGLBへ保存できません。');
      if (mat.displacementMap && mat.displacementScale !== 0)
        warnings.add(
          'displacementMap の頂点変形はGLBに保持されません。CPU側の頂点へ変形を反映してください。',
        );
      if (mat.clippingPlanes?.length)
        warnings.add(
          'クリッピング平面はGLBに保持されません。切断後の形状をメッシュ化してください。',
        );
      if (mat.envMap) warnings.add('マテリアル固有の環境マップはGLBに保持されません。');
      if (mat.wireframe)
        warnings.add('マテリアル固有のワイヤーフレーム表示はGLBに保持されません。');
      for (const value of Object.values(mat))
        if (value?.isTexture && !textures.has(value)) {
          textures.add(value);
          const img = value.image;
          if (!img || !img.width || !img.height)
            warnings.add('未読込または未対応のテクスチャがあります。');
          else {
            if (img.width > budget.maxTextureSize || img.height > budget.maxTextureSize)
              throw new Error(`テクスチャが上限 ${budget.maxTextureSize}px を超えています。`);
            bytes += img.width * img.height * 4;
          }
          if (
            value.isCompressedTexture ||
            value.isVideoTexture ||
            value.isCubeTexture ||
            value.isData3DTexture ||
            value.isDataArrayTexture
          )
            warnings.add('このテクスチャ形式はGLBへの自動変換に未対応です。');
        }
    }
    if (meshes > budget.maxMeshes || triangles > budget.maxTriangles)
      throw new Error(
        `生成規模が予算を超えました (${meshes}メッシュ / ${Math.ceil(triangles)}三角形)。詳細設定で変更できます。`,
      );
    if (bytes > 256 * 1024 * 1024) throw new Error('モデルの推定メモリが256MBを超えました。');
  });
  if (!meshes) throw new Error('表示できるGeometryがありません。');
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3());
  if (
    box.isEmpty() ||
    ![...box.min, ...box.max].every(Number.isFinite) ||
    size.length() < 1e-8 ||
    size.length() > 1e5
  )
    throw new Error('モデルの寸法が不正です。メートル単位で有限の形状を作ってください。');
  return {
    meshes,
    triangles: Math.ceil(triangles),
    materials: materials.size,
    textures: textures.size,
    bytes,
    size: size.toArray(),
    min: box.min.toArray(),
    max: box.max.toArray(),
    warnings: [...warnings],
  };
}
function positionCamera() {
  camera.position.set(
    target.x + radius * Math.sin(phi) * Math.sin(theta),
    target.y + radius * Math.cos(phi),
    target.z + radius * Math.sin(phi) * Math.cos(theta),
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld();
}
function render() {
  positionCamera();
  renderer.render(scene, camera);
}
function frame(view = 'iso') {
  const box = new THREE.Box3().setFromObject(root, true);
  box.getCenter(target);
  extent = Math.max(box.getSize(new THREE.Vector3()).length(), 0.05);
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const angle = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
  radius = (extent / (2 * Math.sin(angle))) * 1.15;
  theta = view === 'side' ? Math.PI / 2 : view === 'front' || view === 'top' ? 0 : Math.PI / 4;
  phi = view === 'top' ? 0.001 : view === 'front' || view === 'side' ? Math.PI / 2 : Math.PI / 3;
  camera.near = Math.max(0.0001, extent / 1000);
  camera.far = extent * 100;
  camera.updateProjectionMatrix();
  render();
}
function resize(width, height) {
  renderer.setSize(Math.max(1, Math.min(2400, width)), Math.max(1, Math.min(1600, height)), false);
  camera.aspect = canvas.width / canvas.height;
  camera.updateProjectionMatrix();
  render();
}
async function initialize(data) {
  settings = data.settings;
  canvas = data.canvas;
  // This is execution, not a security boundary. The opaque-origin Worker + CSP
  // supplies isolation; the host owns a hard deadline and Worker termination.
  const factory = new Function(
    'THREE',
    'addons',
    'seed',
    '"use strict";\n' +
      executableSource(data.source) +
      '\nreturn createModel({ THREE, addons, seed });',
  );
  const result = await factory(THREE, addons, data.seed);
  root = result?.modelRoot ?? result;
  if (!(root instanceof THREE.Object3D))
    throw new Error('createModel は { modelRoot: THREE.Group } を返してください。');
  if (root.parent) root.removeFromParent();
  stats = inspect(root, settings);
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#191d23');
  if (
    typeof result?.preview?.background === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(result.preview.background)
  )
    scene.background.set(result.preview.background);
  camera = new THREE.PerspectiveCamera(38, canvas.width / canvas.height, 0.01, 1000);
  const ambient = new THREE.HemisphereLight(0xe7edff, 0x62616a, 2.5);
  const key = new THREE.DirectionalLight(0xffecd4, 4);
  key.position.set(4, 8, 6);
  const fill = new THREE.DirectionalLight(0xc5d5ff, 2);
  fill.position.set(-5, 4, -3);
  scene.add(ambient, key, fill, root);
  const gridSize = Math.max(2, Math.ceil(Math.max(stats.size[0], stats.size[2]) * 2));
  grid = new THREE.GridHelper(gridSize, 20, 0x525760, 0x333941);
  grid.position.y = stats.min[1] - 0.002;
  scene.add(grid);
  frame();
  return stats;
}
async function screenshot() {
  render();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return await new Promise((yes, no) => {
    const reader = new FileReader();
    reader.onload = () => yes(reader.result);
    reader.onerror = no;
    reader.readAsDataURL(blob);
  });
}
function wireframe(enabled) {
  root.traverse((obj) => {
    for (const mat of obj.material
      ? Array.isArray(obj.material)
        ? obj.material
        : [obj.material]
      : []) {
      if (!originals.has(mat)) originals.set(mat, mat.wireframe);
      mat.wireframe = enabled ? true : originals.get(mat);
    }
  });
  render();
}
async function exportModel() {
  // Wireframe is a viewport option and never changes the exported material.
  const prior = new Map();
  originals.forEach((value, mat) => {
    prior.set(mat, mat.wireframe);
    mat.wireframe = value;
  });
  try {
    const inspection = inspect(root, settings);
    if (inspection.warnings.length)
      throw new Error('GLB互換性: ' + inspection.warnings.join(' / '));
    const buffer = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });
    if (
      !(buffer instanceof ArrayBuffer) ||
      buffer.byteLength < 20 ||
      buffer.byteLength > 128 * 1024 * 1024
    )
      throw new Error('GLBのサイズが不正または128MBを超えました。');
    // Reload into a fresh scene before reporting a successful export.
    const loaded = await new GLTFLoader().parseAsync(buffer, '');
    try {
      const roundtrip = inspect(loaded.scene, settings);
      const tolerance = Math.max(...stats.size) * 0.01 + 1e-6;
      if (
        roundtrip.meshes !== stats.meshes ||
        roundtrip.triangles !== stats.triangles ||
        roundtrip.size.some((n, i) => Math.abs(n - stats.size[i]) > tolerance) ||
        roundtrip.min.some((n, i) => Math.abs(n - stats.min[i]) > tolerance) ||
        roundtrip.textures < stats.textures
      )
        throw new Error('GLB再読込で寸法・位置・部品数・テクスチャ数が一致しませんでした。');
      return { buffer, roundtrip };
    } finally {
      dispose(loaded.scene);
    }
  } finally {
    prior.forEach((value, mat) => {
      mat.wireframe = value;
    });
  }
}
function dispose(object) {
  const seen = new Set();
  object?.traverse((obj) => {
    obj.geometry?.dispose();
    for (const mat of obj.material
      ? Array.isArray(obj.material)
        ? obj.material
        : [obj.material]
      : []) {
      for (const value of Object.values(mat))
        if (value?.isTexture && !seen.has(value)) {
          seen.add(value);
          value.dispose();
          value.image?.close?.();
        }
      mat.dispose();
    }
  });
}
async function command(type, data) {
  switch (type) {
    case 'init':
      return initialize(data);
    case 'resize':
      resize(data.width, data.height);
      return true;
    case 'view':
      frame(data.view);
      return true;
    case 'orbit':
      theta -= data.dx * 0.008;
      phi = THREE.MathUtils.clamp(phi - data.dy * 0.008, 0.001, Math.PI - 0.001);
      render();
      return true;
    case 'pan': {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      target
        .addScaledVector(right, -data.dx * radius * 0.0015)
        .addScaledVector(up, data.dy * radius * 0.0015);
      render();
      return true;
    }
    case 'zoom':
      radius = THREE.MathUtils.clamp(
        radius * Math.exp(data.delta * 0.001),
        extent * 0.05,
        extent * 40,
      );
      render();
      return true;
    case 'wireframe':
      wireframe(data.enabled);
      return true;
    case 'grid':
      grid.visible = data.enabled;
      render();
      return true;
    case 'capture': {
      const saved = {
        radius,
        theta,
        phi,
        target: target.clone(),
        width: canvas.width,
        height: canvas.height,
        grid: grid.visible,
      };
      try {
        grid.visible = false;
        resize(640, 640);
        const images = [];
        for (const view of ['front', 'side', 'iso']) {
          frame(view);
          images.push(await screenshot());
        }
        return images;
      } finally {
        resize(saved.width, saved.height);
        radius = saved.radius;
        theta = saved.theta;
        phi = saved.phi;
        target.copy(saved.target);
        grid.visible = saved.grid;
        render();
      }
    }
    case 'export':
      return exportModel();
    case 'dispose':
      dispose(scene);
      renderer?.dispose();
      renderer?.forceContextLoss();
      return true;
    default:
      throw new Error('未対応のプレビュー操作です。');
  }
}
self.onmessage = (event) => {
  if (!event.data?.port || port) return;
  port = event.data.port;
  self.onmessage = null;
  // The transferred port is inaccessible to generated code; global postMessage
  // is deliberately not used to receive trusted runtime results.
  let chain = Promise.resolve();
  port.onmessage = (event) => {
    const { id, type, data } = event.data;
    chain = chain.then(async () => {
      try {
        const result = await command(type, data);
        port.postMessage(
          { id, result },
          result?.buffer instanceof ArrayBuffer ? [result.buffer] : [],
        );
      } catch (err) {
        port.postMessage({ id, error: String(err?.message || err).slice(0, 4000) });
      }
    });
  };
};
