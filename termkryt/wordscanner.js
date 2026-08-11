Copy

/* ============================================================
   WORD SCANNER — OpenCV grid detection + per-cell OCR
   ============================================================ */
(function () {
    'use strict';

    const CELL_SIZE = 240;
    const MIN_CONFIDENCE = 40;
    const MIN_WORD_LEN = 3;
    const FLIP_THRESHOLD = 12;

    let worker = null;
    let cvReady = null;

    /* ---------- Tesseract ---------- */
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
                preserve_interword_spaces: '1',
                tessedit_pageseg_mode: '7'
            });
        }
        return worker;
    }

    /* ---------- OpenCV loader ---------- */
    function loadOpenCv() {
if (window.cv && cv.Mat) return Promise.resolve(cv);
if (cvReady) return cvReady;
cvReady = new Promise((resolve, reject) => {
const script = document.createElement(‘script’);
script.src = ‘https://docs.opencv.org/4.9.0/opencv.js’;
script.async = true;
script.onload = () => {
if (cv.Mat) resolve(cv);
else cv.onRuntimeInitialized = () => resolve(cv);
};
script.onerror = () => { cvReady = null; reject(new Error(‘OpenCV.js failed to load’)); };
document.head.appendChild(script);
});
return cvReady;
}
/* ---------- Image helpers ---------- */
function orderCorners(pts) {
    const sum = pts.map(p => p.x + p.y);
    const diff = pts.map(p => p.x - p.y);
    const tl = pts[sum.indexOf(Math.min(...sum))];
    const br = pts[sum.indexOf(Math.max(...sum))];
    const tr = pts[diff.indexOf(Math.max(...diff))];
    const bl = pts[diff.indexOf(Math.min(...diff))];
    return [tl, tr, br, bl];
}

function enhanceForOcr(canvas) {
    const out = document.createElement('canvas');
    out.width = CELL_SIZE;
    out.height = CELL_SIZE;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, CELL_SIZE, CELL_SIZE);
    ctx.drawImage(canvas, 0, 0, CELL_SIZE, CELL_SIZE);
    try {
        const imgData = ctx.getImageData(0, 0, CELL_SIZE, CELL_SIZE);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const contrasted = (gray - 128) * 1.4 + 128;
            d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, contrasted));
        }
        ctx.putImageData(imgData, 0, 0);
    } catch (e) {}
    return out;
}

function rotateCanvas180(src) {
    const dst = document.createElement('canvas');
    dst.width = src.width;
    dst.height = src.height;
    const ctx = dst.getContext('2d');
    ctx.translate(src.width / 2, src.height / 2);
    ctx.rotate(Math.PI);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return dst;
}

function plausible(word) {
    if (!word || word.length < MIN_WORD_LEN) return false;
    if (!/[AEIOUY]/.test(word)) return false;
    if (word.replace(/[^A-Z]/g, '').length < MIN_WORD_LEN) return false;
    return true;
}

/* ---------- Board detection (OpenCV) ---------- */
async function extractBoardCanvas(source, statusCb) {
    const cv = await loadOpenCv();
    statusCb('Detecting board grid…');

    const src = cv.imread(source);
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 50, 150);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let boardPts = null;
    let maxArea = 0;
    for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area < 5000) continue;
        const peri = cv.arcLength(cnt, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
        if (approx.rows === 4 && area > maxArea) {
            maxArea = area;
            boardPts = [];
            for (let k = 0; k < 4; k++) {
                boardPts.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
            }
        }
        approx.delete();
        cnt.delete();
    }

    contours.delete();
    hierarchy.delete();
    edges.delete();
    blur.delete();
    gray.delete();

    if (!boardPts) {
        src.delete();
        statusCb('No board contour found — using full image.');
        return source;
    }

    const ordered = orderCorners(boardPts);
    const SIZE = 500;
    const srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, [
        ordered[0].x, ordered[0].y,
        ordered[1].x, ordered[1].y,
        ordered[2].x, ordered[2].y,
        ordered[3].x, ordered[3].y
    ]);
    const dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, SIZE - 1, 0, SIZE - 1, SIZE - 1, 0, SIZE - 1
    ]);
    const M = cv.getPerspectiveTransform(srcMat, dstMat);
    const warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(SIZE, SIZE));

    const out = document.createElement('canvas');
    out.width = SIZE;
    out.height = SIZE;
    cv.imshow(out, warped);

    src.delete();
    srcMat.delete();
    dstMat.delete();
    M.delete();
    warped.delete();

    statusCb('Board detected.');
    return out;
}

/* ---------- Per-cell OCR with 180° self-check ---------- */
async function ocrCell(cropCanvas) {
    const w = await getWorker();
    const up = enhanceForOcr(cropCanvas);
    const upRes = await w.recognize(up);
    const wordUp = (upRes.data.text || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const confUp = upRes.data.confidence || 0;

    const down = rotateCanvas180(up);
    const downRes = await w.recognize(down);
    const wordDown = (downRes.data.text || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const confDown = downRes.data.confidence || 0;

    const useDown = confDown > confUp;
    return {
        word: useDown ? wordDown : wordUp,
        conf: useDown ? confDown : confUp,
        rotated: useDown
    };
}

/* ---------- Public API ---------- */
window.scanWordFromImage = async function (file, statusCb) {
    statusCb = statusCb || function () {};
    try {
        if (typeof Tesseract === 'undefined') {
            throw new Error('Tesseract not loaded — check script tag order.');
        }

        const cvPromise = loadOpenCv().catch(err => {
            console.warn('OpenCV unavailable:', err.message);
            return null;
        });

        const url = URL.createObjectURL(file);
        const img = new Image();
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = url;
        });

        // Downscale huge photos to keep OCR fast
        const maxDim = 2000;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

        const cv = await cvPromise;
        const boardCanvas = cv ? await extractBoardCanvas(canvas, statusCb) : canvas;

        const cellW = boardCanvas.width / 5;
        const cellH = boardCanvas.height / 5;
        const results = [];
        let rotatedCount = 0;

        statusCb('Reading 25 cells…');
        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
                const crop = document.createElement('canvas');
                crop.width = cellW;
                crop.height = cellH;
                const ctx = crop.getContext('2d');
                ctx.drawImage(boardCanvas, c * cellW, r * cellH, cellW, cellH, 0, 0, cellW, cellH);
                const res = await ocrCell(crop);
                if (res.rotated) rotatedCount++;
                results.push(res);
            }
        }

        // If most cells preferred the 180° rotation, the whole photo was upside down
        const globalFlip = rotatedCount >= FLIP_THRESHOLD;
        const domCells = [...board.querySelectorAll('.cell')];
        const filled = [];

        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
                const srcR = globalFlip ? 4 - r : r;
                const srcC = globalFlip ? 4 - c : c;
                const res = results[srcR * 5 + srcC];
                const word = (res.word || '').trim();
                if (res.conf >= MIN_CONFIDENCE && plausible(word)) {
                    domCells[r * 5 + c].querySelector('.cell-text').textContent = word;
                    filled.push(word);
                }
            }
        }

        URL.revokeObjectURL(url);
        updateStats();
        saveCurrentState();
        statusCb(`Filled ${filled.length} cells${globalFlip ? ' (photo was upside down — auto-corrected)' : ''}.`);
        return filled.length;
    } catch (e) {
        console.error(e);
        statusCb('Scan error: ' + e.message);
        return null;
    }
};
})();
