const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3100;
const rooms = new Map();

const RECONNECT_GRACE_MS = 60_000;

// All clients get this much preparation time before playback.
const PLAY_START_DELAY_MS = 5000;

// Small delay for seek operations while playing.
const SEEK_START_DELAY_MS = 1500;

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------------------------
// ROOM HELPERS
// -----------------------------------------

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

    const validHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com"
    ];

    if (!validHosts.includes(host)) {
      return null;
    }

    if (url.pathname === "/watch") {
      return url.searchParams.get("v");
    }

    const parts = url.pathname.split("/").filter(Boolean);

    if (["embed", "shorts", "live"].includes(parts[0])) {
      return parts[1] || null;
    }
  } catch {
    return null;
  }

  return null;
}

function getCurrentPosition(playback, now = Date.now()) {
  if (!playback || !playback.playing || !playback.startedAt) {
    return Math.max(0, Number(playback?.position) || 0);
  }

  const elapsed = Math.max(0, now - playback.startedAt) / 1000;

  return Math.max(0, (Number(playback.position) || 0) + elapsed);
}

function getRoomSnapshot(room, code) {
  return {
    code,
    hostId: room.hostId,

    members: [...room.members].map((id) => ({
      id,
      isHost: id === room.hostId
    })),

    track: room.track,

    // Keep the original server timestamp.
    // Clients calculate the current position using synchronized server time.
    playback: {
      playing: room.playback.playing,
      position: room.playback.position,
      startedAt: room.playback.startedAt
    },

    serverTime: Date.now()
  };
}

function sendRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;

  io.to(code).emit("room-state", getRoomSnapshot(room, code));
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

function sendCallback(callback, data) {
  if (typeof callback === "function") {
    callback(data);
  }
}

// -----------------------------------------
// SOCKET CONNECTION
// -----------------------------------------

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ---------------------------------------
  // SERVER CLOCK SYNCHRONIZATION
  // ---------------------------------------

  socket.on("clock-sync", (callback) => {
    sendCallback(callback, {
      serverTime: Date.now()
    });
  });

  // ---------------------------------------
  // CREATE ROOM
  // ---------------------------------------

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

    sendCallback(callback, {
      ok: true,
      code,
      hostKey
    });

    sendRoomState(code);

    console.log("Room created:", code);
  });

  // ---------------------------------------
  // JOIN ROOM
  // ---------------------------------------

  socket.on("join-room", (input, callback) => {
    const rawCode =
      typeof input === "string" ? input : input?.code;

    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      sendCallback(callback, {
        ok: false,
        error: "Room not found. Check the room code."
      });
      return;
    }

    if (
      !room.members.has(socket.id) &&
      room.members.size >= 6
    ) {
      sendCallback(callback, {
        ok: false,
        error: "Room is full. Maximum 6 phones."
      });
      return;
    }

    if (socket.data.roomCode && socket.data.roomCode !== code) {
      leaveCurrentRoom(socket);
    }

    joinSocketToRoom(socket, code, room);

    sendCallback(callback, {
      ok: true,
      code
    });

    sendRoomState(code);

    console.log("Joined room:", code, socket.id);
  });

  // ---------------------------------------
  // REJOIN ROOM AFTER RECONNECT
  // ---------------------------------------

  socket.on("rejoin-room", (data, callback) => {
    const code = String(data?.code || "").trim().toUpperCase();
    const hostKey = data?.hostKey;

    const room = rooms.get(code);

    if (!room) {
      sendCallback(callback, {
        ok: false,
        error: "Room expired. Create a new room."
      });
      return;
    }

    const isReturningHost =
      typeof hostKey === "string" &&
      hostKey.length > 0 &&
      room.hostKey === hostKey;

    if (
      !isReturningHost &&
      !room.members.has(socket.id) &&
      room.members.size >= 6
    ) {
      sendCallback(callback, {
        ok: false,
        error: "Room is full. Maximum 6 phones."
      });
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

      // Replace old host socket ID with the new connection.
      room.members.delete(room.hostId);
      room.hostId = socket.id;
    }

    joinSocketToRoom(socket, code, room);

    sendCallback(callback, {
      ok: true,
      code,
      isHost: isReturningHost
    });

    sendRoomState(code);

    console.log(
      isReturningHost ? "Host reconnected:" : "Member reconnected:",
      code
    );
  });

  // ---------------------------------------
  // SET YOUTUBE TRACK
  // ---------------------------------------

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
      sendCallback(callback, {
        ok: false,
        error: "Host verification failed. Create or rejoin your room."
      });
      return;
    }

    const videoId = getVideoId(String(data?.url || ""));

    if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
      sendCallback(callback, {
        ok: false,
        error: "Please enter a valid YouTube video link."
      });
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
      startedAt: null,
      serverTime: Date.now()
    });

    sendRoomState(code);

    sendCallback(callback, {
      ok: true,
      track: room.track
    });

    console.log("Track loaded:", videoId, "Room:", code);
  });

  // ---------------------------------------
  // PLAY / PAUSE / SEEK
  // ---------------------------------------

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
      sendCallback(callback, {
        ok: false,
        error: "Host verification failed. Rejoin the room."
      });
      return;
    }

    if (!room.track) {
      sendCallback(callback, {
        ok: false,
        error: "Choose a YouTube song first."
      });
      return;
    }

    const action = command?.action;
    const now = Date.now();
    const current = room.playback;

    if (action === "play") {
      const position = Math.max(
        0,
        Number(command.position) || 0
      );

      room.playback = {
        playing: true,
        position,
        startedAt: now + PLAY_START_DELAY_MS
      };
    } else if (action === "pause") {
      room.playback = {
        playing: false,
        position: getCurrentPosition(current, now),
        startedAt: null
      };
    } else if (action === "seek") {
      const position = Math.max(
        0,
        Number(command.position) || 0
      );

      room.playback = {
        playing: current.playing,
        position,
        startedAt: current.playing
          ? now + SEEK_START_DELAY_MS
          : null
      };
    } else {
      sendCallback(callback, {
        ok: false,
        error: "Unknown playback command."
      });
      return;
    }

    io.to(code).emit("playback-update", {
      action,
      position: room.playback.position,
      playing: room.playback.playing,
      startedAt: room.playback.startedAt,
      serverTime: Date.now()
    });

    sendCallback(callback, {
      ok: true,
      startedAt: room.playback.startedAt
    });

    console.log(
      "Playback command:",
      action,
      "Room:",
      code
    );
  });

  // ---------------------------------------
  // DISCONNECT
  // ---------------------------------------

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    const code = socket.data.roomCode;

    if (code) {
      removeSocketFromRoom(socket, code);
    }
  });
});

// -----------------------------------------
// START SERVER
// -----------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Beat Sync running on port ${PORT}`);
});
