"""Optional Blender workflow. NOT executed during integration.

Reuses the bundled Rigify generator and vendored official basic-human metarig.
--prepare creates an UNFITTED metarig in a new copy for manual bone placement.
--generate requires the fitted metarig's lifeline_fit_reviewed property to be True.
No geometric auto-fit, original overwrite, simulated training, or live ingestion.
"""
import argparse
import importlib.util
import pathlib
import sys
import bpy


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--input", required=True)
    args.add_argument("--output", required=True)
    args.add_argument("--person", default="Person | 6 ft 3 in | lying on kitchen floor")
    mode = args.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--generate", action="store_true")
    cfg = args.parse_args(sys.argv[sys.argv.index("--") + 1:])
    source, output = pathlib.Path(cfg.input).resolve(), pathlib.Path(cfg.output).resolve()
    if source == output or output.exists() or not source.is_file():
        raise ValueError("Use an existing input and a NEW separate output; overwrite is disabled.")
    bpy.ops.wm.open_mainfile(filepath=str(source))
    bpy.ops.preferences.addon_enable(module="rigify")
    person = bpy.data.objects.get(cfg.person)
    if person is None or person.type != "MESH":
        raise ValueError("The supplied person mesh was not found.")
    bpy.ops.object.select_all(action="DESELECT")
    if cfg.prepare:
        if bpy.data.objects.get("LIFELINE_metarig"):
            raise ValueError("A metarig already exists; fit it before generation.")
        bpy.ops.object.armature_add()
        metarig = bpy.context.object
        metarig.name = "LIFELINE_metarig"
        bpy.ops.object.mode_set(mode="EDIT")
        for bone in list(metarig.data.edit_bones):
            metarig.data.edit_bones.remove(bone)
        bpy.ops.object.mode_set(mode="OBJECT")
        template = pathlib.Path(__file__).parent / "vendor" / "rigify-basic-human.py"
        spec = importlib.util.spec_from_file_location("lifeline_rigify_template", template)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.create(metarig)
        if bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        metarig.location = person.location
        metarig.show_in_front = True
        metarig["lifeline_fit_reviewed"] = False
        metarig["lifeline_note"] = "Unfitted template. Supine mesh requires bone placement and rest-pose review."
    else:
        from rigify.generate import generate_rig
        metarig = bpy.data.objects.get("LIFELINE_metarig")
        if metarig is None or metarig.get("lifeline_fit_reviewed") is not True:
            raise ValueError("Fit the bones to this posed mesh and set lifeline_fit_reviewed=True first.")
        metarig.select_set(True)
        bpy.context.view_layer.objects.active = metarig
        generate_rig(bpy.context, metarig)
        rig = metarig.data.rigify_target_rig
        if rig is None:
            raise RuntimeError("Rigify did not return a generated rig.")
        bpy.ops.object.select_all(action="DESELECT")
        rig.select_set(True)
        person.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        rig["lifeline_weight_review_required"] = True
        # Attachment anchors for later animated pose sampling. Body data axes
        # must be set from the actual placement, not guessed from model axes.
        for name, bone_name in [("Sensor_chest_WILi", "DEF-spine.003"), ("Sensor_waist_AirPod", "DEF-spine")]:
            bone = rig.data.bones.get(bone_name)
            if bone is None:
                raise ValueError("Expected Rigify spine bone unavailable; review attachment mapping.")
            anchor = bpy.data.objects.new(name, None)
            bpy.context.collection.objects.link(anchor)
            anchor.matrix_world.translation = rig.matrix_world @ bone.head_local
            anchor.parent, anchor.parent_type, anchor.parent_bone = rig, "BONE", bone_name
            anchor.matrix_world.translation = rig.matrix_world @ bone.head_local
            anchor["provenance"] = "Offline synthetic attachment; placement/orientation needs review."
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output))


if __name__ == "__main__":
    main()
