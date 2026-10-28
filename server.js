
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3100;
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.resolve(__dirname, "public", "index.html"));
});

function makeCode() {
  let code;

  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));

  return code;
}

function getVideoId(input) {
  try {
    const url = new URL(input);

    if (url.hostname === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (
      url.hostname === "youtube.com" ||
      url.hostname === "www.youtube.com" ||
      url.hostname === "m.youtube.com" ||
      url.hostname === "music.youtube.com"
    ) {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }

      const parts = url.pathname.split("/").filter(Boolean);

      if (["embed", "shorts", "live"].includes(parts[0])) {
        return parts[1] || null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function sendRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;

  io.to(code).emit("room-state", {
    code,
    hostId: room.hostId,
    members: [...room.members].map(id => ({
      id,
      isHost: id === room.hostId
    })),
    track: room.track,
    playback: room.playback
  });
}

function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;

  io.to(code).emit("room-closed");
  rooms.delete(code);
}

io.on("connection", socket => {
  socket.on("create-room", callback => {
    if (socket.data.roomCode) {
      const previousCode = socket.data.roomCode;
      const previousRoom = rooms.get(previousCode);

      if (previousRoom) {
        if (previousRoom.hostId === socket.id) {
          closeRoom(previousCode);
        } else {
          previousRoom.members.delete(socket.id);
          sendRoomState(previousCode);
        }
      }

      socket.leave(previousCode);
    }

    const code = makeCode();

    rooms.set(code, {
      hostId: socket.id,
      members: new Set([socket.id]),
      track: null,
      playback: {
        playing: false,
        position: 0,
        startedAt: null
      }
    });

    socket.join(code);
    socket.data.roomCode = code;

    sendRoomState(code);

    if (typeof callback === "function") {
      callback({ ok: true, code });
    }
  });

  socket.on("join-room", (input, callback) => {
    const rawCode =
      typeof input === "string" ? input : input?.code;

    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Room not found." });
      }
      return;
    }

    if (!room.members.has(socket.id) && room.members.size >= 6) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Room is full. Maximum 6 phones."
        });
      }
      return;
    }

    const oldCode = socket.data.roomCode;

    if (oldCode && oldCode !== code) {
      const oldRoom = rooms.get(oldCode);

      if (oldRoom) {
        if (oldRoom.hostId === socket.id) {
          closeRoom(oldCode);
        } else {
          oldRoom.members.delete(socket.id);
          sendRoomState(oldCode);
        }
      }

      socket.leave(oldCode);
    }

    room.members.add(socket.id);
    socket.join(code);
    socket.data.roomCode = code;

    if (typeof callback === "function") {
      callback({ ok: true, code });
    }

    sendRoomState(code);
  });

  socket.on("set-youtube-track", (data, callback) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room || room.hostId !== socket.id) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Only the host can change the song." });
      }
      return;
    }

    const videoId = getVideoId(String(data?.url || ""));

    if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Please enter a valid YouTube video link."
        });
      }
      return;
    }

    room.track = {
      type: "youtube",
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`
    };

    room.playback = {
      playing: false,
      position: 0,
      startedAt: null
    };

    io.to(code).emit("playback-update", {
      action: "load",
      videoId,
      position: 0,
      playing: false,
      startedAt: null
    });

    sendRoomState(code);

    if (typeof callback === "function") {
      callback({ ok: true, track: room.track });
    }
  });

  socket.on("playback-command", (command, callback) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room || room.hostId !== socket.id) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Host controls playback." });
      }
      return;
    }

    if (!room.track || room.track.type !== "youtube") {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Choose a YouTube song first." });
      }
      return;
    }

    const action = command?.action;
    const now = Date.now();
    const current = room.playback;

    if (action === "play") {
      const position = Math.max(0, Number(command.position) || 0);

      room.playback = {
        playing: true,
        position,
        startedAt: now + 1800
      };
    } else if (action === "pause") {
      const position = current.playing && current.startedAt
        ? current.position +
          Math.max(0, now - current.startedAt) / 1000
        : current.position;

      room.playback = {
        playing: false,
        position: Math.max(0, position),
        startedAt: null
      };
    } else if (action === "seek") {
      const position = Math.max(0, Number(command.position) || 0);

      room.playback = {
        playing: current.playing,
        position,
        startedAt: current.playing ? now + 1800 : null
      };
    } else {
      return;
    }

    io.to(code).emit("playback-update", {
      action,
      position: room.playback.position,
      playing: room.playback.playing,
      startedAt: room.playback.startedAt
    });

    if (typeof callback === "function") {
      callback({ ok: true });
    }
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);

    if (!room) return;

    if (room.hostId === socket.id) {
      closeRoom(code);
    } else {
      room.members.delete(socket.id);
      sendRoomState(code);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Beat Sync running at http://localhost:${PORT}`);
});
