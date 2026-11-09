-- nes_music_probe.lua — the eyes of the NES music agent, inside FCEUX.
--
-- Load a ROM, run this one script, and leave it. It does no analysis: it records what the
-- sound chip is told and what FCEUX says it plays, frame by frame, into a session folder
-- per ROM, and draws a small panel over the game. The agent outside (Node, xrom-libs/nes)
-- reads the session and does the thinking; later it also drives the game through the
-- command file this script tails.
--
-- Nothing here is specific to a game. No addresses but the chip's own ($4000-$4017).
--
-- What a session holds (fceux/sessions/<rom>-<md5>/<date-time>/):
--
--   session.json  the ROM, the FCEUX features found, the region measured, totals, and why
--                 recording stopped — rewritten every few seconds and at the end
--   events.log    one line per event, text, appended as it happens (see FORMAT below)
--   ram.bin       the 2 KB of CPU RAM after every frame, back to back — what the agent
--                 searches for the music engine's variables
--   commands.log  the agent's commands to this script, appended by the agent, read here
--   agent.log     what the agent (started by this script, if Node is found) says
--
-- FORMAT of events.log (numbers in hex where the chip uses hex):
--
--   F <frame> <cpu cycle at frame start> <lag 0|1>        a frame begins
--   W <frame> <cycle in frame> <addr> <value> <pc>        a write to $4000-$4017
--   Q <frame> <cycle in frame> <pc>                       a read of $4015 (channel status)
--   S <frame> <square1> <square2> <triangle> <noise> <dpcm>
--                                                         what FCEUX's sound.get() reports
--                                                         after the frame: each channel as
--                                                         volume:frequency:midikey
--   M <frame> <text>                                      a marker (ROM change, reset, limit…)
--   K <frame> <pc> <a> <x> <y> <s> <chain>               $4015 written with channels enabled —
--                                                         how drivers start songs — with the
--                                                         registers and the chain of calls on
--                                                         the stack: jsr>target pairs, innermost
--                                                         first, read from the return addresses
--   C <frame> <pc> <chain>                                the chain of the frame's first chip
--                                                         write, when it differs from the last
--                                                         one logged — the driver's PLAY, called
--                                                         from the frame interrupt
--   P <start frame> <state frame>                         a save state kept from before a song
--                                                         started there (see `try`)
--   X <frame> <entry> <a> <x> <y> <set|seen>             a hooked entry executed, and the
--                                                         registers it was entered with (after
--                                                         an override, if one was set)
--   T <frame> <id> <begin|end|error …>                    an experiment the agent asked for
--
-- Dumps: dumps/<frame>.bin, the CPU's $0000-$07FF and $6000-$FFFF as the driver sees them when it
-- starts a song (2 KB + 40 KB), the first few times only — the agent finds the cartridge's banks
-- and the driver's memory in them.
--
-- Commands the agent appends to commands.log, one a line:
--
--   mark <text>                     a marker in events.log
--   speed <normal|turbo|maximum>    emulation speed
--   status <text>                   a line on the panel
--   hook <entry>                    report every execution of <entry> (hex) as an X line
--   try <id> <start> <entry> <reg> <value|keep> <frames> [nth]
--                                   load the state kept before the song that started on frame
--                                   <start>, and when <entry> next executes set register <reg>
--                                   (a, x or y) to <value> (hex) — at its <nth> call, 1 by
--                                   default; run <frames> frames; T lines mark the window.
--                                   <reg> may carry more registers to set: a+y=02
--   starthook <entry>               like hook, and every call of <entry> counts as a song start
--                                   (a K line, a kept state, a dump): for drivers that start a
--                                   song by a call and never touch $4015 again
--   press <button> <frames>         hold a button on pad 1 (start, a, b, select, up…) — the
--                                   agent moving an unattended game on to its next song
--   stop [reason]                   end the session (and quit FCEUX, when run unattended)
--
-- Frames are counted by this script from the session's start, not by emu.framecount():
-- a reset or a loaded save state moves FCEUX's counter, ours keeps going; both are
-- recorded so they can be matched.

------------------------------------------------------------------------------
-- Configuration
------------------------------------------------------------------------------

-- Sessions live next to this script, whatever FCEUX's working directory is.
local function scriptDir()
    local source = debug.getinfo(1, "S").source:gsub("^@", "")
    return source:match("^(.*)[/\\][^/\\]+$") or "."
end

local DIR = scriptDir()
local SESSIONS = DIR .. "/sessions"

-- A ceiling, so a forgotten script does not fill the disk: 30 minutes of game time.
-- RAM snapshots are 2 KB a frame, 7 MB a minute; events are far smaller.
local MAX_FRAMES = 60 * 60 * 30
local RAM_SNAPSHOTS = true

-- Run by `npm run fceux-agent` (NES_AGENT_AUTO=1): nobody at the controls. Until a song
-- starts, Start is pressed now and then — some games wait on their title for it; when the
-- agent says stop, the session is closed and FCEUX quits.
local AUTO = os.getenv("NES_AGENT_AUTO") == "1"
local AUTO_FIRST_PRESS = 60 * 8   -- frames before the first press of Start
local AUTO_PRESS_EVERY = 60 * 4   -- and between presses after it
local AUTO_PRESSES = 12
local songSeen = false
local pressing = nil   -- { button, last } — a `press` command being held
local lastEnable = -1000   -- the frame of the last $4015 write enabling channels

local FLUSH_EVERY = 60       -- frames between flushes of the open files to disk
local META_EVERY = 300       -- frames between rewrites of session.json
local POLL_EVERY = 6         -- frames between reads of commands.log
local ROM_CHECK_EVERY = 60   -- frames between checks that the same ROM is still loaded

------------------------------------------------------------------------------
-- What this FCEUX offers — looked up, not assumed
------------------------------------------------------------------------------

local function has(tableName, fieldName)
    local t = _G[tableName]
    return type(t) == "table" and type(t[fieldName]) == "function"
end

local features = {
    registerwrite = has("memory", "registerwrite"),
    registerread = has("memory", "registerread"),
    registerexec = has("memory", "registerexec"),
    setregister = has("memory", "setregister"),
    savestates = has("savestate", "create") and has("savestate", "save") and has("savestate", "load"),
    getregister = has("memory", "getregister"),
    readbyterange = has("memory", "readbyterange"),
    cycles = has("debugger", "getcyclescount"),
    soundget = has("sound", "get"),
    romname = has("rom", "getfilename"),
    romhash = has("rom", "gethash"),
    lagged = has("emu", "lagged"),
    speedmode = has("emu", "speedmode"),
    gui = has("gui", "text"),
    popen = type(io.popen) == "function",
}

local warnings = {}
local function warn(text)
    for _, w in ipairs(warnings) do
        if w == text then return end
    end
    warnings[#warnings + 1] = text
    print("nes_music_probe: " .. text)
end

if not features.registerwrite then
    error("this FCEUX has no memory.registerwrite: the sound chip cannot be watched")
end
if not features.cycles then warn("no debugger.getcyclescount: times are per frame only") end
if not features.soundget then warn("no sound.get: FCEUX's own view of the channels is not recorded") end
if not features.readbyterange then warn("no memory.readbyterange: no RAM snapshots") end

------------------------------------------------------------------------------
-- Small helpers
------------------------------------------------------------------------------

local function hex(n, width)
    return string.format("%0" .. (width or 2) .. "X", n)
end

local function cycles()
    if features.cycles then return debugger.getcyclescount() end
    return 0
end

local function jsonString(s)
    s = tostring(s)
    s = s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("[%c]", " ")
    return '"' .. s .. '"'
end

local function safeName(s)
    return (tostring(s):gsub("%.[Nn][Ee][Ss]$", ""):gsub("[^%w%-]+", "_"):gsub("^_+", ""):gsub("_+$", ""))
end

------------------------------------------------------------------------------
-- Session
------------------------------------------------------------------------------

local session = nil   -- the open session, or nil while no ROM is loaded
-- The ROM a stopped session belonged to: not recorded again until another ROM is loaded,
-- or a stop (by the agent, or the frame limit) would open a new session the next frame.
local stoppedRom = nil

-- Totals and recent activity, for the panel and session.json.
local frame = 0
local writes = 0
local reads = 0
local stopReason = nil
local lastFrameCycles = nil
local cyclesPerFrame = nil       -- averaged, to tell NTSC from PAL
local channelWrites = { 0, 0, 0, 0, 0 }      -- this frame, per channel
local recentWrites = { {}, {}, {}, {}, {} }  -- per channel, a ring of the last 60 frames
local lastSound = nil
local status = "waiting for a ROM"

local pending = {}   -- event lines of the current frame, written once at its end

local CHANNEL_OF = {}  -- $4000-$4017 → 1..5 (pulse 1, pulse 2, triangle, noise, DMC), or nil
for a = 0x4000, 0x4003 do CHANNEL_OF[a] = 1 end
for a = 0x4004, 0x4007 do CHANNEL_OF[a] = 2 end
for a = 0x4008, 0x400B do CHANNEL_OF[a] = 3 end
for a = 0x400C, 0x400F do CHANNEL_OF[a] = 4 end
for a = 0x4010, 0x4013 do CHANNEL_OF[a] = 5 end

local function region()
    if not cyclesPerFrame then return "unknown" end
    -- NTSC 29780.5, PAL 33247.5, Dendy 35464 cycles a frame.
    if cyclesPerFrame < 31500 then return "NTSC" end
    if cyclesPerFrame < 34350 then return "PAL" end
    return "Dendy"
end

local function writeMeta()
    if not session then return end
    local f = io.open(session.dir .. "/session.json", "w")
    if not f then
        warn("cannot write session.json in " .. session.dir)
        return
    end
    local feats = {}
    for name, ok in pairs(features) do feats[#feats + 1] = jsonString(name) .. ":" .. tostring(ok) end
    local warns = {}
    for _, w in ipairs(warnings) do warns[#warns + 1] = jsonString(w) end
    f:write("{\n")
    f:write('  "format": "nes-music-probe/1",\n')
    f:write('  "rom": {"file": ' .. jsonString(session.rom) .. ', "md5": ' .. jsonString(session.md5) .. '},\n')
    f:write('  "started": ' .. jsonString(session.started) .. ',\n')
    f:write('  "fceuxFrameAtStart": ' .. session.fceuxFrame .. ',\n')
    f:write('  "region": ' .. jsonString(region()) .. ',\n')
    f:write('  "cyclesPerFrame": ' .. (cyclesPerFrame and string.format("%.1f", cyclesPerFrame) or "null") .. ',\n')
    f:write('  "frames": ' .. frame .. ',\n')
    f:write('  "apuWrites": ' .. writes .. ',\n')
    f:write('  "statusReads": ' .. reads .. ',\n')
    f:write('  "ramSnapshots": ' .. tostring(session.ram ~= nil) .. ',\n')
    f:write('  "features": {' .. table.concat(feats, ", ") .. '},\n')
    f:write('  "warnings": [' .. table.concat(warns, ", ") .. '],\n')
    f:write('  "stopped": ' .. (stopReason and jsonString(stopReason) or "null") .. '\n')
    f:write("}\n")
    f:close()
end

local function closeSession(reason)
    if not session then return end
    stopReason = stopReason or reason
    stoppedRom = session.md5 ~= "nohash" and session.md5 or session.rom
    if #pending > 0 then
        session.events:write(table.concat(pending, "\n"), "\n")
        pending = {}
    end
    session.events:write("M ", frame, " stop ", stopReason or "closed", "\n")
    session.events:close()
    if session.ram then session.ram:close() end
    if session.agent then pcall(function() session.agent:close() end) end
    writeMeta()
    print("nes_music_probe: session closed (" .. tostring(stopReason) .. "): " .. session.dir)
    session = nil
end

local function romIdentity()
    local name = features.romname and rom.getfilename() or nil
    local md5 = features.romhash and rom.gethash("md5") or nil
    return name, md5
end

-- The agent, if this package's Node half is beside the script: started once a session, fed
-- nothing on its stdin but the pipe itself — it reads events.log and appends commands.log, and
-- exits when the pipe closes with the session.
local AGENT = DIR .. "/../src/agent-live.ts"

-- A Node that runs TypeScript as it is: 22.6 or later. FCEUX started from the Finder does not
-- see nvm's PATH, and /usr/local/bin/node may be an old one (14, on this machine) — so every Node
-- found is asked its version, nvm's newest first.
local NODE_LEAST = { 22, 6 }

local function nodeVersion(path)
    local pipe = io.popen('"' .. path .. '" --version 2>/dev/null')
    if not pipe then return nil end
    local text = pipe:read("*a") or ""
    pipe:close()
    local major, minor = text:match("v(%d+)%.(%d+)")
    if not major then return nil end
    return tonumber(major), tonumber(minor)
end

local function nodeBinary()
    local candidates = {}
    local home = os.getenv("HOME") or ""
    local list = io.popen('ls -1 "' .. home .. '/.nvm/versions/node" 2>/dev/null')
    if list then
        local versions = {}
        for name in list:lines() do
            local a, b, c = name:match("^v(%d+)%.(%d+)%.(%d+)$")
            if a then versions[#versions + 1] = { tonumber(a), tonumber(b), tonumber(c), name } end
        end
        list:close()
        table.sort(versions, function(x, y)
            if x[1] ~= y[1] then return x[1] > y[1] end
            if x[2] ~= y[2] then return x[2] > y[2] end
            return x[3] > y[3]
        end)
        for _, v in ipairs(versions) do
            candidates[#candidates + 1] = home .. "/.nvm/versions/node/" .. v[4] .. "/bin/node"
        end
    end
    for _, path in ipairs({ "/opt/homebrew/bin/node", "/usr/local/bin/node", "node" }) do
        candidates[#candidates + 1] = path
    end
    local seen = {}
    for _, path in ipairs(candidates) do
        local major, minor = nodeVersion(path)
        if major then
            seen[#seen + 1] = path .. " v" .. major .. "." .. minor
            if major > NODE_LEAST[1] or (major == NODE_LEAST[1] and minor >= NODE_LEAST[2]) then
                return path
            end
        end
    end
    warn("no Node 22.6+ found (" .. (#seen > 0 and table.concat(seen, ", ") or "none at all") .. ") — recording only")
    return nil
end

function startAgent(dir)
    local f = io.open(AGENT, "r")
    if not f then
        warn("no agent at " .. AGENT .. " — recording only")
        return
    end
    f:close()
    if not features.popen then
        warn("no io.popen: the agent cannot be started — recording only")
        return
    end
    local node = nodeBinary()
    if not node then return end
    local cmd = string.format('"%s" --experimental-strip-types --no-warnings "%s" "%s" > "%s/agent.log" 2>&1',
        node, AGENT, dir, dir)
    print("nes_music_probe: agent runs on " .. node)
    local ok, pipe = pcall(io.popen, cmd, "w")
    if ok and pipe then
        session.agent = pipe
        print("nes_music_probe: agent started, it writes " .. dir .. "/agent.log")
    else
        warn("could not start the agent: " .. tostring(pipe))
    end
end

local function openSession()
    local name, md5 = romIdentity()
    if not name and not md5 then return false end
    if stoppedRom and stoppedRom == (md5 or name) then return false end
    stoppedRom = nil
    name = name or "rom"
    md5 = md5 or "nohash"
    local folder = SESSIONS .. "/" .. safeName(name) .. "-" .. string.sub(md5, 1, 8)
    local dir = folder .. "/" .. os.date("%Y%m%d-%H%M%S")
    os.execute('mkdir -p "' .. dir .. '"')
    local events = io.open(dir .. "/events.log", "w")
    if not events then
        warn("cannot create " .. dir .. " — is the folder writable?")
        return false
    end
    events:write("# nes-music-probe events/1 — see the header of nes_music_probe.lua\n")
    local ram = nil
    if RAM_SNAPSHOTS and features.readbyterange then
        ram = io.open(dir .. "/ram.bin", "wb")
        if not ram then warn("cannot create ram.bin") end
    end
    -- The agent appends here; an empty file now means a fresh start.
    local commands = io.open(dir .. "/commands.log", "w")
    if commands then commands:close() end

    session = {
        dir = dir, rom = name, md5 = md5, events = events, ram = ram,
        started = os.date("%Y-%m-%dT%H:%M:%S"), fceuxFrame = emu.framecount(),
        commandOffset = 0,
    }
    frame, writes, reads, stopReason = 0, 0, 0, nil
    ring, ringNext, pins, dumps, pinRequest = {}, 1, {}, 0, nil
    armed, trying, queued, agentStatus, lastChain = nil, nil, {}, nil, nil
    cyclesPerFrame, lastFrameCycles = nil, nil
    status = "observing"
    events:write("M 0 rom ", name, " ", md5, "\n")
    events:flush()
    startAgent(dir)
    writeMeta()
    print("nes_music_probe: recording " .. name .. " into " .. dir)
    return true
end

------------------------------------------------------------------------------
-- Calls on the stack, song starts, save states
------------------------------------------------------------------------------

-- The chain of calls that led here, from the return addresses on the stack: JSR pushes the
-- address of its own last byte, so a pushed word w with $20 (JSR) at w-2 is a call to the word
-- at w-1. Anything else on the stack (saved registers, an interrupt's frame) fails that test
-- and is skipped. Innermost call first, "jsr>target" in hex.
function callChain()
    local s = memory.getregister("s") or 0xFF
    local out = {}
    local i = s + 1
    while i < 0xFF and #out < 6 do
        local w = memory.readbyte(0x100 + i) + memory.readbyte(0x100 + i + 1) * 256
        -- Only where code lives: a read of $2000-$5FFF is a read of the PPU, the APU or a
        -- controller, and changes them (a $4015 read clears the frame interrupt).
        if w >= 0x6002 and memory.readbyte(w - 2) == 0x20 then
            local target = memory.readbyte(w - 1) + memory.readbyte(w) * 256
            out[#out + 1] = hex(w - 2, 4) .. ">" .. hex(target, 4)
            i = i + 2
        else
            i = i + 1
        end
    end
    return #out > 0 and table.concat(out, ",") or "-"
end

chainLogged = false   -- this frame's first chip write has had its chain looked at
lastChain = nil

local DUMPS_MAX = 16
-- Globals, not locals: openSession (above) resets them for each new session.
dumps = 0
pinRequest = nil   -- a song started on this frame: keep a state from before it

function songStarted(pc)
    songSeen = true
    pending[#pending + 1] = string.format("K %d %s %s %s %s %s %s", frame, hex(pc, 4),
        hex(memory.getregister("a") or 0), hex(memory.getregister("x") or 0),
        hex(memory.getregister("y") or 0), hex(memory.getregister("s") or 0), callChain())
    -- A replay's starts are the experiment's, not the game's: no state, no dump.
    if trying then return end
    pinRequest = pinRequest or frame
    if dumps < DUMPS_MAX then
        dumps = dumps + 1
        dumpAs(frame)
    end
end

-- The CPU's RAM and $6000-$FFFF as mapped now, as dumps/<name>.bin: what the agent runs the
-- driver on, away from the game.
function dumpAs(name, again)
    if not session or not features.readbyterange then return end
    local path = session.dir .. "/dumps/" .. name .. ".bin"
    local existing = io.open(path, "rb")
    if existing then
        existing:close()
        -- Again only from a later frame: within a frame the first call stands — a start made
        -- of five calls of one entry (Alien 3) is replayed from the first of them.
        if not again or dumpFrames[name] == frame then return end
    end
    dumpFrames[name] = frame
    os.execute('mkdir -p "' .. session.dir .. '/dumps"')
    local f = io.open(path, "wb")
    if f then
        f:write(memory.readbyterange(0x0000, 0x800))
        f:write(memory.readbyterange(0x6000, 0xA000))
        f:close()
    end
end

-- A ring of states, one every RING_EVERY frames; when a song starts, the newest state from
-- before it is pinned — taken out of the ring — so the start can be replayed at will.
local RING_EVERY, RING_SIZE, PINS_MAX = 30, 8, 16
ring, ringNext, pins = {}, 1, {}

local function ringSave()
    local slot = ring[ringNext]
    if not slot then
        slot = { state = savestate.create() }
        ring[ringNext] = slot
    end
    savestate.save(slot.state)
    slot.frame = frame
    ringNext = ringNext % RING_SIZE + 1
end

local function pinFor(start)
    local best, bestIndex = nil, nil
    for i, slot in pairs(ring) do
        if slot.frame and slot.frame < start - 1 and (not best or slot.frame > best.frame) then
            best, bestIndex = slot, i
        end
    end
    if not best then return end
    ring[bestIndex] = nil          -- its object now belongs to the pin; the ring makes a new one
    pins[#pins + 1] = { start = start, frame = best.frame, state = best.state }
    if #pins > PINS_MAX then table.remove(pins, 1) end
    pending[#pending + 1] = "P " .. start .. " " .. best.frame
end

-- Hooked entries: report each execution; the armed override changes a register once.
hooks = {}            -- [entry] = true once registered
reporting = {}        -- [entry] = true: write an X line on every execution
dumpFrames = {}       -- [dump name] = the frame it was taken on
dumpedStarts = {}     -- [start] = true once a replay of it reached the override: its dumps are final
startEntries = {}     -- [entry] = frame of its last call: an execution after a lull is a song start too (`starthook`)
armed = nil           -- { entry, reg, value } — the override for the running try
trying = nil          -- { id, last } — the running try

local function hook(entry)
    if hooks[entry] or not features.registerexec then return end
    hooks[entry] = true
    memory.registerexec(entry, 1, function()
        if not session then return end
        local how = "seen"
        local mailbox = armed and armed.entry == entry and armed.ram
        if mailbox and memory.readbyte(mailbox.addr) ~= mailbox.empty then
            mailbox.seen = mailbox.seen + 1
        end
        if mailbox and mailbox.seen < mailbox.nth then
            -- Not yet the request asked for: the entry runs every frame, the mailbox mostly empty.
            if not reporting[entry] then return end
        elseif mailbox then
            -- The moment of the request, before it is acted on: where the agent's player starts
            -- the song from, the earlier requests (Alien 3 stops everything first) already done.
            local name = trying.start .. "-" .. hex(entry, 4) .. "-ram"
            if not dumpedStarts[name] then
                dumpAs(name, true)
                dumpedStarts[name] = true
            end
            if armed.value then memory.writebyte(mailbox.addr, armed.value) end
            how = armed.value and "set" or "kept"
            armed = nil
        elseif armed and armed.entry == entry and armed.skip > 0 then
            -- Not yet the call asked for: Alien 3 starts a song with five calls of $8003 in a
            -- frame — four clear a channel each, the fifth names the song.
            armed.skip = armed.skip - 1
            if trying then dumpAs(trying.start .. "-" .. hex(entry, 4), not dumpedStarts[trying.start]) end
            how = "seen"
        elseif armed and armed.entry == entry then
            if trying then
                dumpAs(trying.start .. "-" .. hex(entry, 4), not dumpedStarts[trying.start])
                dumpedStarts[trying.start] = true
            end
            -- The moment the entry is called, before any of it runs: what the agent's driver is
            -- called from. The start's own dump is taken at its $4015 write, part-way through the
            -- driver — Capcom's RAM is half set up by then, and nothing played like FCEUX from it.
            if trying then dumpAs(trying.start .. "-" .. hex(entry, 4)) end
            if armed.value and features.setregister then
                memory.setregister(armed.reg, armed.value)
                for r, v in pairs(armed.fixed) do memory.setregister(r, v) end
            end
            how = armed.value and "set" or "kept"
            armed = nil
        elseif not reporting[entry] then
            return
        elseif trying then
            -- Every hooked call of a replay: the agent may run the driver from an outer entry —
            -- the last call before the start, kept up to date until the override is made
            -- (Alien 3's $ED94 runs every frame; only the call in the start's frame carries the
            -- song request it acts on). Once a start has been dumped, its replays leave it be.
            dumpAs(trying.start .. "-" .. hex(entry, 4), armed ~= nil and not dumpedStarts[trying.start])
        end
        pending[#pending + 1] = string.format("X %d %s %s %s %s %s", frame, hex(entry, 4),
            hex(memory.getregister("a") or 0), hex(memory.getregister("x") or 0),
            hex(memory.getregister("y") or 0), how)
        -- A start is a call out of the blue: an entry called every frame (the frame routine,
        -- in the same table as the song entry) is not starting anything.
        if startEntries[entry] and how == "seen" then
            local last = startEntries[entry]
            startEntries[entry] = frame
            if frame - last > 30 then songStarted(entry) end
        end
    end)
end

------------------------------------------------------------------------------
-- The chip: every write to $4000-$4017, every read of $4015
------------------------------------------------------------------------------

local frameStart = 0

for address = 0x4000, 0x4017 do
    memory.registerwrite(address, 1, function(addr, size, value)
        if not session or stopReason then return end
        writes = writes + 1
        local ch = CHANNEL_OF[addr]
        if ch then channelWrites[ch] = channelWrites[ch] + 1 end
        local pc = features.getregister and memory.getregister("pc") or 0
        pending[#pending + 1] = "W " .. frame .. " " .. (cycles() - frameStart) .. " "
            .. hex(addr, 4) .. " " .. hex(value or 0) .. " " .. hex(pc, 4)
        if features.getregister then
            if not chainLogged then
                chainLogged = true
                local chain = callChain()
                if chain ~= lastChain then
                    lastChain = chain
                    pending[#pending + 1] = "C " .. frame .. " " .. hex(pc, 4) .. " " .. chain
                end
            end
            -- A start is a $4015 write after a lull: Alien 3's driver rewrites $4015 every
            -- frame, and every frame was a "song start" that pushed the kept states out.
            if addr == 0x4015 and value and value % 16 ~= 0 then
                if frame - lastEnable > 30 then songStarted(pc) end
                lastEnable = frame
            end
        end
    end)
end

-- A driver that asks the chip which channels still sound decides by the answer; the
-- answer itself cannot be read here without a second read, which would clear the
-- frame interrupt flag — so the read is recorded, and the agent works the answer out.
if features.registerread then
    memory.registerread(0x4015, 1, function()
        if not session or stopReason then return end
        reads = reads + 1
        local pc = features.getregister and memory.getregister("pc") or 0
        pending[#pending + 1] = "Q " .. frame .. " " .. (cycles() - frameStart) .. " " .. hex(pc, 4)
    end)
end

------------------------------------------------------------------------------
-- What FCEUX says each channel plays
------------------------------------------------------------------------------

local SOUND_CHANNELS = { "square1", "square2", "triangle", "noise", "dpcm" }

local function soundLine()
    if not features.soundget then return nil end
    local ok, s = pcall(sound.get)
    if not ok or type(s) ~= "table" or type(s.rp2a03) ~= "table" then
        features.soundget = false
        warn("sound.get() did not answer as expected — FCEUX's channel view is off")
        return nil
    end
    local parts = { "S", frame }
    local volumes = {}
    for i, name in ipairs(SOUND_CHANNELS) do
        local c = s.rp2a03[name] or {}
        local v = tonumber(c.volume) or 0
        volumes[i] = v
        parts[#parts + 1] = string.format("%.3f:%.2f:%.2f", v, tonumber(c.frequency) or 0, tonumber(c.midikey) or 0)
    end
    lastSound = volumes
    return table.concat(parts, " ")
end

------------------------------------------------------------------------------
-- Commands from the agent (appended to commands.log, read here by byte offset)
------------------------------------------------------------------------------

agentStatus = nil
queued = {}

local function applyCommand(line)
    local verb, rest = line:match("^(%S+)%s*(.*)$")
    if not verb then return end
    if verb == "mark" then
        pending[#pending + 1] = "M " .. frame .. " " .. rest
    elseif verb == "speed" then
        if features.speedmode then emu.speedmode(rest) else warn("no emu.speedmode") end
        pending[#pending + 1] = "M " .. frame .. " speed " .. rest
    elseif verb == "status" then
        agentStatus = rest
    elseif verb == "hook" then
        local entry = tonumber(rest, 16)
        if entry then
            hook(entry)
            reporting[entry] = true
        end
    elseif verb == "press" then
        local button, frames = rest:match("^(%a+)%s+(%d+)")
        if button then pressing = { button = button, last = frame + tonumber(frames) } end
    elseif verb == "starthook" then
        local entry = tonumber(rest, 16)
        if entry then
            -- The frame it was hooked on: a call in the next 30 frames is not out of the blue
            -- either — the frame routine is called on the very next one.
            startEntries[entry] = frame
            hook(entry)
            reporting[entry] = true
        end
    elseif verb == "try" then
        queued[#queued + 1] = rest   -- save states are loaded between frames, in the main loop
    elseif verb == "stop" then
        stopReason = "stopped by the agent" .. (rest ~= "" and (": " .. rest) or "")
    else
        warn("unknown command: " .. line)
    end
end

-- Opened fresh on every poll: a held handle can keep answering EOF for what another
-- process appended later (found the hard way in admin_bridge.lua).
local function pollCommands()
    if not session then return end
    local file = io.open(session.dir .. "/commands.log", "r")
    if not file then return end
    local size = file:seek("end")
    if size <= session.commandOffset then
        file:close()
        return
    end
    file:seek("set", session.commandOffset)
    local chunk = file:read("*a") or ""
    file:close()
    local lastBreak = chunk:match("^.*()\n")
    if not lastBreak then return end
    session.commandOffset = session.commandOffset + lastBreak
    for line in chunk:sub(1, lastBreak - 1):gmatch("[^\n]+") do
        line = line:gsub("%s+$", "")
        if line ~= "" and not line:match("^#") then applyCommand(line) end
    end
end

------------------------------------------------------------------------------
-- Frame loop
------------------------------------------------------------------------------

local fceuxFrameBefore = nil

emu.registerbefore(function()
    if not session then
        if not openSession() then return end
    end
    if stopReason then return end
    frame = frame + 1
    frameStart = cycles()
    if lastFrameCycles and features.cycles then
        local span = frameStart - lastFrameCycles
        -- One frame's worth only: a reset or a loaded state makes the span meaningless.
        if span > 20000 and span < 40000 then
            cyclesPerFrame = cyclesPerFrame and (cyclesPerFrame * 0.98 + span * 0.02) or span
        end
    end
    lastFrameCycles = frameStart
    -- FCEUX's own counter going backwards or jumping: a reset, a loaded state, a movie.
    local fc = emu.framecount()
    if fceuxFrameBefore and (fc < fceuxFrameBefore or fc > fceuxFrameBefore + 2) then
        pending[#pending + 1] = "M " .. frame .. " fceux-frame " .. fceuxFrameBefore .. " -> " .. fc
    end
    fceuxFrameBefore = fc
    pending[#pending + 1] = "F " .. frame .. " " .. frameStart .. " 0"
    chainLogged = false
end)

emu.registerafter(function()
    if not session or stopReason then
        if session and stopReason then closeSession(stopReason) end
        return
    end

    if features.lagged and emu.lagged() then
        pending[#pending + 1] = "M " .. frame .. " lag"
    end

    local line = soundLine()
    if line then pending[#pending + 1] = line end

    session.events:write(table.concat(pending, "\n"), "\n")
    pending = {}

    if session.ram then
        local ok, bytes = pcall(memory.readbyterange, 0, 0x800)
        if ok and type(bytes) == "string" and #bytes == 0x800 then
            session.ram:write(bytes)
        else
            warn("memory.readbyterange did not return 2048 bytes — RAM snapshots stopped")
            session.ram:close()
            session.ram = nil
        end
    end

    for ch = 1, 5 do
        recentWrites[ch][frame % 60] = channelWrites[ch]
        channelWrites[ch] = 0
    end

    if frame % FLUSH_EVERY == 0 then
        session.events:flush()
        if session.ram then session.ram:flush() end
    end
    if frame % META_EVERY == 0 then writeMeta() end
    if frame % POLL_EVERY == 0 then pollCommands() end

    if frame % ROM_CHECK_EVERY == 0 then
        local name, md5 = romIdentity()
        if (md5 or name) ~= (session.md5 ~= "nohash" and session.md5 or session.rom) then
            closeSession("another ROM was loaded")
            -- Not a stop: the next frame opens the new ROM's session.
            stopReason, stoppedRom = nil, nil
            return
        end
    end

    if frame >= MAX_FRAMES then
        stopReason = "frame limit (" .. MAX_FRAMES .. ")"
        closeSession(stopReason)
    end
end)

emu.registerexit(function()
    closeSession("script stopped")
end)

------------------------------------------------------------------------------
-- Panel
------------------------------------------------------------------------------

local NAMES = { "P1", "P2", "TR", "NS", "DM" }

local function writesLastSecond(ch)
    local n = 0
    for _, v in pairs(recentWrites[ch]) do n = n + v end
    return n
end

if features.gui then
    gui.register(function()
        local y = 8
        local function line(text, colour)
            gui.text(4, y, text, colour or "#FFFFFF", "#000000A0")
            y = y + 9
        end
        line("NES music probe — " .. (stopReason and ("stopped: " .. stopReason) or status))
        if session then
            line(string.sub(session.rom, 1, 30) .. "  " .. region())
            line(string.format("frame %d  writes %d", frame, writes))
            for ch = 1, 5 do
                local w = writesLastSecond(ch)
                local v = lastSound and lastSound[ch] or 0
                local bar = string.rep("|", math.min(20, math.floor(v * 20 + 0.5)))
                line(string.format("%s %3d/s %s", NAMES[ch], w, bar), v > 0 and "#7FFF7F" or "#A0A0A0")
            end
        end
        if trying then line("experiment " .. trying.id, "#80C0FF") end
        if agentStatus then line("agent: " .. string.sub(agentStatus, 1, 38), "#80C0FF") end
        for i = math.max(1, #warnings - 2), #warnings do
            line("! " .. string.sub(warnings[i], 1, 40), "#FFD060")
        end
    end)
end

local emulating = has("emu", "emulating") and emu.emulating()
print("nes_music_probe: ready — " .. (emulating and "recording starts with the next frame"
    or "load a ROM and recording starts by itself"))

------------------------------------------------------------------------------
-- Between frames: save states, pins, experiments (a state is loaded here, not inside a frame)
------------------------------------------------------------------------------

local function startTry(args)
    local id, start, entry, reg, value, frames, nth =
        args:match("^(%S+)%s+(%d+)%s+(%x+)%s+([axy][%+axy=%x]*)%s+(%S+)%s+(%d+)%s*(%d*)")
    -- Or a song asked for through RAM: `ram:<addr>:<empty>:<nth>` in the register's place — the
    -- <nth> time the hooked entry finds <addr> holding something other than <empty>, <value> is
    -- written there (Alien 3's mailbox $A7: $FF when empty, a song number for one frame).
    local ram = nil
    if not id then
        local addr, empty, rnth
        id, start, entry, addr, empty, rnth, value, frames =
            args:match("^(%S+)%s+(%d+)%s+(%x+)%s+ram:(%x+):(%x+):(%d+)%s+(%S+)%s+(%d+)")
        if id then
            ram = { addr = tonumber(addr, 16), empty = tonumber(empty, 16), nth = tonumber(rnth), seen = 0 }
            reg = "ram:" .. addr .. ":" .. empty .. ":" .. rnth
        end
    end
    if not id then
        warn("cannot read: try " .. args)
        return
    end
    start, entry, frames = tonumber(start), tonumber(entry, 16), tonumber(frames)
    local pin = nil
    for _, p in ipairs(pins) do
        if p.start == start then pin = p end
    end
    if not pin then
        pending[#pending + 1] = "T " .. frame .. " " .. id .. " error no state kept for the start on frame " .. start
        return
    end
    hook(entry)
    savestate.load(pin.state)
    -- "a+y=02": the song in A, and Y set to 2 beside it — a dispatcher's routine (Jungle Book's $9000).
    local fixed = {}
    for r, v in reg:gmatch("%+(%a)=(%x+)") do fixed[r] = tonumber(v, 16) end
    armed = { entry = entry, reg = ram and reg or reg:sub(1, 1), value = value ~= "keep" and tonumber(value, 16) or nil,
              skip = (tonumber(nth) or 1) - 1, ram = ram, fixed = fixed }
    trying = { id = id, last = frame + frames, start = start }
    pending[#pending + 1] = string.format("T %d %s begin %d %s %s %s", frame, id, start, hex(entry, 4), reg, value)
end

if not features.savestates then warn("no save states: experiments are off") end
if not features.registerexec then warn("no memory.registerexec: experiments are off") end

while true do
    if AUTO and stopReason and not session then emu.exit() end
    if AUTO and session and not stopReason and not songSeen and frame >= AUTO_FIRST_PRESS then
        local since = frame - AUTO_FIRST_PRESS
        -- Held for four frames: a game reading the pad once a few frames still sees it.
        if since % AUTO_PRESS_EVERY < 4 and since < AUTO_PRESS_EVERY * AUTO_PRESSES then
            joypad.set(1, { start = true })
        end
    end
    if pressing and not trying and session and frame <= pressing.last then
        joypad.set(1, { [pressing.button] = true })
    end
    if session and not stopReason then
        if features.savestates then
            if pinRequest then
                pinFor(pinRequest)
                pinRequest = nil
            end
            -- And on the first frame: a driver set up at power-on starts its song before the
            -- ring's first turn — RoboCop's only $4015 write is on frame 4.
            if not trying and (frame == 1 or (frame % RING_EVERY == 0 and frame > 0)) then ringSave() end
        end
        if trying and frame >= trying.last then
            pending[#pending + 1] = "T " .. frame .. " " .. trying.id .. " end" .. (armed and " unhit" or "")
            armed, trying = nil, nil
        end
        if not trying and #queued > 0 and features.savestates and features.registerexec then
            startTry(table.remove(queued, 1))
        end
    end
    emu.frameadvance()
end
