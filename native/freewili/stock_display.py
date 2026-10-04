"""Keep consecutive OG image frames from re-entering the stock menu.

The manufacturer's SDK sends Ctrl-B before every decorated command. That is
a parser reset, even when the menu is already disabled. On the connected OG
v54, consecutive g/l/filename image commands were independently acknowledged
without repeating Ctrl-B. Limit that fast path to consecutive successful image
calls; any other SDK command, error, or reopened connection resynchronizes it.
"""
import re

from freewili.fw_serial import FreeWiliSerial


class StockDisplaySerial(FreeWiliSerial):
    def __init__(self, *args, **kwargs):
        self._painting_image = False
        self._consecutive_image = False
        super().__init__(*args, **kwargs)

    def open(self, *args, **kwargs):
        if not self.is_open():
            self._consecutive_image = False
        return super().open(*args, **kwargs)

    def close(self, *args, **kwargs):
        self._consecutive_image = False
        return super().close(*args, **kwargs)

    def invalidate_display(self):
        # A physical button can navigate the firmware menu without an SDK
        # command. Resynchronize the next paint once; do not send from callbacks.
        self._consecutive_image = False

    def _set_menu_enabled(self, enabled):
        if self._painting_image and not enabled and self._consecutive_image:
            return
        self._consecutive_image = False
        return super()._set_menu_enabled(enabled)

    def show_gui_image(self, filename):
        # Only our content-addressed basenames enter this OG-only fast path.
        if not isinstance(filename, str) or not re.fullmatch(r'L[0-9A-F]{7}\.FWI', filename):
            raise ValueError('Expected a LIFELINE image basename.')
        if self.is_badge:
            raise ValueError('The consecutive image path is verified only for OG.')
        self._painting_image = True
        try:
            result = super().show_gui_image(filename)
            self._consecutive_image = result is not None and not result.is_err()
            return result
        except Exception:
            self._consecutive_image = False
            raise
        finally:
            self._painting_image = False
