/* ============================================================
   WORD SCANNER — full-board OCR via ppu-paddle-ocr,
   force-matched to WORD_PAIRS
   ------------------------------------------------------------
   - Uses PaddleOCR (PP-OCR det+rec models via onnxruntime-web)
     through the `ppu-paddle-ocr` package. Paddle handles
     rotation, uneven lighting and phone-photo blur far better
     than Tesseract, so fewer image variants are needed.
   - Tries raw + contrast variants, upright + flipped; keeps
     the best-scoring result.
   - Every OCR token maps to the CLOSEST dictionary word.
     Nothing is rejected; the word list itself is the filter.
   - Adjacent tokens merge when the pair beats either alone
     (NEW + YORK -> NEW YORK).
   - Rows/columns found by gap clustering, so mild tilt is OK.
   ------------------------------------------------------------
   Load order:
     1) ppu-paddle-ocr (bundle/UMD or module that exposes a
        global — see getService() for the names we look for),
        e.g.:
        <script src="https://cdn.jsdelivr.net/npm/ppu-paddle-ocr/dist/index.umd.js"></script>
        or, with modules:
        <script type="module">
          import * as PaddleOcr from 'https://cdn.jsdelivr.net/npm/ppu-paddle-ocr/+esm';
          window.PaddleOcr = PaddleOcr;
        </script>
     2) wordpairs.js
     3) wordscanner.js
   Exposes: window.scanWordFromImage(file, statusCb) -> count
   ============================================================ */
(function () {
    'use strict';

    const MAX_DIM = 2000;          // Paddle det model prefers moderate sizes
    const GOOD_ENOUGH = 20;        // stop trying variants once this many cells fill

    let DICT_ENTRIES = null;
    let servicePromise = null;

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

    // --- ENGINE 1: Matrix Alignment (Handles insertions/deletions/swaps) ---
    function matrixSimilarity(a, b) {
        if (!a.length || !b.length) return 0;

        const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++) dp[i][0] = i;
        for (let j = 0; j <= b.length; j++) dp[0][j] = j;

        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,                                  // Deletion
                    dp[i][j - 1] + 1,                                  // Insertion
                    dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0) // Substitution
                );
            }
        }
        return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
    }

    // --- ENGINE 2: Slot Alignment (Locks letter order, blocks trailing substring cuts) ---
    function slotSimilarity(a, b) {
        if (!a.length || !b.length) return 0;

        const maxLen = Math.max(a.length, b.length);
        const minLen = Math.min(a.length, b.length);
        let mismatches = 0;

        for (let i = 0; i < minLen; i++) {
            if (a[i] !== b[i]) mismatches++;
        }
        mismatches += Math.abs(a.length - b.length); // Add trailing penalty

        return 1 - (mismatches / maxLen);
    }

    // --- THE CONTROLLER: Cross-evaluates both scoring algorithms ---
    function bestDictWord(raw) {
        const dict = getDict();
        const clean = norm(raw);

        if (!clean.length) return { display: null, sim: -1 };

        let best = { display: null, sim: -1 };

        for (let i = 0; i < dict.length; i++) {
            const dictWord = dict[i].norm;

            // Skip extreme size variations upfront
            if (Math.abs(clean.length - dictWord.length) > 2) continue;

            const scoreSlot = slotSimilarity(clean, dictWord);
            const scoreMatrix = matrixSimilarity(clean, dictWord);

            // Prioritize slot alignment if it scores reasonably well,
            // fall back to the matrix when a length shift/typo happened.
            const combinedScore = Math.max(scoreSlot * 1.05, scoreMatrix);

            if (combinedScore > best.sim) {
                best = { display: dict[i].display, sim: combinedScore };
            }
        }

        return best;
    }

    /* ---------- ppu-paddle-ocr ---------- */
    function findPaddleGlobal() {
        // Cover the common global names the bundle may register under.
        const candidates = ['PaddleOcr', 'PaddleOCR', 'ppuPaddleOcr', 'paddleOcr'];
        for (let i = 0; i < candidates.length; i++) {
            if (typeof window[candidates[i]] !== 'undefined') return window[candidates[i]];
        }
        return null;
    }

    async function getService() {
        if (!servicePromise) {
            servicePromise = (async function () {
                const mod = findPaddleGlobal();
                if (!mod) {
                    throw new Error('ppu-paddle-ocr not loaded — check script tag order.');
                }
                // The package exposes PaddleOcrService (singleton) in recent
                // versions; older builds export a default class. Handle both.
                const Service = mod.PaddleOcrService || mod.default || mod;
                let svc;
                if (typeof Service.getInstance === 'function') {
                    svc = await Service.getInstance();
                } else {
                    svc = new Service();
                    if (typeof svc.initialize === 'function') await svc.initialize();
                    else if (typeof svc.init === 'function') await svc.init();
                }
                return svc;
            })();
        }
        return servicePromise;
    }

    // Normalize the many result shapes ppu-paddle-ocr versions return into
    // a flat token list: { raw, conf, x0, y0, x1, y1 } (normalized 0..1).
    function extractTokens(result, W, H) {
        const tokens = [];

        function boxToRect(box) {
            // box may be [[x,y]x4], {x0,y0,x1,y1}, or [x0,y0,x1,y1]
            if (!box) return null;
            if (Array.isArray(box) && Array.isArray(box[0])) {
                const xs = box.map(function (p) { return p[0]; });
                const ys = box.map(function (p) { return p[1]; });
                return {
                    x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys),
                    x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys)
                };
            }
            if (Array.isArray(box) && box.length === 4) {
                return { x0: box[0], y0: box[1], x1: box[2], y1: box[3] };
            }
            if (typeof box.x0 === 'number') return box;
            if (typeof box.x === 'number' && typeof box.width === 'number') {
                return { x0: box.x, y0: box.y, x1: box.x + box.width, y1: box.y + box.height };
            }
            return null;
        }

        function push(text, conf, rect) {
            const raw = (text || '').toUpperCase().trim();
            if (!norm(raw).length || !rect) return;
            tokens.push({
                raw: raw,
                conf: (conf || 0) * (conf <= 1 ? 100 : 1),
                x0: rect.x0 / W, y0: rect.y0 / H,
                x1: rect.x1 / W, y1: rect.y1 / H
            });
        }

        const lines = result && (result.lines || result.results || result.data || result);
        if (Array.isArray(lines)) {
            lines.forEach(function (line) {
                // Line may itself contain word segments; otherwise split the
                // line text across its box proportionally.
                const items = Array.isArray(line) ? line : [line];
                items.forEach(function (item) {
                    const text = item.text || item.transcription || item.label || '';
                    const conf = item.confidence != null ? item.confidence
                               : item.score != null ? item.score : item.mean || 0;
                    const rect = boxToRect(item.box || item.bbox || item.points || item.frame);
                    if (!rect) return;
                    const parts = text.trim().split(/\s+/).filter(Boolean);
                    if (parts.length <= 1) {
                        push(text, conf, rect);
                    } else {
                        // Split multi-word lines into proportional sub-boxes so
                        // the grid clustering still works per-token.
                        const totalChars = parts.join('').length + (parts.length - 1);
                        let cursor = rect.x0;
                        const widthPerChar = (rect.x1 - rect.x0) / totalChars;
                        parts.forEach(function (p) {
                            const w = p.length * widthPerChar;
                            push(p, conf, { x0: cursor, y0: rect.y0, x1: cursor + w, y1: rect.y1 });
                            cursor += w + widthPerChar; // account for the space
                        });
                    }
                });
            });
        }
        return tokens;
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
    function harvest(tokens) {
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
        }).filter(function (w) { return w.word; });
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

    /* ---------- run one canvas through Paddle ---------- */
    async function ocrCanvas(svc, canvas) {
        let result;
        if (typeof svc.recognize === 'function') result = await svc.recognize(canvas);
        else if (typeof svc.detect === 'function') result = await svc.detect(canvas);
        else if (typeof svc.ocr === 'function') result = await svc.ocr(canvas);
        else throw new Error('ppu-paddle-ocr service has no recognize()/detect()/ocr() method.');
        return toGrid(harvest(extractTokens(result, canvas.width, canvas.height)));
    }

    /* ---------- public API ---------- */
    window.scanWordFromImage = async function (file, statusCb) {
        statusCb = statusCb || function () {};
        try {
            if (!getDict()) {
                throw new Error('WORD_PAIRS not found — wordpairs.js must load first.');
            }

            statusCb('Loading OCR model…');
            const svc = await getService();

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

            // Paddle is far more robust than Tesseract on phone photos,
            // so fewer variants are needed.
            const variants = [
                { name: 'raw',      make: function () { return cloneCanvas(base); } },
                { name: 'contrast', make: function () { return grayContrast(base, 1.3); } }
            ];

            let best = null, bestLabel = '', bestFlipped = false;

            for (let v = 0; v < variants.length; v++) {
                const canvas = variants[v].make();

                statusCb('Reading board — ' + variants[v].name + ' (upright)…');
                const up = await ocrCanvas(svc, canvas);
                if (!best || up.score > best.score) {
                    best = up; bestLabel = variants[v].name; bestFlipped = false;
                }
                if (best.filled >= GOOD_ENOUGH) break;

                statusCb('Reading board — ' + variants[v].name + ' (flipped)…');
                const flipped = rotate180(canvas);
                const down = await ocrCanvas(svc, flipped);
                if (down.score > best.score) {
                    best = down; bestLabel = variants[v].name; bestFlipped = true;
                }
                if (best.filled >= GOOD_ENOUGH) break;
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
