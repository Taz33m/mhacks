"""Deterministic stock gateway tests: stdlib SDK doubles, no serial SDK or ports."""
import base64
import contextlib
import enum
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import wave


class EventType(enum.Enum):
    Accel = 1
    Button = 2
    Audio = 3


class ButtonColor(enum.Enum):
    Green = 1
    Red = 2
    Blue = 3
    Yellow = 4
    White = 5


class Processor(enum.Enum):
    Display = 1
    Main = 2


class FileType(enum.Enum):
    File = 1
    Directory = 2


class Result:
    def __init__(self, value=None, fail=False):
        self.value, self.fail = value, fail
    def is_err(self):
        return self.fail
    def unwrap(self):
        assert not self.fail
        return self.value


class SerialDouble:
    def __init__(self, *args, **kwargs):
        self.calls = []
        self.opened = False
        self.processor = Processor.Display
        self.gateway = None
        self.fail_disable = False
        self.fail_enable = False
        self.listing = types.SimpleNamespace(cwd="/sounds", contents=[])
        self.fail_listing = False
        self.files = {}
        self.downloads = []
        self.fail_get = False
        self.fail_play = False
        self.fail_accel_resume = False
    def open(self):
        self.calls.append(("open",)); self.opened = True; return Result()
    def is_open(self):
        return self.opened
    def close(self, restore_menu=True):
        self.restore_menu_on_close = restore_menu
        self.calls.append(("close",)); self.opened = False
    def get_app_info(self):
        return Result(types.SimpleNamespace(processor_type=self.processor))
    def enable_audio_events(self, enable):
        self.calls.append(("audio", enable)); return Result(fail=(self.fail_disable and not enable) or (self.fail_enable and enable))
    def set_system_sounds(self, enable):
        self.calls.append(('system-sounds', enable)); return Result()
    def enable_accel_events(self, enable, interval):
        self.calls.append(("accel", enable, interval)); return Result(fail=self.fail_accel_resume and enable)
    def enable_button_events(self, enable, interval):
        self.calls.append(("buttons", enable, interval)); return Result()
    def read_all_buttons(self):
        return Result({ButtonColor.Green: False, ButtonColor.Red: False, ButtonColor.Blue: False})
    def set_event_callback(self, callback):
        self.callback = callback
    def send_file(self, path, target, callback):
        self.calls.append(("upload", path.name, target)); return Result()
    def remove_directory_or_file(self, path):
        self.calls.append(("remove", path)); return Result()
    def get_file(self, source, destination, callback):
        self.calls.append(("download", source))
        self.downloads.append(destination)
        assert callback is None
        assert destination.stat().st_mode & 0o077 == 0
        assert destination.parent.stat().st_mode & 0o077 == 0
        if source not in self.files:
            return Result(fail=True)
        destination.write_bytes(self.files[source])
        return Result(fail=self.fail_get)
    def play_audio_file(self, target):
        self.calls.append(("play", target)); return Result(fail=self.fail_play)
    def change_directory(self, target):
        self.calls.append(("directory", target)); return Result()
    def list_current_directory(self):
        self.calls.append(("list",)); return Result(self.listing, fail=self.fail_listing)
    def show_text_display(self, text):
        self.calls.append(("display", text)); return Result()
    def process_events(self, delay):
        if delay:
            self.gateway.running = False


# Stub every imported SDK surface before loading production worker. Importing this
# test cannot discover a device or initialize an installed third-party runtime.
sdk = types.ModuleType("freewili")
sdk_serial = types.ModuleType("freewili.fw_serial")
sdk_serial.FreeWiliSerial = SerialDouble
sdk_types = types.ModuleType("freewili.types")
sdk_types.ButtonColor, sdk_types.EventType, sdk_types.FreeWiliProcessorType = ButtonColor, EventType, Processor
sdk_types.FileType = FileType
sys.modules.update({"freewili": sdk, "freewili.fw_serial": sdk_serial, "freewili.types": sdk_types})
spec = importlib.util.spec_from_file_location("stock_io", pathlib.Path(__file__).with_name("stock_io.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
protocol_packets = []


def frame(sequence, timestamp=123):
    return types.SimpleNamespace(seq_number=sequence, timestamp=timestamp, is_ok=lambda: True)


def context(phase="CONFIRMING", asset="CHECKIN"):
    return {"type": "incident.context", "incidentId": "LF-TEST1234", "checkinId": "test-checkin",
            "phase": phase, "statusText": "Shared incident state", "ownerName": "Approved responder", "voiceAsset": asset}


class StockTests(unittest.TestCase):
    def test_movement_prompt_uses_same_guarded_microphone_capture_as_fall(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.assets["MOVEMENT"] = .1
        gateway.command(context(asset="MOVEMENT"))
        self.assertIn(("play", "MOVEMENT.WAV"), serial.calls)
        self.assertNotIn(("play", "CHECKIN.WAV"), serial.calls)
        self.assertIsNotNone(gateway.pending_capture)
        now[0] = .31
        gateway.audio_tick()
        self.assertIsNotNone(gateway.capture)
        self.assertTrue(any(p.get("stage") == "listening" for p in packets))

    def setup_gateway(self, muted=False):
        # This SDK double cannot enter a firmware menu. Protocol/readback and
        # failures are exercised separately in stock_volume_test.py.
        volume_patch = patch('stock_volume.set_speaker_volume', return_value=5)
        volume_patch.start()
        self.addCleanup(volume_patch.stop)
        now, packets, serial = [0.0], [], SerialDouble()
        gateway = worker.StockGateway(serial, None, packets.append, lambda: now[0], muted=muted)
        serial.gateway = gateway
        serial.opened = True
        return gateway, serial, now, packets

    def test_volume_readback_failure_stops_startup_before_assets_or_playback(self):
        gateway, serial, _now, packets = self.setup_gateway()
        with patch('stock_volume.set_speaker_volume', side_effect=RuntimeError('Readback failed.')):
            with self.assertRaises(RuntimeError):
                gateway.run()
        self.assertEqual(serial.calls[-1], ('close',))
        self.assertFalse(any(call[0] in ('upload', 'play') for call in serial.calls))
        self.assertNotIn(('accel', True, 33), serial.calls)
        self.assertFalse(any(p.get('status') == 'ready' for p in packets))

    def test_muted_prompt_keeps_phase_and_acceleration_without_playback_or_hidden_capture(self):
        gateway, serial, now, packets = self.setup_gateway(muted=True)
        gateway.assets["CHECKIN"] = .1
        gateway.command(context())
        gateway.audio_tick()
        self.assertEqual(gateway.context["phase"], "CONFIRMING")
        self.assertIsNone(gateway.pending_capture)
        self.assertIsNone(gateway.capture)
        self.assertFalse(gateway.accel_paused)
        self.assertFalse(any(call[0] == "play" for call in serial.calls))
        gateway.on_event(EventType.Accel, frame(1), types.SimpleNamespace(g=2, x=0, y=0, z=16000))
        self.assertTrue(any(packet["type"] == "accel.sample" for packet in packets))
        self.assertTrue(any(packet.get("status") == "audio-muted" for packet in packets))

    def test_muted_dynamic_reply_never_uploads_or_claims_spoken(self):
        gateway, serial, now, packets = self.setup_gateway(muted=True)
        gateway.command(context("HELP_REQUESTED", None))
        command = self.dynamic_packet(gateway)
        gateway.command(command)
        gateway.command(command)
        gateway.audio_tick()
        self.assertIsNone(gateway.conversation)
        self.assertFalse(any(call[0] in ("upload", "play") for call in serial.calls))
        statuses = [packet["status"] for packet in packets if packet["type"] == "voice.playback"]
        self.assertEqual(statuses, ["failed"])
        self.assertEqual(gateway.context["phase"], "HELP_REQUESTED")

    def wellbeing_context(self, gateway, enabled=True, conversation="wellbeing-1"):
        return {"type": "wellbeing.context", "sessionId": gateway.session, "conversationId": conversation,
                "enabled": enabled, "statusText": "How are you feeling today?"}

    def blue(self, gateway, sequence, pressed, red=False, green=False):
        gateway.on_event(EventType.Button, frame(sequence), types.SimpleNamespace(blue=pressed, red=red, green=green))

    def start_wellbeing(self, gateway, now):
        gateway.sync_buttons({ButtonColor.Blue: False})
        gateway.command(self.wellbeing_context(gateway))
        self.blue(gateway, 1, True)
        now[0] = .350
        gateway.audio_tick()

    def test_blue_hold_records_real_wav_and_release_only_reports_transcription(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.sync_buttons({ButtonColor.Blue: False})
        gateway.command(self.wellbeing_context(gateway))
        self.assertIn("HOLD BLUE TO TALK", gateway.displayed)
        self.blue(gateway, 1, True)
        now[0] = .349; gateway.audio_tick()
        self.assertNotIn(("audio", True), serial.calls)
        now[0] = .350; gateway.audio_tick()
        self.assertIn(("audio", True), serial.calls)
        self.assertIn("RECORDING", gateway.displayed)
        gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[-32768, 100, 32767]))
        pcm = gateway.capture["pcm"]
        now[0] = .5; self.blue(gateway, 2, False)
        raw = [p for p in packets if p["type"] == "stock.wellbeing-utterance"]
        self.assertEqual(len(raw), 1)
        self.assertEqual(raw[0]["conversationId"], "wellbeing-1")
        self.assertEqual(raw[0]["sessionId"], gateway.session)
        self.assertEqual(raw[0]["durationMs"], 3 / 8)
        with wave.open(io.BytesIO(base64.b64decode(raw[0]["audioBase64"])), "rb") as clip:
            self.assertEqual((clip.getframerate(), clip.getnchannels(), clip.getsampwidth()), (8000, 1, 2))
            self.assertEqual(clip.readframes(3), b"\x00\x80\x64\x00\xff\x7f")
        self.assertEqual(pcm, bytearray())
        self.assertEqual(serial.calls.count(("audio", False)), 1)
        self.assertIn("TRANSCRIBING", gateway.displayed)
        self.assertFalse(any(p["type"] in ("button.press", "checkin.reply", "stock.utterance") for p in packets))
        result = {"type": "wellbeing.result", "sessionId": gateway.session, "conversationId": "wellbeing-1",
                  "eventId": raw[0]["eventId"], "stage": "complete"}
        with self.assertRaises(ValueError):
            gateway.command({**result, "eventId": "wrong-event"})
        gateway.command(result)
        self.assertIn("VOICE TRANSCRIBED", gateway.displayed)
        self.assertNotIn("SENT", gateway.displayed)
        with self.assertRaises(ValueError): gateway.command(result)

    def test_short_tap_and_startup_held_blue_cannot_open_microphone(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.sync_buttons({ButtonColor.Blue: True})
        gateway.command(self.wellbeing_context(gateway))
        self.blue(gateway, 1, True)
        now[0] = 1; gateway.audio_tick()
        self.assertNotIn(("audio", True), serial.calls)
        self.blue(gateway, 2, False); self.blue(gateway, 3, True)
        now[0] = 1.2; self.blue(gateway, 4, False); gateway.audio_tick()
        self.assertNotIn(("audio", True), serial.calls)
        self.blue(gateway, 5, True); now[0] = 1.551; gateway.audio_tick()
        self.assertIn(("audio", True), serial.calls)
        self.assertFalse(any(p["type"] == "stock.wellbeing-utterance" for p in packets))

    def test_wellbeing_15_second_sample_cap_stops_mic_and_waits_for_release(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_wellbeing(gateway, now)
        for sequence in range(1, 125):
            gateway.on_event(EventType.Audio, frame(sequence), types.SimpleNamespace(data=[123] * 1024))
        pcm = gateway.capture["pcm"]
        self.assertEqual(len(pcm), 240000)
        gateway.audio_tick()
        self.assertFalse(gateway.audio_enabled)
        self.assertIn("RELEASE BLUE TO SEND", gateway.displayed)
        self.assertFalse(any(p["type"] == "stock.wellbeing-utterance" for p in packets))
        gateway.on_event(EventType.Audio, frame(126), types.SimpleNamespace(data=[42] * 1024))
        self.assertEqual(len(pcm), 240000)
        self.blue(gateway, 2, False)
        raw = [p for p in packets if p["type"] == "stock.wellbeing-utterance"]
        self.assertEqual(len(raw), 1); self.assertEqual(raw[0]["durationMs"], 15000)
        self.assertLess(len(json.dumps(raw[0]).encode()), 400000)
        self.assertEqual(pcm, bytearray())
        self.assertEqual(serial.calls.count(("audio", False)), 1)

    def test_wellbeing_deadline_cap_preserves_actual_short_capture_until_release(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_wellbeing(gateway, now)
        gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[123] * 8))
        now[0] = 15.35; gateway.audio_tick()
        self.assertFalse(gateway.audio_enabled)
        gateway.on_event(EventType.Audio, frame(2), types.SimpleNamespace(data=[456] * 8))
        self.assertFalse(any(p["type"] == "stock.wellbeing-utterance" for p in packets))
        self.blue(gateway, 2, False)
        raw = next(p for p in packets if p["type"] == "stock.wellbeing-utterance")
        self.assertEqual(raw["durationMs"], 1)
        self.assertEqual(serial.calls.count(("audio", False)), 1)

    def test_disabled_new_context_incident_and_playback_cancel_wellbeing_and_wipe_audio(self):
        for boundary in ("disabled", "new-context", "incident", "playback"):
            with self.subTest(boundary=boundary):
                gateway, serial, now, packets = self.setup_gateway()
                self.start_wellbeing(gateway, now)
                gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[123]))
                pcm = gateway.capture["pcm"]
                if boundary == "disabled": gateway.command(self.wellbeing_context(gateway, False))
                elif boundary == "new-context": gateway.command(self.wellbeing_context(gateway, conversation="wellbeing-2"))
                elif boundary == "incident": gateway.command(context(asset=None))
                else:
                    gateway.assets["RESOLVED"] = .1
                    gateway.play("RESOLVED")
                self.assertIsNone(gateway.capture); self.assertFalse(gateway.audio_enabled)
                self.assertEqual(pcm, bytearray())
                now[0] = 1; gateway.audio_tick()
                self.blue(gateway, 2, False)
                self.assertFalse(any(p["type"] == "stock.wellbeing-utterance" for p in packets))
                self.assertEqual(serial.calls.count(("audio", True)), 1)

    def test_red_help_is_published_before_cancelling_blue_and_simultaneous_press_is_not_recorded(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_wellbeing(gateway, now)
        gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[123]))
        pcm = gateway.capture["pcm"]
        def disable(enable):
            self.assertTrue(any(p["type"] == "button.press" and p["action"] == "help" for p in packets))
            serial.calls.append(("audio", enable)); return Result()
        serial.enable_audio_events = disable
        self.blue(gateway, 2, True, red=True)
        self.assertEqual(pcm, bytearray()); self.assertIsNone(gateway.capture)
        self.assertFalse(any(p["type"] == "stock.wellbeing-utterance" for p in packets))
        gateway, serial, now, packets = self.setup_gateway()
        gateway.sync_buttons({ButtonColor.Blue: False})
        gateway.command(self.wellbeing_context(gateway))
        self.blue(gateway, 1, True, red=True)
        now[0] = 1; gateway.audio_tick()
        self.assertNotIn(("audio", True), serial.calls)
        self.assertEqual([p["action"] for p in packets if p["type"] == "button.press"], ["help"])

    def test_blue_is_disabled_during_incident_but_green_and_incident_microphone_still_work(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.sync_buttons({ButtonColor.Blue: False})
        gateway.command(self.wellbeing_context(gateway))
        self.start_capture(gateway, now)
        self.blue(gateway, 1, True); now[0] += .4; gateway.audio_tick()
        self.assertNotEqual(gateway.capture.get("kind"), "wellbeing")
        gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[123]))
        self.blue(gateway, 2, True, green=True)
        self.assertEqual([p["action"] for p in packets if p["type"] == "button.press"], ["cancel"])
        now[0] = gateway.capture["deadline"]; gateway.audio_tick()
        self.assertEqual(len([p for p in packets if p["type"] == "stock.utterance"]), 1)
        self.assertFalse(any(p["type"] == "stock.wellbeing-utterance" for p in packets))

    def test_empty_invalid_and_shutdown_wellbeing_never_commit_audio(self):
        for reason in ("empty", "invalid", "shutdown"):
            with self.subTest(reason=reason):
                gateway, serial, now, packets = self.setup_gateway()
                self.start_wellbeing(gateway, now)
                pcm = gateway.capture["pcm"]
                if reason == "invalid": gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[32768]))
                elif reason == "shutdown":
                    gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[123]))
                    gateway.request_stop(); gateway.cancel_wellbeing()
                self.blue(gateway, 2, False)
                self.assertEqual(pcm, bytearray())
                self.assertFalse(any(p["type"] == "stock.wellbeing-utterance" for p in packets))
                self.assertIn("unavailable", [p["stage"] for p in packets if p["type"] == "wellbeing.audio"])

    def dynamic_packet(self, gateway, filename="1234ABCD.WAV", event="responder-1"):
        return {"type": "conversation.play", "sessionId": gateway.session, "eventId": event,
                "incidentId": "LF-TEST1234", "speakerName": "Maya", "text": "Stay seated.\nI'm coming now.", "filename": filename}

    def dynamic_file(self, gateway, directory, filename="1234ABCD.WAV"):
        gateway.conversation_dir = pathlib.Path(directory)
        path = gateway.conversation_dir / filename
        with wave.open(str(path), "wb") as clip:
            clip.setnchannels(1); clip.setsampwidth(2); clip.setframerate(8000); clip.writeframes(b"\x01\x00" * 800)
        path.chmod(0o600)
        return path

    def test_dynamic_speech_upload_button_restore_elapsed_status_screen_hold_and_phase_voice_order(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.command(context("HELP_REQUESTED", None))
        gateway.assets["ACCEPTED"] = .1
        with tempfile.TemporaryDirectory(prefix="lifeline-offline-dynamic-") as directory:
            self.dynamic_file(gateway, directory)
            command = self.dynamic_packet(gateway)
            gateway.command(command); gateway.command(command)
            gateway.audio_tick()
            self.assertEqual(serial.calls.count(("upload", "1234ABCD.WAV", "/sounds/1234ABCD.WAV")), 1)
            self.assertEqual(serial.calls.count(("play", "1234ABCD.WAV")), 1)
            self.assertLess(serial.calls.index(("buttons", False, 50)), serial.calls.index(("upload", "1234ABCD.WAV", "/sounds/1234ABCD.WAV")))
            self.assertLess(serial.calls.index(("buttons", True, 50)), serial.calls.index(("play", "1234ABCD.WAV")))
            self.assertTrue(gateway.accel_paused)
            self.assertIn("Maya says: Stay seated. I'm coming now.", gateway.displayed)
            gateway.command(context("ACKNOWLEDGED", "ACCEPTED"))
            self.assertIn("Maya says:", gateway.displayed)
            self.assertNotIn(("play", "ACCEPTED.WAV"), serial.calls)
            gateway.on_event(EventType.Accel, frame(1), types.SimpleNamespace(g=2, x=0, y=0, z=16000))
            self.assertFalse(any(p["type"] == "accel.sample" for p in packets))
            now[0] = .31; gateway.audio_tick()
            self.assertIn(("remove", "/sounds/1234ABCD.WAV"), serial.calls)
            self.assertIn(("play", "ACCEPTED.WAV"), serial.calls)
            statuses = [p for p in packets if p["type"] == "voice.playback"]
            self.assertEqual([p["status"] for p in statuses], ["playing", "spoken"])
            self.assertTrue(all(p["eventId"] == command["eventId"] and p["incidentId"] == command["incidentId"] for p in statuses))
            self.assertNotIn(("audio", True), serial.calls)
            self.assertIn("Maya says:", gateway.displayed)
            now[0] = 3.32; gateway.audio_tick()
            self.assertEqual(gateway.displayed, gateway.phase_display)

    def test_context_received_during_dynamic_upload_prevents_stale_playback(self):
        gateway, serial, _now, packets = self.setup_gateway()
        gateway.command(context("HELP_REQUESTED", None))
        def upload(path, target, callback):
            serial.calls.append(("upload", path.name, target))
            gateway.inputs.put_nowait(context("RESOLVED", None))
            return Result()
        serial.send_file = upload
        with tempfile.TemporaryDirectory(prefix="lifeline-offline-stale-") as directory:
            self.dynamic_file(gateway, directory)
            gateway.command(self.dynamic_packet(gateway)); gateway.audio_tick()
        self.assertNotIn(("play", "1234ABCD.WAV"), serial.calls)
        self.assertFalse(gateway.accel_paused)
        self.assertEqual([p["status"] for p in packets if p["type"] == "voice.playback"], ["failed"])
        self.assertIn("RESOLVED", gateway.displayed)
        self.assertIn(("buttons", True, 50), serial.calls)

    def test_new_red_hold_during_upload_is_recovered_once_before_playback(self):
        gateway,serial,_now,packets=self.setup_gateway()
        gateway.command(context('HELP_REQUESTED',None))
        readings=iter([{ButtonColor.Red:False},{ButtonColor.Red:True}])
        serial.read_all_buttons=lambda:Result(next(readings))
        with tempfile.TemporaryDirectory(prefix='lifeline-offline-held-help-') as directory:
            self.dynamic_file(gateway,directory)
            gateway.command(self.dynamic_packet(gateway));gateway.audio_tick()
        help_packets=[p for p in packets if p['type']=='button.press']
        self.assertEqual(len(help_packets),1)
        self.assertEqual(help_packets[0]['action'],'help')
        self.assertEqual(help_packets[0]['incidentId'],gateway.context['incidentId'])
        self.assertLess(packets.index(help_packets[0]),next(i for i,p in enumerate(packets) if p['type']=='voice.playback' and p['status']=='playing'))
        gateway.on_event(EventType.Button,frame(1),types.SimpleNamespace(green=False,red=True,blue=False))
        self.assertEqual(len([p for p in packets if p['type']=='button.press']),1)
        self.assertTrue(any(c[0]=='display' and 'HOLD RED FOR HELP' in c[1] for c in serial.calls))

    def test_preheld_red_does_not_generate_upload_help_or_start_blue_recording(self):
        gateway,serial,_now,packets=self.setup_gateway()
        gateway.command(context('HELP_REQUESTED',None))
        held={ButtonColor.Red:True,ButtonColor.Blue:True}
        gateway.sync_buttons(held)
        serial.read_all_buttons=lambda:Result(held)
        with tempfile.TemporaryDirectory(prefix='lifeline-offline-preheld-') as directory:
            self.dynamic_file(gateway,directory)
            gateway.command(self.dynamic_packet(gateway));gateway.audio_tick()
        self.assertFalse(any(p['type']=='button.press' for p in packets))
        self.assertFalse(gateway.blue_armed)
        self.assertIsNone(gateway.capture)

    def test_released_tap_inside_upload_is_not_fabricated_and_limit_is_reported(self):
        gateway,serial,_now,packets=self.setup_gateway()
        gateway.command(context('HELP_REQUESTED',None))
        # The SDK exposes only false before/after. It has no latched history to
        # distinguish no press from a tap completed during its binary transfer.
        with tempfile.TemporaryDirectory(prefix='lifeline-offline-no-latch-') as directory:
            self.dynamic_file(gateway,directory)
            gateway.command(self.dynamic_packet(gateway));gateway.audio_tick()
        self.assertFalse(any(p['type']=='button.press' for p in packets))
        self.assertTrue(any(p.get('status')=='buttons-resumed' and 'Released taps' in p['detail'] for p in packets))

    def test_recovered_hold_uses_context_received_during_upload_and_no_replay(self):
        gateway,serial,_now,packets=self.setup_gateway()
        gateway.command(context('HELP_REQUESTED',None))
        readings=iter([{ButtonColor.Red:False},{ButtonColor.Red:True}])
        serial.read_all_buttons=lambda:Result(next(readings))
        def upload(path,target,callback):
            gateway.inputs.put_nowait({**context('CONFIRMING',None),'incidentId':'LF-NEW','checkinId':'new-checkin'})
            return Result()
        serial.send_file=upload
        with tempfile.TemporaryDirectory(prefix='lifeline-offline-current-hold-') as directory:
            self.dynamic_file(gateway,directory)
            gateway.command(self.dynamic_packet(gateway));gateway.audio_tick()
        help_packet=next(p for p in packets if p['type']=='button.press')
        self.assertEqual((help_packet['incidentId'],help_packet['checkinId']),('LF-NEW','new-checkin'))
        self.assertNotIn(('play','1234ABCD.WAV'),serial.calls)

    def test_simulated_transfer_screen_has_no_demo_prefix(self):
        gateway,serial,_now,packets=self.setup_gateway()
        gateway.command({**context('HELP_REQUESTED',None),'dispatchMode':'simulated'})
        with tempfile.TemporaryDirectory(prefix='lifeline-offline-demo-upload-') as directory:
            self.dynamic_file(gateway,directory)
            gateway.command(self.dynamic_packet(gateway));gateway.audio_tick()
        self.assertIn(('display','PREPARING MESSAGE | HOLD RED FOR HELP'),serial.calls)
        self.assertTrue(gateway.displayed.startswith('Maya says:'))

    def test_dynamic_speech_waits_for_prompt_and_cancels_microphone_echo_window(self):
        gateway, serial, now, _packets = self.setup_gateway()
        gateway.assets["CHECKIN"] = .1
        gateway.command(context())
        with tempfile.TemporaryDirectory(prefix="lifeline-offline-order-") as directory:
            self.dynamic_file(gateway, directory)
            gateway.command(self.dynamic_packet(gateway))
            now[0] = .1; gateway.audio_tick()
            self.assertNotIn(("play", "1234ABCD.WAV"), serial.calls)
            now[0] = .31; gateway.audio_tick()
            self.assertIn(("play", "1234ABCD.WAV"), serial.calls)
            self.assertIsNone(gateway.capture)
            self.assertIsNone(gateway.pending_capture)
            self.assertNotIn(("audio", True), serial.calls)

    def test_terminal_context_during_playback_never_marks_stale_message_completed(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.command(context("HELP_REQUESTED", None))
        with tempfile.TemporaryDirectory(prefix="lifeline-offline-terminal-") as directory:
            self.dynamic_file(gateway, directory)
            gateway.command(self.dynamic_packet(gateway)); gateway.audio_tick()
            gateway.command(context("RESOLVED", None))
            self.assertIn("RESOLVED", gateway.displayed)
            now[0] = .31; gateway.audio_tick()
        self.assertEqual([p["status"] for p in packets if p["type"] == "voice.playback"], ["playing", "failed"])
        self.assertFalse(gateway.accel_paused)

    def test_dynamic_play_failure_restores_streams_and_invalid_filename_never_uploads(self):
        gateway, serial, _now, packets = self.setup_gateway()
        gateway.command(context("HELP_REQUESTED", None))
        with self.assertRaises(ValueError):
            gateway.command(self.dynamic_packet(gateway, "../CHECKIN.WAV"))
        with tempfile.TemporaryDirectory(prefix="lifeline-offline-failed-") as directory:
            path = self.dynamic_file(gateway, directory)
            path.chmod(0o644)
            gateway.command(self.dynamic_packet(gateway)); gateway.audio_tick()
            self.assertFalse(any(call[0] == "upload" for call in serial.calls))
            path.chmod(0o600); serial.fail_play = True
            gateway.command(self.dynamic_packet(gateway, event="second")); gateway.audio_tick()
        self.assertEqual([p["status"] for p in packets if p["type"] == "voice.playback"], ["failed", "failed"])
        self.assertFalse(gateway.accel_paused)
        self.assertIn(("buttons", True, 50), serial.calls)
        self.assertNotIn(("audio", True), serial.calls)

    def test_upload_watchdog_interrupts_stalled_sdk_and_requires_gateway_shutdown(self):
        gateway, serial, _now, packets = self.setup_gateway()
        gateway.command(context("HELP_REQUESTED", None))
        original = worker.upload_watchdog
        worker.upload_watchdog = lambda: original(.01)
        serial.send_file = lambda *_args: time.sleep(.2)
        try:
            with tempfile.TemporaryDirectory(prefix="lifeline-offline-watchdog-") as directory:
                self.dynamic_file(gateway, directory)
                gateway.command(self.dynamic_packet(gateway))
                with self.assertRaises(worker.StockUploadTimeout):
                    gateway.audio_tick()
            self.assertFalse(gateway.running)
            self.assertIn(("buttons", True, 50), serial.calls)
            self.assertEqual([p["status"] for p in packets if p["type"] == "voice.playback"], ["failed"])
            self.assertNotIn(("play", "1234ABCD.WAV"), serial.calls)
            self.assertFalse(any(p.get("status") == "accel-resumed" for p in packets))
            self.assertIsNone(gateway.conversation)
        finally:
            worker.upload_watchdog = original

    def test_shutdown_during_upload_restores_buttons_before_acquisition_closes(self):
        gateway, serial, _now, packets = self.setup_gateway()
        gateway.command(context("HELP_REQUESTED", None))
        serial.send_file = lambda *_args: gateway.request_stop()
        with tempfile.TemporaryDirectory(prefix="lifeline-offline-upload-stop-") as directory:
            self.dynamic_file(gateway, directory)
            gateway.command(self.dynamic_packet(gateway))
            with self.assertRaises(worker.StockTransferFailure):
                gateway.audio_tick()
        self.assertFalse(gateway.running)
        self.assertFalse(gateway.upload_in_progress)
        self.assertIn(("buttons", True, 50), serial.calls)
        self.assertEqual([p["status"] for p in packets if p["type"] == "voice.playback"], ["failed"])
        self.assertNotIn(("play", "1234ABCD.WAV"), serial.calls)

    def start_capture(self, gateway, now):
        gateway.assets["CHECKIN"] = .1
        gateway.command(context())
        self.assertFalse(gateway.audio_enabled)
        now[0] = .31
        gateway.audio_tick()
        self.assertTrue(gateway.audio_enabled)

    def test_sample_shapes_range_conversion_and_unknown_zeros(self):
        gateway, _serial, now, packets = self.setup_gateway()
        gateway.on_event(EventType.Accel, frame(1), types.SimpleNamespace(g=2, x=0, y=0, z=0))
        self.assertEqual(packets[-1]["status"], "sensor-error")
        self.assertFalse(any(p["type"] == "accel.sample" for p in packets))
        for index, (scale, factor) in enumerate(((2, 4), (4, 8), (8, 16), (16, 48)), start=2):
            now[0] = index / 100
            gateway.on_event(EventType.Accel, frame(index, 999), types.SimpleNamespace(g=scale, x=64, y=-768, z=16448))
            sample = packets[-1]
            self.assertEqual(sample["accelerationG"], [factor / 1000, -12 * factor / 1000, 257 * factor / 1000])
            self.assertEqual(sample["captureClock"], "host-receipt")
            self.assertEqual(sample["frameTimestamp"], "999")
            self.assertEqual(sample["sensorTime"], now[0])
        before = len(packets)
        gateway.on_event(EventType.Accel, frame(3), types.SimpleNamespace(g=2, x=64, y=0, z=16448))
        self.assertEqual(len(packets), before)  # Globally skipped sequences are fine; reordered frames are not.
        protocol_packets.append(next(p for p in packets if p["type"] == "accel.sample"))

    def test_saturation_is_retained_as_evidence(self):
        gateway, _serial, _now, packets = self.setup_gateway()
        gateway.on_event(EventType.Accel, frame(1), types.SimpleNamespace(g=2, x=-32768, y=0, z=32704))
        self.assertTrue(packets[-1]["saturated"])
        self.assertEqual(packets[-1]["accelerationG"], [-2.048, 0, 2.044])

    def test_explicit_buttons_are_rising_edges_with_current_ids(self):
        gateway, _serial, _now, packets = self.setup_gateway()
        gateway.context = {k: context()[k] for k in ("incidentId", "checkinId", "phase")}
        for sequence in (1, 2):
            gateway.on_event(EventType.Button, frame(sequence), types.SimpleNamespace(green=True, red=False))
        self.assertEqual(len(packets), 1)
        self.assertEqual(packets[0]["action"], "cancel")
        self.assertEqual(packets[0]["incidentId"], "LF-TEST1234")
        protocol_packets.append(packets[0])
        gateway.context["phase"] = "RESOLVED"
        gateway.on_event(EventType.Button, frame(3), types.SimpleNamespace(green=False, red=False))
        gateway.on_event(EventType.Button, frame(4), types.SimpleNamespace(green=True, red=True))
        self.assertEqual(len(packets), 2)
        self.assertEqual(packets[-1]["action"], "help")
        self.assertIsNone(packets[-1]["incidentId"])
        self.assertIsNone(packets[-1]["checkinId"])
        protocol_packets.append(packets[-1])

    def yellow_event(self, gateway, sequence, pressed=True, red=False, green=False):
        gateway.on_event(EventType.Button,frame(sequence),types.SimpleNamespace(
            yellow=pressed,red=red,green=green,blue=False))

    def simulated_idle(self, gateway):
        gateway.command({'type':'incident.context','sessionId':gateway.session,'incidentId':None,
            'checkinId':None,'phase':None,'dispatchMode':'simulated','voiceAsset':None,
            'ownerName':None,'statusText':'No active incident'})

    def test_yellow_before_context_and_in_live_mode_does_nothing_and_idle_stays_silent(self):
        gateway,serial,_now,packets=self.setup_gateway()
        self.yellow_event(gateway,1)
        self.yellow_event(gateway,2,False)
        gateway.command({**context('RESOLVED',None),'dispatchMode':'live'})
        self.yellow_event(gateway,3)
        self.assertFalse(any(p['type']=='button.press' for p in packets))
        self.assertFalse(any(c[0] in ('play','audio') for c in serial.calls))
        self.assertIsNone(gateway.capture)

    def test_simulated_yellow_rising_edge_uses_fresh_null_identity_and_unique_event(self):
        gateway,serial,_now,packets=self.setup_gateway()
        self.simulated_idle(gateway)
        self.yellow_event(gateway,1)
        self.yellow_event(gateway,1)  # Duplicate frame is rejected too.
        self.yellow_event(gateway,2)
        controls=[p for p in packets if p['type']=='button.press']
        self.assertEqual(len(controls),1)
        self.assertEqual(controls[0]['action'],'rehearse')
        self.assertEqual(controls[0]['sessionId'],gateway.session)
        self.assertIsNone(controls[0]['incidentId']);self.assertIsNone(controls[0]['checkinId'])
        self.yellow_event(gateway,3,False);self.yellow_event(gateway,4)
        controls=[p for p in packets if p['type']=='button.press']
        self.assertEqual(len(controls),2)
        self.assertNotEqual(controls[0]['eventId'],controls[1]['eventId'])
        self.assertFalse(any(c[0] in ('play','audio') for c in serial.calls))
        protocol_packets.append(controls[0])

    def test_yellow_terminal_context_never_reuses_previous_incident(self):
        for phase in ('RESOLVED','CANCELLED_FALSE_ALARM'):
            with self.subTest(phase=phase):
                gateway,_serial,_now,packets=self.setup_gateway()
                gateway.command({**context(phase,None),'dispatchMode':'simulated'})
                self.yellow_event(gateway,1)
                control=next(p for p in packets if p['type']=='button.press')
                self.assertEqual(control['action'],'rehearse')
                self.assertIsNone(control['incidentId']);self.assertIsNone(control['checkinId'])

    def test_yellow_is_blocked_for_every_active_phase(self):
        for phase in worker.PHASES-worker.TERMINAL_PHASES:
            with self.subTest(phase=phase):
                gateway,_serial,_now,packets=self.setup_gateway()
                gateway.command({**context(phase,None),'dispatchMode':'simulated'})
                self.yellow_event(gateway,1)
                self.assertFalse(any(p['type']=='button.press' for p in packets))

    def test_startup_held_yellow_and_mode_change_require_release_before_rehearsal(self):
        gateway,_serial,_now,packets=self.setup_gateway()
        gateway.sync_buttons({ButtonColor.Yellow:True})
        self.simulated_idle(gateway)
        self.yellow_event(gateway,1)
        self.assertFalse(any(p['type']=='button.press' for p in packets))
        self.yellow_event(gateway,2,False);self.yellow_event(gateway,3)
        self.assertEqual(len([p for p in packets if p['type']=='button.press']),1)
        # A live-mode press cannot become a simulated press simply by a
        # context update while the physical button remains held.
        gateway,_serial,_now,packets=self.setup_gateway()
        self.yellow_event(gateway,1);self.simulated_idle(gateway);self.yellow_event(gateway,2)
        self.assertFalse(any(p['type']=='button.press' for p in packets))

    def test_yellow_held_during_upload_is_suppressed_even_after_terminal_context(self):
        gateway,serial,_now,packets=self.setup_gateway()
        gateway.command({**context('HELP_REQUESTED',None),'dispatchMode':'simulated'})
        readings=iter([{ButtonColor.Yellow:False},{ButtonColor.Yellow:True}])
        serial.read_all_buttons=lambda:Result(next(readings))
        def upload(path,target,callback):
            gateway.inputs.put_nowait({**context('RESOLVED',None),'dispatchMode':'simulated'})
            return Result()
        serial.send_file=upload
        with tempfile.TemporaryDirectory(prefix='lifeline-offline-yellow-upload-') as directory:
            self.dynamic_file(gateway,directory)
            gateway.command(self.dynamic_packet(gateway));gateway.audio_tick()
        self.yellow_event(gateway,1)
        self.assertFalse(any(p['type']=='button.press' for p in packets))
        self.yellow_event(gateway,2,False);self.yellow_event(gateway,3)
        self.assertEqual([p['action'] for p in packets if p['type']=='button.press'],['rehearse'])

    def test_red_and_green_safety_controls_take_precedence_over_yellow(self):
        gateway,_serial,_now,packets=self.setup_gateway()
        self.simulated_idle(gateway);self.yellow_event(gateway,1,red=True)
        self.assertEqual([p['action'] for p in packets if p['type']=='button.press'],['help'])
        gateway,_serial,_now,packets=self.setup_gateway()
        gateway.command({**context(asset=None),'dispatchMode':'simulated'})
        self.yellow_event(gateway,1,green=True)
        self.assertEqual([p['action'] for p in packets if p['type']=='button.press'],['cancel'])

    def test_rehearsal_control_does_not_bypass_server_checkin_or_duplicate_prompt(self):
        gateway,serial,now,packets=self.setup_gateway()
        self.simulated_idle(gateway);gateway.assets['CHECKIN']=.1
        self.yellow_event(gateway,1)
        self.assertFalse(any(c[0] in ('play','audio') for c in serial.calls))
        checkin={**context(),'dispatchMode':'simulated'}
        gateway.command(checkin);gateway.command(checkin)
        self.assertEqual(serial.calls.count(('play','CHECKIN.WAV')),1)
        self.assertFalse(gateway.audio_enabled)
        now[0]=.31;gateway.audio_tick()
        self.assertTrue(gateway.audio_enabled)
        self.assertEqual([p['stage'] for p in packets if p['type']=='checkin.audio'],['prompting','listening'])

    def test_microphone_starts_after_prompt_then_stops_with_correlated_wav(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_capture(gateway, now)
        self.assertLess(serial.calls.index(("directory", "/sounds")), serial.calls.index(("play", "CHECKIN.WAV")))
        self.assertLess(serial.calls.index(("play", "CHECKIN.WAV")), serial.calls.index(("audio", True)))
        self.assertIn("LISTENING", serial.calls[-1][1])
        voice_states = [p for p in packets if p["type"] == "checkin.audio"]
        self.assertEqual([p["stage"] for p in voice_states], ["prompting", "listening"])
        self.assertTrue(all(p["sessionId"] == gateway.session and p["incidentId"] == "LF-TEST1234"
                            and p["checkinId"] == "test-checkin" for p in voice_states))
        protocol_packets.extend(voice_states)
        self.assertLess(serial.calls.index(("audio", True)), len(serial.calls) - 1)
        display_count = len([call for call in serial.calls if call[0] == "display"])
        gateway.command(context())
        self.assertEqual(len([call for call in serial.calls if call[0] == "display"]), display_count,
                         "repeated current context does not hide an active microphone window")
        capture = gateway.capture
        gateway.on_event(EventType.Accel, frame(9), types.SimpleNamespace(g=2, x=0, y=0, z=16000))
        sample = next(p for p in packets if p["type"] == "accel.sample")
        self.assertEqual(sample["captureClock"], "host-receipt")
        self.assertEqual(sample["sensorTime"], now[0])
        self.assertEqual(sample["accelerationG"], [0, 0, 1])
        self.assertLess(serial.calls.index(("accel", False, 33)), serial.calls.index(("play", "CHECKIN.WAV")))
        self.assertLess(serial.calls.index(("play", "CHECKIN.WAV")), serial.calls.index(("accel", True, 33)))
        self.assertLess(serial.calls.index(("accel", True, 33)), serial.calls.index(("audio", True)))
        self.assertFalse(gateway.accel_paused, "motion resumes before listening and is not synthesized")
        gateway.on_event(EventType.Audio, frame(8), types.SimpleNamespace(data=[-32768, 0, 32767]))
        gateway.on_event(EventType.Audio, frame(8), types.SimpleNamespace(data=[99]))
        now[0] = 6.32
        gateway.audio_tick()
        self.assertFalse(gateway.audio_enabled)
        self.assertEqual(serial.calls[-2], ("audio", False))
        self.assertEqual(serial.calls[-1], ("display", gateway.phase_display))
        utterance = next(p for p in packets if p["type"] == "stock.utterance")
        self.assertEqual((utterance["incidentId"], utterance["checkinId"]), ("LF-TEST1234", "test-checkin"))
        with wave.open(io.BytesIO(base64.b64decode(utterance["audioBase64"])), "rb") as clip:
            self.assertEqual((clip.getframerate(), clip.getsampwidth(), clip.getnchannels(), clip.getnframes()), (8000, 2, 1, 3))
            self.assertEqual(clip.readframes(3), b"\x00\x80\x00\x00\xff\x7f")
        self.assertEqual(capture["pcm"], bytearray())
        protocol_packets.append(utterance)

    def test_six_second_sample_cap_and_empty_mic_are_bounded_unknowns(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_capture(gateway, now)
        for sequence in range(1, 100):
            gateway.on_event(EventType.Audio, frame(sequence), types.SimpleNamespace(data=[1] * 1024))
        self.assertEqual(len(gateway.capture["pcm"]), 6 * 8000 * 2)
        gateway.audio_tick()
        utterance = next(p for p in packets if p["type"] == "stock.utterance")
        self.assertEqual(utterance["durationMs"], 6000)
        self.assertLess(len(json.dumps(utterance)), 140000)
        self.assertFalse(gateway.audio_enabled)
        gateway, serial, now, packets = self.setup_gateway()
        self.start_capture(gateway, now)
        now[0] = 7
        gateway.audio_tick()
        self.assertFalse(any(p["type"] == "stock.utterance" for p in packets))
        self.assertEqual(next(p for p in reversed(packets) if p["type"] == "stock.status")["status"], "audio-unavailable")
        self.assertEqual(packets[-1]["stage"], "unavailable")
        self.assertEqual(serial.calls[-2], ("audio", False))
        self.assertEqual(serial.calls[-1], ("display", gateway.phase_display))

    def test_listening_requires_successful_enable_and_stale_prompt_cannot_start(self):
        gateway, serial, now, _packets = self.setup_gateway()
        gateway.assets["CHECKIN"] = .1
        gateway.command(context())
        self.assertFalse(any(call[0] == "display" and "LISTENING" in call[1] for call in serial.calls))
        serial.fail_enable = True
        now[0] = .31
        with self.assertRaises(RuntimeError):
            gateway.audio_tick()
        self.assertIsNone(gateway.capture)
        self.assertFalse(gateway.audio_enabled)
        self.assertFalse(any(p["type"] == "checkin.audio" and p["stage"] == "listening" for p in _packets))
        self.assertFalse(any(call[0] == "display" and "LISTENING" in call[1] for call in serial.calls))

        gateway, serial, now, _packets = self.setup_gateway()
        gateway.assets["CHECKIN"] = .1
        gateway.command(context())
        gateway.command(context("HELP_REQUESTED", None))
        now[0] = .31
        gateway.audio_tick()
        self.assertNotIn(("audio", True), serial.calls)
        self.assertEqual(serial.calls[-1], ("display", gateway.phase_display))

    def test_phase_change_abandons_capture_and_positive_feedback_has_no_policy_action(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_capture(gateway, now)
        capture = gateway.capture
        gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[100]))
        gateway.command(context("HELP_REQUESTED", None))
        self.assertIsNone(gateway.capture)
        self.assertFalse(gateway.audio_enabled)
        self.assertEqual(capture["pcm"], bytearray())
        self.assertFalse(any(p["type"] == "stock.utterance" for p in packets))
        self.assertEqual(gateway.context["phase"], "HELP_REQUESTED")
        self.assertEqual(serial.calls[-1], ("display", gateway.phase_display))
        self.assertIn("HELP_REQUESTED", serial.calls[-1][1])
        self.assertNotIn("LISTENING", serial.calls[-1][1])
        gateway.assets["OKAY"] = .1
        gateway.command({"type": "voice.asset", "name": "OKAY", "incidentId": "LF-TEST1234", "checkinId": "test-checkin"})
        self.assertEqual(serial.calls[-1], ("play", "OKAY.WAV"))
        self.assertEqual(gateway.context["phase"], "HELP_REQUESTED")
        self.assertFalse(any(p["type"] == "button.press" for p in packets))

    def test_new_checkin_identity_restores_phase_and_discards_old_listening_audio(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_capture(gateway, now)
        capture = gateway.capture
        gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[100]))
        replacement = context()
        replacement["checkinId"] = "replacement-checkin"
        gateway.command(replacement)
        self.assertIsNone(gateway.capture)
        self.assertFalse(gateway.audio_enabled)
        self.assertEqual(capture["pcm"], bytearray())
        self.assertFalse(any(p["type"] == "stock.utterance" for p in packets))
        self.assertEqual(gateway.pending_capture["checkinId"], "replacement-checkin")
        self.assertEqual(gateway.displayed, gateway.phase_display)
        self.assertNotIn("LISTENING", gateway.displayed)
        self.assertEqual(serial.calls[-1], ("play", "CHECKIN.WAV"))

    def test_voice_pause_keeps_buttons_and_discards_queued_old_accel_until_resume(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.assets["CHECKIN"] = 1
        gateway.command(context())
        self.assertTrue(gateway.accel_paused)
        self.assertFalse(gateway.audio_enabled)
        self.assertFalse(any(call[0] == "buttons" for call in serial.calls))
        gateway.on_event(EventType.Accel, frame(1), types.SimpleNamespace(g=2, x=0, y=0, z=16000))
        gateway.on_event(EventType.Button, frame(2), types.SimpleNamespace(green=True, red=False))
        self.assertTrue(any(packet["type"] == "button.press" for packet in packets))
        self.assertFalse(any(packet["type"] == "accel.sample" for packet in packets))
        drained = []

        def old_events(_delay):
            sequence = 3 + len(drained)
            drained.append(sequence)
            gateway.on_event(EventType.Accel, frame(sequence), types.SimpleNamespace(g=2, x=0, y=0, z=16000))

        serial.process_events = old_events
        now[0] = 1.19
        gateway.audio_tick()
        self.assertTrue(gateway.accel_paused)
        now[0] = 1.21
        gateway.audio_tick()
        self.assertEqual(len(drained), 2)
        self.assertFalse(any(packet["type"] == "accel.sample" for packet in packets),
                         "buffered motion is not relabelled as fresh after playback")
        self.assertFalse(gateway.accel_paused)
        self.assertLess(serial.calls.index(("accel", True, 33)), serial.calls.index(("audio", True)))
        gateway.on_event(EventType.Accel, frame(5), types.SimpleNamespace(g=2, x=0, y=0, z=16000))
        self.assertEqual(len([packet for packet in packets if packet["type"] == "accel.sample"]), 1)
        self.assertEqual(packets[-1]["sensorTime"], now[0])

    def test_overlapping_phase_voice_replaces_old_pause_timer_without_old_mic_start(self):
        gateway, serial, now, _packets = self.setup_gateway()
        gateway.assets.update({"CHECKIN": .1, "HELP": 2})
        gateway.command(context())
        now[0] = .1
        gateway.command(context("HELP_REQUESTED", "HELP"))
        self.assertIsNone(gateway.pending_capture)
        self.assertAlmostEqual(gateway.playback_until, 2.3)
        self.assertEqual(serial.calls.count(("accel", True, 33)), 1,
                         "a phase change restores acquisition before the replacement prompt")
        now[0] = .31
        gateway.audio_tick()
        self.assertTrue(gateway.accel_paused, "the old prompt timer cannot resume the newer voice window")
        self.assertNotIn(("audio", True), serial.calls)
        gateway.command(context("HELP_REQUESTED", "HELP"))
        self.assertEqual(serial.calls.count(("play", "HELP.WAV")), 1, "repeated context does not loop voice")
        self.assertAlmostEqual(gateway.playback_until, 2.3)
        now[0] = 2.31
        gateway.audio_tick()
        self.assertFalse(gateway.accel_paused)
        self.assertNotIn(("audio", True), serial.calls)

    def test_playback_failure_and_shutdown_restore_accel_without_starting_mic(self):
        gateway, serial, _now, packets = self.setup_gateway()
        gateway.assets["CHECKIN"] = .1
        serial.fail_play = True
        gateway.command(context())
        self.assertFalse(gateway.accel_paused)
        self.assertIsNone(gateway.playback_until)
        self.assertIsNone(gateway.pending_capture)
        self.assertNotIn(("audio", True), serial.calls)
        self.assertEqual(next(p for p in reversed(packets) if p["type"] == "stock.status")["status"], "audio-error")
        self.assertEqual(packets[-1]["stage"], "unavailable")
        self.assertLess(serial.calls.index(("play", "CHECKIN.WAV")), serial.calls.index(("accel", True, 33)))

        gateway, serial, _now, _packets = self.setup_gateway()
        gateway.assets["CHECKIN"] = 2
        gateway.read_input = lambda: None
        gateway.inputs.put_nowait(context())
        gateway.inputs.put_nowait(None)
        gateway.run()
        play_index = serial.calls.index(("play", "CHECKIN.WAV"))
        resume_index = next(index for index, call in enumerate(serial.calls)
                            if index > play_index and call == ("accel", True, 33))
        self.assertLess(resume_index, len(serial.calls) - 1)
        self.assertEqual(serial.calls[-1], ("close",))
        self.assertFalse(gateway.accel_paused)
        self.assertNotIn(("audio", True), serial.calls)

    def test_resume_failure_cannot_start_mic_or_claim_acquisition_resumed(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.assets["CHECKIN"] = .1
        gateway.command(context())
        serial.fail_accel_resume = True
        now[0] = .31
        with self.assertRaises(RuntimeError):
            gateway.audio_tick()
        self.assertTrue(gateway.accel_paused)
        self.assertFalse(any(packet.get("status") == "accel-resumed" for packet in packets))
        self.assertNotIn(("audio", True), serial.calls)
        self.assertIsNone(gateway.capture)

    def test_pause_opt_out_preserves_stream_while_retaining_prompt_echo_guard(self):
        gateway, serial, now, _packets = self.setup_gateway()
        gateway.pause_accel_for_audio = False
        gateway.assets["CHECKIN"] = .1
        gateway.command(context())
        self.assertFalse(any(call[0] == "accel" for call in serial.calls))
        self.assertFalse(gateway.accel_paused)
        now[0] = .2
        gateway.audio_tick()
        self.assertNotIn(("audio", True), serial.calls)
        now[0] = .31
        gateway.audio_tick()
        self.assertTrue(gateway.audio_enabled)
        self.assertFalse(any(call[0] == "accel" for call in serial.calls))

    def test_queued_commands_service_real_events_and_capture_deadlines_between_commands(self):
        gateway, serial, now, packets = self.setup_gateway()
        gateway.pause_accel_for_audio = False
        gateway.assets["CHECKIN"] = .1
        gateway.read_input = lambda: None
        for packet in (context(), {"type": "clock.ping", "id": "during-capture"},
                       {"type": "clock.ping", "id": "after-capture"}, None):
            gateway.inputs.put_nowait(packet)
        serviced = []

        def process_events(delay):
            serviced.append(delay)
            if len(serviced) == 1:
                now[0] = .31  # Prompt and guard have elapsed after the first command.
                gateway.on_event(EventType.Accel, frame(1), types.SimpleNamespace(g=2, x=0, y=0, z=16000))
            elif len(serviced) == 2:
                self.assertIsNotNone(gateway.capture, "the queued clock command cannot defer capture startup")
                now[0] = .4
                gateway.on_event(EventType.Audio, frame(2), types.SimpleNamespace(data=[123]))
                now[0] = 6.32

        serial.process_events = process_events
        gateway.run()
        utterance_index = next(index for index, packet in enumerate(packets) if packet["type"] == "stock.utterance")
        next_command_index = next(index for index, packet in enumerate(packets)
                                  if packet["type"] == "clock.pong" and packet["id"] == "after-capture")
        self.assertLess(utterance_index, next_command_index,
                        "the microphone deadline is serviced before the next queued command")
        self.assertTrue(any(packet["type"] == "accel.sample" for packet in packets))
        self.assertEqual(serviced, [0.0, 0.0, 0.0])
        self.assertFalse(gateway.audio_enabled)
        self.assertEqual(serial.calls[-1], ("close",))

    def test_gateway_clock_is_explicit_and_stale_or_malformed_input_rejects(self):
        gateway, serial, now, packets = self.setup_gateway()
        now[0] = 12.5
        gateway.command({"type": "clock.ping", "id": "ping-test", "serverSentMs": 20000})
        self.assertEqual(packets[0]["deviceReceivedMs"], 12500)
        protocol_packets.append(packets[0])
        with self.assertRaises(ValueError):
            gateway.command({"type": "incident.context", "sessionId": "old-session"})
        gateway.command(context("ACKNOWLEDGED", None))
        with self.assertRaises(ValueError):
            gateway.command({"type": "voice.asset", "name": "OKAY", "incidentId": "LF-STALE", "checkinId": "old"})
        self.assertNotIn(("audio", True), serial.calls)
        displayed = [c[1] for c in serial.calls if c[0] == "display"][-1]
        self.assertIn("ACKNOWLEDGED", displayed)
        self.assertNotIn("EN_ROUTE", displayed)

    def test_shutdown_disables_streams_and_closes_and_non_display_never_emits_hello(self):
        gateway, serial, _now, packets = self.setup_gateway()
        gateway.run()
        hello = next(p for p in packets if p["type"] == "device.hello")
        self.assertEqual(hello["transport"], "stock-sdk")
        self.assertEqual(hello["fullScaleG"], 2)
        protocol_packets.append(hello)
        self.assertEqual(serial.calls[-1], ("close",))
        self.assertFalse(serial.restore_menu_on_close, 'shutdown must not restore the GPIO/menu screen')
        self.assertIn(('system-sounds', False), serial.calls)
        self.assertFalse(any(call[0] == 'play' for call in serial.calls), 'ordinary startup is silent')
        self.assertIn(("audio", False), serial.calls)
        self.assertIn(("accel", False, 33), serial.calls)
        self.assertIn(("buttons", False, 50), serial.calls)
        gateway, serial, _now, packets = self.setup_gateway()
        serial.processor = Processor.Main
        with self.assertRaises(RuntimeError):
            gateway.run()
        self.assertFalse(any(p["type"] == "device.hello" for p in packets))
        self.assertEqual(serial.calls[-1], ("close",))

    def test_stdout_is_actual_bounded_ndjson_and_invalid_audio_is_unavailable(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_capture(gateway, now)
        gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[32768]))
        now[0] = 7
        gateway.audio_tick()
        self.assertFalse(any(p["type"] == "stock.utterance" for p in packets))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            worker.StockGateway.write_packet({"type": "stock.status", "detail": "bounded"})
        self.assertEqual(json.loads(output.getvalue()), {"type": "stock.status", "detail": "bounded"})
        with self.assertRaises(ValueError):
            worker.StockGateway.write_packet({"audio": "x" * 400000})

    def test_disable_failure_wipes_transient_audio_and_never_emits_a_transcript(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_capture(gateway, now)
        capture = gateway.capture
        gateway.on_event(EventType.Audio, frame(1), types.SimpleNamespace(data=[123]))
        serial.fail_disable = True
        with self.assertRaises(RuntimeError):
            gateway.stop_capture(deliver=True)
        self.assertEqual(capture["pcm"], bytearray())
        self.assertIsNone(gateway.capture)
        self.assertFalse(any(p["type"] == "stock.utterance" for p in packets))

    def test_prepared_assets_validate_mono_8k_and_upload_exact_83_names(self):
        gateway, serial, _now, packets = self.setup_gateway()
        with tempfile.TemporaryDirectory(prefix="lifeline-offline-prompt-test-") as directory:
            gateway.audio_dir = pathlib.Path(directory)
            for name, channels in (("CHECKIN", 1), ("ACCEPTED", 2)):
                with wave.open(str(gateway.audio_dir / (name + ".WAV")), "wb") as clip:
                    clip.setnchannels(channels); clip.setsampwidth(2); clip.setframerate(8000)
                    clip.writeframes(b"\x01\x00" * (channels * 800))
            gateway.load_assets()
        self.assertEqual(gateway.assets, {"CHECKIN": .1})
        self.assertIn(("upload", "CHECKIN.WAV", "/sounds/CHECKIN.WAV"), serial.calls)
        self.assertFalse(any(c[0] == "upload" and c[1] == "ACCEPTED.WAV" for c in serial.calls))
        self.assertEqual(packets[0]["status"], "audio-error")

    def test_board_cache_reuses_only_readback_verified_identical_files(self):
        gateway, serial, _now, _packets = self.setup_gateway()
        with tempfile.TemporaryDirectory(prefix="lifeline-offline-cache-test-") as directory:
            gateway.audio_dir = pathlib.Path(directory)
            for name in ("CHECKIN", "HELP", "ACCEPTED", "ENROUTE"):
                with wave.open(str(gateway.audio_dir / (name + ".WAV")), "wb") as clip:
                    clip.setnchannels(1); clip.setsampwidth(2); clip.setframerate(8000); clip.writeframes(b"\x01\x00" * 800)
            size = (gateway.audio_dir / "CHECKIN.WAV").stat().st_size
            serial.listing.contents = [
                types.SimpleNamespace(name="CHECKIN.WAV", size=size, file_type=FileType.File),
                types.SimpleNamespace(name="HELP.WAV", size=size + 4060, file_type=FileType.File),
                types.SimpleNamespace(name="ENROUTE.WAV", size=size, file_type=FileType.Directory),
            ]
            serial.files["/sounds/CHECKIN.WAV"] = (gateway.audio_dir / "CHECKIN.WAV").read_bytes()
            gateway.load_assets()
        self.assertEqual(serial.calls.count(("list",)), 1)
        self.assertNotIn(("upload", "CHECKIN.WAV", "/sounds/CHECKIN.WAV"), serial.calls)
        for name in ("HELP", "ACCEPTED", "ENROUTE"):
            self.assertIn(("upload", name + ".WAV", "/sounds/" + name + ".WAV"), serial.calls)
        self.assertEqual(len(gateway.assets), 4)
        self.assertEqual([call for call in serial.calls if call[0] == "download"], [("download", "/sounds/CHECKIN.WAV")])
        self.assertTrue(all(not path.exists() and not path.parent.exists() for path in serial.downloads))

    def test_same_size_old_voice_missing_failed_and_oversized_readbacks_are_uploaded(self):
        for mode in ("different-bytes", "missing", "failed", "oversized"):
            with self.subTest(mode=mode):
                gateway, serial, _now, _packets = self.setup_gateway()
                with tempfile.TemporaryDirectory(prefix="lifeline-offline-readback-test-") as directory:
                    gateway.audio_dir = pathlib.Path(directory)
                    path = gateway.audio_dir / "CHECKIN.WAV"
                    with wave.open(str(path), "wb") as clip:
                        clip.setnchannels(1); clip.setsampwidth(2); clip.setframerate(8000)
                        clip.writeframes(b"\x01\x00" * 800)
                    current = path.read_bytes()
                    serial.listing.contents = [types.SimpleNamespace(
                        name="CHECKIN.WAV", size=len(current), file_type=FileType.File)]
                    if mode == "different-bytes":
                        serial.files["/sounds/CHECKIN.WAV"] = current[:-1] + bytes([current[-1] ^ 1])
                        self.assertEqual(len(serial.files["/sounds/CHECKIN.WAV"]), len(current))
                    elif mode == "failed":
                        serial.files["/sounds/CHECKIN.WAV"] = current
                        serial.fail_get = True
                    elif mode == "oversized":
                        serial.files["/sounds/CHECKIN.WAV"] = b"x" * 250001
                    gateway.load_assets()
                self.assertIn(("download", "/sounds/CHECKIN.WAV"), serial.calls)
                self.assertIn(("upload", "CHECKIN.WAV", "/sounds/CHECKIN.WAV"), serial.calls)
                self.assertEqual(gateway.assets, {"CHECKIN": .1})
                self.assertTrue(all(not path.exists() and not path.parent.exists() for path in serial.downloads))

    def test_failed_or_wrong_directory_cache_query_falls_back_to_upload(self):
        for failed in (True, False):
            gateway, serial, _now, _packets = self.setup_gateway()
            with tempfile.TemporaryDirectory(prefix="lifeline-offline-cache-test-") as directory:
                gateway.audio_dir = pathlib.Path(directory)
                path = gateway.audio_dir / "CHECKIN.WAV"
                with wave.open(str(path), "wb") as clip:
                    clip.setnchannels(1); clip.setsampwidth(2); clip.setframerate(8000); clip.writeframes(b"\x01\x00" * 800)
                serial.fail_listing = failed
                serial.listing = types.SimpleNamespace(cwd="/other", contents=[types.SimpleNamespace(
                    name="CHECKIN.WAV", size=path.stat().st_size, file_type=FileType.File)])
                gateway.load_assets()
            self.assertEqual(serial.calls.count(("list",)), 1)
            self.assertIn(("upload", "CHECKIN.WAV", "/sounds/CHECKIN.WAV"), serial.calls)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(StockTests)
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=1).run(suite)
    if not result.wasSuccessful():
        sys.exit(1)
    for packet in protocol_packets:
        worker.StockGateway.write_packet(packet)
