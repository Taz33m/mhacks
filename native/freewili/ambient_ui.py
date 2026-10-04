"""LIFELINE's 320x240 ambient vocabulary; no device discovery or safety decisions."""
import hashlib
import json
import math
import pathlib
import struct
import time
import wave
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
SIZE = (320, 240)
BG, BLUE, WHITE, MUTED = '#0b1018', '#1683ff', '#f4f7fc', '#8b99ad'
FRAMES = {'ready': 1, 'checking': 4, 'reaching': 4, 'listening': 4,
          'processing': 3, 'heard': 3, 'accepted': 3, 'on_way': 1,
          'on_scene': 1, 'speaking': 4, 'resolved': 1, 'cancelled': 1, 'unavailable': 1}
FRAMES.update(ready_talk=1, recording=4, recording_limit=1)
LABELS = {'ready': 'Here with you', 'checking': 'Do you need help?', 'reaching': 'Reaching out',
          'listening': "I'm listening", 'processing': 'One moment', 'heard': 'I heard you',
          'accepted': 'Responded', 'on_way': 'On the way', 'on_scene': 'Here with you',
          'speaking': 'A message for you', 'resolved': 'Care complete', 'cancelled': 'Check-in closed',
          'unavailable': 'Please try again'}
LABELS.update(ready_talk='Here with you',recording="I'm listening",recording_limit='Release to finish')

def clean_name(value):
    return ' '.join(str(value or '').split())[:40]

def font(size):
    return ImageFont.truetype(str(ROOT / 'public/fonts/dm-sans-regular.ttf'), size * 3)

def render(state, frame=0, owner='', wellbeing=False):
    if state not in FRAMES: raise ValueError('Unknown ambient state')
    if state=='ready_talk':state='ready';wellbeing=True
    if state=='recording':state='listening';wellbeing=True
    owner = clean_name(owner)
    im = Image.new('RGB', (960, 720), BG)
    d = ImageDraw.Draw(im)
    def ellipse(box, fill=None, outline=None, width=1):
        d.ellipse(tuple(int(v*3) for v in box), fill=fill, outline=outline, width=width*3)
    def line(points, fill, width=2):
        d.line([(int(x*3),int(y*3)) for x,y in points], fill=fill, width=width*3, joint='curve')
    def text(value, y, size=20, fill=WHITE, x=160):
        d.text((x*3,y*3),value,font=font(size),fill=fill,anchor='mm')
    def bubble(x,y,w,h,fill=BLUE):
        d.rounded_rectangle((x*3,y*3,(x+w)*3,(y+h)*3),radius=18*3,fill=fill)
        d.polygon([(int((x+w-14)*3),int((y+h-6)*3)),(int((x+w+1)*3),int((y+h+5)*3)),(int((x+w-21)*3),int((y+h-1)*3))], fill=fill)
    def waves(y, level, width=120):
        for i in range(13):
            x=160-width/2+i*width/12
            envelope=math.sin((i+1)/14*math.pi)
            h=4+level*34*envelope*(.55+.45*abs(math.sin(i*1.8)))
            d.rounded_rectangle(((x-2)*3,(y-h/2)*3,(x+2)*3,(y+h/2)*3),radius=6,fill=BLUE)
    text('L I F E L I N E',24,10,MUTED)
    if state in ('ready','checking','reaching'):
        if state != 'ready':
            t=(frame%FRAMES[state])/FRAMES[state]
            for r in (24+t*20,44+t*20,64+t*20):
                strength=max(.08,1-r/100)
                color=tuple(int(a+(b-a)*strength) for a,b in zip((11,16,24),(22,131,255)))
                ellipse((160-r,105-r,160+r,105+r),outline=color,width=2)
        ellipse((138,83,182,127),fill=BLUE)
        if state=='checking': text('!',107,28)
        elif state=='ready': line([(148,105),(157,105),(160,94),(164,115),(168,105),(173,105)],WHITE,2)
        else: ellipse((155,100,165,110),fill=WHITE)
    elif state=='listening':
        # The runtime selects this level from real PCM RMS, never a decorative oscillator.
        waves(108,frame/3)
        ellipse((149,63,171,85),outline=MUTED,width=2)
        line([(160,85),(160,91)],MUTED,2)
    elif state=='processing':
        bubble(119,78,82,53,'#192538')
        for i in range(3): ellipse((138+i*18,99,145+i*18,106),fill=BLUE if i==frame%3 else MUTED)
    elif state=='heard':
        x=(84,135,126)[min(frame,2)]
        bubble(x,74,68,55)
        line([(x+18,99),(x+29,110),(x+51,88)],WHITE,3)
    elif state in ('accepted','on_way','on_scene','speaking'):
        if state=='accepted' and frame<2:
            x=(46,118)[frame]
            bubble(x,78,60,45)
            if owner: text(owner.split()[0][:16],144,14)
        elif owner:
            ellipse((133,69,187,123),fill=BLUE)
            initials=''.join(part[0] for part in owner.split()[:2]).upper()
            text(initials,97,23)
            display=owner.split()[0][:16]
            text(display,144,14)
        else:
            bubble(130,76,60,45)
            text('Your responder',144,13,MUTED)
        if state=='speaking': waves(177,frame/3,100)
        elif state=='on_way':
            line([(142,166),(175,166)],BLUE,2)
            line([(169,160),(175,166),(169,172)],BLUE,2)
        elif state=='on_scene':
            ellipse((141,160,153,172),fill=BLUE);ellipse((166,160,178,172),fill=BLUE)
    elif state in ('resolved','cancelled'):
        ellipse((134,79,186,131),fill='#153b37' if state=='resolved' else '#192538')
        line([(146,106),(157,117),(176,96)],'#88d9bd' if state=='resolved' else WHITE,3)
    else:
        ellipse((135,80,185,130),outline=MUTED,width=2);text('!',107,27)
    label = (owner.split()[0][:16]+' says') if state=='speaking' and owner else LABELS[state]
    label_y=204 if state in ('accepted','on_way','on_scene','speaking') else 190 if state in ('checking','reaching') else 175
    if state!='speaking' or not owner: text(label,label_y,20 if len(label)<20 else 18)
    else: text(label,206,16)
    hint='HOLD BLUE TO TALK' if state=='ready' and wellbeing else (
         'GREEN: CLOSE CHECK-IN   /   RED: HELP' if state in ('checking','listening') and not wellbeing else
         'RELEASE BLUE TO SEND' if state=='listening' and wellbeing else
         'RECORDING LIMIT REACHED' if state=='recording_limit' else
         'VOICE RECEIVED' if state=='heard' else '')
    if hint: text(hint,220,9,MUTED)
    return im.resize(SIZE,Image.Resampling.LANCZOS)

def fwi_bytes(image):
    if image.size != SIZE: raise ValueError('Wrong OG screen dimensions')
    # Matches the official SDK: little-endian header, byte-swapped RGB565 pixels.
    header=struct.pack('<8sIIHHHH',b'FW01IMG\0',1,SIZE[0]*SIZE[1],*SIZE,0,0)
    pixels=bytearray()
    for r,g,b in image.convert('RGB').getdata():
        pixels.extend(struct.pack('>H',(int(r/255*31)<<11)|(int(g/255*63)<<5)|int(b/255*31)))
    return header+pixels

def build_assets(destination, owners=()):
    destination=pathlib.Path(destination);destination.mkdir(parents=True,exist_ok=True)
    entries={}
    for state,count in FRAMES.items():
        for owner in (['']+list(dict.fromkeys(clean_name(n) for n in owners if clean_name(n)))) if state in ('accepted','on_way','on_scene','speaking') else ['']:
            for frame in range(count):
                key=f'{state}:{owner}:{frame}'
                image=render(state,frame,owner)
                content=fwi_bytes(image)
                filename='L'+hashlib.sha256(content).hexdigest()[:7].upper()+'.FWI'
                (destination/filename).write_bytes(content)
                image.save(destination/(filename+'.png'))
                entries[key]={'file':filename,'sha256':hashlib.sha256(content).hexdigest(),'bytes':len(content)}
    manifest={'version':1,'width':320,'height':240,'owners':list(owners),'frames':FRAMES,'assets':entries}
    (destination/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest

class AmbientState:
    """Presentation only: named human states require an actual matching backend phase."""
    def __init__(self):
        self.phase=None; self.owner=''; self.stage='ready'; self.wellbeing=False
        self.processing=False; self.speaker=''; self.level=0; self.level_at=-1
        self.playing=False; self.heard_until=0
        self.voice_levels=[];self.voice_start=0
        self.phase_at=0
    def context(self, phase, owner='', now=0):
        if phase != self.phase or clean_name(owner) != self.owner:
            self.phase_at=now
            self.processing=False; self.playing=False; self.speaker=''; self.heard_until=0
            self.stage='ready'
        self.phase=phase;self.owner=clean_name(owner)
    def pcm(self,samples,now):
        if not samples:return
        mean=sum(samples)/len(samples)
        rms=math.sqrt(sum((v-mean)**2 for v in samples)/len(samples))/32768
        self.level=min(3,max(0,int(math.sqrt(min(1,rms/.15))*3.99)))
        self.level_at=now
    def view(self,now,capturing=False,wellbeing_capture=False):
        if capturing: return 'recording' if wellbeing_capture else 'listening','',self.level if now-self.level_at<.3 else 0
        if self.stage=='recording_limit':return 'recording_limit','',0
        if self.playing:
            index=max(0,min(len(self.voice_levels)-1,int((now-self.voice_start)*8)))
            return 'speaking',self.speaker,self.voice_levels[index] if self.voice_levels else 0
        if self.processing:return 'processing','',int(now*3)%3
        if now<self.heard_until:return 'heard','',min(2,max(0,int((now-(self.heard_until-2))*5)))
        state={None:'ready','DETECTED':'checking','CONFIRMING':'checking',
               'HELP_REQUESTED':'reaching','ACKNOWLEDGED':'accepted','RESPONDER_EN_ROUTE':'on_way',
               'ON_SCENE':'on_scene','RESOLVED':'resolved','CANCELLED_FALSE_ALARM':'cancelled'}.get(self.phase,'unavailable')
        count=FRAMES[state]
        if state=='accepted':return state,self.owner,min(count-1,max(0,int((now-self.phase_at)*5)))
        if state in ('resolved','cancelled') and now-self.phase_at>=3:state='ready'
        if state=='ready' and self.wellbeing:state='ready_talk'
        return state,self.owner if state in ('accepted','on_way','on_scene') else '',int(now*4)%count

class AmbientDisplay:
    """A bounded image client, used only on the gateway's serial-owning thread."""
    def __init__(self, serial, directory, require, status, now=time.monotonic):
        self.serial=serial;self.directory=pathlib.Path(directory);self.require=require
        self.status=status;self.now=now;self.model=AmbientState();self.enabled=False
        self.last_file=None;self.next_at=0;self.interval=.2;self.slow=False
        self.manifest=json.loads((self.directory/'manifest.json').read_text())
        if (self.manifest.get('version')!=1 or self.manifest.get('width')!=320
                or self.manifest.get('height')!=240 or not 1<=len(self.manifest.get('assets',{}))<=64):
            raise ValueError('Invalid ambient display manifest')
        self.files={}
        for key,entry in self.manifest['assets'].items():
            name=entry['file']
            if len(name)!=12 or name[0]!='L' or not all(c in '0123456789ABCDEF' for c in name[1:8]) or name[8:]!='.FWI':
                raise ValueError('Invalid ambient filename')
            path=self.directory/name;content=path.read_bytes()
            if (len(content)!=153624 or content[:8]!=b'FW01IMG\0'
                    or hashlib.sha256(content).hexdigest()!=entry['sha256']
                    or name!='L'+entry['sha256'][:7].upper()+'.FWI'):
                raise ValueError('Invalid ambient asset')
            self.files[name]=path

    def install(self, watchdog):
        self.require(self.serial.change_directory('/images'))
        listing=self.require(self.serial.list_current_directory())
        if listing.cwd.replace('\\','/').rstrip('/').lower()!='/images':raise ValueError('Wrong image directory')
        existing={item.name.upper():item.size for item in listing.contents if item.file_type.name=='File'}
        # Content-addressed names make visual revisions distinct from old cached images.
        for index,(name,path) in enumerate(self.files.items(),1):
            if existing.get(name)!=153624:
                with watchdog(12):self.require(self.serial.send_file(path,'/images/'+name,None))
            if index%8==0:self.status('ui-loading',f'Prepared {index} of {len(self.files)} native images.')
        self.require(self.serial.change_directory('/sounds'))
        self.enabled=True
        self.status('ui-ready',f'Ambient image vocabulary installed: {len(self.files)} images; device timing remains measured.')

    def voice(self,path,speaker):
        values=[]
        with wave.open(str(path),'rb') as clip:
            if (clip.getnchannels(),clip.getsampwidth(),clip.getframerate())!=(1,2,8000):return
            while True:
                pcm=clip.readframes(1000)
                if not pcm:break
                samples=struct.unpack('<'+'h'*(len(pcm)//2),pcm)
                meter=AmbientState();meter.pcm(samples,0);values.append(meter.level)
                if len(values)>120:raise ValueError('Voice meter exceeds playback bound')
        self.model.speaker=clean_name(speaker);self.model.voice_levels=values
        self.model.voice_start=self.now();self.model.playing=True

    def tick(self,capturing=False,blocked=False,remaining=None,wellbeing_capture=False):
        if not self.enabled or blocked or self.now()<self.next_at or remaining is not None and remaining<.35:return
        state,owner,frame=self.model.view(self.now(),capturing,wellbeing_capture)
        entry=self.manifest['assets'].get(f'{state}:{owner}:{frame}') or self.manifest['assets'].get(f'{state}::{frame}')
        if not entry:return
        if entry['file']==self.last_file:return
        started=time.monotonic()
        try:
            # OG v54's GUI loader accepts Windows-style paths. Its filesystem
            # upload API accepts forward slashes, but the image loader rejects them.
            result=self.serial.show_gui_image('\\images\\'+entry['file'])
        except (OSError, RuntimeError):
            result=None
        elapsed=time.monotonic()-started
        if result is None or result.is_err():
            self.enabled=False;self.status('ui-unavailable','Display image command failed; text presentation resumes.');return
        self.last_file=entry['file'];self.next_at=self.now()+self.interval
        if not getattr(self,'reported_frame',False):
            self.reported_frame=True
            self.status('ui-visible',f'Native image command accepted in {round(elapsed*1000)} ms; physical appearance is not camera-verified.')
        if elapsed>.15 and not self.slow:
            self.slow=True;self.interval=1.0
            self.status('ui-paced','Display commands are slow; animation is reduced to preserve event processing.')
