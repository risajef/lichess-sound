const API_BASE = 'https://lichess.org';
const MIN_SIGNAL_INTERVAL_MS = 400;
const MAX_SIGNAL_INTERVAL_MS = 3000;
const TONE_DURATION_SECONDS = 0.105;
const TONE_GAP_SECONDS = 0.075;

const els = {
  form: document.querySelector('#connection-form'),
  token: document.querySelector('#api-token'),
  connect: document.querySelector('#connect-button'),
  connectionStatus: document.querySelector('#connection-status'),
  monitor: document.querySelector('#monitor-panel'),
  seekForm: document.querySelector('#seek-form'),
  timeControl: document.querySelector('#time-control'),
  ratedGame: document.querySelector('#rated-game'),
  findOpponent: document.querySelector('#find-opponent'),
  cancelSeek: document.querySelector('#cancel-seek'),
  seekStatus: document.querySelector('#seek-status'),
  gamePicker: document.querySelector('#game-picker'),
  gameSelect: document.querySelector('#game-select'),
  watchGame: document.querySelector('#watch-game-button'),
  gameSummary: document.querySelector('#game-summary'),
  opponentName: document.querySelector('#opponent-name'),
  playerColor: document.querySelector('#player-color'),
  openGameLink: document.querySelector('#open-game-link'),
  ownClock: document.querySelector('#own-clock'),
  opponentClock: document.querySelector('#opponent-clock'),
  ownFill: document.querySelector('#own-clock-fill'),
  opponentFill: document.querySelector('#opponent-clock-fill'),
  gameStatus: document.querySelector('#game-status'),
  soundToggle: document.querySelector('#sound-toggle'),
  testSound: document.querySelector('#test-sound'),
  disconnect: document.querySelector('#disconnect-button'),
  volume: document.querySelector('#volume'),
};

const state = {
  token: '',
  username: '',
  games: [],
  activeGameId: '',
  color: '',
  initialClockMs: 0,
  initialTurn: 'white',
  clockState: null,
  lastStateAt: 0,
  audioContext: null,
  eventController: null,
  eventReadyPromise: null,
  gameController: null,
  seekController: null,
  failedGameIds: new Set(),
  soundTimer: 0,
  renderTimer: 0,
  soundEnabled: true,
  connected: false,
};

function setConnectionMessage(message, kind = 'normal') {
  els.connectionStatus.textContent = message;
  els.connectionStatus.dataset.kind = kind;
}

function setGameMessage(message) {
  els.gameStatus.textContent = message;
}

function setSeekMessage(message) {
  els.seekStatus.textContent = message;
}

function updateSeekControls() {
  const seeking = Boolean(state.seekController);
  const disabled = !state.connected || Boolean(state.activeGameId) || seeking;
  els.findOpponent.disabled = disabled;
  els.timeControl.disabled = disabled;
  els.ratedGame.disabled = disabled;
  els.cancelSeek.hidden = !seeking;
  els.cancelSeek.disabled = !seeking;
}

function displayName(user) {
  return user?.name || user?.id || 'Unbekannt';
}

function secondsLabel(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function safeApiError(response) {
  if (response.status === 401 || response.status === 403) {
    return 'Der Token ist ungültig oder hat nicht die Berechtigung board:play.';
  }
  if (response.status === 429) {
    return 'Lichess bittet um eine Pause. Warte eine Minute und verbinde dich erneut.';
  }
  if (response.status === 404) {
    return 'Die Partie ist nicht verfügbar oder kann nicht über die Board-API überwacht werden.';
  }
  return `Lichess antwortet mit HTTP ${response.status}.`;
}

async function apiFetch(path, options = {}) {
  const { accept = 'application/json', ...fetchOptions } = options;
  const response = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: accept,
      ...options.headers,
    },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(safeApiError(response));
  return response;
}

async function readNdjson(response, onMessage, signal) {
  if (!response.body) throw new Error('Der Browser kann diesen Lichess-Datenstrom nicht lesen.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onMessage(JSON.parse(trimmed));
      }
    }
    const lastLine = buffer.trim();
    if (lastLine && !signal.aborted) onMessage(JSON.parse(lastLine));
  } finally {
    reader.releaseLock();
  }
}

async function ensureAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Dieser Browser unterstützt keine Web-Audio-Ausgabe.');
  if (!state.audioContext) state.audioContext = new AudioContextClass();
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
}

function playNote(frequency, startAt, level = Number(els.volume.value) / 100) {
  const context = state.audioContext;
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const start = Math.max(startAt, context.currentTime);
  const end = start + TONE_DURATION_SECONDS;
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * 0.12), start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(end + 0.01);
}

function soundPair(ownMs, opponentMs) {
  const maxClock = Math.max(1, state.initialClockMs, ownMs, opponentMs);
  const frequency = time => 300 + 750 * Math.sqrt(Math.max(0, Math.min(1, time / maxClock)));
  const now = state.audioContext?.currentTime || 0;
  playNote(frequency(ownMs), now);
  playNote(frequency(opponentMs), now + TONE_DURATION_SECONDS + TONE_GAP_SECONDS);
}

function currentClocks(now = performance.now()) {
  if (!state.clockState || !state.color) return null;
  const { wtime, btime, moves = '' } = state.clockState;
  const moveCount = moves.trim() ? moves.trim().split(/\s+/).length : 0;
  const whiteTurn = state.initialTurn === 'black' ? moveCount % 2 === 1 : moveCount % 2 === 0;
  const currentTurn = whiteTurn ? 'white' : 'black';
  const elapsed = now - state.lastStateAt;
  const whiteMs = Math.max(0, wtime - (currentTurn === 'white' ? elapsed : 0));
  const blackMs = Math.max(0, btime - (currentTurn === 'black' ? elapsed : 0));
  const ownMs = state.color === 'white' ? whiteMs : blackMs;
  const opponentMs = state.color === 'white' ? blackMs : whiteMs;
  return { ownMs, opponentMs, currentTurn };
}

function signalInterval(ownMs) {
  const ratio = state.initialClockMs > 0 ? Math.min(1, ownMs / state.initialClockMs) : 0;
  return MIN_SIGNAL_INTERVAL_MS + (MAX_SIGNAL_INTERVAL_MS - MIN_SIGNAL_INTERVAL_MS) * Math.sqrt(ratio);
}

function updateClocks() {
  const clocks = currentClocks();
  if (!clocks) return;
  const maxClock = Math.max(state.initialClockMs, clocks.ownMs, clocks.opponentMs, 1);
  els.ownClock.textContent = secondsLabel(clocks.ownMs);
  els.opponentClock.textContent = secondsLabel(clocks.opponentMs);
  els.ownFill.style.width = `${Math.max(0, Math.min(100, clocks.ownMs / maxClock * 100))}%`;
  els.opponentFill.style.width = `${Math.max(0, Math.min(100, clocks.opponentMs / maxClock * 100))}%`;
}

function scheduleSignal(immediate = false) {
  window.clearTimeout(state.soundTimer);
  if (!state.soundEnabled || !state.connected || !state.clockState || state.clockState.status !== 'started') return;
  const clocks = currentClocks();
  if (!clocks || clocks.ownMs <= 0) return;
  if (immediate) soundPair(clocks.ownMs, clocks.opponentMs);
  state.soundTimer = window.setTimeout(() => {
    const latest = currentClocks();
    if (!latest || latest.ownMs <= 0) {
      setGameMessage('Deine Zeit ist abgelaufen.');
      return;
    }
    soundPair(latest.ownMs, latest.opponentMs);
    scheduleSignal();
  }, signalInterval(clocks.ownMs));
}

function clearTimers() {
  window.clearTimeout(state.soundTimer);
  window.clearInterval(state.renderTimer);
  state.soundTimer = 0;
  state.renderTimer = 0;
}

function stopStreams() {
  state.eventController?.abort();
  state.gameController?.abort();
  state.seekController?.abort();
  state.eventController = null;
  state.eventReadyPromise = null;
  state.gameController = null;
  state.seekController = null;
  updateSeekControls();
}

function closeGameDisplay() {
  state.activeGameId = '';
  state.color = '';
  state.clockState = null;
  state.initialClockMs = 0;
  clearTimers();
  els.gameSummary.hidden = true;
  els.openGameLink.hidden = true;
  els.soundToggle.disabled = true;
  els.testSound.disabled = !state.connected;
  els.ownClock.textContent = '--:--';
  els.opponentClock.textContent = '--:--';
  els.ownFill.style.width = '0%';
  els.opponentFill.style.width = '0%';
  updateSeekControls();
}

function ownColorFromGame(game) {
  const account = state.username.toLowerCase();
  const whiteId = (game.white?.id || game.white?.name || '').toLowerCase();
  const blackId = (game.black?.id || game.black?.name || '').toLowerCase();
  if (account && account === whiteId) return 'white';
  if (account && account === blackId) return 'black';
  return '';
}

function renderGameChoice(game) {
  const ownColor = game.color === 'white' ? 'Weiss' : 'Schwarz';
  const opponent = game.opponent?.username || 'Gegner';
  const speed = game.speed ? ` · ${game.speed}` : '';
  return `${opponent} · du spielst ${ownColor}${speed}`;
}

function showGameChoices(games) {
  state.games = games;
  els.gameSelect.replaceChildren();
  games.forEach((game, index) => {
    const option = document.createElement('option');
    option.value = game.gameId;
    option.textContent = renderGameChoice(game);
    if (index === 0) option.selected = true;
    els.gameSelect.append(option);
  });
  els.gamePicker.hidden = games.length < 2;
}

async function loadCurrentGames() {
  const response = await apiFetch('/api/account/playing?nb=50');
  const data = await response.json();
  return data.nowPlaying || [];
}

async function monitorSelectedGame(gameId) {
  if (!gameId || !state.connected) return;
  state.eventController?.abort();
  state.eventController = null;
  state.eventReadyPromise = null;
  if (state.seekController) {
    state.seekController.abort();
    state.seekController = null;
    setSeekMessage('Partie gefunden. Die Gegnersuche ist beendet.');
  }
  state.gameController?.abort();
  clearTimers();
  closeGameDisplay();
  state.failedGameIds.delete(gameId);
  state.activeGameId = gameId;
  updateSeekControls();
  state.gameController = new AbortController();
  const controller = state.gameController;
  setGameMessage('Verbinde mit dem Spielestream …');
  els.gameSummary.hidden = false;
  els.opponentName.textContent = 'Lade Partie …';
  els.playerColor.textContent = '';

  try {
    const response = await apiFetch(`/api/board/game/stream/${encodeURIComponent(gameId)}`, {
      accept: 'application/x-ndjson',
      signal: controller.signal,
    });
    await readNdjson(response, event => {
      if (event.type === 'gameFull') handleGameFull(event);
      else if (event.type === 'gameState') handleGameState(event);
    }, controller.signal);
    if (!controller.signal.aborted && state.activeGameId === gameId) {
      const ended = state.clockState && state.clockState.status !== 'started';
      clearTimers();
      els.soundToggle.disabled = true;
      els.testSound.disabled = !state.connected;
      setGameMessage(ended ? 'Die Partie ist beendet.' : 'Der Spielestream wurde geschlossen.');
      state.gameController = null;
      if (!ended) state.failedGameIds.add(gameId);
      state.activeGameId = '';
      void startEventStream(ended
        ? 'Partie beendet. Warte auf die nächste Partie …'
        : 'Der Spielestream wurde unterbrochen. Ich warte auf die nächste Partie.');
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    closeGameDisplay();
    state.gameController = null;
    state.failedGameIds.add(gameId);
    void startEventStream(`${error.message || 'Der Spielestream konnte nicht geöffnet werden.'} Ich warte auf die nächste Partie.`);
  }
}

function handleGameFull(game) {
  const ownColor = ownColorFromGame(game);
  if (!ownColor) {
    setGameMessage('Dein Lichess-Konto wurde in dieser Partie nicht erkannt.');
    return;
  }
  state.color = ownColor;
  state.initialClockMs = game.clock?.initial || Math.max(game.state?.wtime || 0, game.state?.btime || 0);
  const fenTurn = game.initialFen && game.initialFen !== 'startpos' ? game.initialFen.split(/\s+/)[1] : 'w';
  state.initialTurn = fenTurn === 'b' ? 'black' : 'white';
  els.opponentName.textContent = displayName(ownColor === 'white' ? game.black : game.white);
  els.playerColor.textContent = ownColor === 'white' ? 'Du: Weiss' : 'Du: Schwarz';
  els.openGameLink.href = `${API_BASE}/${encodeURIComponent(game.id)}`;
  els.openGameLink.hidden = false;
  els.gameSummary.hidden = false;
  setGameMessage(game.state?.status === 'started' ? 'Partie läuft. Das Signal ist aktiv.' : 'Partie geladen.');
  handleGameState(game.state);
}

function handleGameState(gameState) {
  if (!gameState || !Number.isFinite(gameState.wtime) || !Number.isFinite(gameState.btime)) return;
  state.clockState = gameState;
  state.lastStateAt = performance.now();
  updateClocks();
  window.clearInterval(state.renderTimer);
  state.renderTimer = window.setInterval(updateClocks, 200);
  if (gameState.status && gameState.status !== 'started') {
    clearTimers();
    els.soundToggle.disabled = true;
    els.testSound.disabled = !state.connected;
    setGameMessage(`Partie beendet: ${gameState.status}.`);
  } else {
    els.soundToggle.disabled = false;
    els.testSound.disabled = false;
    setGameMessage('Partie läuft. Das Signal ist aktiv.');
    scheduleSignal();
  }
}

function startEventStream(waitMessage = 'Warte auf eine laufende oder neue Partie …') {
  if (!state.connected || state.activeGameId) return Promise.resolve(false);
  if (state.eventController) return state.eventReadyPromise || Promise.resolve(true);
  const controller = new AbortController();
  state.eventController = controller;
  let markReady;
  state.eventReadyPromise = new Promise(resolve => { markReady = resolve; });
  const readyPromise = state.eventReadyPromise;
  setGameMessage(waitMessage);
  void (async () => {
    try {
      const response = await apiFetch('/api/stream/event', {
        accept: 'application/x-ndjson',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        markReady(false);
        return;
      }
      markReady(true);
      await readNdjson(response, event => {
        if (event.type === 'gameFinish' && event.game?.id) state.failedGameIds.delete(event.game.id);
        if (event.type === 'gameStart' && event.game?.id && !state.activeGameId && !state.failedGameIds.has(event.game.id)) {
          void monitorSelectedGame(event.game.id);
        }
      }, controller.signal);
      if (!controller.signal.aborted && state.connected) {
        state.eventController = null;
        state.eventReadyPromise = null;
        setGameMessage('Der Ereignisstrom wurde geschlossen. Trenne und verbinde erneut, um weiterzuwarten.');
      }
    } catch (error) {
      markReady(false);
      if (controller.signal.aborted) return;
      state.eventController = null;
      state.eventReadyPromise = null;
      setGameMessage(error.message || 'Der Ereignisstrom konnte nicht geöffnet werden.');
    }
  })();
  return readyPromise;
}

async function startSeek(event) {
  event.preventDefault();
  if (!state.connected || state.activeGameId || state.seekController) return;
  setSeekMessage('Verbinde den Lichess-Ereignisstrom …');
  const eventReady = await startEventStream();
  if (!eventReady) {
    setSeekMessage('Die Suche konnte nicht starten. Prüfe die Verbindung und versuche es erneut.');
    return;
  }
  if (!state.connected || state.activeGameId || state.seekController) return;

  const controller = new AbortController();
  state.seekController = controller;
  updateSeekControls();
  const [time, increment] = els.timeControl.value.split(':');
  const body = new URLSearchParams({
    time,
    increment,
    rated: String(els.ratedGame.checked),
  });
  setSeekMessage(`Suche läuft: ${time} Minuten + ${increment} Sekunden${els.ratedGame.checked ? ' · Wertungsspiel' : ' · casual'}.`);

  try {
    const response = await apiFetch('/api/board/seek', {
      method: 'POST',
      accept: 'application/x-ndjson',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    await readNdjson(response, () => {}, controller.signal);
    if (!controller.signal.aborted) setSeekMessage('Die Suche wurde beendet. Du kannst erneut suchen.');
  } catch (error) {
    if (!controller.signal.aborted) setSeekMessage(error.message || 'Die Suche ist fehlgeschlagen.');
  } finally {
    if (state.seekController === controller) {
      state.seekController = null;
      updateSeekControls();
    }
  }
}

function cancelSeek() {
  if (!state.seekController) return;
  state.seekController.abort();
  state.seekController = null;
  updateSeekControls();
  setSeekMessage('Suche gestoppt.');
}

async function connect(event) {
  event.preventDefault();
  const token = els.token.value.trim();
  if (!token) return;
  els.connect.disabled = true;
  setConnectionMessage('Verbinde mit Lichess …');
  try {
    await ensureAudio();
    state.token = token;
    const accountResponse = await apiFetch('/api/account');
    const account = await accountResponse.json();
    state.username = account.username || '';
    if (!state.username) throw new Error('Dein Lichess-Konto konnte nicht ermittelt werden.');
    state.connected = true;
    els.monitor.hidden = false;
    els.testSound.disabled = false;
    updateSeekControls();
    els.token.value = '';
    setConnectionMessage(`Verbunden als ${state.username}. Der Token bleibt nur im Arbeitsspeicher dieser Seite.`);
    const games = await loadCurrentGames();
    showGameChoices(games);
    if (games.length === 1) {
      void monitorSelectedGame(games[0].gameId);
    } else if (games.length > 1) {
      setGameMessage('Wähle aus, welche laufende Partie überwacht werden soll.');
    } else {
      void startEventStream();
    }
  } catch (error) {
    state.token = '';
    state.username = '';
    state.connected = false;
    els.monitor.hidden = true;
    updateSeekControls();
    setConnectionMessage(error.message || 'Verbindung fehlgeschlagen.', 'error');
  } finally {
    els.connect.disabled = false;
  }
}

function disconnect() {
  stopStreams();
  clearTimers();
  closeGameDisplay();
  state.token = '';
  state.username = '';
  state.games = [];
  state.failedGameIds.clear();
  state.connected = false;
  els.monitor.hidden = true;
  els.testSound.disabled = true;
  els.gamePicker.hidden = true;
  els.token.value = '';
  els.connect.disabled = false;
  setConnectionMessage('Getrennt. Der Token wurde aus dem Arbeitsspeicher entfernt.');
}

els.form.addEventListener('submit', connect);
els.seekForm.addEventListener('submit', startSeek);
els.cancelSeek.addEventListener('click', cancelSeek);
els.watchGame.addEventListener('click', () => monitorSelectedGame(els.gameSelect.value));
els.disconnect.addEventListener('click', disconnect);
els.soundToggle.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  els.soundToggle.textContent = state.soundEnabled ? 'Signal pausieren' : 'Signal fortsetzen';
  if (state.soundEnabled) scheduleSignal(true);
  else window.clearTimeout(state.soundTimer);
});
els.testSound.addEventListener('click', async () => {
  try {
    await ensureAudio();
    soundPair(420000, 240000);
  } catch (error) {
    setGameMessage(error.message);
  }
});

