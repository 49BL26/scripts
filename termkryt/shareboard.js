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

        // If it's a full URL, pull the hash part
        try {
            const u = new URL(raw);
            if (u.hash) raw = decodeURIComponent(u.hash.slice(1));
        } catch (_) {
            // not a URL – treat as raw token
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
