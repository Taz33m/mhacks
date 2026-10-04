"""Verified OG v54 speaker setting; never plays a test sound."""
import re
import time
from queue import Empty

READBACK_TIMEOUT = 2.0


def set_speaker_volume(serial, volume):
    if isinstance(volume, bool) or not isinstance(volume, int) or not 0 <= volume <= 10:
        raise ValueError('Speaker volume must be an integer from 0 to 10.')
    try:
        serial._set_menu_enabled(True)
        serial._empty_data_queue()
        serial.serial_port.send(f'z\ng\nv\n{volume}\n')
        # Allow the stock menu to finish before requesting an independent readback.
        time.sleep(.3)
        serial._empty_data_queue()
        serial.serial_port.send('z\ng\n')
        # SDK _wait_for_data searches each USB chunk separately. Menu lines
        # can span chunks, so collect a bounded response before matching.
        deadline = time.monotonic() + READBACK_TIMEOUT
        response = ''
        match = None
        while time.monotonic() < deadline:
            try:
                response += serial.serial_port.data_queue.get(timeout=.05).decode('ascii', errors='ignore')
            except Empty:
                continue
            if len(response) > 16384:
                raise RuntimeError('Speaker volume response exceeded its limit.')
            match = re.search(r'Speaker Volume \[(\d{1,2})\]', response)
            if match:
                break
        if match is None:
            raise RuntimeError('Speaker volume readback unavailable.')
        actual = int(match.group(1))
        if actual != volume:
            raise RuntimeError('Speaker volume did not match the requested setting.')
        return actual
    finally:
        serial._set_menu_enabled(False)
        serial._empty_all()
