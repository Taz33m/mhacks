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
from ambient_ui import AmbientDisplay, AmbientState, FRAMES, build_assets, fwi_bytes, render
import stock_io_test as doubles


class DisplayDouble(doubles.SerialDouble):
    def invalidate_display(self):
        self.calls.append(('invalidate-display',))

    def send_file(self, path, target, callback):
        self.files['\\images\\'+path.name]=path.read_bytes()
        return super().send_file(path,target,callback)
    def show_gui_image(self, path):
        self.calls.append(('image', path))
        return doubles.Result(fail=getattr(self, 'fail_image', False))


class AmbientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='lifeline-ui-offline-')
        cls.manifest = build_assets(cls.directory.name)
        cls.demo_directory = tempfile.TemporaryDirectory(prefix='lifeline-demo-ui-offline-')
        cls.demo_manifest = build_assets(cls.demo_directory.name,['Maya'],compact=True,dispatch_mode='simulated')

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()
        cls.demo_directory.cleanup()

    def gateway(self, simulated=False):
        serial = DisplayDouble(); clock = [1.0]; packets = []
        gateway = doubles.worker.StockGateway(serial, None, emit=packets.append,
            now=lambda: clock[0], ui_dir=pathlib.Path(self.demo_directory.name if simulated else self.directory.name))
        serial.gateway = gateway; serial.opened = True
        gateway.ui.enabled = True
        return gateway, serial, clock, packets

    def physical_button(self, gateway, sequence, **levels):
        gateway.on_event(doubles.EventType.Button, doubles.frame(sequence),
            types.SimpleNamespace(**{name: levels.get(name, False)
                for name in ('gray', 'yellow', 'green', 'blue', 'red')}))

    def test_red_restores_native_screen_on_owner_loop_without_callback_paint_or_sound(self):
        gateway, serial, _clock, packets = self.gateway()
        gateway.ui_tick()
        original = gateway.ui.last_file
        serial.calls.clear()
        self.physical_button(gateway, 1, red=True)
        self.assertEqual(serial.calls, [])
        self.assertTrue(gateway.display_restore_pending)
        self.assertEqual([p['action'] for p in packets if p['type'] == 'button.press'], ['help'])
        gateway.ui_tick()  # Same timestamp/frame: navigation bypasses frame dedup.
        self.assertEqual(serial.calls, [('invalidate-display',), ('image', original)])
        self.assertFalse(gateway.display_restore_pending)
        self.assertIsNone(gateway.context['phase'])  # Presentation cannot decide state.

    def test_held_button_does_not_reset_animation_but_release_restores_once(self):
        gateway, serial, _clock, _packets = self.gateway()
        gateway.ui_tick()
        serial.calls.clear()
        self.physical_button(gateway, 1, gray=True)
        gateway.ui_tick()
        serial.calls.clear()
        for sequence in range(2, 12):
            self.physical_button(gateway, sequence, gray=True)
            gateway.ui_tick()
        self.assertEqual(serial.calls, [])
        self.physical_button(gateway, 12)
        gateway.ui_tick()
        self.assertEqual([call[0] for call in serial.calls], ['invalidate-display', 'image'])
        serial.calls.clear()
        self.physical_button(gateway, 11, gray=True)  # Reordered event is ignored.
        gateway.ui_tick()
        self.assertEqual(serial.calls, [])

    def test_navigation_preserves_backend_incident_and_current_responder_art(self):
        gateway, serial, clock, _packets = self.gateway(simulated=True)
        gateway.command({**doubles.context('RESPONDER_EN_ROUTE', None),
            'dispatchMode': 'simulated', 'ownerName': 'Maya'})
        gateway.ui_tick()
        original = gateway.ui.last_file
        self.assertEqual(original, gateway.ui.manifest['assets']['on_way:Maya:0']['file'])
        original_context = dict(gateway.context)
        clock[0] += .01
        serial.calls.clear()
        self.physical_button(gateway, 1, gray=True)
        self.physical_button(gateway, 2)  # Coalesced navigation uses one serial paint.
        gateway.ui_tick()
        self.assertEqual(serial.calls, [('invalidate-display',), ('image', original)])
        self.assertEqual(gateway.context, original_context)

    def test_pending_restore_waits_for_transfer_and_near_recording_deadline(self):
        gateway, serial, clock, _packets = self.gateway()
        gateway.ui_tick()
        serial.calls.clear()
        gateway.upload_in_progress = True
        self.physical_button(gateway, 1, gray=True)
        gateway.ui_tick()
        self.assertTrue(gateway.display_restore_pending)
        self.assertEqual(serial.calls, [])
        gateway.upload_in_progress = False
        gateway.capture = {'deadline': clock[0] + .1, 'kind': 'checkin'}
        gateway.audio_enabled = True
        gateway.ui_tick()
        self.assertTrue(gateway.display_restore_pending)
        self.assertEqual(serial.calls, [])
        gateway.capture = None
        gateway.audio_enabled = False
        gateway.ui_tick()
        self.assertFalse(gateway.display_restore_pending)
        self.assertEqual([call[0] for call in serial.calls], ['invalidate-display', 'image'])

    def test_navigation_restores_text_when_image_mode_does_not_match(self):
        gateway, serial, _clock, _packets = self.gateway()  # Live artwork.
        gateway.command({**doubles.context('HELP_REQUESTED', None), 'dispatchMode': 'simulated'})
        gateway.ui_tick()
        text = gateway.displayed
        self.assertTrue(text.endswith('Shared incident state'))
        self.assertNotIn('DEMO', text)
        serial.calls.clear()
        self.physical_button(gateway, 1, gray=True)
        gateway.ui_tick()
        self.assertEqual(serial.calls, [('invalidate-display',), ('display', text)])
        self.assertFalse(gateway.display_restore_pending)

    def test_native_pixel_format(self):
        data = fwi_bytes(Image.new('RGB', (320, 240), '#ff0000'))
        self.assertEqual(len(data), 153624)
        self.assertEqual(struct.unpack('<8sIIHHHH', data[:24]),
            (b'FW01IMG\0', 1, 76800, 320, 240, 0, 0))
        self.assertEqual(data[24:26], b'\xf8\x00')

    def test_product_screens_are_identical_in_both_dispatch_modes(self):
        for state in FRAMES:
            for frame in range(self.manifest['frames'][state]):
                with self.subTest(state=state,frame=frame):
                    self.assertEqual(render(state,frame,demo=True).tobytes(),render(state,frame).tobytes())

    def test_single_demo_bundle_fits_budget_and_preserves_measured_voice_levels(self):
        self.assertEqual(self.demo_manifest['dispatchMode'],'simulated')
        self.assertLessEqual(len({v['file'] for v in self.demo_manifest['assets'].values()}),44)
        for state in ('listening','recording','speaking'):
            self.assertEqual(len({self.demo_manifest['assets'][f'{state}::{i}']['file'] for i in range(4)}),4)
        self.assertEqual(self.demo_manifest['assets']['ready::0']['file'],self.manifest['assets']['ready::0']['file'])

    def test_invalid_bundle_or_context_mode_is_rejected_before_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest=dict(self.manifest);manifest['dispatchMode']='guess'
            pathlib.Path(directory,'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):AmbientDisplay(DisplayDouble(),directory,lambda r:r.unwrap(),lambda *args:None)
        gateway,serial,_,_=self.gateway()
        with self.assertRaises(ValueError):gateway.context_update({**doubles.context(asset=None),'dispatchMode':'guess'})
        self.assertEqual(serial.calls,[])

    def test_mode_mismatch_immediately_replaces_unlabelled_image_and_recovers(self):
        gateway,serial,clock,_=self.gateway()
        gateway.context_update(doubles.context(asset=None));gateway.ui_tick()
        self.assertTrue(any(c[0]=='image' for c in serial.calls))
        serial.calls.clear()
        gateway.context_update({**doubles.context(asset=None),'dispatchMode':'simulated'})
        self.assertEqual(serial.calls[-1],('display','CONFIRMING | Approved responder | Shared incident state'))
        gateway.ui_tick();clock[0]+=3;gateway.ui_tick()
        self.assertFalse(any(c[0]=='image' for c in serial.calls))
        gateway.context_update(doubles.context(asset=None));gateway.ui_tick()
        self.assertEqual(serial.calls[-1][0],'image')
        self.assertTrue(gateway.ui.enabled,'a mismatched bundle must not permanently disable images')

    def test_simulated_bundle_keeps_product_screens_through_listening_speech_and_resolution(self):
        gateway,serial,clock,_=self.gateway(simulated=True)
        ctx={**doubles.context(asset=None),'dispatchMode':'simulated'}
        gateway.context_update(ctx)
        gateway.capture={'kind':'checkin','deadline':10,'pcm':bytearray(),'invalid':False}
        gateway.audio_enabled=True
        gateway.ui_tick()
        expected=self.demo_manifest['assets']['listening::0']['file']
        self.assertEqual(serial.calls[-1],('image',expected))
        gateway.capture=None;gateway.audio_enabled=False
        gateway.ui.model.playing=True;gateway.ui.model.speaker='Maya'
        clock[0]+=.3;gateway.ui_tick()
        self.assertEqual(serial.calls[-1],('image',self.demo_manifest['assets']['speaking:Maya:0']['file']))
        gateway.context_update({**ctx,'phase':'RESOLVED'})
        clock[0]+=.3;gateway.ui_tick()
        self.assertEqual(serial.calls[-1],('image',self.demo_manifest['assets']['resolved::0']['file']))
        clock[0]+=3;gateway.ui_tick()
        self.assertEqual(gateway.ui.model.view(clock[0])[0],'ready')
        self.assertEqual(serial.calls[-1][1],self.demo_manifest['assets']['ready::0']['file'])

    def test_live_context_never_uses_demo_art_and_status_text_cannot_infer_mode(self):
        gateway,serial,_,_=self.gateway(simulated=True)
        gateway.context_update({**doubles.context(asset=None),'statusText':'DEMO from unrelated text','dispatchMode':'live'})
        gateway.ui_tick()
        self.assertFalse(any(c[0]=='image' for c in serial.calls))
        self.assertEqual(gateway.ui.model.dispatch_mode,'live')
        gateway.context_update({**doubles.context(asset=None),'dispatchMode':'simulated'})
        gateway.ui_tick()
        self.assertEqual(serial.calls[-1][0],'image')

    def test_simulated_mismatch_labels_real_listening_and_dynamic_text_without_old_art(self):
        gateway,serial,_,_=self.gateway()
        gateway.context_update({**doubles.context(asset=None),'dispatchMode':'simulated'})
        gateway.show_status('LIFELINE | LISTENING')
        self.assertEqual(serial.calls[-1],('display','LIFELINE | LISTENING'))
        gateway.ui.model.playing=True;gateway.ui.model.speaker='Maya'
        gateway.show_status('Maya says: Stay seated.')
        gateway.ui_tick()
        self.assertEqual(serial.calls[-1],('display','Maya says: Stay seated.'))

    def test_wellbeing_after_simulated_terminal_never_reuses_demo_recognition_art(self):
        gateway,serial,clock,_=self.gateway(simulated=True)
        gateway.wellbeing_update({'type':'wellbeing.context','sessionId':gateway.session,
            'conversationId':'wellbeing-1','enabled':True,'statusText':'Share how you feel.'})
        gateway.context_update({**doubles.context('RESOLVED',None),'dispatchMode':'simulated'})
        gateway.ui_tick()
        self.assertEqual(serial.calls[-1],('image',self.demo_manifest['assets']['resolved::0']['file']))
        clock[0]+=3.1
        gateway.ui.model.processing=True
        gateway.show_status('LIFELINE | TRANSCRIBING | PLEASE WAIT')
        serial.calls.clear();gateway.ui_tick()
        self.assertEqual(gateway.displayed,'LIFELINE | TRANSCRIBING | PLEASE WAIT')
        self.assertFalse(any(c[0]=='image' for c in serial.calls))
        gateway.ui.model.processing=False;gateway.ui.model.heard_until=clock[0]+2
        gateway.show_status('LIFELINE | VOICE TRANSCRIBED | HOLD BLUE TO TALK')
        self.assertFalse(gateway.displayed.startswith('DEMO'))

    def test_idle_breathes_silently_and_only_an_incident_starts_voice_capture(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.ui.model.wellbeing = True
        seen = set()
        for tick in (0, .84, 1.68, 2.52):
            clock[0] = tick
            state, _owner, frame = gateway.ui.model.view(tick)
            self.assertEqual(state, 'ready_talk')
            seen.add(self.manifest['assets'][f'{state}::{frame}']['file'])
            gateway.ui_tick()
        self.assertGreaterEqual(len(seen), 3)
        self.assertFalse(any(call[0] == 'play' for call in serial.calls))
        self.assertNotIn(('audio', True), serial.calls)
        gateway.assets['CHECKIN'] = .1
        gateway.context_update(doubles.context())
        self.assertEqual(gateway.ui.model.view(clock[0])[0], 'checking')
        self.assertIn(('play', 'CHECKIN.WAV'), serial.calls)
        clock[0] += .1
        gateway.audio_tick()
        self.assertNotIn(('audio', True), serial.calls, 'the spoken prompt and echo guard come before capture')
        clock[0] += .21
        gateway.audio_tick()
        self.assertIn(('audio', True), serial.calls)

    def test_initial_idle_uses_the_uploaded_file_even_if_upload_crosses_frame_boundary(self):
        gateway, serial, clock, _ = self.gateway()
        uploaded = set()
        serial.listing = types.SimpleNamespace(cwd='/images', contents=[])
        expected = self.manifest['assets'][f'ready::{gateway.ui.model.view(clock[0])[2]}']['file']
        def upload(path, target, callback):
            uploaded.add(path.name)
            serial.files['\\images\\'+path.name]=path.read_bytes()
            serial.calls.append(('upload', path.name, target))
            clock[0] += 1.0
            return doubles.Result()
        def image(path):
            self.assertIn(path.split('\\')[-1], uploaded)
            serial.calls.append(('image', path))
            return doubles.Result()
        serial.send_file = upload
        serial.show_gui_image = image
        gateway.ui.install(contextlib.nullcontext)
        images = [call for call in serial.calls if call[0] == 'image']
        self.assertEqual(images[0], ('image', expected))
        first_image = serial.calls.index(images[0])
        self.assertEqual(sum(call[0] == 'upload' for call in serial.calls[:first_image]), 1)

    def test_install_cleans_only_obsolete_lifeline_images_and_verifies_uploads(self):
        gateway,serial,_,packets=self.gateway()
        serial.listing=types.SimpleNamespace(cwd='/images',contents=[
            types.SimpleNamespace(name=name,size=153624,file_type=doubles.FileType.File)
            for name in ('L0000000.FWI','OTHER.FWI')])
        gateway.ui.install(contextlib.nullcontext)
        self.assertIn(('remove','\\images\\L0000000.FWI'),serial.calls)
        self.assertNotIn(('remove','\\images\\OTHER.FWI'),serial.calls)
        self.assertTrue(any(call[0]=='download' for call in serial.calls))

    def test_incomplete_upload_cannot_be_reported_as_ready(self):
        gateway,serial,_,packets=self.gateway()
        serial.listing=types.SimpleNamespace(cwd='/images',contents=[])
        def upload(path,target,callback):
            serial.files['\\images\\'+path.name]=b''
            return doubles.Result()
        serial.send_file=upload
        gateway.ui.enabled=False
        with self.assertRaisesRegex(RuntimeError,'readback failed'):
            gateway.ui.install(contextlib.nullcontext)
        self.assertFalse(gateway.ui.enabled)
        self.assertFalse(any(call[0]=='image' for call in serial.calls))
        self.assertFalse(any(p['status']=='ui-ready' for p in packets))

    def test_oversized_contact_image_set_is_rejected_before_opening_serial(self):
        with tempfile.TemporaryDirectory() as directory:
            build_assets(directory,['Maya'])
            with self.assertRaisesRegex(ValueError,'storage budget'):
                AmbientDisplay(DisplayDouble(),directory,lambda r:r.unwrap(),lambda *args:None)

    def test_compact_contact_art_fits_without_losing_states_or_audio_levels(self):
        with tempfile.TemporaryDirectory() as directory:
            m=build_assets(directory,['Maya'],compact=True)
            self.assertLessEqual(len({v['file'] for v in m['assets'].values()}),44)
            self.assertEqual(m['frames'],self.manifest['frames'])
            for state in ('listening','recording','speaking'):
                self.assertEqual(len({m['assets'][f'{state}::{i}']['file'] for i in range(4)}),4)

    def test_responder_states_require_backend_phase(self):
        model = AmbientState()
        for phase, state in [('CONFIRMING', 'checking'), ('HELP_REQUESTED', 'reaching'),
                ('ACKNOWLEDGED', 'accepted'), ('RESPONDER_EN_ROUTE', 'on_way'),
                ('ON_SCENE', 'on_scene'), ('RESOLVED', 'resolved')]:
            model.context(phase, 'Maya')
            self.assertEqual(model.view(0)[0], state)
        model.context('HELP_REQUESTED', 'Maya')
        self.assertEqual(model.view(0)[1], '')

    def test_waiting_for_help_holds_one_frame_but_listening_still_uses_meter(self):
        model = AmbientState()
        model.context('HELP_REQUESTED', '', 0)
        self.assertEqual({model.view(t) for t in (0, .25, .5, 1, 2, 10)}, {('reaching', '', 0)})
        self.assertEqual(model.view(1, True)[0], 'listening')

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
        # A real state change attempts a new image and detects failures.
        clock[0] += 2.1; serial.fail_image = True
        gateway.ui.model.context('ON_SCENE'); gateway.ui_tick()
        self.assertFalse(gateway.ui.enabled)
        self.assertEqual(serial.calls[-1][0], 'display')

    def test_slow_display_reduces_animation(self):
        gateway, serial, clock, packets = self.gateway()
        with patch('ambient_ui.time.monotonic', side_effect=[0, .2]): gateway.ui_tick()
        self.assertEqual(gateway.ui.interval, 1)
        self.assertTrue(any(p['status'] == 'ui-paced' for p in packets))

    def test_held_screen_is_restored_without_flooding_or_interrupting_capture(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.ui.model.context('RESPONDER_EN_ROUTE', now=clock[0])
        gateway.ui_tick()
        expected = serial.calls[-1]
        clock[0] += 1; gateway.ui_tick()
        self.assertEqual(len(serial.calls), 1)
        clock[0] += 2
        gateway.upload_in_progress = True; gateway.ui_tick()
        self.assertEqual(len(serial.calls), 1)
        gateway.upload_in_progress = False
        gateway.capture = {'deadline': clock[0]+.1, 'kind': 'wellbeing'}
        gateway.audio_enabled = True; gateway.ui_tick()
        self.assertEqual(len(serial.calls), 1)
        gateway.capture = None; gateway.audio_enabled = False; gateway.ui_tick()
        self.assertEqual(serial.calls, [expected])
        gateway.display_restore_pending = True; gateway.ui_tick()
        self.assertEqual(serial.calls, [expected, ('invalidate-display',), expected])

    def test_idle_holds_one_image_and_sdk_commands_repaint_once(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.ui_tick()
        expected = serial.calls[-1]
        for t in (2, 3, 10, 30, 60):
            clock[0] = t; gateway.ui_tick()
        self.assertEqual(serial.calls, [expected])
        serial.display_needs_repaint = lambda: True
        clock[0] += 1; gateway.ui_tick()
        self.assertEqual(serial.calls, [expected, expected])
        serial.display_needs_repaint = lambda: False
        clock[0] += 5; gateway.ui_tick()
        self.assertEqual(serial.calls, [expected, expected])

    def test_unknown_person_gets_generic_artwork(self):
        gateway, serial, clock, _ = self.gateway()
        gateway.ui.model.context('ACKNOWLEDGED', 'Uncached Person'); gateway.ui_tick()
        expected = self.manifest['assets']['accepted::2']['file']
        self.assertEqual(serial.calls[-1], ('image', expected))

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
        serial.files={'\\images\\'+entry['file']:(pathlib.Path(self.directory.name)/entry['file']).read_bytes()
                      for entry in self.manifest['assets'].values()}
        gateway.ui.install(lambda seconds: contextlib.nullcontext())
        self.assertFalse(any(call[0] in ('upload', 'remove') for call in serial.calls))
        self.assertEqual(serial.calls[-1], ('directory', '/sounds'))


if __name__ == '__main__': unittest.main()
