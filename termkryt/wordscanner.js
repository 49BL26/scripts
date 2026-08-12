/* ============================================================
   WORD SCANNER — force-match every token to the word list
   2 OCR passes (upright + flipped). No OpenCV. No rejection.
   ============================================================ */
(function () {
    'use strict';

    const MAX_DIM = 2000;

    // Dictionary from WORD_PAIRS
    const DICT_ENTRIES = (function () {
        const map = new Map();
        (window.WORD_PAIRS || []).forEach(pair => pair.forEach(w => {
            const n = w.toUpperCase().replace(/[^A-Z]/g, '');
            if (n.length >= 2) map.set(n, w.toUpperCase());
        }));
        return [...map].map(([norm, display]) => ({ norm, display }));
    })();

    let worker = null;

    const norm = s => (s || '').toUpperCase().replace(/[^A-Z]/g, '');

    function similarity(a, b) {
        if (!a.length || !b.length) return 0;
        const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++) dp[i][0] = i;
        for (let j = 0; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++)
            for (let j = 1; j <= b.length; j++)
                dp[i][j] = Math.min(
                    dp[i-1][j] + 1,
                    dp[i][j-1] + 1,
                    dp[i-1][j-1] + (a[i-1] !== b[j-1] ? 1 : 0)
                );
        return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
    }

    // ALWAYS returns the closest dictionary word — never null
    function bestDictWord(raw) {
        const clean = norm(raw);
        let best = { display: DICT_ENTRIES[0] ? DICT_ENTRIES[0].display : raw, sim: -1 };
        for (const e of DICT_ENTRIES) {
            const s = similarity(clean, e.norm);
            if (s > best.sim) best = { display: e.display, sim: s };
        }
        return best;   // { display, sim }
    }

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

    function enhance(canvas) {
        const ctx = canvas.getContext('2d');
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const g = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
            const v = Math.max(0, Math.min(255, (g - 128) * 1.3 + 128));
            d[i] = d[i+1] = d[i+2] = v;
        }
        ctx.putImageData(img, 0, 0);
    }

    function rotate180(src) {
        const dst = document.createElement('canvas');
        dst.width = src.width; dst.height = src.height;
        const ctx = dst.getContext('2d');
        ctx.translate(src.width/2, src.height/2);
        ctx.rotate(Math.PI);
        ctx.drawImage(src, -src.width/2, -src.height/2);
        return dst;
    }

    /* Collect raw tokens with boxes. Merge horizontally-adjacent tokens
       when the pair is closer to a dictionary entry than either alone. */
    function harvest(data, W, H) {
        const tokens = [];
        (data.words || []).forEach(w => {
            const raw = (w.text || '').toUpperCase().trim();
            if (norm(raw).length < 2) return;          // only real filter: noise
            tokens.push({
                raw,
                conf: w.confidence || 0,
                x0: w.bbox.x0 / W, y0: w.bbox.y0 / H,
                x1: w.bbox.x1 / W, y1: w.bbox.y1 / H
            });
        });

        // Merge pass: try joining each token with its right neighbor
        tokens.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
        const merged = [];
        let cur = null;
        for (const tok of tokens) {
            if (cur) {
                const sameLine = tok.y0 < cur.y1 && tok.y1 > cur.y0;
                const close = (tok.x0 - cur.x1) < 0.04;
                if (sameLine && close) {
                    const joined = bestDictWord(cur.raw + tok.raw);
                    const solo = Math.max(bestDictWord(cur.raw).sim, bestDictWord(tok.raw).sim);
                    if (joined.sim > solo) {           // pair beats both singles
                        cur = {
                            raw: cur.raw + ' ' + tok.raw,
                            conf: Math.max(cur.conf, tok.conf),
                            x0: Math.min(cur.x0, tok.x0), y0: Math.min(cur.y0, tok.y0),
                            x1: Math.max(cur.x1, tok.x1), y1: Math.max(cur.y1, tok.y1)
                        };
                        continue;
                    }
                }
                merged.push(cur);
            }
            cur = tok;
        }
        if (cur) merged.push(cur);

        // Force-match every token — nothing is dropped
        return merged.map(item => {
            const m = bestDictWord(item.raw);
            return {
                word: m.display,
                sim: m.sim,                         // match quality, used for dedupe
                conf: item.conf,
                x: (item.x0 + item.x1) / 2,
                y: (item.y0 + item.y1) / 2
            };
        });
    }

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
            // Better match quality wins the cell
            if (!grid[idx] || w.sim > grid[idx].sim) {
                if (!grid[idx]) score += w.sim;
                grid[idx] = w;
            }
        });
        return { grid, score };
    }

    /* Same dictionary word claimed by two cells? Keep the better match,
       re-run the loser's raw text... simplest: just clear duplicates. */
    function dedupeGrid(grid) {
        const seen = new Map();  // word -> index of best cell
        grid.forEach((cell, i) => {
            if (!cell) return;
            const prev = seen.get(cell.word);
            if (prev === undefined) { seen.set(cell.word, i); return; }
            // keep the higher-sim one
            if (cell.sim > grid[prev].sim) { grid[prev] = null; seen.set(cell.word, i); }
            else grid[i] = null;
        });
        return grid;
    }

    window.scanWordFromImage = async function (file, statusCb) {
        statusCb = statusCb || function () {};
        try {
            if (typeof Tesseract === 'undefined')
                throw new Error('Tesseract not loaded — check script tag.');
            if (!DICT_ENTRIES.length)
                throw new Error('WORD_PAIRS empty — wordpairs.js must load first.');

            const url = URL.createObjectURL(file);
            const img = new Image();
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
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
            dedupeGrid(winner.grid);

            console.log('Scan result grid:',
                winner.grid.map(c => c ? `${c.word} (${c.sim.toFixed(2)})` : '—'));

            if (!winner.grid.some(Boolean)) {
                statusCb('OCR returned zero tokens — image unreadable.');
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
            statusCb(`Filled ${filled} of 25 cells${winner === down ? ' (photo upside down — corrected)' : ''}.`);
            return filled;
        } catch (e) {
            console.error(e);
            statusCb('Scan error: ' + e.message);
            return null;
        }
    };
})();
