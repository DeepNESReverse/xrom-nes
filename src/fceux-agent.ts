/**
 * npm run fceux-agent -- <rom.nes> [<rom.nes>…] [--minutes 10] [--collect]
 *
 * The FCEUX agent with nobody at the controls: for each ROM, FCEUX is started with the probe
 * (`--loadlua fceux/nes_music_probe.lua`) and NES_AGENT_AUTO=1. The probe presses Start until
 * a song starts, the agent it launches finds the driver's entry and argument and goes through
 * every song, then tells the probe to stop, and the probe closes FCEUX. A ROM that has not
 * finished in `--minutes` is stopped by force — its session is still on disk, and says how far
 * it got.
 *
 * What it prints is tracks.json's verdict per ROM. `--collect` then builds the notes from the
 * session — the cartridge's driver on the dump, every song checked against FCEUX — into
 * <session>/collection, sounds under 1.5 s left out as effects; moving them into the workshop
 * (`npm run nsf -- --session … --slug …`) is a step of its own, with names and order.
 *
 * FCEUX is looked for in $FCEUX, then Homebrew's places. Its window opens and closes by itself,
 * the sound at volume 0.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(HERE, '..', 'fceux', 'nes_music_probe.lua');
const SESSIONS = resolve(HERE, '..', 'fceux', 'sessions');

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const roms = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const minutes = Number(opt('minutes') ?? 10);
if (roms.length === 0) {
  console.error('usage: npm run fceux-agent -- <rom.nes> [<rom.nes>…] [--minutes 10]');
  process.exit(1);
}

function fceuxBinary(): string {
  const candidates = [process.env.FCEUX ?? ''];
  for (const cellar of ['/usr/local/Cellar/fceux', '/opt/homebrew/Cellar/fceux']) {
    if (!existsSync(cellar)) continue;
    for (const version of readdirSync(cellar).sort().reverse()) candidates.push(join(cellar, version, 'libexec', 'fceux'));
  }
  candidates.push('/usr/local/bin/fceux', '/opt/homebrew/bin/fceux');
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('FCEUX not found: set FCEUX=<path to the fceux binary>');
  return found;
}

/** This ROM's session folders under fceux/sessions, newest first, with when they were made.
 *  Other ROMs' folders (another FCEUX may be recording) and stray files are passed over. */
function sessions(rom: string): { dir: string; made: number }[] {
  if (!existsSync(SESSIONS)) return [];
  // Named as the probe names it (nes_music_probe.lua: safe()).
  const prefix = basename(rom).replace(/\.nes$/i, '').replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '') + '-';
  const isDir = (path: string) => statSync(path).isDirectory();
  return readdirSync(SESSIONS)
    .filter((name) => name.startsWith(prefix) && isDir(join(SESSIONS, name)))
    .flatMap((name) => readdirSync(join(SESSIONS, name)).map((stamp) => join(SESSIONS, name, stamp)))
    .filter(isDir)
    .map((dir) => ({ dir, made: statSync(dir).mtimeMs }))
    .sort((a, b) => b.made - a.made);
}

function run(rom: string, resume?: string): Promise<{ code: number | null; forced: boolean }> {
  return new Promise((done) => {
    const child = spawn(fceuxBinary(), ['--volume', '0', '--loadlua', PROBE, rom], {
      env: { ...process.env, NES_AGENT_AUTO: '1', ...(resume ? { NES_AGENT_RESUME: resume } : {}) },
      stdio: 'ignore',
    });
    let forced = false;
    // FCEUX may not answer a polite SIGTERM — a window left behind was found an hour later.
    const timer = setTimeout(() => {
      forced = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, minutes * 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ code, forced });
    });
  });
}

const hex = (v: unknown) => String(v);

for (const romPath of roms) {
  const rom = resolve(romPath);
  if (!existsSync(rom)) {
    console.log(`${romPath}: no such file`);
    continue;
  }
  const started = Date.now();
  console.log(`\n${basename(rom)}: FCEUX started (up to ${minutes} min)`);
  let { code, forced } = await run(rom);
  let session = sessions(rom).find((s) => s.made >= started - 5_000);
  // FCEUX gone in the middle of the songs (a value that crashes it): again, from where it was.
  for (let restart = 1; restart <= 5 && session && !forced && !existsSync(join(session.dir, 'tracks.json')) && existsSync(join(session.dir, 'progress.json')); restart++) {
    const before = session.dir;
    console.log(`  FCEUX stopped half-way (${basename(before)}): starting it again, carrying on`);
    const again = Date.now();
    ({ code, forced } = await run(rom, before));
    session = sessions(rom).find((s) => s.made >= again - 5_000) ?? session;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (!session) {
    console.log(`  no session recorded (FCEUX exit ${code}, ${seconds} s)`);
    continue;
  }
  console.log(`  ${forced ? 'STOPPED after the time limit' : 'finished'} in ${seconds} s — ${session.dir}`);
  const tracksFile = join(session.dir, 'tracks.json');
  if (!existsSync(tracksFile)) {
    const log = existsSync(join(session.dir, 'agent.log')) ? readFileSync(join(session.dir, 'agent.log'), 'utf8').trim().split('\n').slice(-3).join('\n    ') : 'no agent.log';
    console.log(`  no tracks.json; the agent's last words:\n    ${log}`);
    continue;
  }
  const t = JSON.parse(readFileSync(tracksFile, 'utf8'));
  if (t.error) {
    console.log(`  agent stopped: ${t.error}`);
    continue;
  }
  const tries = (t.tries ?? []) as { value: string; kind: string; same?: string }[];
  const songs = tries.filter((r) => r.kind.startsWith('new song'));
  const how = t.argument?.mailbox
    ? `RAM $${t.argument.mailbox.addr.toString(16).toUpperCase()} (request ${t.argument.mailbox.nth}) picked up at ${hex(t.argument?.entry)}`
    : `entry ${hex(t.argument?.entry)} register ${String(t.argument?.reg).toUpperCase()}`;
  console.log(
    `  ${how}, replay ${t.exact ? 'exact' : 'NOT exact'}, ` +
      `tables: ${t.tables?.songs ?? 'not found'} songs; ${songs.length} different songs: ${songs.map((r) => r.value).join(' ')}`
  );
  const other = tries.filter((r) => !r.kind.startsWith('new song'));
  if (other.length) console.log(`  the rest: ${other.map((r) => `${r.value} ${r.kind}${r.same ? ' ' + r.same : ''}`).join(', ')}`);
  if (args.includes('--collect')) {
    const out = join(session.dir, 'collection');
    const title = basename(rom).replace(/\.nes$/i, '').replace(/\s*\(.*$/, '');
    console.log(`  collecting into ${out}`);
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', join(HERE, 'nsf-cli.ts'), '--session', session.dir, '--rom', rom, '--title', title, '--out', out, '--min-seconds', '1.5'],
      { encoding: 'utf8' }
    );
    for (const line of (run.stdout + run.stderr).split('\n')) if (/^(song|  \$|INIT|→|Error)/.test(line)) console.log('    ' + line);
  }
}
