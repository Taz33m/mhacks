"""Foreground POSIX serial byte transport; no pyserial install or protocol emulation."""
import argparse
import fcntl
import os
import select
import signal
import stat
import struct
import sys
import termios
import tty

LIMIT = 65536


def relay(port):
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    saved = None
    modem = None
    stdout_flags = fcntl.fcntl(1, fcntl.F_GETFL)
    try:
        if not stat.S_ISCHR(os.fstat(fd).st_mode):
            raise ValueError("Serial port must be a character device.")
        saved = termios.tcgetattr(fd)
        modem = fcntl.ioctl(fd, termios.TIOCMGET, struct.pack("I", 0))
        tty.setraw(fd, termios.TCSANOW)
        settings = termios.tcgetattr(fd)
        settings[2] |= termios.CLOCAL | termios.CREAD
        settings[4] = settings[5] = termios.B115200
        termios.tcsetattr(fd, termios.TCSANOW, settings)
        fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack("I", termios.TIOCM_DTR))
        fcntl.fcntl(1, fcntl.F_SETFL, stdout_flags | os.O_NONBLOCK)
        to_host, to_device = bytearray(), bytearray()
        while True:
            readers = ([0] if len(to_device) < LIMIT else []) + ([fd] if len(to_host) < LIMIT else [])
            writers = ([1] if to_host else []) + ([fd] if to_device else [])
            ready_read, ready_write, _ = select.select(readers, writers, [], .25)
            for source in ready_read:
                target = to_device if source == 0 else to_host
                try:
                    chunk = os.read(source, min(4096, LIMIT - len(target)))
                except BlockingIOError:
                    continue
                if not chunk:
                    return
                target.extend(chunk)
            for destination in ready_write:
                pending = to_host if destination == 1 else to_device
                try:
                    count = os.write(destination, pending)
                    del pending[:count]
                except BlockingIOError:
                    pass
    finally:
        fcntl.fcntl(1, fcntl.F_SETFL, stdout_flags)
        if saved is not None:
            try:
                termios.tcsetattr(fd, termios.TCSANOW, saved)
            except (OSError, termios.error):
                pass
        if modem is not None:
            try:
                fcntl.ioctl(fd, termios.TIOCMSET, modem)
            except OSError:
                pass
        os.close(fd)


def stop(_signal, _frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    options = parser.parse_args()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        relay(options.port)
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, termios.error):
        print("Serial transport failed; check access, cable, and DTR support.", file=sys.stderr)
        sys.exit(1)
