/* ============================================================
   WORD SCANNER — full-board OCR via ppu-paddle-ocr,
   force-matched to WORD_PAIRS
   ------------------------------------------------------------
   Load order:
     <script type="module">
       import * as M from 'https://cdn.jsdelivr.net/npm/ppu-paddle-ocr/+esm';
       window.PaddleOcr = M.default ?? M;
       window.dispatchEvent(new Event('paddle-ready'));
     </script>
     wordpairs.js -> wordscanner.js
   Exposes: window.scanWordFromImage(file, statusCb) -> count
   ============================================================ */
(function () {
    'use strict';

    const MAX_DIM = 2000;
    const GOOD_ENOUGH = 20;
    const PADDLE_WAIT_MS = 15000;   // wait this long for the module to appear

    let DICT_ENTRIES = null;
    let servicePromise = null;

    /* ---------- dictionary ---------- */
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

    function matrixSimilarity(a, b) {
        if (!a.length || !b.length) return 0;
        const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++) dp[i][0] = i;
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

    function slotSimilarity(a, b) {
        if (!a.length || !b.length) return 0;
        const maxLen = Math.max(a.length, b.length);
        const minLen = Math.min(a.length, b.length);
        let mismatches = 0;
        for (let i = 0; i < minLen; i++) if (a[i] !== b[i]) mismatches++;
        mismatches += Math.abs(a.length - b.length);
        return 1 - (mismatches / maxLen);
    }

    function bestDictWord(raw) {
        const dict = getDict();
        const clean = norm(raw);
        if (!clean.length) return { display: null, sim: -1 };
        let best = { display: null, sim: -1 };
        for (let i = 0; i < dict.length; i++) {
            const dictWord = dict[i].norm;
            if (Math.abs(clean.length - dictWord.length) > 2) continue;
            const scoreSlot = slotSimilarity(clean, dictWord);
            const scoreMatrix = matrixSimilarity(clean, dictWord);
            const combinedScore = Math.max(scoreSlot * 1.05, scoreMatrix);
            if (combinedScore > best.sim) {
                best = { display: dict[i].display, sim: combinedScore };
            }
        }
        return best;
    }

    /* ---------- ppu-paddle-ocr service ---------- */
    function findPaddleGlobal() {
        const cands = [window.PaddleOcr, window.PaddleOCR, window.paddleOcr, window.PPUPaddleOCR];
        for (const c of cands) if (c) return c;
        return null;
    }

    function waitForPaddle() {
        return new Promise(function (resolve, reject) {
            const found = findPaddleGlobal();
            if (found) return resolve(found);
            let done = false;
            function finish(v) { if (!done) { done = true; resolve(v); } }
            window.addEventListener('paddle-ready', function () {
                const g = findPaddleGlobal();
                if (g) finish(g);
            }, { once: true });
            const start = Date.now();
            const iv = setInterval(function () {
                const g = findPaddleGlobal();
                if (g) { clearInterval(iv); finish(g); }
                else if (Date.now() - start > PADDLE_WAIT_MS) {
                    clearInterval(iv);
                    if (!done) { done = true; reject(new Error('ppu-paddle-ocr not loaded — use the type="module" import shim.')); }
                }
            }, 200);
        });
    }

    function getService() {
        if (!servicePromise) {
            servicePromise = (async function () {
                const P = await waitForPaddle();

                // Singleton style: PaddleOcrService.getInstance()
                if (typeof P.getInstance === 'function') {
                    const svc = P.getInstance();
                    if (typeof svc.initialize === 'function') await svc.initialize();
                    else if (typeof svc.init === 'function') await svc.init();
                    return svc;
                }
                // Named export holding the class/service
                const Cls = P.PaddleOcrService || P.OcrService || P.default || P;
                if (typeof Cls === 'function') {
                    if (typeof Cls.getInstance === 'function') {
                        const svc = Cls.getInstance();
                        if (typeof svc.initialize === 'function') await svc.initialize();
                        else if (typeof svc.init === 'function') await svc.init();
                        return svc;
                    }
                    const svc = new Cls();
                    if (typeof svc.initialize === 'function') await svc.initialize();
                    else if (typeof svc.init === 'function') await svc.init();
                    return svc;
                }
                // Already an instance
                if (typeof P.initialize === 'function') { await P.initialize(); return P; }
                if (typeof P.init === 'function') { await P.init(); return P; }
                return P;
            })();
            servicePromise.catch(function () { servicePromise = null; }); // allow retry
        }
        return servicePromise;
    }

    async function runOcr(svc, canvas) {
        const fns = ['recognize', 'detect', 'ocr', 'process', 'run'];
        for (const f of fns) {
            if (typeof svc[f] === 'function') return await svc[f](canvas);
        }
        throw new Error('No recognize method found on OCR service.');
    }

    /* ---------- result adapter ---------- */
    // Normalizes many possible output shapes into
    // [{ text, conf, x0,y0,x1,y1 }] in pixel coords.
    function normalizeResults(res) {
        if (!res) return [];
        let lines = res;
        if (!Array.isArray(lines)) {
            lines = res.lines || res.results || res.data || res.words ||
                    res.text_lines || res.items || [];
        }
        if (!Array.isArray(lines)) return [];

        const out = [];
        lines.forEach(function (ln) {
            if (!ln) return;
            const text = ln.text || ln.transcription || ln.label || ln.word ||
                         (typeof ln === 'string' ? ln : '') ||
                         (Array.isArray(ln) && typeof ln[1] === 'string' ? ln[1] : '');
            if (!text) return;
            const conf = (ln.confidence != null ? ln.confidence :
                          ln.score != null ? ln.score : 0.5);

            let x0, y0, x1, y1;
            const box = ln.box || ln.bbox || ln.points || ln.polygon ||
                        (Array.isArray(ln) ? ln[0] : null);
            if (box && Array.isArray(box) && Array.isArray(box[0])) {
                // quad points [[x,y],...]
                const xs = box.map(function (p) { return p[0]; });
                const ys = box.map(function (p) { return p[1]; });
                x0 = Math.min.apply(null, xs); x1 = Math.max.apply(null, xs);
                y0 = Math.min.apply(null, ys); y1 = Math.max.apply(null, ys);
            } else if (box && Array.isArray(box) && box.length === 4 && typeof box[0] === 'number') {
                // [x0,y0,x1,y1] or [x,y,w,h] — heuristic
                if (box[2] > box[0] && box[3] > box[1]) { x0 = box[0]; y0 = box[1]; x1 = box[2]; y1 = box[3]; }
                else { x0 = box[0]; y0 = box[1]; x1 = box[0] + box[2]; y1 = box[1] + box[3]; }
            } else if (box && typeof box === 'object') {
                x0 = box.x0 != null ? box.x0 : box.left != null ? box.left : box.x;
                y0 = box.y0 != null ? box.y0 : box.top != null ? box.top : box.y;
                x1 = box.x1 != null ? box.x1 :
                     (box.right != null ? box.right :
                      (x0 != null && box.width != null ? x0 + box.width : null));
                y1 = box.y1 != null ? box.y1 :
                     (box.bottom != null ? box.bottom :
                      (y0 != null && box.height != null ? y0 + box.height : null));
            }
            if (x0 == null || y0 == null || x1 == null || y1 == null) return;
            out.push({ text: String(text), conf: conf, x0: x0, y0: y0, x1: x1, y1: y1 });
        });
        return out;
    }

    /* ---------- harvest: split lines into word tokens, dict-match ---------- */
    function harvest(rawLines, W, H) {
        const tokens = [];
        rawLines.forEach(function (ln) {
            const words = ln.text.toUpperCase().split(/\s+/).filter(function (t) { return norm(t).length; });
            if (!words.length) return;
            // Proportional sub-boxes across the line width
            const totalChars = words.reduce(function (a, w) { return a + w.length; }, 0) + (words.length - 1);
            let cursor = 0;
            const lineW = ln.x1 - ln.x0;
            words.forEach(function (w) {
                const frac0 = cursor / totalChars;
                const frac1 = (cursor + w.length) / totalChars;
                cursor += w.length + 1;
                tokens.push({
                    raw: w,
                    conf: ln.conf,
                    x0: (ln.x0 + lineW * frac0) / W, y0: ln.y0 / H,
                    x1: (ln.x0 + lineW * frac1) / W, y1: ln.y1 / H
                });
            });
        });

        tokens.sort(function (a, b) { return (a.y0 - b.y0) || (a.x0 - b.x0); });

        // Merge neighbours when the pair beats either alone (NEW + YORK)
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
                word: m.display, sim: m.sim, conf: item.conf,
                x: (item.x0 + item.x1) / 2,
                y: (item.y0 + item.y1) / 2
            };
        }).filter(function (t) { return t.word; });
    }

    /* ---------- gap clustering / grid (unchanged) ---------- */
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

            const variants = [
                { name: 'raw',      make: function () { return cloneCanvas(base); } },
                { name: 'contrast', make: function () { return grayContrast(base, 1.3); } }
            ];

            let best = null, bestLabel = '', bestFlipped = false;

            for (let v = 0; v < variants.length; v++) {
                const canvas = variants[v].make();

                statusCb('Reading board — ' + variants[v].name + ' (upright)…');
                const r1 = await runOcr(svc, canvas);
                const up = toGrid(harvest(normalizeResults(r1), canvas.width, canvas.height));
                if (!best || up.score > best.score) {
                    best = up; bestLabel = variants[v].name; bestFlipped = false;
                }
                if (best.filled >= GOOD_ENOUGH) break;

                statusCb('Reading board — ' + variants[v].name + ' (flipped)…');
                const flipped = rotate180(canvas);
                const r2 = await runOcr(svc, flipped);
                const down = toGrid(harvest(normalizeResults(r2), flipped.width, flipped.height));
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
                statusCb('OCR found no text.');
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
