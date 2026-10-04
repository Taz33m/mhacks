"""Export a browser cutaway from the supplied Blender scene; never save over it."""
import bpy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/Users/tazeemmahashin/Documents/ChatGPT/3D/Apartment_111_Blender/Apartment_111_Final.blend')
DEST = ROOT / 'public/media/location'
DEST.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(SOURCE))

# Loose bedroom furnishings are illustrative additions to the supplied studio.
# Build them in the browser export; the source architecture stays reproducible.
furniture = bpy.data.collections.new('13 | Bedroom furnishings')
bpy.context.scene.collection.children.link(furniture)

def finish(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = .8
    return mat

oak = finish('Bedroom | pale oak', (.58, .43, .29))
linen = finish('Bedroom | ivory linen', (.88, .85, .77))
blanket = finish('Bedroom | muted sage duvet', (.34, .46, .42))
rug = finish('Bedroom | oatmeal rug', (.63, .59, .51))

def furnishing(name, center, size, mat, bevel=.025):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = 'Bedroom | ' + name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)
    furniture.objects.link(obj)
    obj.data.materials.append(mat)
    mod = obj.modifiers.new('Soft furniture edges', 'BEVEL')
    mod.width = bevel
    mod.segments = 3
    obj.modifiers.new('Furniture normals', 'WEIGHTED_NORMAL')
    return obj

# North-west bed leaves a wide passage to the kitchen and entry on the east.
furnishing('bed frame', (1.12, 2.65, .22), (1.72, 2.18, .30), oak)
furnishing('mattress', (1.12, 2.65, .47), (1.62, 2.08, .24), linen, .07)
furnishing('headboard', (1.12, 3.78, .57), (1.74, .10, 1.0), oak)
furnishing('duvet', (1.12, 2.40, .615), (1.65, 1.52, .10), blanket, .045)
for x in [.73, 1.51]:
    furnishing('pillow', (x, 3.40, .64), (.64, .40, .15), linen, .07)
furnishing('bedside table', (2.37, 3.48, .30), (.52, .48, .60), oak)
furnishing('bedside table top', (2.37, 3.48, .625), (.56, .52, .05), linen)
furnishing('bedside drawer', (2.37, 3.23, .42), (.43, .025, .17), oak)
furnishing('rug', (1.28, 1.20, .008), (2.25, .82, .016), rug, .007)
# Compact desk and tucked chair sit away from the doorways and window opening.
furnishing('desk top', (3.38, .61, .76), (1.26, .62, .065), oak)
for x in [2.84, 3.92]:
    for y in [.37, .85]:
        furnishing('desk leg', (x, y, .365), (.055, .055, .73), oak, .008)
furnishing('desk chair seat', (3.38, 1.08, .45), (.45, .45, .065), blanket)
furnishing('desk chair back', (3.38, 1.29, .68), (.45, .055, .47), oak)
for x in [3.20, 3.56]:
    for y in [.90, 1.26]:
        furnishing('chair leg', (x, y, .21), (.045, .045, .42), oak, .008)

prefixes = ['00 |', '02 |', '04 |', '05 |', '06 |', '07 |', '12 |', '13 |']
for collection in bpy.data.collections:
    collection.hide_viewport = False
    collection.hide_select = False
for layer in bpy.context.view_layer.layer_collection.children:
    layer.exclude = False
    layer.hide_viewport = False
bpy.ops.object.select_all(action='DESELECT')
selected = []
for collection in bpy.data.collections:
    if not any(collection.name.startswith(prefix) for prefix in prefixes):
        continue
    for obj in collection.objects:
        if obj.type not in {'MESH', 'CURVE', 'EMPTY'}:
            continue
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.select_set(True)
        selected.append(obj.name)
        if obj.name.startswith('Person |'):
            bpy.context.view_layer.objects.active = obj
            modifier = obj.modifiers.new('Browser geometry reduction', 'DECIMATE')
            modifier.ratio = .28
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            assert obj.data.color_attributes.get('SplatColor') is not None

assert any('Derived cutaway shell' in name for name in selected)
assert any(name.startswith('Person |') for name in selected)
assert not any('Full-height architectural shell' in name for name in selected)
assert not any('Presentation ground' in name for name in selected)
bpy.ops.export_scene.gltf(filepath=str(DEST / 'apartment-111.glb'), use_selection=True,
    export_format='GLB', export_yup=True, export_apply=True,
    export_materials='EXPORT', export_vertex_color='MATERIAL')
metadata = {'source': SOURCE.name, 'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    'display': 'Furnished bedroom cutaway apartment with supplied person on the kitchen floor',
    'furnishings': 'Illustrative bed, pillows, bedside table, rug, desk and chair added to studio; not surveyed furnishings',
    'personGeometryRatio': .28, 'selectedObjects': selected,
    'bytes': (DEST / 'apartment-111.glb').stat().st_size,
    'limitations': 'Supplied architectural reconstruction and person placement; not live indoor tracking. Procedural finishes use GLTF base colours.'}
(DEST / 'provenance.json').write_text(json.dumps(metadata, indent=2) + '\n')
print('LOCATION_EXPORTED', metadata['bytes'], 'bytes', len(selected), 'objects')
