/* ============================================================
   WORD SCANNER — lenient OCR + fuzzy dictionary correction
   2 OCR passes (upright + flipped). No OpenCV.
   ============================================================ */
(function () {
    'use strict';

    const MAX_DIM = 2000;
    const MIN_CONFIDENCE = 5;          // was 40 → now almost anything
    const MIN_WORD_LEN = 2;
    const MATCH_THRESHOLD = 0.45;      // adjust: lower = more aggressive correction

    // Build dictionary entries with normalized + display forms
    const DICT_ENTRIES = (function () {
        const map = new Map();
        (window.WORD_PAIRS || []).forEach(pair => pair.forEach(w => {
            const norm = w.toUpperCase().replace(/[^A-Z]/g, '');
            if (norm.length >= 2) map.set(norm, w.toUpperCase());
        }));
        return [...map].map(([norm, display]) => ({ norm, display }));
    })();

    let worker = null;

    /* ---------- utility ---------- */
    function norm(s) {
        return s.toUpperCase().replace(/[^A-Z]/g, '');
    }

    function similarity(a, b) {
        if (!a.length || !b.length) return 0;
        const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
        for (let j = 0; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
                );
            }
        }
        return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
    }

    // Pick best dictionary match or keep custom word if plausible
    function correctWord(raw) {
        const clean = norm(raw);
        if (clean.length < MIN_WORD_LEN) return null;

        let best = { display: null, sim: 0 };
        for (const entry of DICT_ENTRIES) {
            const sim = similarity(clean, entry.norm);
            if (sim > best.sim) best = { display: entry.display, sim };
        }
        if (best.sim >= MATCH_THRESHOLD) return best.display;

        // Custom word? Require letters + a vowel
        if (/^[A-Z]{2,}$/.test(clean) && /[AEIOUY]/.test(clean)) return clean;
        return null;
    }

    /* ---------- Tesseract ---------- */
    async function getWorker() {
        if (!worker) {
            worker = await Tesseract.createWorker('eng', 1, {
                workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
                corePath:   'https://cdn.jsdelivr.net/npm/tesseract.js-core@6',
                langPath:   'https://tessdata.projectnaptha.com/4.0.0'
            });
            await worker.setParameters({
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ',
                preserve_interword_spaces: '1',
                tessedit_pageseg_mode: '11'
            });
        }
        return worker;
    }

    /* ---------- image processing ---------- */
    function enhance(canvas) {
        const ctx = canvas.getContext('2d');
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const v = Math.max(0, Math.min(255, (g - 128) * 1.3 + 128));
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(img, 0, 0);
    }

    function rotate180(src) {
        const dst = document.createElement('canvas');
        dst.width = src.width;
        dst.height = src.height;
        const ctx = dst.getContext('2d');
        ctx.translate(src.width / 2, src.height / 2);
        ctx.rotate(Math.PI);
        ctx.drawImage(src, -src.width / 2, -src.height / 2);
        return dst;
    }

    /* ---------- OCR harvest + correction ---------- */
    function harvest(data, W, H) {
        const out = [];
        (data.words || []).forEach(w => {
            if (w.confidence < MIN_CONFIDENCE) return;
            const raw = (w.text || '').toUpperCase().trim();
            const word = correctWord(raw);
            if (!word) return;
            out.push({
                word,
                conf: w.confidence,
                x: (w.bbox.x0 + w.bbox.x1) / 2 / W,
                y: (w.bbox.y0 + w.bbox.y1) / 2 / H
            });
        });
        return out;
    }

    /* ---------- grid mapping ---------- */
    function toGrid(words) {
        if (!words.length) return { grid: Array(25).fill(null), score: 0 };
        const xs = words.map(w => w.x), ys = words.map(w => w.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs);
        const y0 = Math.min(...ys), y1 = Math.max(...ys);
        const spanX = Math.max(x1 - x0, 0.01), spanY = Math.max(y1 - y0, 0.01);

        const grid = Array(25).fill(null);
        let score = 0;
        words.forEach(w => {
            const col = Math.min(4, Math.max(0, Math.round(((w.x - x0) / spanX) * 4)));
            const row = Math.min(4, Math.max(0, Math.round(((w.y - y0) / spanY) * 4)));
            const idx = row * 5 + col;
            if (!grid[idx] || w.conf > grid[idx].conf) {
                if (!grid[idx]) score += w.conf;
                grid[idx] = w;
            }
        });
        return { grid, score };
    }

    /* ---------- public API ---------- */
    window.scanWordFromImage = async function (file, statusCb) {
        statusCb = statusCb || function () {};
        try {
            if (typeof Tesseract === 'undefined') {
                throw new Error('Tesseract not loaded — check script tag.');
            }

            const url = URL.createObjectURL(file);
            const img = new Image();
            await new Promise((res, rej) => {
                img.onload = res; img.onerror = rej; img.src = url;
            });
            const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            enhance(canvas);

            const w = await getWorker();

            statusCb('Reading board (pass 1 of 2)…');
            const res1 = await w.recognize(canvas);
            const up = toGrid(harvest(res1.data, canvas.width, canvas.height));

            statusCb('Reading board (pass 2 of 2)…');
            const flipped = rotate180(canvas);
            const res2 = await w.recognize(flipped);
            const down = toGrid(harvest(res2.data, flipped.width, flipped.height));

            const winner = down.score > up.score ? down : up;
            if (!winner.grid.some(Boolean)) {
                statusCb('No readable words found.');
                return 0;
            }

            const cells = [...board.querySelectorAll('.cell')];
            let filled = 0;
            winner.grid.forEach((entry, i) => {
                if (entry) {
                    cells[i].querySelector('.cell-text').textContent = entry.word;
                    filled++;
                }
            });

            updateStats();
            saveCurrentState();
            statusCb('Filled ' + filled + ' of 25 cells' +
                (winner === down ? ' (photo was upside down - auto-corrected)' : '') + '.');
            return filled;
        } catch (e) {
            console.error(e);
            statusCb('Scan error: ' + e.message);
            return null;
        }
    };
})();
