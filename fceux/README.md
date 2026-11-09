# FCEUX probe — stage 1 of the NES music agent

`nes_music_probe.lua` records what a running cartridge does with the sound chip. It does
no analysis; the agent in this package (Node) reads what it records.

## Run

1. FCEUX → File → Open ROM (any game).
2. File → Lua → New Lua Script Window → Browse → `nes_music_probe.lua` → Run.
3. Leave it. Play, or let the title screen and demo run. A panel in the corner shows the
   frame, the writes, and each channel's activity (green = FCEUX hears it).
4. Stop the script (or close FCEUX) when done. Loading another ROM closes this session
   and opens one for the new ROM by itself.

Load the script before or after the ROM — it starts with the first frame of a loaded game.

## What it writes

`fceux/sessions/<rom>-<md5 prefix>/<date-time>/`:

- `events.log` — every write to `$4000-$4017` (frame, cycle in the frame, address, value,
  code address), every read of `$4015`, FCEUX's `sound.get()` after each frame, markers.
  Format: the header of the Lua script.
- `ram.bin` — the 2 KB of RAM after every frame (7 MB a minute; 30 minutes at most).
- `session.json` — ROM, region measured from cycles a frame, FCEUX features found, totals,
  why recording stopped.
- `commands.log` — empty; the agent appends commands here later (`mark`, `speed`, `stop`).

## The agent (stage 3)

If Node is installed (`/usr/local/bin/node`, `/opt/homebrew/bin/node`, or on FCEUX's PATH), the
probe starts `src/agent-live.ts` with the session. It waits for the game to start a song, then
replays that moment from a save state the probe kept, finds which call on the stack starts songs
and which register (A, X, Y) picks the song, and goes through every value at maximum speed,
four seconds each. The panel shows what it is doing; `agent.log` says it in full; the result is
`tracks.json` (the entry, the register, every value tried and what it played: a new song, one
heard before, silence). The game is left at normal speed when it is done.

## Check a session

```
npm run probe-check -- fceux/sessions/<rom>/<date-time> --rom <the same .nes>
```

Prints the totals, the code addresses that write each channel, how many frames FCEUX
hears each channel, and whether the writes line up with this package's own headless NES
running the same cartridge. Exit code 2 and a PROBLEMS list if anything is off.

## Whole songs from the cartridge (stage 3b)

```
npm run nsf -- --session fceux/sessions/<rom>/<date-time> --rom <the same .nes> --slug <name> \
  [--title "…"] [--names "04=Level 3;01=Title"]
```

The game cannot be left to play a song to its end, so each song the agent found is played away
from it: the probe's dump of the moment a song started, the driver's INIT with the song's number,
then PLAY once a frame — the ROM supplying the banks a driver switches to (checked by the MD5 the
probe recorded). PLAY is found, not given: among the routines the probe saw called each frame, the
one whose frames agree with FCEUX's. A song goes into the collection only if its first four
seconds agree with what the cartridge wrote in FCEUX during the agent's experiment, write for
write (lag frames of the game passed over); the others are listed with the frame they part on.

## Unattended (no one at FCEUX)

```
npm run fceux-agent -- <rom.nes> [<rom.nes>…] [--minutes 10] [--collect]
```

Starts FCEUX for each ROM with the probe (`--loadlua`, sound at volume 0) and
`NES_AGENT_AUTO=1`. The probe keeps a state from the first frame, presses Start until a song
starts, and quits FCEUX when the agent is done; the agent moves the game on by pressing Start
while it waits. A start whose calls change nothing but the sound's detail (under 60% of the
writes changed) is passed over for the next one. A driver that never writes `$4015` after
power-on (RoboCop) is found through its entry table: the rows of JMPs around the routines seen
called are hooked (`starthook`), and a call to one after 30 quiet frames is a song start.
`--collect` builds the notes into `<session>/collection`, sounds under 1.5 s left out as effects.

How a song is replayed away from the game: from the driver entry the game itself called (up the
chain from the argument's entry while the caller is driver code — Capcom's `$8003` around `$8106`,
whose "busy" flag only `$8003` clears), from a dump taken at that call
(`dumps/<start>-<ENTRY>.bin`), the song number put in the register where the argument's entry is
reached. It is collected when every write it makes is in FCEUX's experiment in the same order —
the game's own sounds between them allowed; a window ends where the game calls the entry itself.

A song asked for through RAM (Alien 3): when a start is several calls of the driver and the RAM
snapshots show a clear mailbox — a cell nearly always one value, something else for a frame, a
driver call the frame after — the agent tries that first: `try … ram:<addr>:<empty>:<nth> <value>`
writes the value the <nth> time the hooked entry finds the mailbox full, and the dump player pokes
it and calls the same routine (`dumps/<start>-<ENTRY>-ram.bin`). A register or mailbox counts as
the song selector only when two values give other music, and other music from each other.
