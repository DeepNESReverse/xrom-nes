/**
 * npm run agent -- <session dir> [--workshop <slug>]
 *
 * Stage 2 of the NES music agent: listens to a session the FCEUX probe recorded and writes
 * what it heard into <session>/analysis/:
 *
 *   summary.json   the pieces found — where each starts and why, its loop, its grid, which
 *                  code writes music and which writes effects, how many notes of each
 *   notes.csv      every note, music and effect, with the code addresses that struck it
 *   journal.csv    where FCEUX hears a channel and no note was decoded, and the reverse,
 *   journal.json   with the registers as they stood and a reason
 *   collection/    the music's notes, one track a piece, in the workshop's format
 *
 * --workshop <slug> also writes the collection to battletoads-tools-next/public/tracks/<slug>.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSession } from './probe/session.ts';
import { clockOf, listen, segmentsOf, sourcesOf } from './agent/listen.ts';
import { writeCollection } from './collection.ts';
import { detectGrid } from './grid.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!dir) {
  console.error('usage: npm run agent -- <session dir> [--workshop <slug>]');
  process.exit(1);
}

const hex = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
const session = readSession(dir);
const clock = clockOf(session);
const segments = segmentsOf(session);
const sources = sourcesOf(session);
const out = join(dir, 'analysis');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const romFile = String((session.meta.rom as { file?: string })?.file ?? 'rom');
console.log(`${romFile}: ${session.frames.length} frames, ${segments.length} pieces`);
console.log('sources:');
for (const g of sources.groups) console.log(`  ${g.role.padEnd(11)} ${String(g.windows).padStart(4)} half-seconds  ${g.pcs.map((pc) => `$${hex(pc, 4)}`).join(' ')}`);
const every = [...sources.role].filter(([, r]) => r === 'every frame').map(([pc]) => `$${hex(pc, 4)}`);
console.log(`  every frame  ${every.join(' ')}\n`);

const summary: unknown[] = [];
const noteRows = ['segment,source,channel,start,duration,midi,pitch,volume,volumeEnd,pcs'];
const journalRows = ['segment,kind,channel,start,frames,frequency,midi,registers,reason,confidence'];
const journalAll: unknown[] = [];
const collections = [join(out, 'collection'), ...(opt('workshop') ? [join('/Users/alex.m/battletoads_mega_hack copy/battletoads-tools-next/public/tracks', opt('workshop')!, 'notes')] : [])];

for (const seg of segments) {
  const heard = listen(session, clock, seg, sources);
  const music = heard.notes.filter((n) => n.source === 'music');
  const effects = heard.notes.filter((n) => n.source === 'effect');
  const perTrack = (list: typeof heard.notes) => ['pulse1', 'pulse2', 'triangle', 'noise'].map((t) => list.filter((n) => n.track === t).length).join('/');
  const lost = heard.journal.filter((j) => j.kind === 'heard, no note');
  const madeUp = heard.journal.filter((j) => j.kind === 'note, not heard');

  console.log(
    `#${seg.index}  frames ${seg.from}-${seg.to}  ${heard.seconds.toFixed(1)} s  ${seg.cause}${seg.startPc !== undefined ? ` at $${hex(seg.startPc, 4)}` : ''}\n` +
      `    music ${music.length} notes (P1/P2/TR/NS ${perTrack(music)}), effects ${effects.length} (${perTrack(effects)})\n` +
      `    loop ${
        heard.loop
          ? `${heard.loop.start.toFixed(2)} s + ${heard.loop.seconds.toFixed(2)} s${heard.loop.exact ? '' : ' (by notes)'}`
          : heard.near
            ? `none exact; repeats every ${heard.near.frames} frames (${heard.near.seconds.toFixed(2)} s) for ${Math.round(heard.near.match * 100)}% of notes${heard.near.differing.length ? `, differs on passes ${heard.near.differing.join(', ')}` : ''}`
            : 'none within the recording'
      }` +
      `    grid ${heard.grid ? `sixteenth ${heard.grid.sixteenthFrames}f, ♩ ${heard.grid.bpm.toFixed(1)}` : '—'}\n` +
      `    journal: ${lost.length} heard with no note (${lost.filter((j) => j.confidence === 'high').length} high), ${madeUp.length} notes not heard` +
      (heard.ultrasonic.some((n) => n > 0) ? `; ultrasonic frames ignored P1/P2/TR/NS ${heard.ultrasonic.slice(0, 4).join('/')}` : '')
  );
  for (const j of lost.filter((x) => x.confidence === 'high').slice(0, 5)) {
    console.log(`      ${j.channel} at ${j.start.toFixed(2)} s, ${j.frames} frames, ${j.frequency.toFixed(0)} Hz (MIDI ${j.midi}), regs ${j.registers}: ${j.reason}`);
  }
  console.log('');

  summary.push({
    index: seg.index,
    from: seg.from,
    to: seg.to,
    seconds: Number(heard.seconds.toFixed(3)),
    cause: seg.cause,
    startPc: seg.startPc,
    musicNotes: music.length,
    effectNotes: effects.length,
    loop: heard.loop,
    nearLoop: heard.near,
    grid: heard.grid,
    journal: { heardNoNote: lost.length, noteNotHeard: madeUp.length },
    ultrasonicFrames: heard.ultrasonic,
  });
  for (const n of heard.notes) {
    noteRows.push([seg.index, n.source, n.track, n.start.toFixed(4), n.duration.toFixed(4), n.midi, n.pitch.toFixed(2), n.volume, n.volumeEnd, n.pcs.map((pc) => `$${hex(pc, 4)}`).join(' ')].join(','));
  }
  for (const j of heard.journal) {
    journalRows.push([j.segment, `"${j.kind}"`, j.channel, j.start.toFixed(3), j.frames, j.frequency.toFixed(1), j.midi, j.registers, `"${j.reason}"`, j.confidence].join(','));
    journalAll.push(j);
  }

  if (music.length > 0) {
    const grid = heard.grid ?? detectGrid(music, clock.frameHz);
    for (const target of collections) {
      writeCollection(
        target,
        {
          id: seg.index,
          slug: `${String(seg.index).padStart(2, '0')}_piece`,
          name: `${romFile} — piece ${seg.index} (${heard.seconds.toFixed(0)} s)`,
          reading: {},
          source: `${romFile}, recorded in FCEUX by nes_music_probe.lua and listened to by the agent`,
        },
        music,
        heard.seconds,
        grid,
        clock.frameHz,
        undefined,
        heard.loop ? { start: heard.loop.start, seconds: heard.loop.seconds } : null
      );
    }
  }
}

writeFileSync(
  join(out, 'summary.json'),
  JSON.stringify({ rom: session.meta.rom, region: session.meta.region, frames: session.frames.length, sources: sources.groups.map((g) => ({ ...g, pcs: g.pcs.map((pc) => `$${hex(pc, 4)}`) })), pieces: summary }, null, 1)
);
writeFileSync(join(out, 'notes.csv'), noteRows.join('\n') + '\n');
writeFileSync(join(out, 'journal.csv'), journalRows.join('\n') + '\n');
writeFileSync(join(out, 'journal.json'), JSON.stringify(journalAll, null, 1));
console.log(`→ ${out}${opt('workshop') ? ` and the workshop's tracks/${opt('workshop')}` : ''}`);
