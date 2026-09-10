export const calibrationSource = `function createModel({ THREE, addons, seed }) {
  const modelRoot = new THREE.Group(); modelRoot.name = 'Asymmetric calibration';
  const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.18 });
  const add = (geometry, material, position, name, parent = modelRoot) => { const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...position); mesh.name = name; parent.add(mesh); return mesh; };
  const blue = mat('#4b86d2'), orange = mat('#ef9b52'), white = mat('#ded9cb');
  const unit = add(new THREE.BoxGeometry(1, 1, 1), blue, [0, 0.5, 0], '1m calibration cube');
  const stack = new THREE.Group(); stack.name = 'Right assembly'; modelRoot.add(stack);
  add(new THREE.CylinderGeometry(0.22, 0.3, 0.15, 48), orange, [0.85, 0.075, 0], 'Round base', stack);
  const points = [new THREE.Vector2(0.15,0),new THREE.Vector2(0.11,0.12),new THREE.Vector2(0.2,0.36),new THREE.Vector2(0.13,0.48),new THREE.Vector2(0.14,0.5)];
  add(new THREE.LatheGeometry(points, 48), white, [0.85,0.15,0], 'Lathe vase', stack);
  const shape = new THREE.Shape(); shape.moveTo(-0.18,0);shape.lineTo(0.18,0);shape.lineTo(0,0.3);shape.closePath();
  add(new THREE.ExtrudeGeometry(shape,{depth:0.16,bevelEnabled:false}), orange, [0,1,0.3], 'Front triangle');
  for (let i=0;i<3;i++) { const peg=add(new THREE.CylinderGeometry(0.045,0.045,0.28,24),orange,[-0.3+i*0.3,1.14,-0.25],'Repeated peg '+i); }
  const c = new OffscreenCanvas(64,64); const ctx=c.getContext('2d');ctx.fillStyle='#ead7a4';ctx.fillRect(0,0,64,64);ctx.fillStyle='#343a47';ctx.fillRect(0,0,32,32);ctx.fillRect(32,32,32,32);
  const texture = new THREE.CanvasTexture(c); texture.colorSpace=THREE.SRGBColorSpace;
  const tileMat=new THREE.MeshStandardMaterial({map:texture,roughness:0.6});
  add(new THREE.BoxGeometry(0.24,0.24,0.04),tileMat,[0.22,0.62,0.53],'Embedded texture tile');
  const reflected=add(new THREE.ConeGeometry(0.14,0.35,3),white,[-0.76,0.175,0.12],'Negative scale marker');reflected.scale.x=-1;
  return {modelRoot};
}`;
