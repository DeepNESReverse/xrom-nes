/**
 * npm run complexity -- [--nsf-dir <dir>] [--jobs 8] [--seconds 60] [--rank-only]
 *
 * Every soundtrack of an NSF library ranked from simple to complex (see
 * metrics.ts for what "complex" means here and how the weights were set).
 *
 * 1. One NSF per game: folders are named `Title (year)(composer - publisher)…`;
 *    the rip without effects is preferred, then one that is not an alternate
 *    ([a]) or headerless.
 * 2. Each is scanned by `scan.ts` into the cache, eight at a time, unless its
 *    file is already there — so a re-run after adding NSFs scans only the new ones.
 * 3. Homebrew, covers and unidentified rips are dropped, rips that decode to the
 *    same notes are merged, and the rest is ranked into
 *    - `<library>/complexity-rank.tsv` (rank first, for reading and grepping) and
 *    - the workshop's `public/music-complexity.json` (the /music/complexity page).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JINGLE_LIMITS, METRICS, gameScore, median, normalOf, songMetrics, songScore, type ScanRow, type SongLimits, type SongMetrics } from './metrics.ts';

const WORKSHOP = '/Users/alex.m/battletoads_mega_hack copy';
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const nsfDir = opt('nsf-dir') ?? join(WORKSHOP, 'nsf_for_test/nsf');
const library = dirname(nsfDir);
const cache = opt('cache') ?? join(library, 'complexity-cache');
const jobs = Number(opt('jobs') ?? 8);
const seconds = Number(opt('seconds') ?? 60);
const tsvPath = opt('tsv') ?? join(library, 'complexity-rank.tsv');
const jsonPath = opt('json') ?? join(WORKSHOP, 'battletoads-tools-next/public/music-complexity.json');

/** Not a licensed game: homebrew and demo authors, covers, rips nobody identified. */
const NOT_A_GAME = /Mankeli|Joey Parsell|Phlumb-Dumb|Memblers|Damian Yerrick|Andrew Coppess|Doppelganger|Angelo|Forrest Harding|Lasse Oorni|\[Original|ZZZ_UNK|Covers/;

const titleOf = (folder: string) =>
  folder
    .split(/ \(\d{4}|\s\(19xx|\s\(198x/)[0]
    .replace(/\s*\(Zophar\)$/, '')
    .trim();

function pickNsfs(): string[] {
  const best = new Map<string, { penalty: number; path: string }>();
  for (const folder of readdirSync(nsfDir).sort()) {
    const dir = join(nsfDir, folder);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.nsf') && !f.includes('driver restored'));
    if (!files.length) continue;
    const file = files.sort((a, b) => a.length - b.length)[0];
    const penalty = (folder.includes('With SFX') ? 4 : 0) + (folder.includes('[a]') ? 2 : 0) + (folder.includes('NO HEADER') ? 1 : 0);
    const title = titleOf(folder);
    const had = best.get(title);
    if (!had || penalty < had.penalty) best.set(title, { penalty, path: join(dir, file) });
  }
  return [...best.values()].map((b) => b.path);
}

/** The cache file of one NSF: the md5 of its path (as `echo path | md5` gives it, so older caches still match). */
const cacheOf = (path: string) => join(cache, createHash('md5').update(`${path}\n`).digest('hex') + '.jsonl');

async function scanAll(paths: string[]) {
  mkdirSync(cache, { recursive: true });
  const todo = paths.filter((p) => !existsSync(cacheOf(p)));
  console.log(`${paths.length} games, ${paths.length - todo.length} already scanned, ${todo.length} to scan`);
  const worker = join(dirname(fileURLToPath(import.meta.url)), 'scan.ts');
  let next = 0;
  let done = 0;
  const run = async () => {
    while (next < todo.length) {
      const path = todo[next++];
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', worker, path, cacheOf(path), String(seconds)], { stdio: 'ignore' });
        // A driver that never returns a frame would hold its slot forever.
        const timer = setTimeout(() => child.kill('SIGKILL'), 400_000);
        child.on('exit', () => {
          clearTimeout(timer);
          done++;
          if (done % 25 === 0 || done === todo.length) console.log(`  scanned ${done}/${todo.length}`);
          resolve();
        });
      });
    }
  };
  await Promise.all(Array.from({ length: jobs }, run));
}

interface GameRow {
  rank: number;
  score: number;
  title: string;
  year: string;
  who: string;
  nsf: string;
  songs: number;
  /** The NSF song number that scored highest — the one to listen to first. */
  busiest: number;
  expansion: string[];
  median: SongMetrics;
  /**
   * Which songs were measured: `listed` — the music a careful pass named in the `names.m3u` beside the
   * NSF, sound effects left out; `by length` — every song of 15 s or more; `jingles` — listed music
   * that is all shorter than that (Battle City), measured anyway and not quite comparable.
   */
  music: 'listed' | 'by length' | 'jingles';
}

/**
 * The songs of an NSF a careful pass named as music (`file::NSF,<song>,<name>` lines of the
 * `names.m3u` beside it, for this very file), or null when there is no such list.
 */
function musicOf(path: string): Set<number> | null {
  const m3u = join(dirname(path), 'names.m3u');
  if (!existsSync(m3u)) return null;
  const file = basename(path);
  const songs = new Set<number>();
  for (const line of readFileSync(m3u, 'utf8').split('\n')) {
    const at = line.indexOf('::NSF,');
    if (at < 0 || line.slice(0, at) !== file) continue;
    const song = Number(line.slice(at + 6).split(',')[0]);
    if (Number.isInteger(song)) songs.add(song);
  }
  return songs.size ? songs : null;
}

function rank(paths: string[]): GameRow[] {
  const games: { folder: string; nsf: string; expansion: string[]; songs: (SongMetrics & { song: number })[]; music: GameRow['music'] }[] = [];
  // A Zophar copy duplicates a rip already in the library; met second, it is the one merged away.
  const ordered = [...paths].sort((a, b) => Number(a.includes('(Zophar)')) - Number(b.includes('(Zophar)')));
  for (const path of ordered) {
    const folder = basename(dirname(path));
    if (NOT_A_GAME.test(folder) || !existsSync(cacheOf(path))) continue;
    const music = musicOf(path);
    const scans: { song: number; rows: ScanRow[] }[] = [];
    let expansion: string[] = [];
    for (const line of readFileSync(cacheOf(path), 'utf8').split('\n')) {
      if (!line) continue;
      const j = JSON.parse(line) as { song: number; rows?: ScanRow[]; expansion?: string[] };
      if (!j.rows) continue;
      expansion = j.expansion ?? [];
      if (!music || music.has(j.song)) scans.push({ song: j.song, rows: j.rows });
    }
    const measure = (limits?: SongLimits) =>
      scans.flatMap(({ song, rows }) => {
        const m = songMetrics(rows, 60, limits);
        return m ? [{ ...m, song }] : [];
      });
    let songs = measure();
    let kind: GameRow['music'] = music ? 'listed' : 'by length';
    // A game whose music is all jingles is measured on its jingles, never on its sound effects. Seconds
    // of music do not repeat, so the per-second measures run high: the rank is a rough one.
    if (!songs.length && music) [songs, kind] = [measure(JINGLE_LIMITS), 'jingles'];
    if (songs.length) games.push({ folder, nsf: basename(path), expansion, songs, music: kind });
  }
  const normal = normalOf(games.flatMap((g) => g.songs));
  const seen = new Set<string>();
  const rows: Omit<GameRow, 'rank'>[] = [];
  for (const g of games) {
    const scored = g.songs.map((s) => ({ s, score: songScore(s, normal) }));
    const score = gameScore(scored.map((x) => x.score));
    // Two folders of one rip (a Zophar copy, a second spelling of the title) decode to the same notes.
    const sig = score.toFixed(6);
    if (seen.has(sig)) continue;
    seen.add(sig);
    const med = {} as SongMetrics;
    for (const k of METRICS) med[k] = median(g.songs.map((s) => s[k]));
    rows.push({
      score,
      title: titleOf(g.folder),
      year: /\((\d{4}|19xx|198x)\)/.exec(g.folder)?.[1] ?? '?',
      who: /\((?:\d{4}|19xx|198x)\)\(([^)]*)\)/.exec(g.folder)?.[1] ?? '',
      nsf: g.nsf,
      songs: g.songs.length,
      busiest: scored.reduce((a, b) => (b.score > a.score ? b : a)).s.song,
      expansion: g.expansion,
      median: med,
      music: g.music,
    });
  }
  return rows.sort((a, b) => a.score - b.score).map((r, i) => ({ rank: i + 1, ...r }));
}

const paths = pickNsfs();
if (!args.includes('--rank-only')) await scanAll(paths);
const rows = rank(paths);

const header = ['rank', 'score', 'game', 'year', 'composer / developer', 'songs', 'busiest song', ...METRICS, 'expansion (not heard)'];
writeFileSync(
  tsvPath,
  '# NES soundtracks, simple to complex: frame-exact notes off the chip, first 60 s of each song of 15 s or more;\n' +
    '# a game is the mean of its busier half of songs. Weights and caveats: xrom-libs/nes/src/complexity/metrics.ts.\n' +
    header.join('\t') +
    '\n' +
    rows
      .map((r) => [r.rank, r.score.toFixed(2), r.title, r.year, r.who, r.songs, r.busiest, ...METRICS.map((k) => r.median[k].toFixed(2)), r.expansion.join(',')].join('\t'))
      .join('\n') +
    '\n',
);
writeFileSync(jsonPath, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), seconds, metrics: METRICS, games: rows }));
console.log(`${rows.length} games ranked → ${tsvPath}\n                     → ${jsonPath}`);
