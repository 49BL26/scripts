/* ============================================================
   WORD SCANNER — Tesseract OCR → fills empty board cells
   Load AFTER wordpairs.js. Uses WORD_PAIRS for the dictionary.
   ============================================================ */
(function () {
    const TARGET_WIDTH = 800;             // downscale for CPU
    const MIN_CONFIDENCE = 0.25;

    // Build dictionary from your existing WORD_PAIRS
    const DICT = (function () {
        const out = [];
        const seen = new Set();
        (WORD_PAIRS || []).forEach(pair => pair.forEach(w => {
            const k = w.toLowerCase().replace(/[^a-z0-9]+/g, '');
            if (k && !seen.has(k)) { seen.add(k); out.push(w.toUpperCase()); }
        }));
        return out;
    })();

    let worker = null;

async function getWorker() {
    if (!worker) {
        worker = await Tesseract.createWorker('eng', 1, {
            workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
            corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@6',
            langPath:   'https://tessdata.projectnaptha.com/4.0.0',
            logger: m => console.log('OCR:', m.status, m.progress)
        });
        await worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ',
            preserve_interword_spaces: '1'
        });
    }
    return worker;
}


    // Simple normalized similarity (use string-similarity lib if present)
    function similarity(a, b) {
        // Levenshtein-based ratio (small implementation)
        const m = a.length, n = b.length;
        if (!m || !n) return 0;
        const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
                );
            }
        }
        return 1 - dp[m][n] / Math.max(m, n);
    }

function bestMatch(text) {
    const tokens = text.split(/\s+/).filter(w => w.length > 2);
    const candidates = [...tokens];
    for (let i = 0; i < tokens.length - 1; i++) {
        candidates.push(tokens[i] + ' ' + tokens[i + 1]);
    }
    let best = { target: '', rating: 0 };
    for (const cand of candidates) {
        for (const dictWord of DICT) {
            const r = similarity(cand, dictWord);
            if (r > best.rating) best = { target: dictWord, rating: r };
        }
    }
    for (const dictWord of DICT) {           // exact substring = perfect match
        if (text.includes(dictWord)) return { target: dictWord, rating: 1 };
    }
    return best;
}


    // Main pipeline — returns recognized word string or null
    async function processImage(file, statusCb) {
        if (typeof Tesseract === 'undefined') {
            throw new Error('Tesseract.js not loaded — check CDN script tag.');
        }

        const url = URL.createObjectURL(file);
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
        });

        // Downscale to target width preserving aspect
        const scale = TARGET_WIDTH / img.width;
        const canvas = document.createElement('canvas');
        canvas.width = TARGET_WIDTH;
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');

        // Normal orientation
        statusCb('Optimizing image…');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

        // Flipped 180°
        canvas.width = canvas.width; // reset
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(Math.PI);
        ctx.drawImage(img, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
        ctx.restore();
        const flippedUrl = canvas.toDataURL('image/jpeg', 0.85);

        // OCR both orientations
        statusCb('Analyzing text (may take a few seconds)…');
        const w = await getWorker();
        const [r1, r2] = await Promise.all([
            w.recognize(dataUrl),
            w.recognize(flippedUrl)
        ]);

        const clean = s => s.toUpperCase().replace(/\s+/g, ' ').trim();
        const t1 = clean(r1.data.text), t2 = clean(r2.data.text);

        console.log('OCR upright:', JSON.stringify(t1));
        console.log('OCR flipped:', JSON.stringify(t2));

       
        // Pick the better-scoring orientation
        const m1 = bestMatch(t1), m2 = bestMatch(t2);
        const winner = (m1.rating >= m2.rating) ? m1 : m2;

        return (winner.rating >= MIN_CONFIDENCE && winner.target) ? winner.target : null;
    }

    // Public API — wire the button to this
    window.scanWordFromImage = async function (file, statusCb) {
        try {
            const word = await processImage(file, statusCb || (() => {}));
            if (!word) {
                statusCb?.('No match found. Try another angle/lighting.');
                return null;
            }

            // Find next empty cell
            const cells = [...board.querySelectorAll('.cell')];
            const targetIdx = cells.findIndex((cell, i) => {
                const t = cell.querySelector('.cell-text').textContent.trim();
                return t === '' || t === `Card ${i + 1}`;
            });

            if (targetIdx === -1) {
                // Board full — prompt to replace
                const replace = await uiConfirm(
                    `Board is full. Replace a card with " ${word} "?`,
                    'Board Full'
                );
                if (!replace) return null;
                const idx = await uiPrompt(`Enter cell number (1-25) to replace:`, '', {
                    title: 'Replace cell'
                });
                const n = parseInt(idx);
                if (isNaN(n) || n < 1 || n > 25) {
                    uiAlert('Invalid cell number.');
                    return null;
                }
                cells[n - 1].querySelector('.cell-text').textContent = word;
            } else {
                cells[targetIdx].querySelector('.cell-text').textContent = word;
            }

            updateStats();
            saveCurrentState();
            statusCb?.('Added “' + word + '” to card ' + (targetIdx + 1));
            return word;
        } catch (e) {
            console.error(e);
            statusCb?.('Scan error: ' + e.message);
            return null;
        }
    };
})();
