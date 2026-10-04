"""Silent volume configuration verifies independent readback before playback."""
import types
import unittest
from queue import Queue
from unittest.mock import patch

from stock_volume import set_speaker_volume


class MenuDouble:
    def __init__(self, readback='Speaker Volume [5]'):
        self.calls = []
        self.readback = readback
        self.serial_port = types.SimpleNamespace(send=self.send, data_queue=Queue())

    def send(self, value):
        self.calls.append(('send', value))
        if value == 'z\ng\n' and self.readback is not None:
            # Real USB can split in the middle of the volume label or number.
            for part in (self.readback[:8], self.readback[8:17], self.readback[17:]):
                self.serial_port.data_queue.put(part.encode('ascii'))

    def _set_menu_enabled(self, enabled):
        self.calls.append(('menu', enabled))

    def _empty_data_queue(self):
        self.calls.append(('clear-data',))

    def _empty_all(self):
        self.calls.append(('clear-all',))

class VolumeTests(unittest.TestCase):
    def test_independent_readback_and_silent_cleanup(self):
        serial = MenuDouble()
        with patch('stock_volume.time.sleep'):
            self.assertEqual(set_speaker_volume(serial, 5), 5)
        self.assertEqual([c for c in serial.calls if c[0] == 'send'],
                         [('send', 'z\ng\nv\n5\n'), ('send', 'z\ng\n')])
        self.assertEqual(serial.calls[-2:], [('menu', False), ('clear-all',)])

    def test_missing_or_wrong_readback_fails_and_disables_menu(self):
        for readback in (None, 'Speaker Volume [10]'):
            with self.subTest(readback=readback):
                serial = MenuDouble(readback)
                with patch('stock_volume.time.sleep'), patch('stock_volume.READBACK_TIMEOUT', .01), self.assertRaises(RuntimeError):
                    set_speaker_volume(serial, 5)
                self.assertEqual(serial.calls[-2:], [('menu', False), ('clear-all',)])

    def test_invalid_volume_never_contacts_hardware(self):
        for volume in (True, -1, 11, 5.5, '5'):
            serial = MenuDouble()
            with self.assertRaises(ValueError):
                set_speaker_volume(serial, volume)
            self.assertEqual(serial.calls, [])


if __name__ == '__main__':
    unittest.main()
