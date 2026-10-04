"""Real SDK wire regressions with a fake transport; never opens a serial port.

Use a child interpreter because the other stock-worker tests replace the global
freewili modules with doubles. This child exercises the installed SDK decorator
and command bodies, rather than a copy of their behavior.
"""
import os
import pathlib
import subprocess
import sys
import types
import unittest
from queue import Queue
from unittest.mock import patch


if os.environ.get('LIFELINE_DISPLAY_TEST_CHILD') == '1':
    import freewili.fw_serial as sdk
    from result import Ok
    from stock_display import StockDisplaySerial

    class WireTransport:
        def __init__(self, *args, **kwargs):
            self.connected = False
            self.data_queue, self.rf_event_queue, self.rf_queue = Queue(), Queue(), Queue()
            self.calls = []
            self.next_image_error = False
            self.next_image_exception = False
            self.open_count = 0

        def is_open(self):
            return self.connected

        def open(self, *args, **kwargs):
            if not self.connected:
                self.open_count += 1
            self.connected = True
            return Ok(None)

        def close(self, *args, **kwargs):
            self.connected = False

        def send(self, command, *args, **kwargs):
            self.calls.append(command)
            if command == sdk.CMD_DISABLE_MENU:
                return
            if isinstance(command, str) and sdk.CMD_ENABLE_MENU.decode('ascii') in command:
                self.data_queue.put(b'Enter Letter:')
                return
            if isinstance(command, str) and command.startswith('g\nl\n'):
                if self.next_image_exception:
                    self.next_image_exception = False
                    raise OSError('Generated transport failure.')
                successful = not self.next_image_error
                self.next_image_error = False
            else:
                successful = True
            self.rf_queue.put(Ok(types.SimpleNamespace(is_ok=lambda: successful,
                response='Generated acknowledgment.' if successful else 'Generated command rejection.')))

    class ActualSDKWireTests(unittest.TestCase):
        def setUp(self):
            transport_patch = patch.object(sdk, 'SerialPort', WireTransport)
            transport_patch.start()
            self.addCleanup(transport_patch.stop)
            self.serial = StockDisplaySerial('/dev/DO-NOT-OPEN-TEST', stay_open=True)
            self.wire = self.serial.serial_port

        def paint(self, filename='L012ABCD.FWI'):
            result = self.serial.show_gui_image(filename)
            self.assertTrue(result.is_ok())
            return result

        def test_first_image_resets_but_consecutive_acknowledged_images_do_not(self):
            self.assertTrue(hasattr(sdk.FreeWiliSerial.show_gui_image, '__wrapped__'))
            for _ in range(10):
                self.paint()
            self.assertEqual(self.wire.calls, [sdk.CMD_DISABLE_MENU] + ['g\nl\nL012ABCD.FWI'] * 10)
            self.assertEqual(self.wire.open_count, 1)

        def test_interleaved_real_sdk_button_command_restores_reset_boundary(self):
            self.paint()
            self.paint('L7654321.FWI')
            self.assertTrue(self.serial.enable_button_events(True, 50).is_ok())
            self.paint()
            self.paint()
            self.assertEqual(self.wire.calls, [sdk.CMD_DISABLE_MENU, 'g\nl\nL012ABCD.FWI',
                'g\nl\nL7654321.FWI', sdk.CMD_DISABLE_MENU, 'g\no\n50',
                sdk.CMD_DISABLE_MENU, 'g\nl\nL012ABCD.FWI', 'g\nl\nL012ABCD.FWI'])

        def test_physical_navigation_invalidates_without_sending_then_resets_once(self):
            self.paint()
            self.paint()
            before = list(self.wire.calls)
            self.serial.invalidate_display()
            self.serial.invalidate_display()
            self.assertEqual(self.wire.calls, before)
            self.paint()
            self.paint()
            self.assertEqual(self.wire.calls[len(before):], [sdk.CMD_DISABLE_MENU,
                'g\nl\nL012ABCD.FWI', 'g\nl\nL012ABCD.FWI'])

        def test_error_response_invalidates_fast_path(self):
            self.paint()
            self.wire.next_image_error = True
            self.assertTrue(self.serial.show_gui_image('L7654321.FWI').is_err())
            self.paint()
            self.assertEqual(self.wire.calls, [sdk.CMD_DISABLE_MENU, 'g\nl\nL012ABCD.FWI',
                'g\nl\nL7654321.FWI', sdk.CMD_DISABLE_MENU, 'g\nl\nL012ABCD.FWI'])

        def test_transport_exception_invalidates_fast_path(self):
            self.paint()
            self.wire.next_image_exception = True
            with self.assertRaises(OSError):
                self.serial.show_gui_image('L7654321.FWI')
            self.paint()
            self.assertEqual(self.wire.calls[-2:], [sdk.CMD_DISABLE_MENU, 'g\nl\nL012ABCD.FWI'])

        def test_closed_and_reopened_port_requires_first_image_reset_again(self):
            self.paint()
            self.serial.close(restore_menu=False)
            self.assertFalse(self.wire.is_open())
            self.paint()
            self.assertEqual(self.wire.open_count, 2)
            self.assertEqual(self.wire.calls.count(sdk.CMD_DISABLE_MENU), 2)

        def test_lost_connection_invalidates_even_without_explicit_close(self):
            self.paint()
            self.wire.connected = False
            self.paint()
            self.assertEqual(self.wire.open_count, 2)
            self.assertEqual(self.wire.calls[-2:], [sdk.CMD_DISABLE_MENU, 'g\nl\nL012ABCD.FWI'])

        def test_other_menu_calls_and_text_display_do_not_borrow_image_fast_path(self):
            self.paint()
            self.serial._set_menu_enabled(True)
            self.paint()
            self.assertTrue(self.serial.show_text_display('Generated text.').is_ok())
            self.paint()
            self.assertEqual(self.wire.calls.count(sdk.CMD_DISABLE_MENU), 4)
            self.assertIn('g\np\nGenerated text.', self.wire.calls)

        def test_invalid_filenames_and_badge_never_contact_transport(self):
            for filename in ('/images/L012ABCD.FWI', '../L012ABCD.FWI', 'L012ABCD.FWI\nq',
                             'l012abcd.fwi', 'pip_boy.fwi', 'L012ABCD.WAV', None, 123):
                with self.subTest(filename=filename), self.assertRaises(ValueError):
                    self.serial.show_gui_image(filename)
            self.assertEqual(self.wire.calls, [])
            self.assertEqual(self.wire.open_count, 0)
            self.serial.is_badge = True
            with self.assertRaises(ValueError):
                self.serial.show_gui_image('L012ABCD.FWI')
            self.assertEqual(self.wire.calls, [])

else:
    class IsolatedSDKTests(unittest.TestCase):
        def test_actual_sdk_wire_contract_in_isolated_interpreter(self):
            root = pathlib.Path(__file__).resolve().parents[2]
            runtime = root / 'output/freewili-runtime/bin/python'
            if not runtime.is_file():
                self.skipTest('Installed stock SDK runtime unavailable; run setup:freewili before SDK wire checks.')
            result = subprocess.run([str(runtime), str(pathlib.Path(__file__).resolve())],
                env={'PATH': '/usr/bin:/bin', 'PYFW_LOG_LEVEL': 'error', 'LIFELINE_DISPLAY_TEST_CHILD': '1'},
                cwd=root, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('Ran 9 tests', result.stderr)


if __name__ == '__main__':
    unittest.main()
