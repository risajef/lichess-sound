(() => {
  if (globalThis.__lichessClockTonesLoaded) return;
  globalThis.__lichessClockTonesLoaded = true;

  const MIN_INTERVAL_MS = 400;
  const MAX_INTERVAL_MS = 3000;
  const NOTE_LENGTH = 0.11;
  const NOTE_GAP = 0.08;
  const LOW_TIME_WARNING_MS = 10_000;
  const POLL_MS = 100;

  const host = document.createElement('div');
  host.id = 'lichess-clock-tones-extension';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        width: min(320px, calc(100vw - 32px));
        color: #f4f6f8;
        background: #17212b;
        border: 1px solid #52616d;
        border-radius: 12px;
        box-shadow: 0 8px 28px #0009;
        font: 14px/1.45 system-ui, sans-serif;
        overflow: hidden;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 11px 12px;
        background: #202e3a;
      }
      h2 { margin: 0; font-size: 15px; font-weight: 700; }
      .body { padding: 12px; }
      .status { min-height: 40px; margin: 0 0 10px; color: #d7e3ed; }
      label { display: block; margin: 10px 0 5px; font-weight: 650; }
      select, input, button {
        color: inherit;
        font: inherit;
      }
      select {
        width: 100%;
        min-height: 42px;
        padding: 7px 9px;
        color: #17212b;
        background: #fff;
        border: 2px solid transparent;
        border-radius: 7px;
      }
      .actions { display: flex; gap: 8px; margin-top: 12px; }
      button {
        min-height: 42px;
        padding: 8px 10px;
        background: #344958;
        border: 1px solid #758997;
        border-radius: 7px;
        cursor: pointer;
      }
      button.primary { flex: 1; background: #16734b; border-color: #55ae80; font-weight: 700; }
      button.primary[aria-pressed="true"] { background: #9a5c18; border-color: #e5a64e; }
      button:hover { filter: brightness(1.14); }
      button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible {
        outline: 3px solid #ffd166;
        outline-offset: 2px;
      }
      .volume-row { display: flex; align-items: center; gap: 10px; }
      .volume-row label { flex: 0 0 auto; }
      input[type="range"] { width: 100%; accent-color: #74c69d; }
      details { margin-top: 9px; color: #d7e3ed; }
      summary { width: fit-content; cursor: pointer; }
      details p { margin: 7px 0 0; }
      .collapse { min-height: 36px; padding: 5px 8px; font-size: 12px; }
      .collapsed .body { display: none; }
      .collapsed { width: auto; min-width: 190px; }
      @media (max-width: 480px) {
        :host { right: 8px !important; bottom: 8px !important; }
        .panel { width: min(320px, calc(100vw - 16px)); }
      }
    </style>
    <section class="panel" aria-label="Lichess-Uhrensignal">
      <header>
        <h2>Lichess-Uhrensignal</h2>
        <button id="collapse" class="collapse" type="button" aria-expanded="true">Minimieren</button>
      </header>
      <div class="body">
        <p id="status" class="status" role="status" aria-live="polite">Suche nach Lichess-Uhren …</p>
        <label for="own-clock">Welche Uhr ist deine?</label>
        <select id="own-clock">
          <option value="bottom">Unten (meine Seite)</option>
          <option value="white">Weiss</option>
          <option value="black">Schwarz</option>
        </select>
        <div class="actions">
          <button id="toggle" class="primary" type="button" aria-pressed="false">Signal aktivieren</button>
          <button id="test" type="button">Probehören</button>
        </div>
        <div class="volume-row">
          <label for="volume">Lautstärke</label>
          <input id="volume" type="range" min="5" max="100" value="45" aria-label="Lautstärke">
        </div>
        <details>
          <summary>Was bedeuten die Töne?</summary>
          <p>Die Tonhöhe zeigt den Zeitunterschied: Hast du mehr Zeit, wird der Ton tiefer; hast du weniger, höher. Das Wiederholtempo zeigt deine eigene Restzeit und wird bei knapper Zeit schneller. Beim Unterschreiten von 10 Sekunden kommt einmalig ein Warnklick.</p>
        </details>
      </div>
    </section>
  `;
  document.documentElement.append(host);

  const panel = shadow.querySelector('.panel');
  const status = shadow.querySelector('#status');
  const ownClockChoice = shadow.querySelector('#own-clock');
  const toggleButton = shadow.querySelector('#toggle');
  const testButton = shadow.querySelector('#test');
  const volume = shadow.querySelector('#volume');
  const collapseButton = shadow.querySelector('#collapse');

  let audioContext;
  let enabled = false;
  let initialClockMs = 0;
  let lastClockKey = '';
  let lastClockSample = null;
  let nextSignalAt = 0;
  let lastStatus = '';
  let warningClickPlayed = false;
  let lastPathname = location.pathname;

  function setStatus(message) {
    if (message === lastStatus) return;
    lastStatus = message;
    status.textContent = message;
  }

  function parseClock(text) {
    const normalized = text.replace(/\u00a0/g, ' ').trim();
    const match = normalized.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/);
    if (match) {
      const hours = Number(match[1] || 0);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
      return ((hours * 60 + minutes) * 60 + seconds + fraction) * 1000;
    }

    // Lichess uses spoken, localized clock text in blind mode. Parse common
    // numeric unit names as well, so the audio cue can still follow that clock.
    const spoken = normalized.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const units = [
      { multiplier: 86_400_000, pattern: /(\d+)\s*(?:days?|d|tage?n?|tagen|jours?|dias?|giorn[oi]|dagen)(?=$|\s|[.,])/g },
      { multiplier: 3_600_000, pattern: /(\d+)\s*(?:hours?|hrs?|h|stunden?|std\.?|heures?|horas?|hores?|ore|uur|uren?)(?=$|\s|[.,])/g },
      { multiplier: 60_000, pattern: /(\d+)\s*(?:minutes?|mins?|min|m|minuten?|minuti|minutos?)(?=$|\s|[.,])/g },
      { multiplier: 1_000, pattern: /(\d+)\s*(?:seconds?|secs?|sec|s|sekunden?|sek\.?|secondes?|segundos?|segund[oi]|seconden?)(?=$|\s|[.,])/g },
    ];
    let totalMs = 0;
    let foundUnit = false;
    for (const unit of units) {
      for (const part of spoken.matchAll(unit.pattern)) {
        totalMs += Number(part[1]) * unit.multiplier;
        foundUnit = true;
      }
    }
    return foundUnit ? totalMs : null;
  }

  function readClockElements() {
    const white = document.querySelector('.rclock.rclock-white');
    const black = document.querySelector('.rclock.rclock-black');
    if (!white || !black) {
      lastClockKey = '';
      lastClockSample = null;
      return null;
    }

    const whiteTime = white.querySelector('.time');
    const blackTime = black.querySelector('.time');
    if (!whiteTime || !blackTime) {
      lastClockKey = '';
      lastClockSample = null;
      return null;
    }

    const whiteText = whiteTime.textContent || '';
    const blackText = blackTime.textContent || '';
    const whiteMs = parseClock(whiteText);
    const blackMs = parseClock(blackText);
    if (whiteMs === null || blackMs === null) {
      lastClockKey = '';
      lastClockSample = null;
      return { unreadable: true, whiteText, blackText };
    }

    const activeColor = white.classList.contains('running')
      ? 'white'
      : black.classList.contains('running')
        ? 'black'
        : '';
    const key = `${whiteText}|${blackText}|${activeColor}`;
    const now = performance.now();
    if (key !== lastClockKey) {
      lastClockKey = key;
      lastClockSample = { whiteMs, blackMs, activeColor, sampledAt: now };
      if (initialClockMs === 0) initialClockMs = Math.max(whiteMs, blackMs, 1);
    }

    return { ...lastClockSample, sampledAt: lastClockSample.sampledAt };
  }

  function getOwnColor() {
    const selection = ownClockChoice.value;
    if (selection !== 'bottom') return selection;
    const bottomClock = document.querySelector('.rclock.rclock-bottom');
    if (!bottomClock) return '';
    if (bottomClock.classList.contains('rclock-white')) return 'white';
    if (bottomClock.classList.contains('rclock-black')) return 'black';
    return '';
  }

  function estimatedTimes(snapshot, now = performance.now()) {
    if (!snapshot || snapshot.unreadable) return null;
    const elapsed = snapshot.activeColor ? Math.max(0, now - snapshot.sampledAt) : 0;
    return {
      whiteMs: Math.max(0, snapshot.whiteMs - (snapshot.activeColor === 'white' ? elapsed : 0)),
      blackMs: Math.max(0, snapshot.blackMs - (snapshot.activeColor === 'black' ? elapsed : 0)),
    };
  }

  async function ensureAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('Dieser Browser unterstützt keine Web-Audio-Ausgabe.');
    if (!audioContext) audioContext = new AudioContextClass();
    if (audioContext.state === 'suspended') await audioContext.resume();
  }

  function playNote(frequency, startsAt, level) {
    if (!audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const start = Math.max(startsAt, audioContext.currentTime);
    const end = start + NOTE_LENGTH;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * 0.14), start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.01);
  }

  function comparisonFrequency(ownMs, opponentMs) {
    const reference = Math.max(1, initialClockMs || 60_000);
    const relativeDifference = Math.max(-1, Math.min(1, (ownMs - opponentMs) / reference));
    return 660 - relativeDifference * 360;
  }

  function playComparisonTone(ownMs, opponentMs, startsAt = audioContext?.currentTime || 0) {
    if (!audioContext) return;
    const level = Number(volume.value) / 100;
    playNote(comparisonFrequency(ownMs, opponentMs), startsAt, level);
  }

  function playWarningClick(startsAt = audioContext?.currentTime || 0) {
    if (!audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const start = Math.max(startsAt, audioContext.currentTime);
    const end = start + 0.028;
    const level = Number(volume.value) / 100;
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(1450, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * 0.10), start + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(end + 0.005);
  }

  function signalInterval(ownMs) {
    const ratio = initialClockMs > 0 ? Math.min(1, ownMs / initialClockMs) : 0;
    return MIN_INTERVAL_MS + (MAX_INTERVAL_MS - MIN_INTERVAL_MS) * Math.sqrt(ratio);
  }

  function update() {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      initialClockMs = 0;
      lastClockKey = '';
      lastClockSample = null;
      warningClickPlayed = false;
      nextSignalAt = 0;
    }

    const clocks = readClockElements();
    host.hidden = !clocks;
    if (!clocks) {
      initialClockMs = 0;
      warningClickPlayed = false;
      setStatus('Öffne eine Lichess-Partie, um das Uhrensignal zu verwenden.');
      nextSignalAt = 0;
      return;
    }
    if (clocks.unreadable) {
      setStatus('Das angezeigte Uhrformat wurde nicht erkannt.');
      nextSignalAt = 0;
      return;
    }

    const ownColor = getOwnColor();
    if (!ownColor) {
      setStatus('Wähle Weiss oder Schwarz als deine Uhr.');
      nextSignalAt = 0;
      return;
    }
    if (!clocks.activeColor) {
      setStatus(enabled ? 'Signal bereit. Es startet, sobald die Partie-Uhr läuft.' : 'Partie erkannt. Aktiviere das Signal zum Start.');
      nextSignalAt = 0;
      return;
    }

    const times = estimatedTimes(clocks);
    const ownMs = ownColor === 'white' ? times.whiteMs : times.blackMs;
    const opponentMs = ownColor === 'white' ? times.blackMs : times.whiteMs;
    if (enabled) {
      setStatus('Signal aktiv. Tonhöhe zeigt den Zeitunterschied; das Tempo deine Restzeit.');
      const now = performance.now();
      let warningJustPlayed = false;
      if (!document.hidden && ownMs <= LOW_TIME_WARNING_MS && !warningClickPlayed) {
        playWarningClick();
        warningClickPlayed = true;
        warningJustPlayed = true;
      }
      if (!document.hidden && now >= nextSignalAt && ownMs > 0) {
        const delay = warningJustPlayed ? 0.14 : 0;
        playComparisonTone(ownMs, opponentMs, audioContext.currentTime + delay);
        nextSignalAt = now + signalInterval(ownMs);
      }
    } else {
      setStatus(`Partie läuft. Deine Uhr ist ${ownColor === 'white' ? 'weiss' : 'schwarz'}.`);
      nextSignalAt = 0;
    }
  }

  toggleButton.addEventListener('click', async () => {
    if (enabled) {
      enabled = false;
      nextSignalAt = 0;
      toggleButton.textContent = 'Signal aktivieren';
      toggleButton.setAttribute('aria-pressed', 'false');
      update();
      return;
    }
    try {
      await ensureAudio();
      enabled = true;
      nextSignalAt = 0;
      toggleButton.textContent = 'Signal pausieren';
      toggleButton.setAttribute('aria-pressed', 'true');
      update();
    } catch (error) {
      setStatus(error.message || 'Audio konnte nicht gestartet werden.');
    }
  });

  testButton.addEventListener('click', async () => {
    try {
      await ensureAudio();
      const start = audioContext.currentTime;
      playComparisonTone(40_000, 20_000, start);
      playComparisonTone(20_000, 40_000, start + NOTE_LENGTH + NOTE_GAP + 0.16);
      playWarningClick(start + (NOTE_LENGTH + NOTE_GAP) * 2 + 0.32);
    } catch (error) {
      setStatus(error.message || 'Audio konnte nicht gestartet werden.');
    }
  });

  ownClockChoice.addEventListener('change', () => {
    nextSignalAt = 0;
    update();
  });

  collapseButton.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    collapseButton.textContent = collapsed ? 'Öffnen' : 'Minimieren';
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
  });

  window.setInterval(update, POLL_MS);
})();
