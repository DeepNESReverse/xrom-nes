-- A game's whole screen as it is played, frame by frame — sprites, both nametables and where the
-- camera is — for animations of a game that scrolls. Load it in FCEUX and play:
--
--   fceux --loadlua fceux/record_screen.lua "<rom.nes>"
--
-- Every frame writes one line to sessions/<rom name>.screen.txt:
--
--   <frame> <camera page> <camera x> <sprite page hex> <32 palette bytes hex> <$2000 hex or -> <$2400 hex or ->
--
-- `record_sprites.lua` keeps $2000 alone and no scroll: under a level that scrolls its sprites
-- drifted off a background that stood still (Super Mario Bros.' flag, Mario inside a wall). Here
-- each nametable is written where it changed since the line before, and the camera is the game's
-- own: the page and the pixel of the screen's left edge in the level (Super Mario Bros.: $071A and
-- $071C — set CAMERA_PAGE / CAMERA_X for another game). With vertical mirroring, level column w
-- is column w % 32 of nametable (w / 32) % 2.

local OAM_PAGE = 0x0200
local CAMERA_PAGE = 0x071A
local CAMERA_X = 0x071C

local here = debug.getinfo(1, 'S').source:match('^@(.*/)') or './'
local rom = (rom and rom.getfilename and rom.getfilename()) or 'game'
local name = rom:match('([^/\\]+)$') or rom
name = name:gsub('%.nes$', '')
local path = here .. 'sessions/' .. name .. '.screen.txt'
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

local function nametable(base)
  local parts = {}
  for i = 0, 0x3FF do parts[i + 1] = string.format('%02x', ppu.readbyte(base + i)) end
  return table.concat(parts)
end

local frames = 0
local last0, last1
while true do
  local oam = memory.readbyterange(OAM_PAGE, 256)
  local nt0 = nametable(0x2000)
  local nt1 = nametable(0x2400)
  out:write(string.format('%d %d %d %s %s %s %s\n', emu.framecount(), memory.readbyte(CAMERA_PAGE),
    memory.readbyte(CAMERA_X), hex(oam), palette(), nt0 == last0 and '-' or nt0,
    nt1 == last1 and '-' or nt1))
  last0, last1 = nt0, nt1
  frames = frames + 1
  if frames % 60 == 0 then out:flush() end
  gui.text(4, 4, string.format('REC %ds  camera %d:%d', math.floor(frames / 60),
    memory.readbyte(CAMERA_PAGE), memory.readbyte(CAMERA_X)))
  emu.frameadvance()
end
