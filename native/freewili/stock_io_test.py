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
import types
import unittest
import wave


class EventType(enum.Enum):
    Accel = 1
    Button = 2
    Audio = 3


class ButtonColor(enum.Enum):
    Green = 1
    Red = 2


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
    def open(self):
        self.calls.append(("open",)); self.opened = True; return Result()
    def is_open(self):
        return self.opened
    def close(self):
        self.calls.append(("close",)); self.opened = False
    def get_app_info(self):
        return Result(types.SimpleNamespace(processor_type=self.processor))
    def enable_audio_events(self, enable):
        self.calls.append(("audio", enable)); return Result(fail=(self.fail_disable and not enable) or (self.fail_enable and enable))
    def enable_accel_events(self, enable, interval):
        self.calls.append(("accel", enable, interval)); return Result()
    def enable_button_events(self, enable, interval):
        self.calls.append(("buttons", enable, interval)); return Result()
    def read_all_buttons(self):
        return Result({ButtonColor.Green: False, ButtonColor.Red: False})
    def set_event_callback(self, callback):
        self.callback = callback
    def send_file(self, path, target, callback):
        self.calls.append(("upload", path.name, target)); return Result()
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
        self.calls.append(("play", target)); return Result()
    def change_directory(self, target):
        self.calls.append(("directory", target)); return Result()
    def list_current_directory(self):
        self.calls.append(("list",)); return Result(self.listing, fail=self.fail_listing)
    def show_text_display(self, text):
        self.calls.append(("display", text)); return Result()
    def process_events(self, delay):
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
    def setup_gateway(self):
        now, packets, serial = [0.0], [], SerialDouble()
        gateway = worker.StockGateway(serial, None, packets.append, lambda: now[0])
        serial.gateway = gateway
        return gateway, serial, now, packets

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

    def test_microphone_starts_after_prompt_then_stops_with_correlated_wav(self):
        gateway, serial, now, packets = self.setup_gateway()
        self.start_capture(gateway, now)
        self.assertLess(serial.calls.index(("directory", "/sounds")), serial.calls.index(("play", "CHECKIN.WAV")))
        self.assertLess(serial.calls.index(("play", "CHECKIN.WAV")), serial.calls.index(("audio", True)))
        self.assertIn("LISTENING", serial.calls[-1][1])
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
        self.assertNotIn(("accel", False, 33), serial.calls, "listening does not pause or synthesize motion samples")
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
        self.assertEqual(packets[-1]["status"], "audio-unavailable")
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

    def test_queued_commands_service_real_events_and_capture_deadlines_between_commands(self):
        gateway, serial, now, packets = self.setup_gateway()
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
            worker.StockGateway.write_packet({"audio": "x" * 140000})

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
