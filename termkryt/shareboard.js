/* ============================================================
   shareboard.js — URL sharing for TermKryt
   Load order:  keycards.js, wordpairs.js, shareboard.js, main script

   TOKEN FORMAT (everything after '#', no separators)
     full      :  base62( gridValue + 1280n * SUM(wordIdx_i * D^i) )
                  gridValue = boardId*32 + rotationId*8 + orientation
     colorblind:  '-' + base62( orientation + 8n * SUM(wordIdx_i * D^i) )
                  board reinflated as 25 white cells

     orientation = (isFlipped ? 4 : 0) + currentRotation/90
     D           = WORD_LIST.length

   NOT ENCODED: revealed cards, non-retail colourings, off-dictionary
   words. encodeBoardToken() returns null in those cases and the caller
   falls back to the verbose buildDataString() format.
   ============================================================ */

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/* frozen wire-format dictionary: WORD_PAIRS flattened, deduped, in order */
const WORD_LIST = (() => {
    const out = [], seen = new Set();
    WORD_PAIRS.forEach(p => p.forEach(w => {
        const k = w.toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (k && !seen.has(k)) { seen.add(k); out.push(w); }
    }));
    return out;
})();
const WORD_INDEX = new Map(WORD_LIST.map((w, i) => [w.toLowerCase().replace(/[^a-z0-9]+/g, ''), i]));
const D_BIG = BigInt(WORD_LIST.length);

/* retail key cards in declaration order, 25 chars each */
const GRID_LIST = (() => {
    const out = [];
    Object.values(KEY_CARDS).forEach(raw => {
        const s = String(raw).toLowerCase().replace(/[^drbw]/g, '');
        for (let p = 0; p + 25 <= s.length; p += 25) out.push(s.slice(p, p + 25));
    });
    return out;
})();

const GRID_CLS = { r: 'red', b: 'blue', w: 'white', d: 'black' };
const CLS_GRID = { red: 'r', blue: 'b', white: 'w', black: 'd' };

/* ---------- ENCODE ---------- */
function encodeBoardToken(colorblind = false) {
    const cells = [...document.querySelectorAll('#board .cell')];
    if (cells.length !== 25) return null;

    const orientation = (isFlipped ? 4 : 0) + ((((currentRotation % 360) / 90) | 0) & 3);
    const factor = colorblind ? 8n : 1280n;
    let gridValue = orientation;

    if (!colorblind) {
        const live = cells.map(c => CLS_GRID[getColor(c)] || 'w').join('');
        let found = -1, rotationId = 0;
        for (let b = 0; b < GRID_LIST.length && found < 0; b++) {
            let g = GRID_LIST[b];
            for (let r = 0; r < 4; r++) {
                if (g === live) { found = b; rotationId = r; break; }
                g = Array.from({ length: 25 }, (_, i) => g[(4 - i % 5) * 5 + (i / 5 | 0)]).join('');
            }
        }
        if (found < 0) return null;                       // not a retail layout
        gridValue = found * 32 + rotationId * 8 + orientation;
    }

    let totalValue = BigInt(gridValue);
    for (let i = 0; i < 25; i++) {
        const idx = WORD_INDEX.get(getText(cells[i]).trim().toLowerCase().replace(/[^a-z0-9]+/g, ''));
        if (idx === undefined) return null;               // off-dictionary word
        totalValue += BigInt(idx) * factor * (D_BIG ** BigInt(i));
    }

    let s = '';
    if (totalValue === 0n) s = '0';
    while (totalValue > 0n) { s = B62[Number(totalValue % 62n)] + s; totalValue /= 62n; }
    return (colorblind ? '-' : '') + s;
}

/* ---------- DECODE ---------- */
function decodeBoardToken(str) {
    const colorblind = str[0] === '-';
    const body = colorblind ? str.slice(1) : str;
    if (!/^[0-9A-Za-z]+$/.test(body)) return null;

    let totalValue = 0n;
    for (const ch of body) {
        const d = B62.indexOf(ch);
        if (d < 0) return null;
        totalValue = totalValue * 62n + BigInt(d);
    }

    const factor = colorblind ? 8n : 1280n;
    const gridValue = Number(totalValue % factor);
    totalValue /= factor;

    let grid = 'wwwwwwwwwwwwwwwwwwwwwwwww', orientation = gridValue;
    if (!colorblind) {
        const boardId = (gridValue / 32) | 0;
        if (boardId >= GRID_LIST.length) return null;
        orientation = gridValue % 8;
        grid = GRID_LIST[boardId];
        for (let r = ((gridValue % 32) / 8) | 0; r > 0; r--)
            grid = Array.from({ length: 25 }, (_, i) => grid[(4 - i % 5) * 5 + (i / 5 | 0)]).join('');
    }

    const cells = [];
    for (let i = 0; i < 25; i++) {
        const wordIndex = Number(totalValue % D_BIG);
        totalValue /= D_BIG;
        cells.push({
            text: WORD_LIST[wordIndex] || `Card ${i + 1}`,
            colorClass: GRID_CLS[grid[i]] || 'white',
            isPlayFlipped: false
        });
    }

    return { isFlipped: orientation >= 4, rotation: (orientation % 4) * 90, cells };
}

/* ---------- SHARE UI ---------- */
function shareBoardUrl(colorblind = false) {
    let isPlayer = !!colorblind;          // current mode inside the modal

    const base = location.href.split('#')[0];
    const overlay = document.getElementById('modal-overlay');
    const qrEl = document.getElementById('modal-qr');

    function buildUrl() {
        const token = encodeBoardToken(isPlayer);
        return token
            ? base + '#' + token
            : base + '#' + encodeURIComponent(buildDataString(isPlayer));
    }

    function updateQR(url) {
        if (!qrEl || typeof QRCode === 'undefined') return;
        qrEl.innerHTML = '';
        qrEl.style.display = 'flex';
        try {
            new QRCode(qrEl, {
                text: url, width: 256, height: 256,
                colorDark: '#000000', colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch (e) {
            qrEl.style.display = 'none';
            qrEl.innerHTML = '';
        }
    }

    function currentTitle() {
        return isPlayer
            ? 'Share Player Link (no colors)'
            : 'Share Spymaster Link (with colors)';
    }

    function toggleLabel() {
        // The button tells you what you will switch TO
        return isPlayer
            ? 'Share with Spymaster ↪️🥸'
            : 'Share with Player ↪️👤';
    }

    // Initial URL + QR
    let url = buildUrl();
    overlay.classList.add('fullscreen');
    updateQR(url);

    return showModal({
        title: currentTitle(),
        message: '',
        dismiss: null,
        buttons: [
            {
                label: 'Copy Link',
                keepOpen: true,
                action: btn => {
                    const flash = () => {
                        const t = btn.textContent;
                        btn.textContent = 'Copied!';
                        setTimeout(() => btn.textContent = t, 1200);
                    };
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(url).then(flash).catch(flash);
                    } else {
                        const ta = document.createElement('textarea');
                        ta.value = url;
                        document.body.appendChild(ta);
                        ta.select();
                        try { document.execCommand('copy'); flash(); } catch (e) {}
                        document.body.removeChild(ta);
                    }
                }
            },
            {
                // Toggle button – stays open and rebuilds the link + QR
                label: toggleLabel(),
                keepOpen: true,
                action: btn => {
                    isPlayer = !isPlayer;
                    url = buildUrl();
                    updateQR(url);

                    // Update modal title and this button’s label
                    const titleEl = document.getElementById('modal-title');
                    if (titleEl) titleEl.textContent = currentTitle();
                    btn.textContent = toggleLabel();
                }
            },
            { label: 'Close', value: null, primary: true }
        ]
    }).then(() => {
        overlay.classList.remove('fullscreen');
        if (qrEl) {
            qrEl.style.display = 'none';
            qrEl.innerHTML = '';
        }
    });
}
/* ---------- IN-APP QR LOADER ---------- */
function scanShareQR() {
    if (typeof jsQR === 'undefined') {
        alert('jsQR library not loaded');
        return;
    }

    // Create a simple fullscreen overlay with video + cancel
    const overlay = document.createElement('div');
    overlay.id = 'qr-scan-overlay';
    overlay.style.cssText = `
        position:fixed; inset:0; z-index:99999;
        background:#000; display:flex; flex-direction:column;
        align-items:center; justify-content:center; gap:16px;
    `;

    const video = document.createElement('video');
    video.setAttribute('playsinline', '');          // critical for iOS
    video.style.cssText = 'width:min(100vw,480px); max-height:70vh; border-radius:12px;';
    video.muted = true;

    const status = document.createElement('div');
    status.textContent = 'Point camera at a TermKryt QR code…';
    status.style.cssText = 'color:#fff; font:16px system-ui; text-align:center; padding:0 16px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:12px 28px; font-size:16px; border-radius:8px; border:none; cursor:pointer;';

    overlay.append(video, status, cancelBtn);
    document.body.appendChild(overlay);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stream = null;
    let running = true;
    let raf = 0;

    function stop() {
        running = false;
        cancelAnimationFrame(raf);
        if (stream) stream.getTracks().forEach(t => t.stop());
        overlay.remove();
    }

    cancelBtn.onclick = stop;

    // Prefer rear camera
    navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
    }).then(s => {
        stream = s;
        video.srcObject = stream;
        video.play();
        tick();
    }).catch(err => {
        status.textContent = 'Camera permission denied or unavailable.';
        console.error(err);
    });

    function tick() {
        if (!running) return;
        raf = requestAnimationFrame(tick);

        if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
        });

        if (!code || !code.data) return;

        // Accept full URLs or raw tokens
        let raw = code.data.trim();

// Room invite URLs use ?room=CODE.
// Board-share URLs continue to use the URL hash.
try {
    const u = new URL(raw);
    const roomCode = (u.searchParams.get('room') || '').trim().toUpperCase();

    if (roomCode) {
        stop();

        if (typeof window.joinGame === 'function') {
            const modeSelect = document.getElementById('op1');
            if (modeSelect) {
                modeSelect.value = 'host';
                uiSync();
            }

            const codeInput = document.getElementById('join-code-input');
            if (codeInput) codeInput.value = roomCode;

            window.joinGame(roomCode);
        } else {
            alert('Room joining is not available on this page.');
        }

        return;
    }

    if (u.hash) raw = decodeURIComponent(u.hash.slice(1));
} catch (_) {
    // Not a URL; keep treating it as a board token as before.
}

        // Try to parse with the existing helpers
        const parsed = (typeof parseAnyFormat === 'function')
            ? parseAnyFormat(raw)
            : null;

        if (!parsed) {
            status.textContent = 'QR found, but not a TermKryt board link…';
            return;
        }

        // Success – load the board
        stop();

        isFlipped = parsed.isFlipped;
        board.classList.toggle('flipped', isFlipped);
        currentRotation = parsed.rotation;
        thinkCounter = 1;
        initBoard(parsed.cells);
        if (typeof saveCurrentState === 'function') saveCurrentState();
        if (typeof pushHistory === 'function') pushHistory();   // optional, if you have history

        // Optional feedback
        if (typeof uiAlert === 'function') {
            uiAlert('Board loaded from QR code', 'Imported');
        }
    }
}
