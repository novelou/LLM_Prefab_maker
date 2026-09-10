"""Run with Blender --background --factory-startup --python scripts/check_blender.py -- [GLB paths]."""
import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector

root = Path(__file__).resolve().parents[1]
paths = [Path(p).resolve() for p in sys.argv[sys.argv.index('--') + 1:]] if '--' in sys.argv else [root / '.local/poc/calibration.glb']
reports = []
for path in paths:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    positions = [o.matrix_world @ Vector(corner) for o in meshes for corner in o.bound_box]
    low = [min(v[i] for v in positions) for i in range(3)]
    high = [max(v[i] for v in positions) for i in range(3)]
    report = {
        'file': str(path.relative_to(root)), 'blender': bpy.app.version_string,
        'meshes': len(meshes), 'triangles': sum(len(o.data.loop_triangles) for o in meshes),
        'dimensionsBlenderXYZ': [high[i] - low[i] for i in range(3)],
        'images': [{'name': im.name, 'size': list(im.size), 'packed': bool(im.packed_file)} for im in bpy.data.images],
        'cameras': sum(o.type == 'CAMERA' for o in bpy.context.scene.objects),
        'lights': sum(o.type == 'LIGHT' for o in bpy.context.scene.objects),
        'negativeScales': [o.name for o in meshes if o.matrix_world.determinant() < 0],
        'objects': [{'name': o.name, 'parent': o.parent.name if o.parent else None} for o in bpy.context.scene.objects],
    }
    for o in meshes:
        o.data.calc_loop_triangles()
    report['triangles'] = sum(len(o.data.loop_triangles) for o in meshes)
    assert meshes and not report['cameras'] and not report['lights']
    if path.name == 'calibration.glb':
        unit = next(o for o in meshes if o.name.replace('_', ' ') == '1m calibration cube')
        assert all(abs(d - 1) <= .01 for d in unit.dimensions), list(unit.dimensions)
        report['calibrationUnitDimensions'] = list(unit.dimensions)
        assert report['images'] and all(i['packed'] for i in report['images'])
        assert len(meshes) == 9 and report['triangles'] == 902
        assert report['negativeScales']
        assert any(o.parent and o.parent.name.replace('_', ' ') == 'Right assembly' for o in meshes)
        # Y-up glTF -> Z-up Blender. Check front and right parts remain on
        # the corresponding axes, without mirroring the model.
        front = next(o for o in meshes if o.name.replace('_', ' ') == 'Front triangle')
        vase = next(o for o in meshes if o.name.replace('_', ' ') == 'Lathe vase')
        assert front.matrix_world.translation.y < 0
        assert vase.matrix_world.translation.x > 0
        report['orientationVerified'] = True
    report['passed'] = True
    reports.append(report)
out = root / '.local/poc/blender-check.json'
out.parent.mkdir(exist_ok=True, parents=True)
out.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': len(reports), 'report': str(out)}, ensure_ascii=False))
