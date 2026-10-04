import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

/** On-demand recovery only; never kills a process or installs a restarting job. */
export async function recoverWili(port = '/dev/cu.usbmodem1201'): Promise<'started' | 'running' | 'unplugged'> {
  if (!/^\/dev\/cu\.usbmodem[\w.-]+$/.test(port)) throw new Error('Select the verified WILi DISPLAY port.');
  try { if (!(await stat(port)).isCharacterDevice()) return 'unplugged'; } catch { return 'unplugged'; }
  try {
    const pid = Number((await readFile('data/wili-bridge.pid', 'utf8')).trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']);
      if (stdout.includes('native/freewili/stock-bridge.ts')) return 'running';
    }
  } catch { /* A dead bridge's PID is expected after its bounded recovery expires. */ }
  const log = await open('data/wili-bridge.log', 'a', 0o600);
  try {
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'native/freewili/stock-bridge.ts',
      '--port', port, '--reconnect'], { cwd: resolve('.'), detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', reject); });
    await writeFile('data/wili-bridge.pid', `${child.pid}\n`, { mode: 0o600 });
    child.unref(); return 'started';
  } finally { await log.close(); }
}
