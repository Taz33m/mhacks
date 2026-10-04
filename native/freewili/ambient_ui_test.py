"""Offline tests for native pixels, truthful states and serial scheduling."""
import contextlib
import json
import pathlib
import struct
import tempfile
import types
import unittest
import wave
from unittest.mock import patch

from PIL import Image
from ambient_ui import AmbientDisplay, AmbientState, build_assets, fwi_bytes
import stock_io_test as doubles


class DisplayDouble(doubles.SerialDouble):
    def show_gui_image(self, path):
        self.calls.append(('image', path))
        return doubles.Result(fail=getattr(self, 'fail_image', False))


class AmbientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='lifeline-ui-offline-')
        cls.manifest = build_assets(cls.directory.name, ['Maya'])

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def gateway(self):
        serial = DisplayDouble(); clock = [1.0]; packets = []
        gateway = doubles.worker.StockGateway(serial, None, emit=packets.append,
            now=lambda: clock[0], ui_dir=pathlib.Path(self.directory.name))
        serial.gateway = gateway; serial.opened = True
        gateway.ui.enabled = True
        return gateway, serial, clock, packets

    def test_native_pixel_format(self):
        data = fwi_bytes(Image.new('RGB', (320, 240), '#ff0000'))
        self.assertEqual(len(data), 153624)
        self.assertEqual(struct.unpack('<8sIIHHHH', data[:24]),
            (b'FW01IMG\0', 1, 76800, 320, 240, 0, 0))
        self.assertEqual(data[24:26], b'\xf8\x00')

    def test_responder_states_require_backend_phase(self):
        model = AmbientState()
        for phase, state in [('CONFIRMING', 'checking'), ('HELP_REQUESTED', 'reaching'),
                ('ACKNOWLEDGED', 'accepted'), ('RESPONDER_EN_ROUTE', 'on_way'),
                ('ON_SCENE', 'on_scene'), ('RESOLVED', 'resolved')]:
            model.context(phase, 'Maya')
            self.assertEqual(model.view(0)[0], state)
        model.context('HELP_REQUESTED', 'Maya')
        self.assertEqual(model.view(0)[1], '')

    def test_meter_uses_pcm_and_decays_to_silence(self):
        model = AmbientState()
        model.pcm([12000, -12000] * 100, 1)
        self.assertEqual(model.view(1.1, True)[2], 3)
        self.assertEqual(model.view(1.5, True)[2], 0)
        model.pcm([8000] * 100, 2)  # DC offset is not speaking.
        self.assertEqual(model.view(2, True)[2], 0)

    def test_incoming_speech_uses_the_actual_audio_envelope(self):
        gateway, serial, clock, _ = self.gateway()
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'VOICE.WAV'
            with wave.open(str(path), 'wb') as clip:
                clip.setnchannels(1); clip.setsampwidth(2); clip.setframerate(8000)
                clip.writeframes(b'\x00\x00' * 1000 + struct.pack('<hh',12000,-12000) * 500)
            gateway.ui.voice(path, 'Maya')
        self.assertEqual(gateway.ui.model.view(1), ('speaking', 'Maya', 0))
        self.assertEqual(gateway.ui.model.view(1.13), ('speaking', 'Maya', 3))

    def test_wellbeing_capture_remains_distinct_after_terminal_incident(self):
        model = AmbientState(); model.context('RESOLVED')
        self.assertEqual(model.view(0, True, True)[0], 'recording')
        self.assertEqual(model.view(0, True, False)[0], 'listening')

    def test_terminal_state_returns_to_ready_and_recording_limit_is_not_listening(self):
        model = AmbientState(); model.wellbeing = True; model.context('RESOLVED', now=10)
        self.assertEqual(model.view(11)[0], 'resolved')
        self.assertEqual(model.view(14)[0], 'ready_talk')
        model.stage = 'recording_limit'
        self.assertEqual(model.view(14)[0], 'recording_limit')

    def test_no_display_upload_or_command_at_capture_deadline(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.capture = {'deadline': 1.1, 'kind': 'wellbeing'}; gateway.audio_enabled = True
        gateway.ui_tick()
        self.assertEqual(serial.calls, [])
        gateway.capture['deadline'] = 7
        gateway.upload_in_progress = True; gateway.ui_tick()
        self.assertEqual(serial.calls, [])

    def test_serial_rate_limit_and_text_fallback(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.ui.model.context('HELP_REQUESTED'); gateway.ui_tick()
        clock[0] += .1; gateway.ui_tick()
        self.assertEqual(len(serial.calls), 1)
        clock[0] += .5; serial.fail_image = True; gateway.ui_tick()
        self.assertFalse(gateway.ui.enabled)
        self.assertEqual(serial.calls[-1][0], 'display')

    def test_slow_display_reduces_animation(self):
        gateway, serial, clock, packets = self.gateway()
        with patch('ambient_ui.time.monotonic', side_effect=[0, .2]): gateway.ui_tick()
        self.assertEqual(gateway.ui.interval, 1)
        self.assertTrue(any(p['status'] == 'ui-paced' for p in packets))

    def test_unknown_person_gets_generic_artwork(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.ui.model.context('ACKNOWLEDGED', 'Uncached Person'); gateway.ui_tick()
        expected = self.manifest['assets']['accepted::2']['file']
        self.assertEqual(serial.calls[-1], ('image', '/images/' + expected))

    def test_sdk_callback_only_updates_model(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.capture = {'deadline': 7, 'pcm': bytearray(), 'invalid': False}
        gateway.audio_enabled = True
        gateway.on_event(doubles.EventType.Audio, doubles.frame(1), types.SimpleNamespace(data=[12000, -12000]))
        self.assertEqual(gateway.ui.model.level, 3)
        self.assertEqual(serial.calls, [])

    def test_stale_transcription_cannot_override_new_incident_screen(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.context_update(doubles.context(asset=None))
        gateway.checkin_processing_event = 'utterance-1'; gateway.ui.model.processing = True
        packet = {'type': 'stock.checkin-result', 'sessionId': gateway.session,
                  'incidentId': gateway.context['incidentId'], 'checkinId': gateway.context['checkinId'],
                  'eventId': 'utterance-1', 'stage': 'complete'}
        gateway.context_update(doubles.context('HELP_REQUESTED', None))
        with self.assertRaises(ValueError): gateway.command(packet)
        self.assertEqual(gateway.ui.model.view(clock[0])[0], 'reaching')

    def test_transcription_acknowledges_voice_without_claiming_sent(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.context_update(doubles.context(asset=None))
        gateway.checkin_processing_event = 'utterance-1'; gateway.ui.model.processing = True
        gateway.command({'type': 'stock.checkin-result', 'sessionId': gateway.session,
            'incidentId': gateway.context['incidentId'], 'checkinId': gateway.context['checkinId'],
            'eventId': 'utterance-1', 'stage': 'complete'})
        self.assertEqual(gateway.ui.model.view(clock[0])[0], 'heard')
        clock[0] += 3
        self.assertEqual(gateway.ui.model.view(clock[0])[0], 'checking')

    def test_install_keeps_cached_files_and_does_not_delete_board_assets(self):
        gateway, serial, clock, _ = self.gateway()
        serial.listing = types.SimpleNamespace(cwd='/images', contents=[
            types.SimpleNamespace(name=entry['file'], size=entry['bytes'], file_type=doubles.FileType.File)
            for entry in self.manifest['assets'].values()])
        gateway.ui.install(lambda seconds: contextlib.nullcontext())
        self.assertFalse(any(call[0] in ('upload', 'remove') for call in serial.calls))
        self.assertEqual(serial.calls[-1], ('directory', '/sounds'))


if __name__ == '__main__': unittest.main()
