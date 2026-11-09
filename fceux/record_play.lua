-- A whole game as it is played, for replaying headless afterwards: what the player pressed and
-- what the game kept in RAM, frame by frame. Load it in FCEUX and play:
--
--   fceux --loadlua fceux/record_play.lua "<rom.nes>"
--
-- It powers the console on again first, so the take starts where the headless NES starts. Then
-- every frame writes to sessions/<rom name>-<date>-<time>.play.txt (a take of its own each run):
--
--   f <frame> <buttons> <lagged>         the frame, the pad (bit 0 A … bit 7 right), 1 if lagged
--   r <aaaavv…>                          the RAM bytes that changed since the frame before:
--                                        4 hex digits of address, 2 of value, one after another
--
-- The first frame's `r` line is the whole 2 KB. Replayed headless with the RAM laid over each
-- frame (`npm run replay`), the game stays in step with this one, and everything the PPU drew —
-- the levels, every enemy and boss, the CHR banks line by line — can be read back out of it.
--
-- Cheats are fine (infinite energy): they are RAM, and the take carries them. Loading a save state
-- or resetting is not: the headless NES cannot jump with them. Play straight through; to start
-- over, close FCEUX and run it again — that is a new take.

local here = debug.getinfo(1, 'S').source:match('^@(.*/)') or './'
local romname = (rom and rom.getfilename and rom.getfilename()) or 'game'
local name = (romname:match('([^/\\]+)$') or romname):gsub('%.nes$', '')
local path = here .. 'sessions/' .. name .. os.date('-%Y%m%d-%H%M%S') .. '.play.txt'
local out = assert(io.open(path, 'w'))
emu.registerexit(function() out:close() end)

local BUTTONS = { 'A', 'B', 'select', 'start', 'up', 'down', 'left', 'right' }
local function pad()
  local held = joypad.get(1)
  local mask = 0
  for bit, key in ipairs(BUTTONS) do
    if held[key] then mask = mask + 2 ^ (bit - 1) end
  end
  return math.floor(mask)
end

emu.poweron()

local last = nil
local frames = 0
while true do
  emu.frameadvance()
  local ram = memory.readbyterange(0x0000, 0x0800)
  local changed = {}
  for i = 1, 0x800 do
    local v = ram:byte(i)
    if last == nil or v ~= last:byte(i) then
      changed[#changed + 1] = string.format('%04x%02x', i - 1, v)
    end
  end
  last = ram
  out:write(string.format('f %d %d %d\n', emu.framecount(), pad(), emu.lagged() and 1 or 0))
  if #changed > 0 then out:write('r ', table.concat(changed), '\n') end
  frames = frames + 1
  if frames % 60 == 0 then out:flush() end
  gui.text(4, 4, string.format('REC %d:%02d  area %d', math.floor(frames / 3600),
    math.floor(frames / 60) % 60, memory.readbyte(0xD1)))
end
