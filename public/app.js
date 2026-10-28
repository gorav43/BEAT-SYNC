
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
let hostId = null;
let currentTrack = null;
let player = null;
let playerReady = false;
let pendingPlayback = null;
let isHost = false;
let toastTimeout = null;
let lastCommandAt = 0;
let lastAppliedAction = "";

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 2800);
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
  connectionStatus.textContent = connected ? "Connected" : "Reconnecting";
  document.querySelector(".live-dot").style.background =
    connected ? "#27834b" : "#d99b28";
}

function getDisplayName(member, index) {
  if (member.id === mySocketId) {
    return nicknameInput.value.trim() || (isHost ? "You (Host)" : "You");
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
    const row = document.createElement("div");
    row.className = "member-row";

    const avatar = document.createElement("div");
    avatar.className = "member-avatar";
    avatar.textContent = getDisplayName(member, index).charAt(0).toUpperCase();

    const details = document.createElement("div");
    details.className = "member-details";

    const name = document.createElement("div");
    name.className = "member-name";
    name.textContent = getDisplayName(member, index);

    const role = document.createElement("div");
    role.className = "member-role";
    role.textContent = member.isHost ? "Room host" : "Connected listener";

    const online = document.createElement("span");
    online.className = "member-online";
    online.textContent = "Online";

    details.append(name, role);
    row.append(avatar, details, online);
    membersText.append(row);
  });
}

function resetPlayer() {
  playerReady = false;
  player = null;
  playerContainer.replaceChildren();
  playerPlaceholder.hidden = false;
  playbackStatus.textContent = "Waiting for a song";
  updateControls();
}

function onYouTubeIframeAPIReady() {
  if (!currentTrack) return;
  createPlayer(currentTrack.videoId);
}

window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function loadYouTubeAPI() {
  if (window.YT && window.YT.Player) {
    if (currentTrack) createPlayer(currentTrack.videoId);
    return;
  }

  if (document.getElementById("youtube-iframe-api")) return;

  const script = document.createElement("script");
  script.id = "youtube-iframe-api";
  script.src = "https://www.youtube.com/iframe_api";
  script.onerror = () => showToast("YouTube player could not load. Check your internet.");
  document.head.appendChild(script);
}

function createPlayer(videoId) {
  if (!window.YT || !window.YT.Player) return;

  playerReady = false;
  playerContainer.replaceChildren();
  playerPlaceholder.hidden = false;

  const element = document.createElement("div");
  element.id = "yt-player-frame";
  playerContainer.appendChild(element);

  player = new YT.Player("yt-player-frame", {
    width: "100%",
    height: "100%",
    videoId,
    playerVars: {
      playsinline: 1,
      controls: 1,
      rel: 0,
      origin: window.location.origin
    },
    events: {
      onReady: () => {
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
      onStateChange: event => {
        if (event.data === YT.PlayerState.PLAYING) {
          playbackStatus.textContent = "Playing";
        } else if (event.data === YT.PlayerState.PAUSED) {
          playbackStatus.textContent = "Paused";
        } else if (event.data === YT.PlayerState.ENDED) {
          playbackStatus.textContent = "Song ended";
        }
      },
      onError: event => {
        const errors = {
          2: "Invalid YouTube video ID.",
          5: "This video cannot play in the embedded player.",
          100: "Video not found or unavailable.",
          101: "The owner does not allow embedded playback.",
          150: "The owner does not allow embedded playback."
        };

        showToast(errors[event.data] || "YouTube could not play this video.");
        playbackStatus.textContent = "Video unavailable";
      }
    }
  });
}

function getExpectedPosition(command) {
  let position = Math.max(0, Number(command.position) || 0);

  if (command.playing && command.startedAt) {
    position += Math.max(0, Date.now() - command.startedAt) / 1000;
  }

  return position;
}

function applyPlayback(command) {
  if (!playerReady || !player) {
    pendingPlayback = command;
    return;
  }

  if (command.action === "load") {
    return;
  }

  const position = getExpectedPosition(command);
  lastAppliedAction = command.action;

  try {
    if (command.action === "pause" || command.playing === false) {
      player.pauseVideo();
      if (Number.isFinite(position)) player.seekTo(position, true);
      playbackStatus.textContent = "Paused";
      return;
    }

    if (command.action === "play" || command.playing === true ||
        command.action === "seek") {
      if (command.startedAt && Date.now() < command.startedAt) {
        player.pauseVideo();
        player.seekTo(Math.max(0, Number(command.position) || 0), true);

        setTimeout(() => {
          if (!playerReady || !player) return;

          if (Date.now() >= command.startedAt) {
            player.seekTo(getExpectedPosition(command), true);
            player.playVideo();
          }
        }, Math.max(0, command.startedAt - Date.now()));

        return;
      }

      player.seekTo(position, true);
      player.playVideo();
    }
  } catch {
    showToast("Playback could not start. Tap Play on this phone.");
  }
}

function createRoom() {
  socket.emit("create-room", response => {
    if (!response?.ok) {
      showToast("Could not create room. Try again.");
      return;
    }

    currentRoom = response.code;
    hostId = socket.id;
    isHost = true;
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

  socket.emit("join-room", code, response => {
    if (!response?.ok) {
      showToast(response?.error || "Could not join room.");
      return;
    }

    currentRoom = response.code;
    isHost = false;
    roomTitle.textContent = "Joined listening room";
    roomCodeDisplay.textContent = currentRoom;
    roomCodeBox.hidden = false;

    setStatus("Connected! Wait for the host to choose a song.");
    showToast("Successfully joined room");
    updateControls();
  });
}

function loadSong() {
  if (!isHost || !currentRoom) {
    showToast("Create a room first. Only the host can choose a song.");
    return;
  }

  const url = youtubeUrl.value.trim();

  if (!url) {
    showToast("Paste a YouTube link first.");
    return;
  }

  socket.emit("set-youtube-track", { url }, response => {
    if (!response?.ok) {
      showToast(response?.error || "Could not load the song.");
      return;
    }

    currentTrack = response.track;
    pendingPlayback = null;
    createPlayer(currentTrack.videoId);
    setStatus("Song loaded. Press Play for everyone.");
    playbackStatus.textContent = "Loading YouTube video";
    updateControls();
  });
}

function sendPlayback(action) {
  if (!isHost || !playerReady || !player) {
    showToast("Wait for the YouTube player to finish loading.");
    return;
  }

  const now = Date.now();

  // Prevent accidental repeated clicks.
  if (now - lastCommandAt < 350) return;
  lastCommandAt = now;

  let position = 0;

  try {
    position = player.getCurrentTime() || 0;
  } catch {
    showToast("Player is not ready yet.");
    return;
  }

  socket.emit("playback-command", { action, position }, response => {
    if (!response?.ok) {
      showToast(response?.error || "Playback command failed.");
    }
  });
}

socket.on("connect", () => {
  mySocketId = socket.id;
  setConnected(true);
});

socket.on("disconnect", () => {
  setConnected(false);
});

socket.on("room-state", state => {
  currentRoom = state.code;
  hostId = state.hostId;
  isHost = state.hostId === socket.id;

  roomTitle.textContent = isHost ? "Your listening room" : "Joined listening room";
  roomCodeDisplay.textContent = state.code;
  roomCodeBox.hidden = false;

  if (state.track?.type === "youtube") {
    const changedVideo = currentTrack?.videoId !== state.track.videoId;
    currentTrack = state.track;
    youtubeUrl.value = state.track.url;

    if (changedVideo) {
      createPlayer(state.track.videoId);
    }
  } else {
    currentTrack = null;
    resetPlayer();
  }

  renderMembers(state.members || []);
  updateControls();

  if (isHost) {
    setStatus("You're the host. Share the code and choose a YouTube song.");
  } else {
    setStatus("You're connected. The host controls the music.");
  }

  if (state.playback && currentTrack) {
    applyPlayback({
      ...state.playback,
      action: state.playback.playing ? "play" : "pause"
    });
  }
});

socket.on("playback-update", command => {
  if (command.action === "load") {
    currentTrack = { type: "youtube", videoId: command.videoId };
    pendingPlayback = null;
    createPlayer(command.videoId);
    return;
  }

  applyPlayback(command);
});

socket.on("room-closed", () => {
  currentRoom = null;
  hostId = null;
  currentTrack = null;
  isHost = false;

  roomTitle.textContent = "No room yet";
  roomCodeBox.hidden = true;
  renderMembers([]);
  resetPlayer();
  updateControls();
  setStatus("The host has left. This room is closed.");
  showToast("Room closed");
});

createBtn.addEventListener("click", createRoom);
joinBtn.addEventListener("click", joinRoom);
loadSongBtn.addEventListener("click", loadSong);

playBtn.addEventListener("click", () => sendPlayback("play"));
pauseBtn.addEventListener("click", () => sendPlayback("pause"));

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
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

loadYouTubeAPI();
updateControls();
