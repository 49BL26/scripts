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
