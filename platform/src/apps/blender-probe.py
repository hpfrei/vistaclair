# The blender extra's install-time proof (platform-extras.js installBlender):
# render a 64x64 UV sphere with each engine, headless, into <outdir>.
#
#   blender -b --factory-startup -noaudio --python blender-probe.py -- <outdir>
#
# Prints one marker line per fact, which parseProbeLines() reads:
#   PROBE version <bpy.app.version_string>
#   PROBE python <x.y.z>
#   PROBE <ENGINE> ok <seconds> | PROBE <ENGINE> FAIL <message>
# Each engine runs in its own try, so one failing does not hide the others.
# Cycles runs before Eevee: a broken GL stack is the likeliest crash, and it
# should not take the CPU engine's answer down with it.
import os
import sys
import tempfile
import time

import bmesh
import bpy

ENGINES = ('BLENDER_WORKBENCH', 'CYCLES', 'BLENDER_EEVEE')


def say(line):
    print('PROBE ' + line, flush=True)


def build_scene(scene):
    for name in ('Cube',):
        obj = bpy.data.objects.get(name)
        if obj:
            bpy.data.objects.remove(obj)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=1.0)
    mesh = bpy.data.meshes.new('probe')
    bm.to_mesh(mesh)
    bm.free()
    scene.collection.objects.link(bpy.data.objects.new('probe', mesh))
    if scene.camera is None:
        cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
        cam.location = (0.0, -6.0, 0.0)
        cam.rotation_euler = (1.5708, 0.0, 0.0)
        scene.collection.objects.link(cam)
        scene.camera = cam
    if not any(o.type == 'LIGHT' for o in scene.objects):
        light = bpy.data.objects.new('Light', bpy.data.lights.new('Light', 'POINT'))
        light.location = (4.0, -4.0, 5.0)
        scene.collection.objects.link(light)
    scene.render.resolution_x = 64
    scene.render.resolution_y = 64
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'


def render(scene, engine, outdir):
    scene.render.engine = engine
    if engine == 'CYCLES':
        scene.cycles.device = 'CPU'
        scene.cycles.samples = 4
    elif engine == 'BLENDER_EEVEE':
        scene.eevee.taa_render_samples = 4
    target = os.path.join(outdir, engine.lower() + '.png')
    scene.render.filepath = target
    bpy.ops.render.render(write_still=True)
    if not os.path.isfile(target) or os.path.getsize(target) == 0:
        raise RuntimeError('render finished but wrote no image')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    outdir = argv[0] if argv else tempfile.mkdtemp(prefix='vc-blender-probe-')
    os.makedirs(outdir, exist_ok=True)
    say('version ' + bpy.app.version_string)
    say('python ' + sys.version.split()[0])
    scene = bpy.context.scene
    build_scene(scene)
    for engine in ENGINES:
        started = time.time()
        try:
            render(scene, engine, outdir)
            say('%s ok %.2f' % (engine, time.time() - started))
        except Exception as e:  # noqa: BLE001 — every failure is an answer here
            msg = ' '.join(str(e).split())[:300] or type(e).__name__
            say('%s FAIL %s' % (engine, msg))


main()
