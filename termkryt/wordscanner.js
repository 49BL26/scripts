(function () {
    "use strict";

    // Configuration Fallbacks (Assumed based on your context structure)
    const CFG = {
        WARP_W: 300,
        WARP_H: 200,
        CROP_MARGIN: 0.12, // Trim outer 12% to completely drop card lines
        WORKER_COUNT: 4,
        MAX_DIM: 1600
    };

    let workerPool = null;

    // Fixed: Injected standard cleanup to replace the missing global forceMatch dependency
    function forceMatch(text) {
        if (!text) return null;
        // Strip out lingering whitespace or rogue single-character noise
        let cleaned = text.replace(/[^a-zA-Z]/g, '').trim();
        return cleaned.length > 1 ? cleaned.toUpperCase() : null;
    }

    function cvReady() {
        return new Promise((resolve) => {
            if (typeof cv !== 'undefined' && cv.Mat) return resolve();
            if (typeof cv !== 'undefined') {
                cv.onRuntimeInitialized = resolve;
            } else {
                window.addEventListener('opencv-ready', resolve, { once: true });
            }
        });
    }

    /* ================= STAGE 2c/3: WARP + CROP + OTSU ================= */
    function warpAndBinarize(srcMat, quad) {
        const [tl, tr, br, bl] = quad.corners;
        
        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CFG.WARP_W, 0, CFG.WARP_W, CFG.WARP_H, 0, CFG.WARP_H]);
        
        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        const warped = new cv.Mat();
        
        // Target matrices allocated safely for standard loop scope
        let roi = null;
        let gray = new cv.Mat();
        let bin = new cv.Mat();
        const canvas = document.createElement('canvas');

        try {
            cv.warpPerspective(srcMat, warped, M, new cv.Size(CFG.WARP_W, CFG.WARP_H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

            // Center crop calculations
            const mx = Math.round(CFG.WARP_W * CFG.CROP_MARGIN);
            const my = Math.round(CFG.WARP_H * CFG.CROP_MARGIN);
            
            // Fixed: Captured ROI into scoped variable to safely invoke clear operations later
            roi = warped.roi(new cv.Rect(mx, my, CFG.WARP_W - 2 * mx, CFG.WARP_H - 2 * my));

            // Otsu Binarization process
            cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
            cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

            // Polar inversion correction
            if (cv.countNonZero(bin) < (bin.rows * bin.cols) / 2) {
                cv.bitwise_not(bin, bin);
            }

            cv.imshow(canvas, bin);
        } finally {
            // Fixed: Explicit, deep WebAssembly memory sweeps to actively target leak footprints
            srcTri.delete(); 
            dstTri.delete(); 
            M.delete();
            warped.delete(); 
            gray.delete(); 
            bin.delete();
            if (roi) roi.delete();
        }

        return canvas;
    }

    /* ================= STAGE 4: TESSERACT POOL ================= */
    async function getPool() {
        if (workerPool) return workerPool;
        const n = Math.min(CFG.WORKER_COUNT, navigator.hardwareConcurrency || 2);
        
        const localPool = [];
        for (let i = 0; i < n; i++) {
            // Fixed: Sequential generation patterns rather than simultaneous promises to ensure thread stability
            const w = await Tesseract.createWorker('eng');
            await w.setParameters({
                tessedit_pageseg_mode: '8', // Force strict single word target processing
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
            });
            localPool.push(w);
        }
        workerPool = localPool;
        return workerPool;
    }

    async function recognizeAll(canvases, statusCb) {
        const pool = await getPool();
        const results = new Array(canvases.length).fill(null);
        let next = 0, done = 0;

        await Promise.all(pool.map(async function (w) {
            while (next < canvases.length) {
                const idx = next++;
                if (!canvases[idx]) { done++; continue; }
                try {
                    const r = await w.recognize(canvases[idx]);
                    results[idx] = (r.data.text || '').trim();
                } catch (e) {
                    console.warn('OCR failed for card', idx, e);
                    results[idx] = null; 
                }
                statusCb('Reading cards… ' + (++done) + '/' + canvases.length);
            }
        }));
        return results;
    }

    /* ================= CORE PIPELINE ================= */
    async function extractBoardWords(imageSource, statusCb) {
        statusCb = statusCb || function () {};
        await cvReady();

        const iw = imageSource.width || imageSource.naturalWidth;
        const ih = imageSource.height || imageSource.naturalHeight;
        const scale = Math.min(1, CFG.MAX_DIM / Math.max(iw, ih));
        
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(iw * scale);
        canvas.height = Math.round(ih * scale);
        canvas.getContext('2d').drawImage(imageSource, 0, 0, canvas.width, canvas.height);

        const src = cv.imread(canvas);
        let cardCanvases = [], gridRows = [];
        
        try {
            statusCb('Detecting card edges…');
            const edgeMat = preprocessEdges(src);
            let quads;
            try {
                quads = findCardQuads(edgeMat, canvas.width * canvas.height);
            } finally {
                edgeMat.delete();
            }

            if (quads.length < 8) {
                throw new Error('Only ' + quads.length +
                    ' card(s) detected — retake photo with the full board, ' +
                    'even lighting, and a contrasting background.');
            }

            gridRows = gridSort(quads);
            const flat = gridRows.flat();
            statusCb('Found ' + flat.length + ' cards. Flattening…');

            cardCanvases = flat.map(function (q, i) {
                try { return warpAndBinarize(src, q); }
                catch (e) {
                    console.warn('Warp failed for card', i, e);
                    return null; 
                }
            });
        } finally {
            src.delete(); // Critical cleanup point for original canvas matrix mapping context
        }

        const rawWords = await recognizeAll(cardCanvases, statusCb);

        const board = [];
        let k = 0;
        for (const row of gridRows) {
            const outRow = [];
            for (let c = 0; c < row.length; c++) {
                const matched = forceMatch(rawWords[k++]);
                outRow.push(matched || null);
            }
            board.push(outRow);
        }
        
        while (board.length < 5) board.push([null, null, null, null, null]);
        board.length = 5;
        board.forEach(function (r) {
            while (r.length < 5) r.push(null);
            r.length = 5;
        });
        return board;
    }

    /* ================= PUBLIC API ================= */
    window.extractBoardWords = extractBoardWords;

    window.scanWordFromImage = async function (file, statusCb) {
        statusCb = statusCb || function () {};
        try {
            if (typeof Tesseract === 'undefined')
                throw new Error('tesseract.js not loaded.');

            statusCb('Loading image…');
            const url = URL.createObjectURL(file);
            const img = new Image();
            await new Promise(function (res, rej) {
                img.onload = res; img.onerror = rej; img.src = url;
            });
            URL.revokeObjectURL(url);

            const board = await extractBoardWords(img, statusCb);
            const cells = Array.prototype.slice.call(document.getElementById('board').querySelectorAll('.cell'));
            let filled = 0;
            
            board.flat().forEach(function (word, i) {
                if (word && cells[i]) {
                    const textNode = cells[i].querySelector('.cell-text');
                    if (textNode) {
                        textNode.textContent = word.toLowerCase();
                        filled++;
                    }
                }
            });

            console.log('Board result:', board);
            if (!filled) { statusCb('No readable cards found.'); return 0; }

            if (typeof updateStats === 'function') updateStats();
            if (typeof saveCurrentState === 'function') saveCurrentState();
            statusCb('Filled ' + filled + ' of 25 cells.');
            return filled;
        } catch (e) {
            console.error(e);
            statusCb('Scan error: ' + e.message);
            return null;
        }
    };
})();
/* ============================================================
   WORD SCANNER v3 — OpenCV.js card isolation + Tesseract.js
   ------------------------------------------------------------
   Pipeline:
     1. OpenCV: grayscale -> Gaussian blur -> Canny -> morph close
     2. Contours filtered by area + aspect ratio -> 25 cards
     3. Per-card perspective warp -> flat standardized canvas
     4. Center crop + Otsu binarize (black text / white bg)
     5. Tesseract PSM 8 (single word), letters-only whitelist
     6. Optional force-match against WORD_PAIRS
   ------------------------------------------------------------
   Load order: tesseract.js -> opencv.js -> wordpairs.js -> this
   Exposes: window.scanWordFromImage(file, statusCb) -> count
            window.extractBoardWords(imgOrCanvas)    -> 5x5 array
   ============================================================ */
(function () {
    'use strict';

    /* ================= CONFIG ================= */
    const CFG = {
        MAX_DIM: 1600,            // working resolution ceiling
        BLUR_KSIZE: 5,            // Gaussian kernel (5 or 7)
        CANNY_LOW: 50,
        CANNY_HIGH: 150,
        MORPH_KSIZE: 5,           // closing kernel
        CARD_MIN_AREA_FRAC: 0.004,  // card must be >= 0.4% of image
        CARD_MAX_AREA_FRAC: 0.10,   // and <= 10%
        ASPECT_MIN: 1.1,          // Codenames cards ~1.55:1 landscape
        ASPECT_MAX: 2.4,
        WARP_W: 300,              // standardized card size
        WARP_H: 200,
        CROP_MARGIN: 0.13,        // trim 13% margin off warped card
        WORKER_COUNT: 4,          // Tesseract worker pool size
        MIN_WORD_LEN: 2
    };

    let workerPool = null;
    let DICT_ENTRIES = null;

    /* ================= OPENCV READINESS ================= */
    function cvReady() {
        return new Promise(function (resolve, reject) {
            if (typeof cv !== 'undefined' && cv.Mat) return resolve();
            let waited = 0;
            const iv = setInterval(function () {
                if (typeof cv !== 'undefined' && cv.Mat) { clearInterval(iv); resolve(); }
                else if ((waited += 200) > 20000) {
                    clearInterval(iv);
                    reject(new Error('OpenCV.js failed to load.'));
                }
            }, 200);
        });
    }

    /* ================= DICTIONARY (optional force-match) ================= */
    function norm(s) { return (s || '').toUpperCase().replace(/[^A-Z]/g, ''); }

    function getDict() {
        if (DICT_ENTRIES) return DICT_ENTRIES;
        const pairs = (typeof WORD_PAIRS !== 'undefined' && Array.isArray(WORD_PAIRS)) ? WORD_PAIRS
                    : (window.WORD_PAIRS || null);
        if (!pairs) return null;
        const map = new Map();
        pairs.forEach(function (pair) {
            (Array.isArray(pair) ? pair : [pair]).forEach(function (w) {
                if (typeof w !== 'string') return;
                const n = norm(w);
                if (n.length >= CFG.MIN_WORD_LEN && !map.has(n)) map.set(n, w.toUpperCase());
            });
        });
        DICT_ENTRIES = map.size ? Array.from(map, e => ({ norm: e[0], display: e[1] })) : null;
        return DICT_ENTRIES;
    }

    function levenshtein(a, b) {
        const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++) dp[i][0] = i;
        for (let j = 0; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++)
            for (let j = 1; j <= b.length; j++)
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)
                );
        return dp[a.length][b.length];
    }

    function forceMatch(raw) {
        const dict = getDict();
        const clean = norm(raw);
        if (!clean.length) return null;
        if (!dict) return clean;                       // no dictionary: pass through
        let best = null, bestSim = -1;
        for (const entry of dict) {
            if (Math.abs(clean.length - entry.norm.length) > 3) continue;
            const sim = 1 - levenshtein(clean, entry.norm) /
                        Math.max(clean.length, entry.norm.length);
            if (sim > bestSim) { bestSim = sim; best = entry.display; }
        }
        return best;
    }

    /* ================= STAGE 1: PREPROCESS + EDGES ================= */
    function preprocessEdges(srcMat) {
        const gray = new cv.Mat(), blurred = new cv.Mat(),
              edges = new cv.Mat(), closed = new cv.Mat();
        try {
            cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred,
                new cv.Size(CFG.BLUR_KSIZE, CFG.BLUR_KSIZE), 0);
            cv.Canny(blurred, edges, CFG.CANNY_LOW, CFG.CANNY_HIGH);
            const kernel = cv.getStructuringElement(cv.MORPH_RECT,
                new cv.Size(CFG.MORPH_KSIZE, CFG.MORPH_KSIZE));
            cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
            kernel.delete();
            return closed;
        } finally {
            gray.delete(); blurred.delete(); edges.delete();
        }
    }

    /* ================= STAGE 2: CONTOURS -> CARD QUADS ================= */
    function orderCorners(pts) {
        // Sort 4 points: TL, TR, BR, BL
        const bySum   = pts.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
        const byDiff  = pts.slice().sort((a, b) => (a.y - a.x) - (b.y - b.x));
        return [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // TL, TR, BR, BL
    }

    function findCardQuads(edgeMat, imgArea) {
        const contours = new cv.MatVector(), hierarchy = new cv.Mat();
        const quads = [];
        try {
            cv.findContours(edgeMat, contours, hierarchy,
                cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

            for (let i = 0; i < contours.size(); i++) {
                const cnt = contours.get(i);
                const area = cv.contourArea(cnt);
                if (area < imgArea * CFG.CARD_MIN_AREA_FRAC ||
                    area > imgArea * CFG.CARD_MAX_AREA_FRAC) { cnt.delete(); continue; }

                // Use min-area rect: tolerant of slightly rounded corners
                const rect = cv.minAreaRect(cnt);
                const w = Math.max(rect.size.width, rect.size.height);
                const h = Math.min(rect.size.width, rect.size.height);
                cnt.delete();
                if (!h) continue;
                const aspect = w / h;
                if (aspect < CFG.ASPECT_MIN || aspect > CFG.ASPECT_MAX) continue;
                if ((w * h) > 0 && area / (w * h) < 0.75) continue; // not solidly rectangular

                const box = cv.RotatedRect.points(rect);   // 4 corner points
                quads.push({
                    corners: orderCorners(box.map(p => ({ x: p.x, y: p.y }))),
                    cx: rect.center.x, cy: rect.center.y,
                    area: area
                });
            }
        } finally {
            contours.delete(); hierarchy.delete();
        }

        // Deduplicate nested/duplicate detections of the same card
        quads.sort((a, b) => b.area - a.area);
        const kept = [];
        for (const q of quads) {
            const dupe = kept.some(k =>
                Math.hypot(k.cx - q.cx, k.cy - q.cy) < Math.sqrt(k.area) * 0.5);
            if (!dupe) kept.push(q);
        }
        return kept;
    }

    /* ================= STAGE 2b: SORT QUADS INTO 5x5 GRID ================= */
    function gridSort(quads) {
        if (!quads.length) return [];
        const sorted = quads.slice().sort((a, b) => a.cy - b.cy);
        const rows = [];
        let row = [sorted[0]];
        const rowTol = Math.sqrt(sorted[0].area) * 0.6;
        for (let i = 1; i < sorted.length; i++) {
            const prevY = row.reduce((s, q) => s + q.cy, 0) / row.length;
            if (Math.abs(sorted[i].cy - prevY) < rowTol) row.push(sorted[i]);
            else { rows.push(row); row = [sorted[i]]; }
        }
        rows.push(row);
        rows.forEach(r => r.sort((a, b) => a.cx - b.cx));
        return rows;
    }

    /* ================= STAGE 2c/3: WARP + CROP + OTSU ================= */
    function warpAndBinarize(srcMat, quad) {
        const [tl, tr, br, bl] = quad.corners;
        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
            [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2,
            [0, 0, CFG.WARP_W, 0, CFG.WARP_W, CFG.WARP_H, 0, CFG.WARP_H]);

        const M = cv.getPerspectiveTransform(srcTri, dstTri);
        const warped = new cv.Mat();
        cv.warpPerspective(srcMat, warped, M,
            new cv.Size(CFG.WARP_W, CFG.WARP_H),
            cv.INTER_LINEAR, cv.BORDER_REPLICATE);
        srcTri.delete(); dstTri.delete(); M.delete();

        // Center crop: remove borders/shadows
        const mx = Math.round(CFG.WARP_W * CFG.CROP_MARGIN);
        const my = Math.round(CFG.WARP_H * CFG.CROP_MARGIN);
        const roi = warped.roi(new cv.Rect(mx, my,
            CFG.WARP_W - 2 * mx, CFG.WARP_H - 2 * my));

        // Otsu binarize -> black text on white
        const gray = new cv.Mat(), bin = new cv.Mat();
        cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
        cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

        // If mostly black, polarity is inverted: flip it
        if (cv.countNonZero(bin) < bin.rows * bin.cols / 2) {
            cv.bitwise_not(bin, bin);
        }

        const canvas = document.createElement('canvas');
        cv.imshow(canvas, bin);

        roi.delete(); warped.delete(); gray.delete(); bin.delete();
        return canvas;
    }

    /* ================= STAGE 4: TESSERACT POOL ================= */
    async function getPool() {
        if (workerPool) return workerPool;
        const n = Math.min(CFG.WORKER_COUNT,
            navigator.hardwareConcurrency || 2);
        workerPool = await Promise.all(
            Array.from({ length: n }, async function () {
                const w = await Tesseract.createWorker('eng');
                await w.setParameters({
                    tessedit_pageseg_mode: '8',   // single word
                    tessedit_char_whitelist:
                        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
                });
                return w;
            })
        );
        return workerPool;
    }

    async function recognizeAll(canvases, statusCb) {
        const pool = await getPool();
        const results = new Array(canvases.length).fill(null);
        let next = 0, done = 0;

        await Promise.all(pool.map(async function (w) {
            while (next < canvases.length) {
                const idx = next++;
                if (!canvases[idx]) { done++; continue; }
                try {
                    const r = await w.recognize(canvases[idx]);
                    results[idx] = (r.data.text || '').trim();
                } catch (e) {
                    console.warn('OCR failed for card', idx, e);
                    results[idx] = null;                 // graceful per-card failure
                }
                statusCb('Reading cards… ' + (++done) + '/' + canvases.length);
            }
        }));
        return results;
    }

    /* ================= CORE PIPELINE ================= */
    async function extractBoardWords(imageSource, statusCb) {
        statusCb = statusCb || function () {};
        await cvReady();

        // Normalize input to a bounded canvas
        const iw = imageSource.width || imageSource.naturalWidth;
        const ih = imageSource.height || imageSource.naturalHeight;
        const scale = Math.min(1, CFG.MAX_DIM / Math.max(iw, ih));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(iw * scale);
        canvas.height = Math.round(ih * scale);
        canvas.getContext('2d').drawImage(imageSource, 0, 0, canvas.width, canvas.height);

        const src = cv.imread(canvas);
        let cardCanvases = [], gridRows = [];
        try {
            statusCb('Detecting card edges…');
            const edgeMat = preprocessEdges(src);
            let quads;
            try {
                quads = findCardQuads(edgeMat, canvas.width * canvas.height);
            } finally {
                edgeMat.delete();
            }

            if (quads.length < 8) {
                throw new Error('Only ' + quads.length +
                    ' card(s) detected — retake photo with the full board, ' +
                    'even lighting, and a contrasting background.');
            }

            gridRows = gridSort(quads);
            const flat = gridRows.flat();
            statusCb('Found ' + flat.length + ' cards. Flattening…');

            cardCanvases = flat.map(function (q, i) {
                try { return warpAndBinarize(src, q); }
                catch (e) {
                    console.warn('Warp failed for card', i, e);
                    return null;                          // unresolved contour: skip
                }
            });
        } finally {
            src.delete();
        }

        const rawWords = await recognizeAll(cardCanvases, statusCb);

        // Rebuild 5x5 structure following the physical row layout
        const board = [];
        let k = 0;
        for (const row of gridRows) {
            const outRow = [];
            for (let c = 0; c < row.length; c++) {
                const matched = forceMatch(rawWords[k++]);
                outRow.push(matched || null);
            }
            board.push(outRow);
        }
        // Pad/trim to strict 5x5
        while (board.length < 5) board.push([null, null, null, null, null]);
        board.length = 5;
        board.forEach(function (r) {
            while (r.length < 5) r.push(null);
            r.length = 5;
        });
        return board;
    }

    /* ================= PUBLIC API ================= */
    window.extractBoardWords = extractBoardWords;

    window.scanWordFromImage = async function (file, statusCb) {
        statusCb = statusCb || function () {};
        try {
            if (typeof Tesseract === 'undefined')
                throw new Error('tesseract.js not loaded.');

            statusCb('Loading image…');
            const url = URL.createObjectURL(file);
            const img = new Image();
            await new Promise(function (res, rej) {
                img.onload = res; img.onerror = rej; img.src = url;
            });
            URL.revokeObjectURL(url);

            const board = await extractBoardWords(img, statusCb);

            // Write into the DOM board
            const cells = Array.prototype.slice.call(
                document.getElementById('board').querySelectorAll('.cell'));
            let filled = 0;
            board.flat().forEach(function (word, i) {
                if (word && cells[i]) {
                    cells[i].querySelector('.cell-text').textContent = word.toLowerCase();
                    filled++;
                }
            });

            console.log('Board result:', board);
            if (!filled) { statusCb('No readable cards found.'); return 0; }

            if (typeof updateStats === 'function') updateStats();
            if (typeof saveCurrentState === 'function') saveCurrentState();
            statusCb('Filled ' + filled + ' of 25 cells.');
            return filled;
        } catch (e) {
            console.error(e);
            statusCb('Scan error: ' + e.message);
            return null;
        }
    };
})();
