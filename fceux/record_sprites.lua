-- A game's sprites as it is played, frame by frame — for cutting out animations a bot cannot
-- reach (the goal of a stage, a boss). Load it in FCEUX and play:
--
--   fceux --loadlua fceux/record_sprites.lua "<rom.nes>"
--
-- Every frame writes one line to sessions/<rom name>.sprites.txt:
--
--   <frame> <ram $00> <ram $63> <sprite page, 256 bytes hex> <32 palette bytes hex> <nametable>
--
-- The nametable is the first one ($2000, 1 KB hex) where it changed since the line before, `-`
-- where it did not: what a game that draws its characters in the background shows of them (Yie
-- Ar Kung-Fu's fighters on the floor).
-- The sprite page is the RAM page the game copies to the PPU each frame ($4014 — Circus Charlie's
-- is $0200; set OAM_PAGE for another game). `$00` and `$63` are Circus Charlie's game phase and
-- stage, kept to find a passage in the take afterwards (phase 8 is a stage's bonus count).
-- `npm run fceux-sprites` turns the file into what `clips` reads.

local OAM_PAGE = 0x0200

local here = debug.getinfo(1, 'S').source:match('^@(.*/)') or './'
local rom = (rom and rom.getfilename and rom.getfilename()) or 'game'
local name = rom:match('([^/\\]+)$') or rom
name = name:gsub('%.nes$', '')
local path = here .. 'sessions/' .. name .. '.sprites.txt'
local out = assert(io.open(path, 'w'))

local function hex(bytes)
  local parts = {}
  for i = 1, #bytes do parts[i] = string.format('%02x', bytes:byte(i)) end
  return table.concat(parts)
end

local function palette()
  local parts = {}
  for i = 0, 31 do
    -- $3F10/$3F14/$3F18/$3F1C are $3F00/$3F04/… — read as what the PPU returns for them.
    local a = 0x3F00 + i
    if i % 4 == 0 and i >= 16 then a = a - 16 end
    parts[#parts + 1] = string.format('%02x', ppu.readbyte(a))
  end
  return table.concat(parts)
end

local function nametable()
  local parts = {}
  for i = 0, 0x3FF do parts[i + 1] = string.format('%02x', ppu.readbyte(0x2000 + i)) end
  return table.concat(parts)
end

local frames = 0
local last
while true do
  local oam = memory.readbyterange(OAM_PAGE, 256)
  local nt = nametable()
  out:write(string.format('%d %d %d %s %s %s\n', emu.framecount(), memory.readbyte(0x00),
    memory.readbyte(0x63), hex(oam), palette(), nt == last and '-' or nt))
  last = nt
  frames = frames + 1
  if frames % 60 == 0 then out:flush() end
  gui.text(4, 4, string.format('REC %ds  phase %d', math.floor(frames / 60), memory.readbyte(0x00)))
  emu.frameadvance()
end
