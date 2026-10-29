
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
const RECONNECT_GRACE_MS = 60_000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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
    const host = url.hostname.toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com"
      ].includes(host)
    ) {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }

      const parts = url.pathname.split("/").filter(Boolean);

      if (["embed", "shorts", "live"].includes(parts[0])) {
        return parts[1] || null;
      }
    }
  } catch {}

  return null;
}

function getCurrentPosition(playback, now = Date.now()) {
  if (!playback.playing || !playback.startedAt) {
    return playback.position;
  }

  return (
    playback.position +
    Math.max(0, now - playback.startedAt) / 1000
  );
}

function sendRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;

  const playback = { ...room.playback };

  if (playback.playing) {
    playback.position = getCurrentPosition(playback);
    playback.startedAt = Date.now() + 1200;
  }

  io.to(code).emit("room-state", {
    code,
    hostId: room.hostId,
    members: [...room.members].map((id) => ({
      id,
      isHost: id === room.hostId
    })),
    track: room.track,
    playback
  });
}

function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;

  if (room.reconnectTimer) {
    clearTimeout(room.reconnectTimer);
  }

  io.to(code).emit("room-closed");

  for (const id of room.members) {
    const memberSocket = io.sockets.sockets.get(id);

    if (memberSocket) {
      memberSocket.leave(code);
      if (memberSocket.data.roomCode === code) {
        delete memberSocket.data.roomCode;
      }
    }
  }

  rooms.delete(code);
}

function removeSocketFromRoom(socket, code) {
  const room = rooms.get(code);
  if (!room) return;

  if (room.hostId === socket.id) {
    // Keep the room temporarily so the host can reconnect.
    if (room.reconnectTimer) {
      clearTimeout(room.reconnectTimer);
    }

    room.reconnectTimer = setTimeout(() => {
      const latestRoom = rooms.get(code);

      if (latestRoom && latestRoom.hostId === socket.id) {
        closeRoom(code);
      }
    }, RECONNECT_GRACE_MS);

    sendRoomState(code);
  } else {
    room.members.delete(socket.id);
    sendRoomState(code);
  }
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);

  if (room) {
    if (room.hostId === socket.id) {
      closeRoom(code);
    } else {
      room.members.delete(socket.id);
      sendRoomState(code);
    }
  }

  socket.leave(code);
  delete socket.data.roomCode;
}

function joinSocketToRoom(socket, code, room) {
  room.members.add(socket.id);
  socket.join(code);
  socket.data.roomCode = code;
}

io.on("connection", (socket) => {
  socket.on("create-room", (callback) => {
    leaveCurrentRoom(socket);

    const code = makeCode();
    const hostKey = crypto.randomBytes(32).toString("hex");

    rooms.set(code, {
      hostId: socket.id,
      hostKey,
      members: new Set(),
      track: null,
      playback: {
        playing: false,
        position: 0,
        startedAt: null
      },
      reconnectTimer: null
    });

    const room = rooms.get(code);
    joinSocketToRoom(socket, code, room);

    if (typeof callback === "function") {
      callback({ ok: true, code, hostKey });
    }

    sendRoomState(code);
  });

  socket.on("join-room", (input, callback) => {
    const rawCode =
      typeof input === "string" ? input : input?.code;

    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Room not found. Check the room code."
        });
      }
      return;
    }

    if (
      !room.members.has(socket.id) &&
      room.members.size >= 6
    ) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Room is full. Maximum 6 phones."
        });
      }
      return;
    }

    if (socket.data.roomCode && socket.data.roomCode !== code) {
      leaveCurrentRoom(socket);
    }

    joinSocketToRoom(socket, code, room);

    if (typeof callback === "function") {
      callback({ ok: true, code });
    }

    sendRoomState(code);
  });

  socket.on("rejoin-room", (data, callback) => {
    const code = String(data?.code || "").trim().toUpperCase();
    const hostKey = data?.hostKey;
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Room expired. Create a new room."
        });
      }
      return;
    }

    const isReturningHost =
      typeof hostKey === "string" &&
      hostKey.length > 0 &&
      room.hostKey === hostKey;

    if (
      !isReturningHost &&
      room.members.size >= 6
    ) {
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
      leaveCurrentRoom(socket);
    }

    if (isReturningHost) {
      if (room.reconnectTimer) {
        clearTimeout(room.reconnectTimer);
        room.reconnectTimer = null;
      }

      // Replace the disconnected host's socket ID.
      room.members.delete(room.hostId);
      room.hostId = socket.id;
    }

    joinSocketToRoom(socket, code, room);

    if (typeof callback === "function") {
      callback({
        ok: true,
        code,
        isHost: isReturningHost
      });
    }

    sendRoomState(code);
  });

  socket.on("set-youtube-track", (data, callback) => {
    const code = String(
      data?.code || socket.data.roomCode || ""
    ).trim().toUpperCase();

    const room = rooms.get(code);

    if (
      !room ||
      room.hostId !== socket.id ||
      room.hostKey !== data?.hostKey
    ) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Host verification failed. Create or rejoin your room."
        });
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
    const code = String(
      command?.code || socket.data.roomCode || ""
    ).trim().toUpperCase();

    const room = rooms.get(code);

    if (
      !room ||
      room.hostId !== socket.id ||
      room.hostKey !== command?.hostKey
    ) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Host verification failed. Rejoin the room."
        });
      }
      return;
    }

    if (!room.track) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Choose a YouTube song first."
        });
      }
      return;
    }

    const action = command?.action;
    const now = Date.now();
    const current = room.playback;

    if (action === "play") {
      room.playback = {
        playing: true,
        position: Math.max(0, Number(command.position) || 0),
        startedAt: now + 1500
      };
    } else if (action === "pause") {
      room.playback = {
        playing: false,
        position: Math.max(0, getCurrentPosition(current, now)),
        startedAt: null
      };
    } else if (action === "seek") {
      room.playback = {
        playing: current.playing,
        position: Math.max(0, Number(command.position) || 0),
        startedAt: current.playing ? now + 1500 : null
      };
    } else {
      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Unknown playback command."
        });
      }
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
    if (code) removeSocketFromRoom(socket, code);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Beat Sync running on port ${PORT}`);
});
