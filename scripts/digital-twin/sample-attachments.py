"""Optional Blender pose sampler; unexecuted. Export only to offline JSON.

Requires reviewed, animated rig + chest/waist anchors from rig-person.py.
No animation creation, live packets, contact physics, or detector parameters.
"""
import argparse
import json
import math
import pathlib
import sys
import bpy
from mathutils import Vector


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scenario", choices=["fall", "shaking", "gait"], required=True)
    cfg = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    source, output = pathlib.Path(cfg.input).resolve(), pathlib.Path(cfg.output).resolve()
    if not source.is_file() or source == output or output.exists() or output.suffix != ".json":
        raise ValueError("Use an existing animated input and a NEW .json output.")
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene = bpy.context.scene
    names = {"chest": "Sensor_chest_WILi", "waist": "Sensor_waist_AirPod"}
    anchors = {key: bpy.data.objects.get(name) for key, name in names.items()}
    if any(obj is None for obj in anchors.values()):
        raise ValueError("Reviewed sensor anchors are required; run no automatic fitting here.")
    dt = scene.render.fps_base / scene.render.fps
    if scene.frame_end - scene.frame_start < 3:
        raise ValueError("Provide an animation with at least four frames.")
    poses = []
    original_frame = scene.frame_current
    try:
        for frame in range(scene.frame_start, scene.frame_end + 1):
            scene.frame_set(frame)
            graph = bpy.context.evaluated_depsgraph_get()
            poses.append({key: obj.evaluated_get(graph).matrix_world.copy() for key, obj in anchors.items()})
        samples = []
        # Skip endpoints: central differences require samples on both sides.
        for i in range(1, len(poses) - 1):
            sensors = {}
            for key in names:
                prev, current, following = [poses[index][key] for index in [i - 1, i, i + 1]]
                acceleration = (following.translation - 2 * current.translation + prev.translation) / (dt * dt)
                orientation = current.to_quaternion()
                specific_force = orientation.inverted() @ (acceleration - Vector((0, 0, -9.80665))) / 9.80665
                delta = prev.to_quaternion().rotation_difference(following.to_quaternion())
                axis, angle = delta.to_axis_angle()
                if angle > math.pi:
                    angle -= 2 * math.pi
                local_rotation = orientation.inverted() @ (prev.to_quaternion() @ axis) * (angle / (2 * dt))
                sensors[key] = {"positionM": list(current.translation), "quaternionWXYZ": list(orientation),
                    "accelerationG": list(specific_force), "rotationRateRadS": list(local_rotation),
                    "provenance": "synthetic-animated-pose"}
            samples.append({"timeSeconds": i * dt, "frame": scene.frame_start + i, "sensors": sensors})
    finally:
        scene.frame_set(original_frame)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as stream:
        json.dump({"schema": "lifeline.offline-blender-pose.v1", "provenance": "synthetic-animated-pose",
            "scenario": cfg.scenario, "notForTraining": True, "source": source.name, "sampleHz": 1 / dt,
            "coordinateFrame": "Blender Z-up; local sensor axes require placement review",
            "limitations": ["Kinematic derivatives only; not contact forces", "No clinical validation", "No live ingestion"],
            "samples": samples}, stream, indent=2)


if __name__ == "__main__":
    main()
