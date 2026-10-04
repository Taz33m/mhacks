"""Build the native display assets and a contact sheet without opening any device."""
import importlib.util
import pathlib
import shutil
import os
import sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
# Use the board runtime's Pillow for identical contact/preview pixels. Different
# Pillow versions can rasterize the same font differently and change asset hashes.
runtime=ROOT/'output/freewili-runtime/bin/python'
if runtime.is_file() and pathlib.Path(sys.executable).resolve()!=runtime.resolve():
 os.execv(str(runtime),[str(runtime),str(pathlib.Path(__file__).resolve()),*sys.argv[1:]])
from PIL import Image,ImageDraw
spec=importlib.util.spec_from_file_location('ambient_ui',ROOT/'native/freewili/ambient_ui.py')
ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
dest=ROOT/'output/wili-ui';manifest=ui.build_assets(dest)
sheet=Image.new('RGB',(4*344,4*276),'#eef0f3');draw=ImageDraw.Draw(sheet)
for i,state in enumerate(ui.FRAMES):
 x,y=(i%4)*344,(i//4)*276
 sheet.paste(ui.render(state,2 if state in ('accepted','heard','listening','speaking') else 0,'Maya' if state in ('accepted','on_way','on_scene','speaking') else ''),(x+12,y+12))
 draw.text((x+14,y+256),state,fill='#26344b')
sheet.save(dest/'contact-sheet.png')
preview=ROOT/'output/wili-ui-preview';preview.mkdir(exist_ok=True)
preview_manifest=ui.build_assets(preview/'assets',['Maya'])
# Browser preview contains pixels and a fictional name, never a backend connection.
for entry in preview_manifest['assets'].values(): (preview/'assets'/entry['file']).unlink(missing_ok=True)
shutil.copyfile(ROOT/'native/freewili/ambient-ui-preview.html',preview/'index.html')
shutil.copyfile(ROOT/'public/fonts/dm-sans-regular.ttf',preview/'dm-sans-regular.ttf')
print(f"Built {len(manifest['assets'])} RGB565 images for the OG 320x240 display; no serial connection.")
