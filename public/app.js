
const socket = io();
const $ = (id) => document.getElementById(id);

const createBtn = $("createBtn");
const joinBtn = $("joinBtn");
const roomCodeInput = $("roomCode");
const nicknameInput = $("nickname");
const roomTitle = $("roomTitle");
const statusText = $("status");
const membersText = $("membersList");
const memberCount = $("memberCount");
const roomBadge = $("roomBadge");
const roomCodeBox = $("roomCodeBox");
const roomCodeDisplay = $("roomCodeDisplay");
const copyCodeBtn = $("copyCodeBtn");
const youtubeUrl = $("youtubeUrl");
const loadSongBtn = $("loadSongBtn");
const playerPlaceholder = $("playerPlaceholder");
const playerContainer = $("youtubePlayer");
const playBtn = $("playBtn");
const pauseBtn = $("pauseBtn");
const playbackStatus = $("playbackStatus");
const connectionStatus = $("connectionStatus");
const toast = $("toast");

let mySocketId = null;
let currentRoom = null;
let hostKey = null;
let currentTrack = null;
let player = null;
let playerReady = false;
let pendingPlayback = null;
let isHost = false;
let toastTimeout = null;
let lastCommandAt = 0;
let playbackTimer = null;
let playerGeneration = 0;
let lastPlaybackSignature = "";
let reconnectAttempted = false;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(
    () => toast.classList.remove("show"),
    3000
  );
}

function setStatus(message) {
  statusText.textContent = message;
}

function updateControls() {
  const hasRoom = Boolean(currentRoom);
  const hasTrack = Boolean(currentTrack);

  loadSongBtn.disabled = !isHost || !hasRoom;
  youtubeUrl.disabled = !isHost || !hasRoom;
  playBtn.disabled = !isHost || !hasTrack || !playerReady;
  pauseBtn.disabled = !isHost || !hasTrack || !playerReady;

  roomBadge.textContent = !hasRoom
    ? "NOT CONNECTED"
    : isHost
      ? "HOST ROOM"
      : "GUEST ROOM";
}

function setConnected(connected) {
  connectionStatus.textContent = connected
    ? "Connected"
    : "Reconnecting";

  const dot = document.querySelector(".live-dot");

  if (dot) {
    dot.style.background = connected ? "#27834b" : "#d99b28";
  }
}

function getDisplayName(member, index) {
  if (member.id === mySocketId) {
    return nicknameInput.value.trim() ||
      (member.isHost ? "You (Host)" : "You");
  }

  return member.isHost ? "Room Host" : `Listener ${index + 1}`;
}

function renderMembers(members) {
  memberCount.textContent = `${members.length} / 6`;

  if (!members.length) {
    membersText.innerHTML =
      '<p class="empty-members">No listeners connected yet.</p>';
    return;
  }

  membersText.replaceChildren();

  members.forEach((member, index) => {
    const displayName = getDisplayName(member, index);

    const row = document.createElement("div");
    row.className = "member-row";

    const avatar = document.createElement("div");
    avatar.className = "member-avatar";
    avatar.textContent = displayName.charAt(0).toUpperCase();

    const details = document.createElement("div");
    details.className = "member-details";

    const name = document.createElement("div");
    name.className = "member-name";
    name.textContent = displayName;

    const role = document.createElement("div");
    role.className = "member-role";
    role.textContent = member.isHost
      ? "Room host"
      : "Connected listener";

    const online = document.createElement("span");
    online.className = "member-online";
    online.textContent = "Online";

    details.append(name, role);
    row.append(avatar, details, online);
    membersText.append(row);
  });
}

function clearPlaybackTimer() {
  if (playbackTimer) clearTimeout(playbackTimer);
  playbackTimer = null;
}

function resetPlayer() {
  playerGeneration++;
  clearPlaybackTimer();

  const oldPlayer = player;
  player = null;
  playerReady = false;
  pendingPlayback = null;

  if (oldPlayer && typeof oldPlayer.destroy === "function") {
    try {
      oldPlayer.destroy();
    } catch {}
  }

  playerContainer.replaceChildren();
  playerPlaceholder.hidden = false;
  playbackStatus.textContent = "Waiting for a song";

  updateControls();
}

function loadYouTubeAPI() {
  if (window.YT && window.YT.Player) {
    if (currentTrack && (!player || !playerReady)) {
      createPlayer(currentTrack.videoId);
    }
    return;
  }

  if (document.getElementById("youtube-iframe-api")) return;

  const script = document.createElement("script");
  script.id = "youtube-iframe-api";
  script.src = "https://www.youtube.com/iframe_api";
  script.onerror = () => {
    showToast("YouTube player could not load. Check your internet.");
  };

  document.head.appendChild(script);
}

window.onYouTubeIframeAPIReady = () => {
  if (currentTrack) createPlayer(currentTrack.videoId);
};

function createPlayer(videoId) {
  if (!window.YT || !window.YT.Player) {
    loadYouTubeAPI();
    return;
  }

  resetPlayer();

  const generation = playerGeneration;
  const element = document.createElement("div");
  element.id = "yt-player-frame";
  playerContainer.appendChild(element);

  player = new YT.Player("yt-player-frame", {
    width: "100%",
    height: "100%",
    videoId,
    playerVars: {
      playsinline: 1,
      controls: 0,
      disablekb: 1,
      rel: 0,
      origin: window.location.origin
    },
    events: {
      onReady: () => {
        if (generation !== playerGeneration) return;

        playerReady = true;
        playerPlaceholder.hidden = true;
        playbackStatus.textContent = "Song ready";
        updateControls();

        if (pendingPlayback) {
          const command = pendingPlayback;
          pendingPlayback = null;
          applyPlayback(command);
        }
      },

      onStateChange: (event) => {
        if (generation !== playerGeneration) return;

        if (event.data === YT.PlayerState.PLAYING) {
          playbackStatus.textContent = "Playing";
        } else if (event.data === YT.PlayerState.PAUSED) {
          playbackStatus.textContent = "Paused";
        } else if (event.data === YT.PlayerState.ENDED) {
          playbackStatus.textContent = "Song ended";
        }
      },

      onError: (event) => {
        if (generation !== playerGeneration) return;

        const errors = {
          2: "Invalid YouTube video ID.",
          5: "This video cannot play in the embedded player.",
          100: "Video not found or unavailable.",
          101: "The owner does not allow embedded playback.",
          150: "The owner does not allow embedded playback."
        };

        showToast(
          errors[event.data] || "YouTube could not play this video."
        );

        playbackStatus.textContent = "Video unavailable";
      }
    }
  });
}

function getExpectedPosition(command) {
  let position = Math.max(0, Number(command.position) || 0);

  if (command.playing && command.startedAt) {
    position += Math.max(
      0,
      Date.now() - Number(command.startedAt)
    ) / 1000;
  }

  return position;
}

function applyPlayback(command) {
  if (!command) return;

  const signature =
    `${command.action}|${command.position}|${command.playing}|${command.startedAt}`;

  if (
    signature === lastPlaybackSignature &&
    command.action !== "load"
  ) {
    return;
  }

  lastPlaybackSignature = signature;

  if (!playerReady || !player) {
    pendingPlayback = command;
    return;
  }

  if (command.action === "load") return;

  clearPlaybackTimer();

  const position = getExpectedPosition(command);

  try {
    if (command.action === "pause" || command.playing === false) {
      player.pauseVideo();
      player.seekTo(position, true);
      playbackStatus.textContent = "Paused";
      return;
    }

    if (
      command.action === "play" ||
      command.playing === true ||
      command.action === "seek"
    ) {
      const startAt = Number(command.startedAt) || 0;

      if (startAt > Date.now()) {
        player.pauseVideo();
        player.seekTo(
          Math.max(0, Number(command.position) || 0),
          true
        );

        playbackTimer = setTimeout(() => {
          playbackTimer = null;
          if (!playerReady || !player) return;

          player.seekTo(getExpectedPosition(command), true);
          player.playVideo();
        }, startAt - Date.now());
      } else {
        player.seekTo(position, true);
        player.playVideo();
      }
    }
  } catch {
    showToast(
      "Playback could not start. Tap the video once, then press Play."
    );
  }
}

function createRoom() {
  socket.emit("create-room", (response) => {
    if (!response?.ok) {
      showToast("Could not create room. Try again.");
      return;
    }

    currentRoom = response.code;
    hostKey = response.hostKey;
    isHost = true;
    currentTrack = null;
    lastPlaybackSignature = "";

    // Save the room details so the host can reconnect.
    localStorage.setItem("beatSyncRoom", currentRoom);
    localStorage.setItem("beatSyncHostKey", hostKey);

    roomTitle.textContent = "Your listening room";
    roomCodeDisplay.textContent = currentRoom;
    roomCodeBox.hidden = false;

    setStatus("Room created! Share the code with your friends.");
    showToast(`Room ${currentRoom} created`);

    updateControls();
  });
}

function joinRoom() {
  const code = roomCodeInput.value.trim().toUpperCase();

  if (code.length !== 6) {
    showToast("Enter the 6-character room code.");
    return;
  }

  socket.emit("join-room", code, (response) => {
    if (!response?.ok) {
      showToast(response?.error || "Could not join room.");
      return;
    }

    currentRoom = response.code;
    hostKey = null;
    isHost = false;
    currentTrack = null;
    lastPlaybackSignature = "";

    localStorage.setItem("beatSyncRoom", currentRoom);
    localStorage.removeItem("beatSyncHostKey");

    roomTitle.textContent = "Joined listening room";
    roomCodeDisplay.textContent = currentRoom;
    roomCodeBox.hidden = false;

    setStatus("Connected! Wait for the host to choose a song.");
    showToast("Successfully joined room");

    updateControls();
  });
}

function loadSong() {
  if (!isHost || !currentRoom || !hostKey) {
    showToast("Create or reconnect to your host room first.");
    return;
  }

  const url = youtubeUrl.value.trim();

  if (!url) {
    showToast("Paste a YouTube link first.");
    return;
  }

  socket.emit(
    "set-youtube-track",
    {
      url,
      code: currentRoom,
      hostKey
    },
    (response) => {
      if (!response?.ok) {
        showToast(response?.error || "Could not load the song.");
        return;
      }

      currentTrack = response.track;
      pendingPlayback = null;
      lastPlaybackSignature = "";

      setStatus("Song loaded. Press Play for everyone.");
      playbackStatus.textContent = "Loading YouTube video";

      updateControls();
    }
  );
}

function sendPlayback(action) {
  if (!isHost || !hostKey || !playerReady || !player) {
    showToast("Wait for the YouTube player to finish loading.");
    return;
  }

  const now = Date.now();

  if (now - lastCommandAt < 350) return;
  lastCommandAt = now;

  let position = 0;

  try {
    position = player.getCurrentTime() || 0;
  } catch {
    showToast("Player is not ready yet.");
    return;
  }

  socket.emit(
    "playback-command",
    {
      action,
      position,
      code: currentRoom,
      hostKey
    },
    (response) => {
      if (!response?.ok) {
        showToast(response?.error || "Playback command failed.");
      }
    }
  );
}

function attemptRejoin() {
  if (reconnectAttempted || !socket.connected) return;

  const savedRoom = localStorage.getItem("beatSyncRoom");
  const savedHostKey = localStorage.getItem("beatSyncHostKey");

  if (!savedRoom) return;

  reconnectAttempted = true;

  socket.emit(
    "rejoin-room",
    {
      code: savedRoom,
      hostKey: savedHostKey || null
    },
    (response) => {
      if (!response?.ok) {
        currentRoom = null;
        hostKey = null;
        isHost = false;

        localStorage.removeItem("beatSyncRoom");
        localStorage.removeItem("beatSyncHostKey");

        updateControls();
        showToast(response?.error || "Could not reconnect. Create or join a room.");
        return;
      }

      currentRoom = response.code;
      isHost = Boolean(response.isHost);
      hostKey = response.isHost ? savedHostKey : null;

      if (!isHost) {
        localStorage.removeItem("beatSyncHostKey");
      }

      roomCodeDisplay.textContent = currentRoom;
      roomCodeBox.hidden = false;

      roomTitle.textContent = isHost
        ? "Your listening room"
        : "Joined listening room";

      setStatus(
        isHost
          ? "Host reconnected. Your room is ready."
          : "Reconnected to the listening room."
      );

      updateControls();
    }
  );
}

socket.on("connect", () => {
  mySocketId = socket.id;
  reconnectAttempted = false;
  setConnected(true);
  attemptRejoin();
});

socket.on("disconnect", () => {
  setConnected(false);
});

socket.on("room-state", (state) => {
  currentRoom = state.code;
  isHost = state.hostId === socket.id;

  roomTitle.textContent = isHost
    ? "Your listening room"
    : "Joined listening room";

  roomCodeDisplay.textContent = state.code;
  roomCodeBox.hidden = false;

  if (state.track?.type === "youtube") {
    const changedVideo =
      currentTrack?.videoId !== state.track.videoId;

    currentTrack = state.track;
    youtubeUrl.value =
      state.track.url ||
      `https://www.youtube.com/watch?v=${state.track.videoId}`;

    if (changedVideo) {
      createPlayer(state.track.videoId);
    }
  } else if (!state.track) {
    currentTrack = null;
    resetPlayer();
  }

  renderMembers(state.members || []);
  updateControls();

  setStatus(
    isHost
      ? "You're the host. Share the code and choose a YouTube song."
      : "You're connected. The host controls the music."
  );

  if (state.playback && currentTrack) {
    applyPlayback({
      ...state.playback,
      action: state.playback.playing ? "play" : "pause"
    });
  }
});

socket.on("playback-update", (command) => {
  if (command.action === "load") {
    currentTrack = {
      type: "youtube",
      videoId: command.videoId,
      url: `https://www.youtube.com/watch?v=${command.videoId}`
    };

    pendingPlayback = null;
    lastPlaybackSignature = "";

    createPlayer(command.videoId);
    return;
  }

  applyPlayback(command);
});

socket.on("room-closed", () => {
  currentRoom = null;
  hostKey = null;
  currentTrack = null;
  isHost = false;
  reconnectAttempted = false;
  lastPlaybackSignature = "";

  localStorage.removeItem("beatSyncRoom");
  localStorage.removeItem("beatSyncHostKey");

  roomTitle.textContent = "No room yet";
  roomCodeBox.hidden = true;

  renderMembers([]);
  resetPlayer();
  updateControls();

  setStatus("The room has closed.");
  showToast("Room closed");
});

createBtn.addEventListener("click", createRoom);
joinBtn.addEventListener("click", joinRoom);
loadSongBtn.addEventListener("click", loadSong);

playBtn.addEventListener("click", () => {
  sendPlayback("play");
});

pauseBtn.addEventListener("click", () => {
  sendPlayback("pause");
});

copyCodeBtn.addEventListener("click", async () => {
  if (!currentRoom) return;

  try {
    await navigator.clipboard.writeText(currentRoom);
    showToast("Room code copied!");
  } catch {
    showToast(`Room code: ${currentRoom}`);
  }
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
});

loadYouTubeAPI();
updateControls();
