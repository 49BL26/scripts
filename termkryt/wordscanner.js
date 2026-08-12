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
   Exposes: window.scanBoardFromImage(imgElementOrCanvas, statusCb)
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

                const rect = cv.minAreaRect(cnt);
                const w = Math.max(rect.size.width, rect.size.height);
                const h = Math.min(rect.size.width, rect.size.height);
                cnt.delete();
                if (!h) continue;
                const aspect = w / h;
                if (aspect < CFG.ASPECT_MIN || aspect > CFG.ASPECT_MAX) continue;
                if ((w * h) > 0 && area / (w * h) < 0.75) continue; 

                const box = cv.RotatedRect.points(rect);   
                quads.push({
                    corners: orderCorners(box.map(p => ({ x: p.x, y: p.y }))),
                    cx: rect.center.x, cy: rect.center.y,
                    area: area
                });
            }
        } finally {
            contours.delete(); hierarchy.delete();
        }

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
        // Sort items globally from top to bottom
        const sorted = quads.slice().sort((a, b) => a.cy - b.cy);
        const rows = [];
        let row = [sorted[0]];
        const rowTol = Math.sqrt(sorted[0].area) * 0.6;

        for (let i = 1; i < sorted.length; i++) {
            const prevY = row.reduce((s, q) => s + q.cy, 0) / row.length;
            if (Math.abs(sorted[i].cy - prevY) < rowTol) {
                row.push(sorted[i]);
            } else {
                rows.push(row);
                row = [sorted[i]];
            }
        }
        rows.push(row);

        // **FIX**: Complete sorting left-to-right inside each row row-by-row
        rows.forEach(r => r.sort((a, b) => a.cx - b.cx));
        return rows.flat();
    }

    /* ================= STAGE 3 & 4: WARP + PROCESSING FOR OCR ================= */
    function extractCardTextMat(srcMat, quad) {
    const dstMat = new cv.Mat();
    const dsize = new cv.Size(CFG.WARP_W, CFG.WARP_H);
    
    // ✅ Index maps sequentially through array coordinates [0] to [3]
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        quad.corners[0].x, quad.corners[0].y, // Top-Left
        quad.corners[1].x, quad.corners[1].y, // Top-Right
        quad.corners[2].x, quad.corners[2].y, // Bottom-Right
        quad.corners[3].x, quad.corners[3].y  // Bottom-Left
    ]);
    
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        CFG.WARP_W, 0,
        CFG.WARP_W, CFG.WARP_H,
        0, CFG.WARP_H
    ]);

    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(srcMat, dstMat, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    // 13% Center text crop
    const mx = Math.floor(CFG.WARP_W * CFG.CROP_MARGIN);
    const my = Math.floor(CFG.WARP_H * CFG.CROP_MARGIN);
    const cropRect = new cv.Rect(mx, my, CFG.WARP_W - (mx * 2), CFG.WARP_H - (my * 2));
    const cropped = dstMat.roi(cropRect);

    // Grayscale and clean binarization
    const grayCrop = new cv.Mat(), finalBin = new cv.Mat();
    cv.cvtColor(cropped, grayCrop, cv.COLOR_RGBA2GRAY);
    cv.threshold(grayCrop, finalBin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

    // Memory cleanup
    srcTri.delete(); dstTri.delete(); M.delete(); dstMat.delete(); cropped.delete(); grayCrop.delete();
    
    return finalBin;
}
