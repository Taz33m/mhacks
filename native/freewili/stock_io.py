"""Foreground OG stock-SDK gateway. No discovery, flashing, STT or incident decisions.

Run with the installed SDK's Python and an explicitly verified DISPLAY serial port.
stdin/stdout are bounded NDJSON; stdout contains no SDK logs or raw audio samples.
"""
import argparse
import base64
import contextlib
import hashlib
import io
import json
import logging
import math
import os
import pathlib
import queue
import re
import select
import signal
import stat
import struct
import sys
import threading
import tempfile
import time
import uuid
import wave

from freewili.types import ButtonColor, EventType, FileType, FreeWiliProcessorType

ASSETS = {"CHECKIN", "MOVEMENT", "HELP", "ACCEPTED", "ENROUTE", "ARRIVED", "RESOLVED", "OKAY"}
PHASES = {"DETECTED", "CONFIRMING", "HELP_REQUESTED", "ACKNOWLEDGED", "RESPONDER_EN_ROUTE",
          "ON_SCENE", "RESOLVED", "CANCELLED_FALSE_ALARM"}
ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
MAX_SAMPLES = 8000 * 6
MAX_WELLBEING_SAMPLES = 8000 * 15
TERMINAL_PHASES = {"RESOLVED", "CANCELLED_FALSE_ALARM"}
# The 7 board LEDs mirror incident state with one calm color. They change only on a
# state change, never during microphone capture or playback (shared USB channel),
# and LED failure is cosmetic: control is dropped, the safety path is untouched.
LED_COUNT = 7
LED_COLORS = {
    "idle": (0, 8, 0),                    # faint green: monitoring
    "DETECTED": (70, 30, 0),              # amber: possible fall noticed
    "CONFIRMING": (70, 30, 0),            # amber: checking on you
    "listening": (0, 25, 80),             # blue: microphone open
    "HELP_REQUESTED": (80, 0, 0),         # red: getting help
    "ACKNOWLEDGED": (60, 0, 80),          # purple: someone answered
    "RESPONDER_EN_ROUTE": (0, 60, 60),    # teal: help on the way
    "ON_SCENE": (0, 80, 20),              # green: help is here
    "RESOLVED": (0, 40, 10),              # soft green: closed
    "CANCELLED_FALSE_ALARM": (0, 8, 0),   # back to monitoring
}


class StockTransferFailure(RuntimeError):
    pass


class StockUploadTimeout(StockTransferFailure):
    pass


@contextlib.contextmanager
def upload_watchdog(seconds=12):
    # The stock SDK owns serial synchronously. Interrupt a stalled transfer on
    # this main thread rather than introducing concurrent serial operations.
    if threading.current_thread() is not threading.main_thread() or signal.getitimer(signal.ITIMER_REAL)[0]:
        raise RuntimeError("The bounded upload watchdog is unavailable.")
    previous = signal.getsignal(signal.SIGALRM)
    def expired(_signal, _frame):
        raise StockUploadTimeout("Stock file upload exceeded its deadline.")
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def valid_id(value):
    return isinstance(value, str) and bool(ID.fullmatch(value))


def display_text(value, limit):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Invalid display text.")
    # Stock SDK sends text as an ASCII menu argument; line breaks are commands.
    return " ".join(value.split()).encode("ascii", "replace").decode("ascii")


class StockGateway:
    def __init__(self, serial, audio_dir, emit=None, now=time.monotonic, pause_accel_for_audio=True, conversation_dir=None, ui_dir=None, muted=False, volume=5):
        self.serial, self.audio_dir, self.now = serial, audio_dir, now
        self.muted = muted
        if isinstance(volume, bool) or not isinstance(volume, int) or not 0 <= volume <= 10:
            raise ValueError('Speaker volume must be 0–10.')
        self.volume = volume
        self.emit = emit or self.write_packet
        self.session = str(uuid.uuid4())
        self.running = True
        self.context = {"incidentId": None, "checkinId": None, "phase": None, "dispatchMode": "live"}
        self.inputs = queue.Queue(maxsize=64)
        self.buttons = {"gray": False, "green": False, "red": False, "blue": False, "yellow": False}
        self.blue_armed = False
        self.blue_held_at = None
        self.wellbeing = {"enabled": False, "conversationId": None, "statusText": ""}
        self.wellbeing_processing_event = None
        self.sequences = {}
        self.assets = {}
        self.played = set()
        self.displayed = None
        self.status_text = None
        self.text_fallback = False
        self.display_restore_pending = False
        self.phase_display = "No active incident"
        self.pending_capture = None
        self.capture = None
        self.audio_enabled = False
        self.pause_accel_for_audio = pause_accel_for_audio
        self.accel_paused = False
        self.playback_until = None
        self.zero_reported = False
        self.readiness_reported = False
        self.conversation_dir = conversation_dir
        self.conversation = None
        self.conversation_seen = []
        self.voice_until = None
        self.deferred_voice = None
        self.conversation_hold_until = None
        self.upload_in_progress = False
        self.checkin_processing_event = None
        self.ui = None
        self.leds_enabled = True
        self.led_applied = None
        if ui_dir is not None:
            from ambient_ui import AmbientDisplay
            self.ui = AmbientDisplay(serial, ui_dir, self.require, self.status, now)

    @staticmethod
    def write_packet(packet):
        line = json.dumps(packet, separators=(",", ":"), ensure_ascii=True)
        if len(line) > 400000:
            raise ValueError("Stock output exceeds the bound.")
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    def status(self, status, detail):
        self.emit({"type": "stock.status", "source": "body-wili", "sessionId": self.session,
                   "status": status, "detail": detail[:160]})

    def require(self, result):
        if result is None or result.is_err():
            raise RuntimeError("Stock SDK command failed.")
        return result.unwrap()

    def show_status(self, text, force_text=False):
        self.status_text = text
        capturing = self.capture is not None and self.audio_enabled
        wellbeing_capture = capturing and self.capture.get('kind') == 'wellbeing'
        fallback = (force_text or self.ui is None or not self.ui.enabled
                    or not self.ui.supports_context(capturing, wellbeing_capture))
        if text != self.displayed or fallback and not self.text_fallback:
            if fallback:
                self.require(self.serial.show_text_display(text[:450]))
                if self.ui is not None:
                    self.ui.last_file = None
                    self.ui.next_at = 0
            self.displayed = text
        self.text_fallback = fallback

    def ui_tick(self):
        capturing = self.capture is not None and self.audio_enabled
        remaining = self.capture["deadline"] - self.now() if capturing else None
        if self.display_restore_pending:
            if self.upload_in_progress or remaining is not None and remaining < .35:
                return
            # Button callbacks only mark the presentation dirty. Restore it on
            # the serial-owning loop, after firmware navigation, without audio
            # or changing the current incident/recording state.
            invalidate = getattr(self.serial, 'invalidate_display', None)
            if callable(invalidate):
                invalidate()
            self.displayed = None
            self.text_fallback = False
            if self.ui is not None:
                self.ui.last_file = None
                self.ui.next_at = 0
                self.ui.refresh_at = 0
            self.show_status(self.status_text or self.idle_display())
            self.display_restore_pending = False
        if self.ui is None:
            return
        enabled = self.ui.enabled
        wellbeing_capture = capturing and self.capture.get('kind') == 'wellbeing'
        if (enabled and not self.upload_in_progress and (remaining is None or remaining >= .35)
                and not self.ui.supports_context(capturing, wellbeing_capture)):
            self.show_status(self.status_text or self.idle_display())
        self.ui.tick(capturing=capturing, blocked=self.upload_in_progress, remaining=remaining,
                     wellbeing_capture=wellbeing_capture)
        if self.ui.enabled and self.ui.supports_context(capturing, wellbeing_capture) and self.ui.last_file is not None:
            self.text_fallback = False
        if enabled and not self.ui.enabled:
            self.displayed = None
            self.show_status(self.idle_display())

    def active_incident(self):
        return self.context["phase"] is not None and self.context["phase"] not in TERMINAL_PHASES

    def idle_display(self):
        if self.context['phase'] in TERMINAL_PHASES and (self.ui is None
                or self.ui.model.view(self.now())[0] in ('resolved', 'cancelled')):
            return self.phase_display
        if self.wellbeing["enabled"] and not self.active_incident():
            return "LIFELINE | HOLD BLUE TO TALK | RELEASE TO SEND | " + self.wellbeing["statusText"]
        return self.phase_display

    def sync_buttons(self, current):
        self.buttons = {"gray": bool(current.get(ButtonColor.White)),
                        "green": bool(current.get(ButtonColor.Green)), "red": bool(current.get(ButtonColor.Red)),
                        "blue": bool(current.get(ButtonColor.Blue)), "yellow": bool(current.get(ButtonColor.Yellow))}
        self.blue_armed = not self.buttons["blue"]
        self.blue_held_at = None

    def safety_button(self, name):
        incident, checkin = self.context['incidentId'], self.context['checkinId']
        if name == 'green' and (self.context['phase'] != 'CONFIRMING' or not incident or not checkin):
            return
        if name == 'red' and self.context['phase'] in TERMINAL_PHASES:
            incident, checkin = None, None
        self.emit({'type': 'button.press', 'source': 'body-wili', 'sessionId': self.session,
                   'eventId': str(uuid.uuid4()), 'incidentId': incident, 'checkinId': checkin,
                   'action': 'cancel' if name == 'green' else 'help'})
        self.cancel_wellbeing()

    def recover_held_red(self, before, current):
        # The SDK exposes levels, not latched edges. Recover only a measured
        # new held press; an already-held button or a released tap is unknown.
        if self.running and not before.get(ButtonColor.Red) and current.get(ButtonColor.Red):
            self.safety_button('red')

    def wellbeing_audio(self, stage, target=None):
        target = target or self.wellbeing
        if target.get("conversationId"):
            self.emit({"type": "wellbeing.audio", "source": "body-wili", "sessionId": self.session,
                       "eventId": str(uuid.uuid4()), "conversationId": target["conversationId"], "stage": stage})

    def cancel_wellbeing(self, restore_display=True):
        self.blue_held_at = None
        if self.buttons["blue"]:
            self.blue_armed = False
        self.wellbeing_processing_event = None
        if self.ui is not None:
            self.ui.model.processing = False
        if self.capture is not None and self.capture.get("kind") == "wellbeing":
            self.wellbeing_audio("unavailable", self.capture)
            self.stop_capture(restore_display=restore_display)

    def wellbeing_update(self, packet):
        if (not valid_id(packet.get("conversationId")) or not isinstance(packet.get("enabled"), bool)
                or set(packet) != {"type", "sessionId", "conversationId", "enabled", "statusText"}):
            raise ValueError("Invalid wellbeing context.")
        status = display_text(packet.get("statusText"), 300)
        if not packet["enabled"] or packet["conversationId"] != self.wellbeing["conversationId"]:
            self.cancel_wellbeing(restore_display=False)
        self.wellbeing = {"enabled": packet["enabled"], "conversationId": packet["conversationId"], "statusText": status}
        if self.ui is not None:
            self.ui.model.wellbeing = packet["enabled"]
        if self.capture is None and self.wellbeing_processing_event is None and not self.active_incident():
            self.show_status(self.idle_display())

    def wellbeing_tick(self):
        if self.blue_held_at is None or self.now() - self.blue_held_at < .350:
            return
        self.blue_held_at = None
        if (not self.blue_armed or not self.buttons["blue"] or self.buttons["red"] or not self.wellbeing["enabled"]
                or self.active_incident() or self.capture is not None or self.pending_capture is not None
                or self.wellbeing_processing_event is not None or self.conversation is not None
                or self.voice_until is not None and self.now() < self.voice_until or self.upload_in_progress):
            return
        self.require(self.serial.enable_audio_events(True))
        self.audio_enabled = True
        self.capture = {"kind": "wellbeing", "conversationId": self.wellbeing["conversationId"],
                        "deadline": self.now() + 15, "maxSamples": MAX_WELLBEING_SAMPLES,
                        "pcm": bytearray(), "invalid": False, "capped": False}
        self.wellbeing_audio("recording", self.capture)
        self.show_status("LIFELINE | RECORDING | RELEASE BLUE TO SEND | UP TO 15 SECONDS")

    def resume_accel(self):
        if self.accel_paused:
            if not self.serial.is_open():
                raise RuntimeError("Stock serial connection ended while acquisition was paused.")
            # Discard queued pre-pause accel frames while the callback still
            # knows acquisition is suspended. Buttons continue to be handled.
            self.serial.process_events(0.0)
            self.require(self.serial.enable_accel_events(True, 33))
            self.serial.process_events(0.0)
            self.accel_paused = False
            self.status("accel-resumed", "Accelerometer events resumed after voice playback; the recorded gap remains.")
        self.playback_until = None

    def load_assets(self):
        if self.audio_dir is None:
            self.status("audio-unavailable", "No prepared audio directory was provided.")
            return
        cached = {}
        try:
            self.require(self.serial.change_directory("/sounds"))
            listing = self.require(self.serial.list_current_directory())
            if listing.cwd.replace("\\", "/").rstrip("/").lower() != "/sounds":
                raise ValueError("Board listing has an unverified directory.")
            cached = {item.name.upper(): item.size for item in listing.contents
                      if item.file_type == FileType.File and isinstance(item.size, int)
                      and not isinstance(item.size, bool) and item.size > 0}
        except (OSError, ValueError, RuntimeError, AttributeError, TypeError):
            # A failed lookup never establishes a cache hit. Fall back to upload.
            cached = {}
        for name in sorted(ASSETS):
            path = self.audio_dir / (name + ".WAV")
            if not path.is_file():
                continue
            try:
                with path.open("rb") as source:
                    local_bytes = source.read(250001)
                if len(local_bytes) > 250000:
                    raise ValueError("Oversized prepared prompt.")
                with wave.open(io.BytesIO(local_bytes), "rb") as clip:
                    if (clip.getnchannels(), clip.getsampwidth(), clip.getframerate(), clip.getcomptype()) != (1, 2, 8000, "NONE"):
                        raise ValueError("Prompt must be mono 8kHz PCM16 WAV.")
                    duration = clip.getnframes() / 8000
                    if duration <= 0 or duration > 15:
                        raise ValueError("Invalid prompt duration.")
                identical = False
                if cached.get(path.name.upper()) == len(local_bytes):
                    try:
                        # A basename and equal size never prove voice provenance.
                        # Read back once into a private, automatically removed file.
                        with tempfile.TemporaryDirectory(prefix="lifeline-og-readback-") as directory:
                            downloaded = pathlib.Path(directory) / path.name
                            downloaded.touch(mode=0o600)
                            self.require(self.serial.get_file("/sounds/" + path.name, downloaded, None))
                            if downloaded.stat().st_size == len(local_bytes):
                                with downloaded.open("rb") as readback:
                                    board_bytes = readback.read(250001)
                                identical = len(board_bytes) == len(local_bytes) and (
                                    hashlib.sha256(board_bytes).digest() == hashlib.sha256(local_bytes).digest())
                    except (OSError, ValueError, RuntimeError):
                        # Missing, partial or failed readback must be replaced.
                        identical = False
                if not identical:
                    self.require(self.serial.send_file(path, "/sounds/" + path.name, None))
                self.assets[name] = duration
            except (OSError, ValueError, RuntimeError, wave.Error):
                self.status("audio-error", "A prepared prompt could not be validated or uploaded.")
        if "CHECKIN" not in self.assets:
            self.status("audio-unavailable", "CHECKIN.WAV is not available; microphone check-ins remain disabled.")

    def on_event(self, event_type, frame, data):
        if not frame.is_ok():
            return
        sequence = frame.seq_number
        if not isinstance(sequence, int) or sequence < 0 or sequence <= self.sequences.get(event_type, -1):
            return
        self.sequences[event_type] = sequence
        if event_type == EventType.Accel:
            if not self.accel_paused:
                self.acceleration(frame, data)
        elif event_type == EventType.Button:
            if any(bool(getattr(data, name, False)) != pressed for name, pressed in self.buttons.items()):
                # Both press and release may redraw the stock screen. Repeated
                # held levels are not new navigation and must not reset frames.
                self.display_restore_pending = True
            gray = bool(getattr(data, 'gray', False))
            previous_gray = self.buttons['gray']
            self.buttons['gray'] = gray
            if gray and not previous_gray:
                self.emit({'type': 'button.press', 'source': 'body-wili', 'sessionId': self.session,
                           'eventId': str(uuid.uuid4()), 'incidentId': self.context['incidentId'],
                           'checkinId': self.context['checkinId'], 'action': 'reset'})
                self.cancel_wellbeing(restore_display=False)
                self.stop_capture(restore_display=False)
            for name in ("green", "red"):
                pressed = bool(getattr(data, name))
                previous = self.buttons[name]
                self.buttons[name] = pressed
                if not pressed or previous:
                    continue
                # Publish the safety control before synchronous microphone cleanup.
                self.safety_button(name)
            blue = bool(getattr(data, "blue", False))
            previous = self.buttons["blue"]
            self.buttons["blue"] = blue
            if not blue:
                self.blue_armed = True
                self.blue_held_at = None
                if previous and self.capture is not None and self.capture.get("kind") == "wellbeing":
                    self.stop_capture(deliver=True)
            elif not previous and self.blue_armed:
                self.blue_held_at = self.now()
            yellow = bool(getattr(data, 'yellow', False))
            previous = self.buttons['yellow']
            self.buttons['yellow'] = yellow
            if (yellow and not previous and not self.buttons['red']
                    and self.context.get('dispatchMode', 'live') == 'simulated' and not self.active_incident()):
                # An operator-triggered rehearsal starts at CHECKIN on the
                # server. Old terminal identifiers are not a new incident.
                self.emit({'type': 'button.press', 'source': 'body-wili', 'sessionId': self.session,
                           'eventId': str(uuid.uuid4()), 'incidentId': None, 'checkinId': None,
                           'action': 'rehearse'})
                self.cancel_wellbeing()
        elif event_type == EventType.Audio and self.capture is not None:
            if not self.audio_enabled or self.now() >= self.capture["deadline"]:
                return
            samples = data.data
            if not isinstance(samples, list) or not samples or len(samples) > 1024 or any(
                    not isinstance(value, int) or isinstance(value, bool) or value < -32768 or value > 32767 for value in samples):
                self.capture["invalid"] = True
                return
            remaining = self.capture.get("maxSamples", MAX_SAMPLES) - len(self.capture["pcm"]) // 2
            if self.ui is not None:
                self.ui.model.pcm(samples[:remaining], self.now())
            for sample in samples[:remaining]:
                self.capture["pcm"].extend(struct.pack("<h", sample))

    def acceleration(self, frame, data):
        scale = data.g
        raw = (data.x, data.y, data.z)
        if scale not in (2, 4, 8, 16) or any(not math.isfinite(v) or v != int(v) or v < -32768 or v > 32767 for v in raw):
            self.status("sensor-error", "Invalid stock accelerometer values; sample was discarded.")
            return
        if all(value == 0 for value in raw):
            if not self.zero_reported:
                self.status("sensor-error", "All-zero raw acceleration is unavailable, not evidence of free fall.")
                self.zero_reported = True
            return
        self.zero_reported = False
        axes = [int(value) >> 6 for value in raw]
        mg = {2: 4, 4: 8, 8: 16, 16: 48}[scale]
        self.emit({"type": "accel.sample", "source": "body-wili", "sessionId": self.session,
                   "sequence": frame.seq_number, "sensorTime": self.now(), "captureClock": "host-receipt",
                   "frameTimestamp": str(frame.timestamp), "fullScaleG": int(scale),
                   "accelerationG": [value * mg / 1000 for value in axes],
                   "fresh": True, "saturated": any(value <= -512 or value >= 511 for value in axes), "quality": "measured"})

    def checkin_audio(self, stage, context=None):
        target = context or self.context
        if not target.get("incidentId") or not target.get("checkinId"):
            return
        self.emit({"type": "checkin.audio", "source": "body-wili", "sessionId": self.session,
                   "eventId": str(uuid.uuid4()), "incidentId": target["incidentId"],
                   "checkinId": target["checkinId"], "stage": stage})

    def stop_capture(self, deliver=False, restore_display=True):
        self.pending_capture = None
        capture, self.capture = self.capture, None
        if self.ui is not None:
            self.ui.model.stage = 'ready'
        pcm = capture["pcm"] if capture is not None else bytearray()
        try:
            if self.audio_enabled:
                # If disabling fails, fail the gateway rather than continue listening.
                self.audio_enabled = False
                self.require(self.serial.enable_audio_events(False))
            if capture is None:
                return
            if restore_display:
                self.show_status(self.idle_display())
            if not deliver:
                return
            if not pcm or capture["invalid"]:
                self.status("audio-unavailable", "No valid bounded microphone utterance was captured.")
                if capture.get("kind") == "wellbeing": self.wellbeing_audio("unavailable", capture)
                else: self.checkin_audio("unavailable", capture)
                return
            output = io.BytesIO()
            with wave.open(output, "wb") as clip:
                clip.setnchannels(1); clip.setsampwidth(2); clip.setframerate(8000); clip.writeframes(pcm)
            if self.ui is not None:
                self.ui.model.processing = True
            if capture.get("kind") == "wellbeing":
                event_id = str(uuid.uuid4())
                self.wellbeing_processing_event = event_id
                self.show_status("LIFELINE | TRANSCRIBING | PLEASE WAIT")
                self.emit({"type": "stock.wellbeing-utterance", "source": "body-wili", "sessionId": self.session,
                           "eventId": event_id, "conversationId": capture["conversationId"],
                           "format": "wav", "sampleRate": 8000, "audioBase64": base64.b64encode(output.getvalue()).decode("ascii"),
                           "durationMs": len(pcm) / 16, "receivedAtMs": self.now() * 1000})
                return
            event_id = str(uuid.uuid4())
            self.checkin_processing_event = event_id
            self.emit({"type": "stock.utterance", "source": "body-wili", "sessionId": self.session,
                       "eventId": event_id, "incidentId": capture["incidentId"], "checkinId": capture["checkinId"],
                       "format": "wav", "sampleRate": 8000, "audioBase64": base64.b64encode(output.getvalue()).decode("ascii"),
                       "durationMs": len(pcm) / 16, "receivedAtMs": self.now() * 1000})
        finally:
            pcm[:] = b"\x00" * len(pcm)
            pcm.clear()

    def play(self, name, checkin_capture=False):
        if self.conversation is not None:
            self.deferred_voice = (name, checkin_capture, self.context.copy())
            return
        key = (self.context["incidentId"], self.context["checkinId"], name)
        if key in self.played:
            return
        self.played.add(key)
        if self.muted:
            self.status("audio-muted", "Wearable speaker playback is temporarily muted.")
            if checkin_capture:
                self.checkin_audio("unavailable")
            return
        if name not in self.assets:
            self.status("audio-unavailable", "Requested prepared board prompt is unavailable.")
            if checkin_capture:
                self.checkin_audio("unavailable")
            return
        self.cancel_wellbeing()
        self.stop_capture()
        try:
            # OG v54 playback resolves a basename in the selected directory.
            self.require(self.serial.change_directory('/sounds'))
            if self.pause_accel_for_audio and not self.accel_paused:
                self.accel_paused = True
                self.require(self.serial.enable_accel_events(False, 33))
                self.serial.process_events(0.0)
                self.status("accel-paused", "Accelerometer events suspended for voice playback; no samples are fabricated.")
            self.require(self.serial.play_audio_file(name + ".WAV"))
        except RuntimeError:
            self.resume_accel()
            self.status("audio-error", "Stock board playback command failed; audibility is unknown.")
            if checkin_capture:
                self.checkin_audio("unavailable")
            return
        # SDK success means command acceptance, not an audible completion event.
        # Exclude prompt echo using known clip duration plus a short guard.
        after = self.now() + self.assets[name] + 0.2
        self.voice_until = after
        if self.accel_paused:
            self.playback_until = after
        if checkin_capture:
            self.pending_capture = {"after": after,
                                    "incidentId": self.context["incidentId"], "checkinId": self.context["checkinId"]}
            self.checkin_audio("prompting")

    def led_key(self):
        if self.context["incidentId"] is not None and self.context["phase"] in LED_COLORS:
            return self.context["phase"]
        return "idle"

    def update_leds(self, key=None):
        """Mirror state on the board LEDs; deferred while audio is busy, never raises."""
        wanted = key or self.led_key()
        if not self.leds_enabled or wanted == self.led_applied:
            return
        busy = (self.capture is not None or self.upload_in_progress
                or self.voice_until is not None and self.now() < self.voice_until)
        if busy or not self.serial.is_open():
            return
        setter = getattr(self.serial, "set_board_leds", None)
        if setter is None:
            self.leds_enabled = False
            return
        try:
            for index in range(LED_COUNT):
                self.require(setter(index, *LED_COLORS[wanted]))
        except Exception:
            self.leds_enabled = False
            self.status("leds-unavailable", "Board LED control failed; lights are left to the firmware.")
            return
        self.led_applied = wanted

    def context_update(self, packet):
        incident, checkin, phase = packet.get("incidentId"), packet.get("checkinId"), packet.get("phase")
        dispatch_mode = packet.get('dispatchMode', 'live')
        if ((incident is None) != (checkin is None) or (incident is not None and (not valid_id(incident) or not valid_id(checkin)))
                or (phase is not None and phase not in PHASES) or (incident is None) != (phase is None)
                or dispatch_mode not in ('live', 'simulated')):
            raise ValueError("Invalid incident context.")
        asset = packet.get("voiceAsset")
        if asset is not None and asset not in ASSETS:
            raise ValueError("Invalid voice asset.")
        status = display_text(packet.get("statusText", ""), 300)
        owner = display_text(packet.get("ownerName", "") or "", 100)
        if incident != self.context["incidentId"]:
            self.conversation_hold_until = None
        if (incident, checkin, phase) != tuple(self.context[k] for k in ("incidentId", "checkinId", "phase")):
            self.checkin_processing_event = None
            # The new phase screen replaces LISTENING directly; do not flash
            # the prior incident's screen while processing a context change.
            self.cancel_wellbeing(restore_display=False)
            self.stop_capture(restore_display=False)
            if self.conversation is None:
                self.resume_accel()
        self.context = {"incidentId": incident, "checkinId": checkin, "phase": phase, "dispatchMode": dispatch_mode}
        if self.ui is not None:
            self.ui.model.context(phase, owner, self.now(), dispatch_mode)
        if self.conversation is not None and not self.conversation_current(self.conversation):
            self.conversation["stale"] = True
            self.conversation_hold_until = None
        if phase in TERMINAL_PHASES or incident is None:
            self.conversation_hold_until = None
        self.phase_display = " | ".join(value for value in (phase, owner, status) if value) or "No active incident"
        if self.capture is None and not (self.conversation is not None and not self.conversation["stale"]
                                        or self.conversation_hold_until is not None and self.now() < self.conversation_hold_until):
            self.show_status(self.idle_display())
        self.update_leds()
        if asset is not None and incident is not None:
            self.play(asset, phase == "CONFIRMING" and asset in {"CHECKIN", "MOVEMENT"})

    def command(self, packet):
        if not isinstance(packet, dict) or packet.get("sessionId", self.session) != self.session:
            raise ValueError("Invalid stock command session.")
        if packet.get("type") == "clock.ping":
            if not valid_id(packet.get("id")):
                raise ValueError("Invalid clock ping.")
            received = self.now() * 1000
            self.emit({"type": "clock.pong", "id": packet["id"], "sessionId": self.session,
                       "deviceReceivedMs": received, "deviceSentMs": self.now() * 1000})
        elif packet.get("type") == "incident.context":
            self.context_update(packet)
        elif packet.get("type") == "wellbeing.context":
            self.wellbeing_update(packet)
        elif packet.get("type") == "wellbeing.result":
            if (set(packet) != {"type", "sessionId", "conversationId", "eventId", "stage"}
                    or not valid_id(packet.get("eventId")) or packet.get("eventId") != self.wellbeing_processing_event
                    or packet.get("conversationId") != self.wellbeing["conversationId"]
                    or packet.get("stage") not in ("complete", "unavailable")):
                raise ValueError("Uncorrelated wellbeing recognition result.")
            self.wellbeing_processing_event = None
            if self.ui is not None:
                self.ui.model.processing = False
                self.ui.model.heard_until = self.now() + 2 if packet["stage"] == "complete" else 0
            if self.wellbeing["enabled"] and not self.active_incident():
                self.show_status("LIFELINE | " + ("VOICE TRANSCRIBED" if packet["stage"] == "complete" else "VOICE UNAVAILABLE")
                                 + " | HOLD BLUE TO TALK | RELEASE TO SEND")
        elif packet.get("type") == "stock.checkin-result":
            if (set(packet) != {"type", "sessionId", "incidentId", "checkinId", "eventId", "stage"}
                    or self.context["phase"] != "CONFIRMING"
                    or any(packet.get(k) != self.context[k] for k in ("incidentId", "checkinId"))
                    or not valid_id(packet.get("eventId")) or packet["eventId"] != self.checkin_processing_event
                    or packet.get("stage") not in ("complete", "unavailable")):
                raise ValueError("Uncorrelated check-in recognition result.")
            self.checkin_processing_event = None
            if self.ui is not None:
                self.ui.model.processing = False
                self.ui.model.heard_until = self.now() + 2 if packet["stage"] == "complete" else 0
        elif packet.get("type") == "voice.asset":
            if packet.get("name") not in ASSETS or not packet.get("incidentId") or any(
                    packet.get(k) != self.context[k] for k in ("incidentId", "checkinId")):
                raise ValueError("Voice asset does not match the active incident.")
            self.play(packet["name"])
        elif packet.get("type") == "conversation.play":
            self.queue_conversation(packet)
        else:
            raise ValueError("Unsupported stock command.")

    def conversation_current(self, packet):
        return (packet["sessionId"] == self.session and packet["incidentId"] == self.context["incidentId"]
                and self.context["phase"] is not None and self.context["phase"] not in TERMINAL_PHASES)

    def playback_status(self, packet, status):
        self.emit({"type": "voice.playback", "source": "body-wili", "sessionId": self.session,
                   "eventId": packet["eventId"], "incidentId": packet["incidentId"], "status": status})

    def queue_conversation(self, packet):
        if (set(packet) != {"type", "sessionId", "eventId", "incidentId", "speakerName", "text", "filename"}
                or not valid_id(packet.get("eventId")) or not valid_id(packet.get("incidentId"))
                or not isinstance(packet.get("speakerName"), str) or not packet["speakerName"].strip()
                or len(packet["speakerName"]) > 100 or re.search(r"[\x00-\x1f\x7f]", packet["speakerName"])
                or not isinstance(packet.get("text"), str) or not packet["text"].strip() or len(packet["text"]) > 500
                or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", packet["text"])
                or not isinstance(packet.get("filename"), str) or not re.fullmatch(r"[A-F0-9]{8}\.WAV", packet["filename"])):
            raise ValueError("Invalid dynamic speech command.")
        if packet["eventId"] in self.conversation_seen:
            return
        self.conversation_seen.append(packet["eventId"])
        self.conversation_seen = self.conversation_seen[-128:]
        if self.muted:
            self.status("audio-muted", "Wearable speaker playback is temporarily muted.")
            self.playback_status(packet, "failed")
            return
        if self.conversation is not None or not self.conversation_current(packet):
            self.playback_status(packet, "failed")
            return
        self.cancel_wellbeing()
        self.conversation = {**packet, "state": "pending", "stale": False, "uploaded": False}

    def finish_conversation(self, status):
        job, self.conversation = self.conversation, None
        if job is None:
            return
        if self.ui is not None:
            self.ui.model.playing = False
            self.ui.model.voice_levels = []
        if job["uploaded"] and self.serial.is_open():
            try:
                self.require(self.serial.remove_directory_or_file("/sounds/" + job["filename"]))
            except RuntimeError:
                self.status("audio-cleanup-error", "The dynamic board audio file could not be removed.")
        self.resume_accel()
        self.playback_status(job, status)
        self.conversation_hold_until = self.now() + 3 if status == "spoken" else None
        if status != "spoken":
            self.show_status(self.idle_display())

    def begin_conversation(self):
        job = self.conversation
        if job is None or job["state"] != "pending":
            return
        if job["stale"] or not self.conversation_current(job):
            self.finish_conversation("failed")
            return
        self.cancel_wellbeing()
        self.stop_capture()
        try:
            if self.conversation_dir is None:
                raise ValueError("Private dynamic audio directory is unavailable.")
            path = self.conversation_dir / job["filename"]
            info = path.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid()
                    or self.conversation_dir.stat().st_mode & 0o077 or info.st_size > 240044):
                raise ValueError("Dynamic audio file is not private and bounded.")
            data = path.read_bytes()
            with wave.open(io.BytesIO(data), "rb") as clip:
                duration = clip.getnframes() / 8000
                if ((clip.getnchannels(), clip.getsampwidth(), clip.getframerate(), clip.getcomptype()) != (1, 2, 8000, "NONE")
                        or not 0 < duration <= 15 or len(data) != 44 + clip.getnframes() * 2 or data[36:40] != b"data"):
                    raise ValueError("Dynamic audio must be complete canonical mono 8kHz PCM16 WAV.")
            self.require(self.serial.change_directory("/sounds"))
            self.accel_paused = True
            self.require(self.serial.enable_accel_events(False, 33))
            self.status("accel-paused", "Dynamic audio upload and playback suspend acceleration; the gap is recorded.")
            self.serial.process_events(0)
            before = self.require(self.serial.read_all_buttons())
            previous = {ButtonColor.Red: self.buttons['red']}
            self.sync_buttons(before)
            self.recover_held_red(previous, before)
            self.show_status('PREPARING MESSAGE | HOLD RED FOR HELP', force_text=True)
            try:
                self.upload_in_progress = True
                with upload_watchdog():
                    self.require(self.serial.enable_button_events(False, 50))
                    self.status("buttons-paused", "Buttons are briefly suspended only while uploading dynamic audio.")
                    self.require(self.serial.send_file(path, "/sounds/" + job["filename"], None))
                    job["uploaded"] = True
            finally:
                self.upload_in_progress = False
                # An upload timeout is fatal below. Restoration is still
                # attempted with the SDK's finite response timeout.
                try:
                    self.require(self.serial.enable_button_events(True, 50))
                    current = self.require(self.serial.read_all_buttons())
                    self.sync_buttons(current)
                    self.status("buttons-resumed", "Buttons resumed; a newly held RED press is recovered. Released taps during upload are unavailable.")
                except RuntimeError as error:
                    raise StockTransferFailure("Stock button restoration failed.") from error
            # Context can change while the sole serial thread uploads. Apply
            # already queued control messages before starting any old speech.
            for _ in range(64):
                try:
                    packet = self.inputs.get_nowait()
                except queue.Empty:
                    break
                if packet is None:
                    self.running = False
                    job["stale"] = True
                    break
                try:
                    self.command(packet)
                except ValueError:
                    self.status("input-error", "Malformed stock command was discarded after upload.")
            self.recover_held_red(before, current)
            if job["stale"] or not self.conversation_current(job) or not self.running:
                self.finish_conversation("failed")
                return
            self.show_status(display_text(job["speakerName"] + " says: " + job["text"], 607))
            if not self.pause_accel_for_audio:
                self.resume_accel()
            self.require(self.serial.play_audio_file(job["filename"]))
            if self.ui is not None:
                self.ui.voice(path, job["speakerName"])
            job["state"], job["after"] = "playing", self.now() + duration + .2
            self.voice_until = job["after"]
            self.playback_until = job["after"] if self.accel_paused else None
            self.playback_status(job, "playing")
        except StockTransferFailure:
            self.playback_status(job, "failed")
            self.conversation = None
            self.deferred_voice = None
            self.running = False
            raise  # Close acquisition; never leave a stalled SDK stream looking ready.
        except (OSError, ValueError, RuntimeError, wave.Error):
            self.finish_conversation("failed")

    def conversation_tick(self):
        if self.conversation is not None:
            job = self.conversation
            if job["state"] == "pending" and (self.voice_until is None or self.now() >= self.voice_until):
                self.begin_conversation()
            elif job["state"] == "playing" and self.now() >= job["after"]:
                self.finish_conversation("failed" if job["stale"] else "spoken")
        if self.conversation is None and self.deferred_voice is not None:
            name, capture, previous = self.deferred_voice
            self.deferred_voice = None
            if previous == self.context:
                self.play(name, capture)
        if self.conversation_hold_until is not None and self.now() >= self.conversation_hold_until:
            self.conversation_hold_until = None
            self.show_status(self.idle_display())

    def audio_tick(self):
        self.update_leds()
        self.conversation_tick()
        self.wellbeing_tick()
        if self.conversation is None and self.accel_paused and self.playback_until is not None and self.now() >= self.playback_until:
            self.resume_accel()
        if self.pending_capture is not None and self.now() >= self.pending_capture["after"]:
            pending, self.pending_capture = self.pending_capture, None
            if self.context["phase"] == "CONFIRMING" and all(pending[k] == self.context[k] for k in ("incidentId", "checkinId")):
                self.update_leds("listening")
                self.require(self.serial.enable_audio_events(True))
                self.audio_enabled = True
                self.capture = {"incidentId": pending["incidentId"], "checkinId": pending["checkinId"],
                                "deadline": self.now() + 6, "pcm": bytearray(), "invalid": False}
                self.checkin_audio("listening", pending)
                # This indicates an enabled, bounded microphone window, not
                # a successful transcript or a safety determination.
                self.show_status("LIFELINE | LISTENING | Say I need help | Green: close check-in | Red: help")
        if self.capture is not None and (self.now() >= self.capture["deadline"] or len(self.capture["pcm"]) >= self.capture.get("maxSamples", MAX_SAMPLES) * 2):
            if self.capture.get("kind") == "wellbeing":
                if not self.capture["capped"]:
                    self.capture["capped"] = True
                    if self.ui is not None:
                        self.ui.model.stage = 'recording_limit'
                    if self.audio_enabled:
                        self.audio_enabled = False
                        self.require(self.serial.enable_audio_events(False))
                    self.show_status("LIFELINE | RECORDING LIMIT REACHED | RELEASE BLUE TO SEND")
            else:
                self.stop_capture(deliver=True)

    def read_input(self):
        pending = bytearray()
        try:
            while self.running:
                if not select.select([sys.stdin.fileno()], [], [], .2)[0]:
                    continue
                # A daemon blocked in BufferedReader.readline holds a CPython
                # lock and can abort the interpreter on normal gateway exit.
                raw = os.read(sys.stdin.fileno(), 16384)
                if not raw:
                    if pending:
                        raise ValueError("Partial host command at EOF.")
                    self.inputs.put_nowait(None)
                    return
                pending.extend(raw)
                while b"\n" in pending:
                    end = pending.index(10)
                    if end + 1 > 16384:
                        raise ValueError("Oversized host command.")
                    line = bytes(pending[:end])
                    del pending[:end + 1]
                    self.inputs.put_nowait(json.loads(line))
                if len(pending) >= 16384:
                    raise ValueError("Oversized host command.")
        except (ValueError, queue.Full, OSError):
            self.running = False

    def request_stop(self):
        self.running = False
        if self.upload_in_progress:
            # Exit the SDK's synchronous transfer through its cleanup path.
            raise StockTransferFailure("Dynamic upload was interrupted by shutdown.")

    def run(self):
        try:
            self.require(self.serial.open())
            info = self.require(self.serial.get_app_info())
            if info.processor_type != FreeWiliProcessorType.Display:
                raise RuntimeError("The explicit port is not the verified DISPLAY processor.")
            self.emit({"type": "device.hello", "protocolVersion": 1, "source": "body-wili", "sessionId": self.session,
                       "deviceModel": "freewili-og", "fullScaleG": 2, "transport": "stock-sdk",
                       "capabilities": {"accelerometer": True, "buttons": True, "speaker": True, "microphone": True}})
            self.require(self.serial.enable_audio_events(False))
            # SDK file transfer drains its event queue until a quiet interval.
            # Disable old streams before uploads, including after a killed bridge.
            self.require(self.serial.enable_accel_events(False, 33))
            self.require(self.serial.enable_button_events(False, 50))
            from stock_volume import set_speaker_volume
            set_speaker_volume(self.serial, self.volume)
            self.status('speaker-volume', f'Speaker volume verified at {self.volume}/10; playback mute is {"on" if self.muted else "off"}.')
            self.require(self.serial.set_system_sounds(False))
            self.status('system-sounds-off', 'Stock menu/system sounds disabled; incident voice remains event-driven.')
            if self.ui is not None:
                try:
                    self.upload_in_progress = True
                    self.ui.install(upload_watchdog)
                except StockTransferFailure:
                    raise
                except (OSError, ValueError, RuntimeError):
                    self.ui.enabled = False
                    self.status("ui-unavailable", "Image setup failed; the stock text display remains available.")
                finally:
                    self.upload_in_progress = False
                self.ui_tick()
            self.load_assets()
            current = self.require(self.serial.read_all_buttons())
            self.sync_buttons(current)
            self.serial.set_event_callback(self.on_event)
            self.require(self.serial.enable_accel_events(True, 33))
            self.require(self.serial.enable_button_events(True, 50))
            if self.ui is not None:
                # Paint after the final stock setup command, even if the frame
                # was already accepted before button/sensor initialization.
                self.ui.last_file = None
                self.ui.next_at = 0
                self.ui_tick()
            self.status("ready", "Stock SDK configured; actual sensor cadence and board audio still require verification.")
            threading.Thread(target=self.read_input, daemon=True).start()
            while self.running:
                for _ in range(64):
                    try:
                        packet = self.inputs.get_nowait()
                    except queue.Empty:
                        break
                    if packet is None:
                        self.running = False
                        break
                    try:
                        self.command(packet)
                    except ValueError:
                        self.status("input-error", "Malformed or uncorrelated stock command was discarded.")
                    # Keep queued host commands from starving measured events
                    # or bounded capture deadlines. Individual SDK commands
                    # remain synchronous on this sole serial-owning thread.
                    self.serial.process_events(0.0)
                    self.audio_tick()
                    if not self.running:
                        break
                if not self.running:
                    break
                if not self.serial.is_open():
                    raise RuntimeError("Stock serial connection ended.")
                self.serial.process_events(0.005)
                self.audio_tick()
                self.ui_tick()
        finally:
            self.running = False
            try:
                self.cancel_wellbeing(restore_display=False)
                self.stop_capture()
                if self.conversation is not None:
                    self.finish_conversation("failed")
            finally:
                if self.serial.is_open():
                    try:
                        self.resume_accel()
                    except Exception:
                        pass
                    for disable in (lambda: self.serial.enable_audio_events(False),
                                    lambda: self.serial.enable_accel_events(False, 33),
                                    lambda: self.serial.enable_button_events(False, 50)):
                        try:
                            disable()
                        except Exception:
                            pass
                    # SDK's default close restores the stock GPIO/menu screen.
                    # Keep the last LIFELINE frame instead of replacing it.
                    self.serial.close(restore_menu=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--audio-dir", type=pathlib.Path)
    parser.add_argument("--conversation-dir", type=pathlib.Path)
    parser.add_argument("--ui-dir", type=pathlib.Path)
    parser.add_argument("--ui-contacts", default="[]", help="At most two display names; never phone numbers.")
    parser.add_argument("--mute", action="store_true", default=os.environ.get("LIFELINE_WILI_MUTED") == "1",
                        help="Disable all speaker playback; also enabled by LIFELINE_WILI_MUTED=1.")
    parser.add_argument("--volume", type=int, choices=range(11), default=int(os.environ.get('LIFELINE_WILI_VOLUME', '5')),
                        help="Speaker level 0–10, verified before playback. Default 5; LIFELINE_WILI_VOLUME overrides it.")
    parser.add_argument("--keep-accel-during-audio", action="store_true",
                        help="Keep accelerometer events running during voice playback for comparison.")
    options = parser.parse_args()
    if not re.fullmatch(r"/dev/(cu\.[\w.-]+|tty(?:ACM|USB)\d+)", options.port) or not stat.S_ISCHR(pathlib.Path(options.port).stat().st_mode):
        raise ValueError("An explicit verified DISPLAY character-device port is required.")
    if options.audio_dir is not None and not options.audio_dir.is_dir():
        raise ValueError("Prepared audio directory is missing.")
    if options.conversation_dir is not None and (not options.conversation_dir.is_dir()
            or options.conversation_dir.stat().st_mode & 0o077):
        raise ValueError("Dynamic audio directory must be private.")
    logging.disable(logging.CRITICAL)
    contacts = json.loads(options.ui_contacts)
    if not isinstance(contacts, list) or len(contacts) > 2 or any(not isinstance(n, str) or len(n) > 100 for n in contacts):
        raise ValueError("Invalid ambient contacts.")
    with contextlib.ExitStack() as lifetime:
        ui_dir = options.ui_dir
        if ui_dir is not None:
            from ambient_ui import build_assets
            ui_dir = pathlib.Path(lifetime.enter_context(tempfile.TemporaryDirectory(prefix="lifeline-wili-ui-")))
            # One named contact fits alongside prompts/live voice. Additional
            # responders use generic artwork; backend ownership is unchanged.
            build_assets(ui_dir, contacts[:1], compact=True,
                         dispatch_mode=os.environ.get('LIFELINE_DISPATCH_MODE', 'live'))
        from stock_display import StockDisplaySerial
        gateway = StockGateway(StockDisplaySerial(options.port, stay_open=True), options.audio_dir,
                               pause_accel_for_audio=not options.keep_accel_during_audio,
                               conversation_dir=options.conversation_dir, ui_dir=ui_dir, muted=options.mute, volume=options.volume)
        def stop(_signal, _frame):
            gateway.request_stop()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        gateway.run()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Stock gateway failed; verify DISPLAY access, SDK responses and prepared assets.", file=sys.stderr)
        sys.exit(1)
