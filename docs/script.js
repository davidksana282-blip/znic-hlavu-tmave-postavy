const holes = Array.from(document.querySelectorAll(".hole"));
const scoreEl = document.getElementById("score");
const timeEl = document.getElementById("time");
const livesEl = document.getElementById("lives");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const hammer = document.getElementById("hammer");
const gameOverEl = document.getElementById("gameOver");
const retryBtn = document.getElementById("retryBtn");
const quitBtn = document.getElementById("quitBtn");
const menuEl = document.getElementById("menu");
const gameTitleEl = document.getElementById("gameTitle");
const gameSubtitleEl = document.getElementById("gameSubtitle");
const leaderSubtitleEl = document.getElementById("leaderSubtitle");
const gameTiles = Array.from(document.querySelectorAll(".game-tile"));
const authEl = document.getElementById("auth");
const authTitle = document.getElementById("authTitle");
const authDesc = document.getElementById("authDesc");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const authNickname = document.getElementById("authNickname");
const authBtn = document.getElementById("authBtn");
const authSwitch = document.getElementById("authSwitch");
const authError = document.getElementById("authError");
const leaderList = document.getElementById("leaderList");
const headSrc = "assets/head.png";
const activeHeads = new Map();

let lastHole = null;
let timeUp = true;
let score = 0;
let timeLeft = 30;
let livesLeft = 3;
let popTimer = null;
let countdownTimer = null;
let activeHoles = [];
let gameOver = false;
let unlocked = false;
let authMode = "register";
let nickname = "";
let email = "";
let comboStreak = 0;
let comboLevel = 0;
let currentGame = null;

const GAMES = {
  bonk: {
    title: "Bonk",
    subtitle: "Mlat kladivem, tref hlavu a udrz si tempo.",
    leaderboardLabel: "Bonk",
  },
};

const SUPABASE_URL = "https://akjtbrqnnsqmhzudrtbz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFranRicnFubnNxbWh6dWRydGJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2OTQxOTEsImV4cCI6MjA4OTI3MDE5MX0.zR_Ot1KcjUOq0HpZ757VC7Qiel5YikXoEM-QNWZi5Uo";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const SESSION_KEY = "zajac_session";
const SESSION_TTL = 60 * 60 * 1000;

const COMBO_STEP = 4;
const COMBO_MAX_LEVEL = 4;

function randomTime(min, max) {
  return Math.round(Math.random() * (max - min) + min);
}

function randomHole() {
  const idx = Math.floor(Math.random() * holes.length);
  const hole = holes[idx];
  if (hole === lastHole) {
    return randomHole();
  }
  lastHole = hole;
  return hole;
}

function createHead() {
  const img = document.createElement("img");
  img.className = "mole";
  img.alt = "hlava";
  img.src = headSrc;
  return img;
}

function spawnInHole(hole, lifeTime) {
  if (activeHeads.has(hole)) return;
  const img = createHead();
  hole.dataset.hit = "0";
  hole.classList.remove("bonked");
  hole.appendChild(img);
  hole.classList.add("up");
  img.classList.add("visible");
  activeHeads.set(hole, img);

  img.addEventListener(
    "pointerdown",
    (event) => {
      if (timeUp) return;
      if (!hole.classList.contains("up")) return;
      if (hole.dataset.hit === "1") return;
      hole.dataset.hit = "1";
      hole.classList.add("bonked");
      applyHitScore();
      removeHead(hole, true);
      event.preventDefault();
    },
    { once: true }
  );

  window.setTimeout(() => {
    removeHead(hole, false);
  }, lifeTime);
}

function removeHead(hole, wasHitOverride) {
  const img = activeHeads.get(hole);
  if (!img) return;
  const wasHit = typeof wasHitOverride === "boolean" ? wasHitOverride : hole.dataset.hit === "1";
  hole.classList.remove("up", "bonked");
  hole.dataset.hit = "0";
  img.classList.remove("visible");
  if (img.parentElement === hole) hole.removeChild(img);
  activeHeads.delete(hole);
  if (!wasHit && !timeUp) {
    updateLives(-1);
    resetCombo();
  }
}

function showMole() {
  if (timeUp) return;
  const time = randomTime(600, 1200);
  const count = Math.random() < 0.25 ? 2 : 1;
  activeHoles = [];
  for (let i = 0; i < count; i += 1) {
    const hole = randomHole();
    if (activeHoles.includes(hole)) continue;
    activeHoles.push(hole);
    spawnInHole(hole, time);
  }

  popTimer = setTimeout(() => {
    activeHoles.forEach((hole) => removeHead(hole, false));
    activeHoles = [];
    if (!timeUp) showMole();
  }, time);
}

function updateScore(value) {
  score += value;
  scoreEl.textContent = score;
}

function updateComboUI() {
  const comboEl = document.getElementById("combo");
  if (!comboEl) return;
  if (comboStreak <= 0) {
    comboEl.textContent = "x1";
    return;
  }
  comboEl.textContent = `x${(1 + comboLevel * 0.25).toFixed(2)}`;
}

function applyHitScore() {
  comboStreak += 1;
  comboLevel = Math.min(Math.floor(comboStreak / COMBO_STEP), COMBO_MAX_LEVEL);
  const multiplier = 1 + comboLevel * 0.25;
  const points = 1 + Math.floor((multiplier - 1) * 2 + 0.0001);
  updateScore(points);
  updateComboUI();
}

function resetCombo() {
  comboStreak = 0;
  comboLevel = 0;
  updateComboUI();
}

function updateLives(value) {
  livesLeft += value;
  livesEl.textContent = livesLeft;
  if (livesLeft <= 0) {
    finishGame(true);
  }
}

function resetBoard() {
  holes.forEach((hole) => {
    hole.classList.remove("up", "bonked");
    hole.dataset.hit = "0";
    const img = activeHeads.get(hole);
    if (img && img.parentElement === hole) hole.removeChild(img);
  });
  activeHeads.clear();
  activeHoles = [];
}

function startGame() {
  if (!unlocked) return;
  if (!currentGame) {
    menuEl.classList.remove("hidden");
    return;
  }
  clearTimeout(popTimer);
  clearInterval(countdownTimer);
  timeUp = false;
  gameOver = false;
  score = 0;
  timeLeft = 30;
  livesLeft = 3;
  resetCombo();
  scoreEl.textContent = score;
  timeEl.textContent = timeLeft;
  livesEl.textContent = livesLeft;
  gameOverEl.classList.add("hidden");
  resetBoard();
  showMole();

  countdownTimer = setInterval(() => {
    timeLeft -= 1;
    timeEl.textContent = timeLeft;
    if (timeLeft <= 0) {
      finishGame(false);
    }
  }, 1000);
}

function finishGame(showLose) {
  timeUp = true;
  clearTimeout(popTimer);
  clearInterval(countdownTimer);
  holes.forEach((hole) => {
    hole.classList.remove("up", "bonked");
    hole.dataset.hit = "0";
    const img = activeHeads.get(hole);
    if (img && img.parentElement === hole) hole.removeChild(img);
  });
  activeHeads.clear();
  activeHoles = [];
  resetCombo();
  if (currentGame) {
    submitScore();
    loadLeaderboard();
  }
  if (showLose) {
    gameOver = true;
    gameOverEl.classList.remove("hidden");
  }
}

startBtn.addEventListener("click", startGame);
retryBtn.addEventListener("click", startGame);
quitBtn.addEventListener("click", () => {
  window.location.href = "https://www.youtube.com/watch?v=djFhsBAUdJ0";
});

function selectGame(gameId) {
  const config = GAMES[gameId];
  if (!config) return;
  currentGame = gameId;
  gameTitleEl.textContent = config.title;
  gameSubtitleEl.textContent = config.subtitle;
  leaderSubtitleEl.textContent = `Top skore hracu: ${config.leaderboardLabel}`;
  menuEl.classList.add("hidden");
  showAuthIfNeeded();
  loadLeaderboard();
}

function showAuthIfNeeded() {
  if (unlocked) {
    authEl.classList.add("hidden");
    return;
  }
  authEl.classList.remove("hidden");
}

function setAuthMode(mode) {
  authMode = mode;
  if (authMode === "login") {
    authTitle.textContent = "Prihlaseni";
    authDesc.textContent = "Pokracuj se svym uctem.";
    authNickname.classList.add("hidden");
    authBtn.textContent = "Prihlasit";
    authSwitch.textContent = "Nemam ucet";
  } else {
    authTitle.textContent = "Registrace";
    authDesc.textContent = "Zaregistruj se a vyber si jedinecny nickname.";
    authNickname.classList.remove("hidden");
    authBtn.textContent = "Registrovat";
    authSwitch.textContent = "Mam ucet";
  }
  authError.classList.add("hidden");
}

async function hashPassword(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function registerUser() {
  const emailValue = authEmail.value.trim().toLowerCase();
  const passwordValue = authPassword.value.trim();
  const nicknameValue = authNickname.value.trim();
  if (!emailValue || !passwordValue || passwordValue.length < 8 || nicknameValue.length < 3) {
    authError.textContent = "Zadej email, heslo (min. 8 znaku) a nickname (min. 3 znaky).";
    authError.classList.remove("hidden");
    return;
  }
  const passwordHash = await hashPassword(passwordValue);
  const { error } = await supabaseClient.from("players").insert([
    {
      email: emailValue,
      nickname: nicknameValue,
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
    },
  ]);
  if (error) {
    authError.textContent = "Email nebo nickname je uz obsazeny.";
    authError.classList.remove("hidden");
    return;
  }
  unlocked = true;
  nickname = nicknameValue;
  email = emailValue;
  const session = {
    nickname,
    email,
    expiresAt: Date.now() + SESSION_TTL,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  authEl.classList.add("hidden");
  authEmail.value = "";
  authPassword.value = "";
  authNickname.value = "";
}

async function loginUser() {
  const emailValue = authEmail.value.trim().toLowerCase();
  const passwordValue = authPassword.value.trim();
  if (!emailValue || !passwordValue) {
    authError.textContent = "Zadej email a heslo.";
    authError.classList.remove("hidden");
    return;
  }
  const passwordHash = await hashPassword(passwordValue);
  const { data, error } = await supabaseClient
    .from("players")
    .select("nickname, password_hash")
    .eq("email", emailValue)
    .maybeSingle();
  if (error || !data) {
    authError.textContent = "Ucet neexistuje.";
    authError.classList.remove("hidden");
    return;
  }
  if (data.password_hash !== passwordHash) {
    authError.textContent = "Spatne heslo.";
    authError.classList.remove("hidden");
    return;
  }
  unlocked = true;
  nickname = data.nickname;
  email = emailValue;
  const session = {
    nickname,
    email,
    expiresAt: Date.now() + SESSION_TTL,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  authEl.classList.add("hidden");
  authPassword.value = "";
}

authBtn.addEventListener("click", () => {
  if (authMode === "login") {
    loginUser();
  } else {
    registerUser();
  }
});

authSwitch.addEventListener("click", () => {
  setAuthMode(authMode === "login" ? "register" : "login");
});

async function loadLeaderboard() {
  if (!leaderList) return;
  if (!currentGame) {
    leaderList.innerHTML = "<li>Nejdrive vyber hru.</li>";
    return;
  }
  const { data, error } = await supabaseClient
    .from("leaderboard")
    .select("nickname, score")
    .eq("game", currentGame)
    .order("score", { ascending: false })
    .limit(10);

  if (error) {
    leaderList.innerHTML = "<li>Nepodarilo se nacist leaderboard.</li>";
    return;
  }

  if (!data || data.length === 0) {
    leaderList.innerHTML = "<li>Zatim bez skore.</li>";
    return;
  }

  leaderList.innerHTML = data
    .map(
      (row) =>
        `<li><span class="leader-name">${row.nickname}</span><span class="leader-score">${row.score}</span></li>`
    )
    .join("");
}

async function submitScore() {
  if (!nickname || score <= 0 || !currentGame) return;
  const { data } = await supabaseClient
    .from("leaderboard")
    .select("score")
    .eq("nickname", nickname)
    .eq("game", currentGame)
    .limit(1)
    .maybeSingle();

  if (data && data.score >= score) return;
  await supabaseClient
    .from("leaderboard")
    .upsert([{ nickname, score, game: currentGame }], { onConflict: "nickname,game" });
}

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    startGame();
  }
});

window.addEventListener("pointermove", (event) => {
  hammer.style.setProperty("--x", `${event.clientX - 40}px`);
  hammer.style.setProperty("--y", `${event.clientY - 40}px`);
});

window.addEventListener("pointerdown", () => {
  hammer.classList.add("swing");
  window.setTimeout(() => hammer.classList.remove("swing"), 120);
});

stopBtn.addEventListener("click", () => finishGame(false));
window.addEventListener("blur", finishGame);

function restoreSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return;
  try {
    const session = JSON.parse(raw);
    if (session.expiresAt && session.expiresAt > Date.now() && session.nickname && session.email) {
      unlocked = true;
      nickname = session.nickname;
      email = session.email;
      if (currentGame) authEl.classList.add("hidden");
      return;
    }
  } catch {
    // ignore invalid session
  }
  localStorage.removeItem(SESSION_KEY);
}

resetBoard();
loadLeaderboard();
restoreSession();
setAuthMode("register");
authEl.classList.add("hidden");
gameTiles.forEach((tile) => {
  tile.addEventListener("click", () => {
    selectGame(tile.dataset.game);
  });
});
