"""Foreground OG stock-SDK gateway. No discovery, flashing, STT or incident decisions.

Run with the installed SDK's Python and an explicitly verified DISPLAY serial port.
stdin/stdout are bounded NDJSON; stdout contains no SDK logs or raw audio samples.
"""
import argparse
import base64
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

from freewili.fw_serial import FreeWiliSerial
from freewili.types import ButtonColor, EventType, FileType, FreeWiliProcessorType

ASSETS = {"CHECKIN", "HELP", "ACCEPTED", "ENROUTE", "ARRIVED", "RESOLVED", "OKAY"}
PHASES = {"DETECTED", "CONFIRMING", "HELP_REQUESTED", "ACKNOWLEDGED", "RESPONDER_EN_ROUTE",
          "ON_SCENE", "RESOLVED", "CANCELLED_FALSE_ALARM"}
ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
MAX_SAMPLES = 8000 * 6


def valid_id(value):
    return isinstance(value, str) and bool(ID.fullmatch(value))


def display_text(value, limit):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Invalid display text.")
    # Stock SDK sends text as an ASCII menu argument; line breaks are commands.
    return " ".join(value.split()).encode("ascii", "replace").decode("ascii")


class StockGateway:
    def __init__(self, serial, audio_dir, emit=None, now=time.monotonic):
        self.serial, self.audio_dir, self.now = serial, audio_dir, now
        self.emit = emit or self.write_packet
        self.session = str(uuid.uuid4())
        self.running = True
        self.context = {"incidentId": None, "checkinId": None, "phase": None}
        self.inputs = queue.Queue(maxsize=64)
        self.buttons = {"green": False, "red": False}
        self.sequences = {}
        self.assets = {}
        self.played = set()
        self.displayed = None
        self.phase_display = "No active incident"
        self.pending_capture = None
        self.capture = None
        self.audio_enabled = False
        self.zero_reported = False
        self.readiness_reported = False

    @staticmethod
    def write_packet(packet):
        line = json.dumps(packet, separators=(",", ":"), ensure_ascii=True)
        if len(line) > 140000:
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

    def show_status(self, text):
        if text != self.displayed:
            self.require(self.serial.show_text_display(text[:450]))
            self.displayed = text

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
            self.acceleration(frame, data)
        elif event_type == EventType.Button:
            for name in ("green", "red"):
                pressed = bool(getattr(data, name))
                previous = self.buttons[name]
                self.buttons[name] = pressed
                if not pressed or previous:
                    continue
                incident, checkin = self.context["incidentId"], self.context["checkinId"]
                if name == "green" and (self.context["phase"] != "CONFIRMING" or not incident or not checkin):
                    continue
                if name == "red" and self.context["phase"] in ("RESOLVED", "CANCELLED_FALSE_ALARM"):
                    incident, checkin = None, None
                self.emit({"type": "button.press", "source": "body-wili", "sessionId": self.session,
                           "eventId": str(uuid.uuid4()), "incidentId": incident, "checkinId": checkin,
                           "action": "cancel" if name == "green" else "help"})
        elif event_type == EventType.Audio and self.capture is not None:
            if self.now() >= self.capture["deadline"]:
                return
            samples = data.data
            if not isinstance(samples, list) or not samples or len(samples) > 1024 or any(
                    not isinstance(value, int) or isinstance(value, bool) or value < -32768 or value > 32767 for value in samples):
                self.capture["invalid"] = True
                return
            remaining = MAX_SAMPLES - len(self.capture["pcm"]) // 2
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

    def stop_capture(self, deliver=False, restore_display=True):
        self.pending_capture = None
        capture, self.capture = self.capture, None
        pcm = capture["pcm"] if capture is not None else bytearray()
        try:
            if self.audio_enabled:
                # If disabling fails, fail the gateway rather than continue listening.
                self.audio_enabled = False
                self.require(self.serial.enable_audio_events(False))
            if capture is None:
                return
            if restore_display:
                self.show_status(self.phase_display)
            if not deliver:
                return
            if not pcm or capture["invalid"]:
                self.status("audio-unavailable", "No valid bounded microphone utterance was captured.")
                return
            output = io.BytesIO()
            with wave.open(output, "wb") as clip:
                clip.setnchannels(1); clip.setsampwidth(2); clip.setframerate(8000); clip.writeframes(pcm)
            self.emit({"type": "stock.utterance", "source": "body-wili", "sessionId": self.session,
                       "eventId": str(uuid.uuid4()), "incidentId": capture["incidentId"], "checkinId": capture["checkinId"],
                       "format": "wav", "sampleRate": 8000, "audioBase64": base64.b64encode(output.getvalue()).decode("ascii"),
                       "durationMs": len(pcm) / 16, "receivedAtMs": self.now() * 1000})
        finally:
            pcm[:] = b"\x00" * len(pcm)
            pcm.clear()

    def play(self, name, checkin_capture=False):
        key = (self.context["incidentId"], self.context["checkinId"], name)
        if key in self.played:
            return
        self.played.add(key)
        if name not in self.assets:
            self.status("audio-unavailable", "Requested prepared board prompt is unavailable.")
            return
        self.stop_capture()
        try:
            # OG v54 playback resolves a basename in the selected directory.
            self.require(self.serial.change_directory('/sounds'))
            self.require(self.serial.play_audio_file(name + ".WAV"))
        except RuntimeError:
            self.status("audio-error", "Stock board playback command failed; audibility is unknown.")
            return
        # SDK success means command acceptance, not an audible completion event.
        # Exclude prompt echo using known clip duration plus a short guard.
        if checkin_capture:
            self.pending_capture = {"after": self.now() + self.assets[name] + 0.2,
                                    "incidentId": self.context["incidentId"], "checkinId": self.context["checkinId"]}

    def context_update(self, packet):
        incident, checkin, phase = packet.get("incidentId"), packet.get("checkinId"), packet.get("phase")
        if ((incident is None) != (checkin is None) or (incident is not None and (not valid_id(incident) or not valid_id(checkin)))
                or (phase is not None and phase not in PHASES) or (incident is None) != (phase is None)):
            raise ValueError("Invalid incident context.")
        asset = packet.get("voiceAsset")
        if asset is not None and asset not in ASSETS:
            raise ValueError("Invalid voice asset.")
        status = display_text(packet.get("statusText", ""), 300)
        owner = display_text(packet.get("ownerName", "") or "", 100)
        if (incident, checkin, phase) != tuple(self.context[k] for k in ("incidentId", "checkinId", "phase")):
            # The new phase screen replaces LISTENING directly; do not flash
            # the prior incident's screen while processing a context change.
            self.stop_capture(restore_display=False)
        self.context = {"incidentId": incident, "checkinId": checkin, "phase": phase}
        self.phase_display = " | ".join(value for value in (phase, owner, status) if value) or "No active incident"
        if self.capture is None:
            self.show_status(self.phase_display)
        if asset is not None and incident is not None:
            self.play(asset, phase == "CONFIRMING" and asset == "CHECKIN")

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
        elif packet.get("type") == "voice.asset":
            if packet.get("name") not in ASSETS or not packet.get("incidentId") or any(
                    packet.get(k) != self.context[k] for k in ("incidentId", "checkinId")):
                raise ValueError("Voice asset does not match the active incident.")
            self.play(packet["name"])
        else:
            raise ValueError("Unsupported stock command.")

    def audio_tick(self):
        if self.pending_capture is not None and self.now() >= self.pending_capture["after"]:
            pending, self.pending_capture = self.pending_capture, None
            if self.context["phase"] == "CONFIRMING" and all(pending[k] == self.context[k] for k in ("incidentId", "checkinId")):
                self.require(self.serial.enable_audio_events(True))
                self.audio_enabled = True
                self.capture = {"incidentId": pending["incidentId"], "checkinId": pending["checkinId"],
                                "deadline": self.now() + 6, "pcm": bytearray(), "invalid": False}
                # This indicates an enabled, bounded microphone window, not
                # a successful transcript or a safety determination.
                self.show_status("LIFELINE | LISTENING | Say I need help | Green: close check-in | Red: help")
        if self.capture is not None and (self.now() >= self.capture["deadline"] or len(self.capture["pcm"]) >= MAX_SAMPLES * 2):
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
            self.load_assets()
            current = self.require(self.serial.read_all_buttons())
            self.buttons = {"green": bool(current.get(ButtonColor.Green)), "red": bool(current.get(ButtonColor.Red))}
            self.serial.set_event_callback(self.on_event)
            self.require(self.serial.enable_accel_events(True, 33))
            self.require(self.serial.enable_button_events(True, 50))
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
        finally:
            self.running = False
            try:
                self.stop_capture()
            finally:
                if self.serial.is_open():
                    for disable in (lambda: self.serial.enable_audio_events(False),
                                    lambda: self.serial.enable_accel_events(False, 33),
                                    lambda: self.serial.enable_button_events(False, 50)):
                        try:
                            disable()
                        except Exception:
                            pass
                    self.serial.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--audio-dir", type=pathlib.Path)
    options = parser.parse_args()
    if not re.fullmatch(r"/dev/(cu\.[\w.-]+|tty(?:ACM|USB)\d+)", options.port) or not stat.S_ISCHR(pathlib.Path(options.port).stat().st_mode):
        raise ValueError("An explicit verified DISPLAY character-device port is required.")
    if options.audio_dir is not None and not options.audio_dir.is_dir():
        raise ValueError("Prepared audio directory is missing.")
    logging.disable(logging.CRITICAL)
    gateway = StockGateway(FreeWiliSerial(options.port, stay_open=True), options.audio_dir)
    def stop(_signal, _frame):
        gateway.running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    gateway.run()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Stock gateway failed; verify DISPLAY access, SDK responses and prepared assets.", file=sys.stderr)
        sys.exit(1)
