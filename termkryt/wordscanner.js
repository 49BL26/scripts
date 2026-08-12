/* ============================================================
   WORD SCANNER — full-board OCR, force-matched to WORD_PAIRS
   ------------------------------------------------------------
   - Tries several image variants (raw / contrast / binarized /
     upscaled) in both orientations; keeps the best result.
   - Every OCR token maps to the CLOSEST dictionary word.
     Nothing is rejected; the word list itself is the filter.
   - Adjacent tokens merge when the pair beats either alone
     (NEW + YORK -> NEW YORK).
   - Rows/columns found by gap clustering, so mild tilt is OK.
   ------------------------------------------------------------
   Load order:  tesseract.js -> wordpairs.js -> wordscanner.js
   Exposes: window.scanWordFromImage(file, statusCb) -> count
   ============================================================ */
(function () {
    'use strict';

    const MAX_DIM = 4000;          // downscale ceiling
    const GOOD_ENOUGH = 20;        // stop trying variants once this many cells fill

    let DICT_ENTRIES = null;
    let worker = null;

    /* ---------- dictionary (lazy; works with `const WORD_PAIRS`) ---------- */
    function rawPairs() {
        if (typeof WORD_PAIRS !== 'undefined' && Array.isArray(WORD_PAIRS)) return WORD_PAIRS;
        if (typeof window !== 'undefined' && Array.isArray(window.WORD_PAIRS)) return window.WORD_PAIRS;
        return null;
    }

    function getDict() {
        if (DICT_ENTRIES) return DICT_ENTRIES;
        const pairs = rawPairs();
        if (!pairs || !pairs.length) return null;
        const map = new Map();
        pairs.forEach(function (pair) {
            (Array.isArray(pair) ? pair : [pair]).forEach(function (w) {
                if (typeof w !== 'string') return;
                const n = w.toUpperCase().replace(/[^A-Z]/g, '');
                if (n.length >= 2 && !map.has(n)) map.set(n, w.toUpperCase());
            });
        });
        if (!map.size) return null;
        DICT_ENTRIES = Array.from(map, function (e) { return { norm: e[0], display: e[1] }; });
        return DICT_ENTRIES;
    }

    /* ---------- string matching ---------- */
    function norm(s) { return (s || '').toUpperCase().replace(/[^A-Z]/g, ''); }

   /* ---------- looser string matching (Jaro-Winkler style) ---------- */
function similarity(s1, s2) {
    if (s1 === s2) return 1.0;
    
    const len1 = s1.length, len2 = s2.length;
    if (len1 === 0 || len2 === 0) return 0.0;

    // Max distance allowed between matching characters
    const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
    const matches1 = new Array(len1).fill(false);
    const matches2 = new Array(len2).fill(false);

    let m = 0; // Number of matching characters
    for (let i = 0; i < len1; i++) {
        const start = Math.max(0, i - matchWindow);
        const end = Math.min(len2, i + matchWindow + 1);
        for (let j = start; j < end; j++) {
            if (!matches2[j] && s1[i] === s2[j]) {
                matches1[i] = true;
                matches2[j] = true;
                m++;
                break;
            }
        }
    }

    if (m === 0) return 0.0;

    // Count transpositions
    let t = 0, k = 0;
    for (let i = 0; i < len1; i++) {
        if (matches1[i]) {
            while (!matches2[k]) k++;
            if (s1[i] !== s2[k]) t++;
            k++;
        }
    }
    t /= 2;

    // Base Jaro similarity
    let jaro = (m / len1 + m / len2 + (m - t) / m) / 3;

    // Winkler modification: bonus for common prefix (up to 4 chars)
    let prefix = 0;
    for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
        if (s1[i] === s2[i]) prefix++;
        else break;
    }
    
    return jaro + (prefix * 0.1 * (1 - jaro));
}

function bestDictWord(raw) {
    const dict = getDict();
    const clean = norm(raw);
    
    // Ignore extreme garbage / tiny noise tokens
    if (clean.length < 2) return { display: null, sim: 0 }; 

    let best = { display: null, sim: -1 };
    for (let i = 0; i < dict.length; i++) {
        const s = similarity(clean, dict[i].norm);
        if (s > best.sim) best = { display: dict[i].display, sim: s };
    }

    // MINIMUM THRESHOLD: Only accept if it's at least a 65% match.
    // This stops Tesseract from turning random image artifacts into wrong words.
    if (best.sim < 0.65) {
        return { display: null, sim: 0 };
    }

    return best;
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

    /* ---------- image variants ---------- */
    function cloneCanvas(src, scale) {
        scale = scale || 1;
        const dst = document.createElement('canvas');
        dst.width = Math.round(src.width * scale);
        dst.height = Math.round(src.height * scale);
        const ctx = dst.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, dst.width, dst.height);
        return dst;
    }

    function grayContrast(src, amount) {
        const c = cloneCanvas(src);
        const ctx = c.getContext('2d');
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const v = Math.max(0, Math.min(255, (g - 128) * amount + 128));
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(img, 0, 0);
        return c;
    }

    // Adaptive-ish threshold using the mean luminance
    function binarize(src) {
        const c = cloneCanvas(src);
        const ctx = c.getContext('2d');
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) {
            sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
        const mean = sum / (d.length / 4);
        const cut = mean * 0.92;
        for (let i = 0; i < d.length; i += 4) {
            const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const v = g < cut ? 0 : 255;
            d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(img, 0, 0);
        return c;
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

    /* ---------- harvest + merge ---------- */
    function harvest(data, W, H) {
        let tokens = [];
        (data.words || []).forEach(function (w) {
            const raw = (w.text || '').toUpperCase().trim();
            if (!norm(raw).length) return;              // single letters now allowed
            if (!w.bbox) return;
            tokens.push({
                raw: raw,
                conf: w.confidence || 0,
                x0: w.bbox.x0 / W, y0: w.bbox.y0 / H,
                x1: w.bbox.x1 / W, y1: w.bbox.y1 / H
            });
        });

        tokens.sort(function (a, b) { return (a.y0 - b.y0) || (a.x0 - b.x0); });

        // Merge with right neighbour when the pair matches better
        const merged = [];
        let cur = null;
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (cur) {
                const sameLine = tok.y0 < cur.y1 && tok.y1 > cur.y0;
                const close = (tok.x0 - cur.x1) < 0.07;
                if (sameLine && close) {
                    const joined = bestDictWord(cur.raw + ' ' + tok.raw);
                    const solo = Math.max(bestDictWord(cur.raw).sim, bestDictWord(tok.raw).sim);
                    if (joined.sim >= solo) {
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

        return merged.map(function (item) {
            const m = bestDictWord(item.raw);
            return {
                word: m.display,
                sim: m.sim,
                conf: item.conf,
                x: (item.x0 + item.x1) / 2,
                y: (item.y0 + item.y1) / 2
            };
        });
    }

    /* ---------- gap clustering: tolerant of tilt / partial boards ---------- */
    function clusterAxis(values, maxGroups) {
        const sorted = values.slice().sort(function (a, b) { return a - b; });
        if (!sorted.length) return [];
        const span = sorted[sorted.length - 1] - sorted[0];
        let groups = [[sorted[0]]];
        const threshold = Math.max(span / (maxGroups * 2.2), 0.012);
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] - sorted[i - 1] > threshold) groups.push([sorted[i]]);
            else groups[groups.length - 1].push(sorted[i]);
        }
        // Too many clusters: merge the closest neighbours until we fit
        while (groups.length > maxGroups) {
            let bestI = 0, bestGap = Infinity;
            for (let i = 0; i < groups.length - 1; i++) {
                const gap = groups[i + 1][0] - groups[i][groups[i].length - 1];
                if (gap < bestGap) { bestGap = gap; bestI = i; }
            }
            groups[bestI] = groups[bestI].concat(groups[bestI + 1]);
            groups.splice(bestI + 1, 1);
        }
        return groups.map(function (g) {
            return g.reduce(function (a, b) { return a + b; }, 0) / g.length;
        });
    }

    function nearestIndex(centers, v) {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < centers.length; i++) {
            const d = Math.abs(centers[i] - v);
            if (d < bd) { bd = d; bi = i; }
        }
        return bi;
    }

    function toGrid(words) {
        const grid = new Array(25).fill(null);
        if (!words.length) return { grid: grid, score: 0, filled: 0 };

        const rowCenters = clusterAxis(words.map(function (w) { return w.y; }), 5);
        const colCenters = clusterAxis(words.map(function (w) { return w.x; }), 5);

        let score = 0, filled = 0;
        words.forEach(function (w) {
            const row = nearestIndex(rowCenters, w.y);
            const col = nearestIndex(colCenters, w.x);
            const idx = Math.min(24, row * 5 + col);
            if (!grid[idx]) { filled++; score += w.sim; grid[idx] = w; }
            else if (w.sim > grid[idx].sim) { score += w.sim - grid[idx].sim; grid[idx] = w; }
        });
        return { grid: grid, score: score, filled: filled };
    }

    function dedupeGrid(grid) {
        const seen = new Map();
        grid.forEach(function (cell, i) {
            if (!cell) return;
            const prev = seen.get(cell.word);
            if (prev === undefined) { seen.set(cell.word, i); return; }
            if (cell.sim > grid[prev].sim) { grid[prev] = null; seen.set(cell.word, i); }
            else grid[i] = null;
        });
        return grid;
    }

    /* ---------- public API ---------- */
    window.scanWordFromImage = async function (file, statusCb) {
        statusCb = statusCb || function () {};
        try {
            if (typeof Tesseract === 'undefined') {
                throw new Error('Tesseract not loaded — check script tag order.');
            }
            if (!getDict()) {
                throw new Error('WORD_PAIRS not found — wordpairs.js must load first.');
            }

            const url = URL.createObjectURL(file);
            const img = new Image();
            await new Promise(function (res, rej) {
                img.onload = res; img.onerror = rej; img.src = url;
            });
            const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
            const base = document.createElement('canvas');
            base.width = Math.round(img.width * scale);
            base.height = Math.round(img.height * scale);
            base.getContext('2d').drawImage(img, 0, 0, base.width, base.height);
            URL.revokeObjectURL(url);

            // Variants, cheapest/most-likely first
            const variants = [
                { name: 'contrast', make: function () { return grayContrast(base, 1.3); } },
                { name: 'raw',      make: function () { return cloneCanvas(base); } },
                { name: 'binary',   make: function () { return binarize(base); } },
                { name: 'upscaled', make: function () { return grayContrast(cloneCanvas(base, 1.6), 1.15); } }
            ];

            const w = await getWorker();
            let best = null, bestLabel = '', bestFlipped = false;

            for (let v = 0; v < variants.length; v++) {
                const canvas = variants[v].make();

                statusCb('Reading board — ' + variants[v].name + ' (upright)…');
                const r1 = await w.recognize(canvas);
                const up = toGrid(harvest(r1.data, canvas.width, canvas.height));
                if (!best || up.score > best.score) {
                    best = up; bestLabel = variants[v].name; bestFlipped = false;
                }

                statusCb('Reading board — ' + variants[v].name + ' (flipped)…');
                const flipped = rotate180(canvas);
                const r2 = await w.recognize(flipped);
                const down = toGrid(harvest(r2.data, flipped.width, flipped.height));
                if (down.score > best.score) {
                    best = down; bestLabel = variants[v].name; bestFlipped = true;
                }

                if (best.filled >= GOOD_ENOUGH) break;   // stop early when it's working
            }

            dedupeGrid(best.grid);

            console.log('Scan variant used:', bestLabel, bestFlipped ? '(flipped)' : '(upright)');
            console.log('Scan result grid:', best.grid.map(function (c) {
                return c ? c.word + ' (' + c.sim.toFixed(2) + ')' : '—';
            }));

            const cells = Array.prototype.slice.call(
                document.getElementById('board').querySelectorAll('.cell')
            );
            let filled = 0;
            best.grid.forEach(function (entry, i) {
                if (entry && cells[i]) {
                    cells[i].querySelector('.cell-text').textContent = entry.word.toLowerCase();
                    filled++;
                }
            });

            if (!filled) {
                statusCb('OCR found no text in any variant.');
                return 0;
            }

            if (typeof updateStats === 'function') updateStats();
            if (typeof saveCurrentState === 'function') saveCurrentState();

            statusCb('Filled ' + filled + ' of 25 cells using ' + bestLabel +
                (bestFlipped ? ' (photo upside down — corrected)' : '') + '.');
            return filled;
        } catch (e) {
            console.error(e);
            statusCb('Scan error: ' + e.message);
            return null;
        }
    };
})();
