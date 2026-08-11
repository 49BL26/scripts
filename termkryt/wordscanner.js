/* ============================================================
   WORD SCANNER — lightweight full-board OCR
   2 OCR passes total (upright + flipped). No OpenCV.
   Words are mapped to the 5x5 grid by their bounding boxes.
   Load AFTER wordpairs.js and tesseract.js.
   ============================================================ */
(function () {
    'use strict';

    const MAX_DIM = 1600;          // downscale limit; keeps memory low
    const MIN_CONFIDENCE = 40;     // per-word Tesseract confidence (0-100)
    const MIN_WORD_LEN = 3;

    let worker = null;

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
                tessedit_pageseg_mode: '11'   // sparse text: isolated words + boxes
            });
        }
        return worker;
    }

    function plausible(word) {
        if (!word || word.length < MIN_WORD_LEN) return false;
        if (!/[AEIOUY]/.test(word)) return false;
        if (/[^A-Z ]/.test(word)) return false;
        return true;
    }

    // Grayscale + contrast, in place
    function enhance(canvas) {
        const ctx = canvas.getContext('2d');
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const v = Math.max(0, Math.min(255, (g - 128) * 1.4 + 128));
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

    // Extract usable words + centroids from one recognize() result
    function harvest(data, W, H) {
        const out = [];
        (data.words || []).forEach(w => {
            const text = (w.text || '').toUpperCase().trim();
            if (w.confidence < MIN_CONFIDENCE || !plausible(text)) return;
            out.push({
                word: text,
                conf: w.confidence,
                x: (w.bbox.x0 + w.bbox.x1) / 2 / W,   // normalized 0-1
                y: (w.bbox.y0 + w.bbox.y1) / 2 / H
            });
        });
        return out;
    }

    // Map word list onto a 5x5 grid using the words' own bounding extent
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
                if (!grid[idx]) score += w.conf;      // reward new cells
                grid[idx] = w;
            }
        });
        return { grid, score };
    }

    window.scanWordFromImage = async function (file, statusCb) {
        statusCb = statusCb || function () {};
        try {
            if (typeof Tesseract === 'undefined') {
                throw new Error('Tesseract not loaded — check script tag.');
            }

            // Load and downscale the photo
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

            // Pass 1: upright
            statusCb('Reading board (pass 1 of 2)…');
            const res1 = await w.recognize(canvas);
            const up = toGrid(harvest(res1.data, canvas.width, canvas.height));

            // Pass 2: flipped 180°
            statusCb('Reading board (pass 2 of 2)…');
            const flipped = rotate180(canvas);
            const res2 = await w.recognize(flipped);
            const down = toGrid(harvest(res2.data, flipped.width, flipped.height));

            // Choose the better orientation by total confidence of placed cells
            const winner = down.score > up.score ? down : up;
            if (!winner.grid.some(Boolean)) {
                statusCb('No readable words found.');
                return 0;
            }

            // Fill board (grid already in correct order for either orientation,
            // because the flipped pass reads the flipped image top-to-bottom,
            // which corresponds to the true board order)
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
