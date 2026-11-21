import type { AvatarRig } from './types';

const MAX_AVATAR_DIM = 512;

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gagal memuat gambar avatar.'));
    img.src = src;
  });
}

/**
 * Mengubah file upload atau Data URL dari /api/avatar-fetch menjadi gambar 512x512
 * terkompresi (WebP dengan fallback PNG) sambil menjaga transparansi latar belakang.
 */
export async function compressAvatarSourceToDataUrl(src: string): Promise<string> {
  const img = await loadHtmlImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = MAX_AVATAR_DIM;
  canvas.height = MAX_AVATAR_DIM;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D tidak tersedia di browser.');
  }

  ctx.clearRect(0, 0, MAX_AVATAR_DIM, MAX_AVATAR_DIM);

  const scale = Math.min(MAX_AVATAR_DIM / img.width, MAX_AVATAR_DIM / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const offsetX = (MAX_AVATAR_DIM - drawW) / 2;
  const offsetY = (MAX_AVATAR_DIM - drawH) / 2;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

  const webp = canvas.toDataURL('image/webp', 0.86);
  if (webp.startsWith('data:image/webp')) {
    return webp;
  }
  return canvas.toDataURL('image/png');
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Gagal membaca file gambar.'));
      }
    };
    reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
    reader.readAsDataURL(file);
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export interface SampledFaceAppearance {
  skinColor: string;
  skinColorTransparent: string;
  lidColor: string;
  lipColor: string;
  lashColor: string;
  /** Pergeseran vertikal (-0.06..0.06) hasil auto-deteksi pusat bibir terhadap rig.mouth.y */
  detectedMouthY: number;
  /** Kurva senyum: negatif = ujung bibir melengkung ke atas */
  smileCurveNorm: number;
}

export interface FaceAnimState {
  timeSec: number;
  mouthOpen: number; // 0..1
  blink: number;     // 0..1
  isSpeaking: boolean;
  isListening: boolean;
  isThinking: boolean;
  /** Nilai gerakan leher yang sudah diperhalus (exponential smoothing seperti mulut) */
  smoothRollRad?: number;
  smoothShiftXNorm?: number;
  smoothShiftYNorm?: number;
}

// Kanvas buffer internal yang digunakan ulang untuk merender wajah utuh (mata + mulut)
// sebelum dideformasi secara elastis pada leher, sehingga 100% bebas garis potong clip().
let sharedFaceBufferCanvas: HTMLCanvasElement | null = null;

function getSharedFaceBuffer(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  if (typeof document === 'undefined') return null;
  if (!sharedFaceBufferCanvas) {
    sharedFaceBufferCanvas = document.createElement('canvas');
  }
  if (
    sharedFaceBufferCanvas.width !== width ||
    sharedFaceBufferCanvas.height !== height
  ) {
    sharedFaceBufferCanvas.width = width;
    sharedFaceBufferCanvas.height = height;
  }
  const ctx = sharedFaceBufferCanvas.getContext('2d');
  if (!ctx) return null;
  return { canvas: sharedFaceBufferCanvas, ctx };
}

function rgbCss(r: number, g: number, b: number, a = 1): string {
  const rr = Math.round(clamp(r, 0, 255));
  const gg = Math.round(clamp(g, 0, 255));
  const bb = Math.round(clamp(b, 0, 255));
  return a >= 0.999 ? `rgb(${rr}, ${gg}, ${bb})` : `rgba(${rr}, ${gg}, ${bb}, ${a})`;
}

/**
 * Menganalisis warna kulit sekitar wajah, warna kelopak mata, warna bibir,
 * dan bentuk kurva bibir secara otomatis dari piksel gambar asli.
 */
export function analyzeFaceAppearance(
  img: HTMLImageElement,
  rig: AvatarRig
): SampledFaceAppearance {
  const S = 160;
  const off = document.createElement('canvas');
  off.width = S;
  off.height = S;
  const ctx = off.getContext('2d', { willReadFrequently: true });

  const fallback: SampledFaceAppearance = {
    skinColor: 'rgb(250, 214, 191)',
    skinColorTransparent: 'rgba(250, 214, 191, 0)',
    lidColor: 'rgb(240, 200, 178)',
    lipColor: 'rgb(215, 78, 78)',
    lashColor: 'rgb(30, 27, 24)',
    detectedMouthY: rig.mouth.y,
    smileCurveNorm: -0.22,
  };

  if (!ctx || img.width <= 0 || img.height <= 0) return fallback;
  ctx.drawImage(img, 0, 0, S, S);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, S, S).data;
  } catch {
    return fallback;
  }

  const getPixel = (nx: number, ny: number): [number, number, number, number] => {
    const px = clamp(Math.round(nx * (S - 1)), 0, S - 1);
    const py = clamp(Math.round(ny * (S - 1)), 0, S - 1);
    const i = (py * S + px) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };

  // 1. Sampel warna kulit dari area pipi & dagu di sekitar mulut/mata (piksel terang & tidak transparan)
  const skinSamples: [number, number, number][] = [];
  const sampleOffsets: [number, number][] = [
    [rig.mouth.x - rig.mouth.rx * 1.45, rig.mouth.y - rig.mouth.ry * 0.6],
    [rig.mouth.x + rig.mouth.rx * 1.45, rig.mouth.y - rig.mouth.ry * 0.6],
    [rig.mouth.x, rig.mouth.y + rig.mouth.ry * 1.35],
    [rig.mouth.x, rig.mouth.y - rig.mouth.ry * 1.25],
    [0.5, (rig.leftEye.y + rig.mouth.y) * 0.5],
  ];
  for (const [sx, sy] of sampleOffsets) {
    for (let dx = -0.015; dx <= 0.015; dx += 0.015) {
      for (let dy = -0.015; dy <= 0.015; dy += 0.015) {
        const [r, g, b, a] = getPixel(sx + dx, sy + dy);
        if (a > 200 && r + g + b > 240) {
          skinSamples.push([r, g, b]);
        }
      }
    }
  }

  let skinR = 250,
    skinG = 214,
    skinB = 191;
  if (skinSamples.length > 0) {
    skinSamples.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
    const mid = skinSamples[Math.floor(skinSamples.length * 0.6)];
    skinR = mid[0];
    skinG = mid[1];
    skinB = mid[2];
  }

  // 2. Sampel warna kelopak atas sedikit di atas area mata
  const lidSamples: [number, number, number][] = [];
  for (const eye of [rig.leftEye, rig.rightEye]) {
    for (let dx = -0.02; dx <= 0.02; dx += 0.01) {
      const [r, g, b, a] = getPixel(eye.x + dx, eye.y - eye.ry * 1.12);
      if (a > 200 && r + g + b > 220) {
        lidSamples.push([r, g, b]);
      }
    }
  }
  const lidR = lidSamples.length
    ? lidSamples.reduce((s, p) => s + p[0], 0) / lidSamples.length
    : skinR * 0.96;
  const lidG = lidSamples.length
    ? lidSamples.reduce((s, p) => s + p[1], 0) / lidSamples.length
    : skinG * 0.94;
  const lidB = lidSamples.length
    ? lidSamples.reduce((s, p) => s + p[2], 0) / lidSamples.length
    : skinB * 0.93;

  // 3. Deteksi kontur & warna bibir sebenarnya di dalam area kotak mulut pin M
  const x0 = Math.max(0, Math.floor((rig.mouth.x - rig.mouth.rx) * S));
  const x1 = Math.min(S - 1, Math.ceil((rig.mouth.x + rig.mouth.rx) * S));
  const y0 = Math.max(0, Math.floor((rig.mouth.y - rig.mouth.ry * 1.25) * S));
  const y1 = Math.min(S - 1, Math.ceil((rig.mouth.y + rig.mouth.ry * 1.25) * S));

  let weightSum = 0;
  let weightedY = 0;
  let lipR = 0,
    lipG = 0,
    lipB = 0;

  let centerYAcc = 0,
    centerW = 0;
  let edgeYAcc = 0,
    edgeW = 0;

  const spanX = Math.max(1, (x1 - x0) / 2);
  const midX = (x0 + x1) / 2;

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const i = (py * S + px) * 4;
      const a = data[i + 3];
      if (a < 180) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Skor kemiripan piksel bibir: perbedaan warna dari kulit + kemerahan/kegelapan garis bibir
      const colorDist = Math.abs(r - skinR) + Math.abs(g - skinG) + Math.abs(b - skinB);
      const redness = Math.max(0, r - (g + b) * 0.5);
      const darkness = Math.max(0, (skinR + skinG + skinB) / 3 - (r + g + b) / 3);
      const score = colorDist * 0.55 + redness * 1.45 + darkness * 0.7;

      if (score > 45) {
        const w = score - 45;
        weightSum += w;
        weightedY += py * w;
        lipR += r * w;
        lipG += g * w;
        lipB += b * w;

        const normDx = Math.abs(px - midX) / spanX;
        if (normDx < 0.35) {
          centerYAcc += py * w;
          centerW += w;
        } else if (normDx > 0.55) {
          edgeYAcc += py * w;
          edgeW += w;
        }
      }
    }
  }

  let detectedMouthY = rig.mouth.y;
  let smileCurveNorm = -0.22;
  let finalLipCss = fallback.lipColor;

  if (weightSum > 80) {
    const foundY = weightedY / weightSum / S;
    // Clamp supaya selalu dekat dengan pin yang ditaruh user
    if (Math.abs(foundY - rig.mouth.y) <= rig.mouth.ry * 1.15) {
      detectedMouthY = foundY;
    }
    finalLipCss = rgbCss(lipR / weightSum, lipG / weightSum, lipB / weightSum);

    if (centerW > 0 && edgeW > 0) {
      const cy = centerYAcc / centerW / S;
      const ey = edgeYAcc / edgeW / S;
      smileCurveNorm = clamp((ey - cy) / Math.max(0.02, rig.mouth.rx), -0.45, 0.25);
    }
  }

  return {
    skinColor: rgbCss(skinR, skinG, skinB),
    skinColorTransparent: rgbCss(skinR, skinG, skinB, 0),
    lidColor: rgbCss(lidR, lidG, lidB),
    lipColor: finalLipCss,
    lashColor: 'rgb(34, 26, 26)',
    detectedMouthY,
    smileCurveNorm,
  };
}

/**
 * Merender ekspresi wajah (gambar dasar + kedipan mata + mulut elastis) dalam posisi netral
 * ke dalam kanvas target tanpa pemotongan leher.
 */
function renderNeutralFaceFeatures(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  rig: AvatarRig,
  appearance: SampledFaceAppearance,
  mouthOpen: number,
  blink: number,
  width: number,
  height: number
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  // 1. Animasi Kedipan Mata
  if (blink > 0.02) {
    const eyes = [rig.leftEye, rig.rightEye];
    for (const eye of eyes) {
      const ex = eye.x * width;
      const ey = eye.y * height;
      const erx = eye.rx * width;
      const ery = eye.ry * height;
      const closeY = ey + ery * 0.22;
      const topY = ey - ery * 1.08;
      const currentLidY = topY + (closeY - topY) * blink;

      ctx.save();
      ctx.beginPath();
      ctx.ellipse(ex, ey, erx * 1.05, ery * 1.08, 0, 0, Math.PI * 2);
      ctx.clip();

      ctx.fillStyle = appearance.lidColor;
      ctx.beginPath();
      ctx.rect(ex - erx * 1.2, topY - 4, erx * 2.4, currentLidY - topY + 4);
      ctx.fill();

      if (blink > 0.45) {
        ctx.strokeStyle = appearance.lashColor;
        ctx.lineWidth = Math.max(1.5, ery * 0.19);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(ex - erx * 0.85, currentLidY - ery * 0.12);
        ctx.quadraticCurveTo(
          ex,
          currentLidY + ery * 0.18 * blink,
          ex + erx * 0.85,
          currentLidY - ery * 0.12
        );
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 2. Animasi Mulut mengikuti posisi, lengkungan, & warna bibir karakter
  if (mouthOpen > 0.03) {
    const mx = rig.mouth.x * width;
    const my = rig.mouth.y * height;
    const mrx = rig.mouth.rx * width;
    const mry = rig.mouth.ry * height;

    const dropPx = mouthOpen * mry * 1.35;
    const widthScale = 0.78 + mouthOpen * 0.12;
    const openRx = mrx * widthScale;
    const curveNorm = rig.mouth.curve ?? appearance.smileCurveNorm;
    const cornerOffset = curveNorm * openRx;

    // A. Deformasi dagu & bibir bawah elastis (halus ke tepi pipi & leher, bebas garis patah)
    const imgEl = img as HTMLImageElement;
    const srcW = imgEl.naturalWidth || imgEl.width || width;
    const srcH = imgEl.naturalHeight || imgEl.height || height;

    const halfW = mrx * 1.48;
    const chinSpan = mry * 2.15;
    const colStep = Math.max(0.9, width / 220);
    const numBands = 5;
    const bandDrops = [1.0, 0.72, 0.42, 0.16, 0.0];
    const srcScaleX = srcW / width;
    const srcScaleY = srcH / height;

    const leftX = mx - openRx;
    const rightX = mx + openRx;
    const cornerY = my + cornerOffset;
    const upperMidY = my - dropPx * 0.14;
    const lowerMidY = my + dropPx;
    const upperCtrlY = 2 * upperMidY - cornerY;
    const lowerCtrlY = 2 * lowerMidY - cornerY;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(leftX - openRx * 0.2, cornerY - 1);
    ctx.quadraticCurveTo(mx, upperCtrlY - 1, rightX + openRx * 0.2, cornerY - 1);
    ctx.lineTo(mx + halfW, my + dropPx + mry * 0.9);
    ctx.lineTo(mx - halfW, my + dropPx + mry * 0.9);
    ctx.closePath();
    ctx.clip();

    const fadeCy = my + dropPx * 0.36;
    const skinFade = ctx.createRadialGradient(
      mx,
      fadeCy,
      openRx * 0.25,
      mx,
      fadeCy,
      openRx * 1.1
    );
    skinFade.addColorStop(0, appearance.skinColor);
    skinFade.addColorStop(0.7, appearance.skinColor);
    skinFade.addColorStop(1, appearance.skinColorTransparent);
    ctx.fillStyle = skinFade;
    ctx.beginPath();
    ctx.ellipse(mx, fadeCy, openRx * 1.1, mry * 0.38 + dropPx * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    for (let dx = mx - halfW; dx < mx + halfW; dx += colStep) {
      const normX = (dx + colStep * 0.5 - mx) / halfW;
      const wx = 0.5 * (1 + Math.cos(clamp(normX, -1, 1) * Math.PI));
      if (wx <= 0.005) continue;

      const lipNorm = clamp((dx + colStep * 0.5 - mx) / Math.max(1, openRx), -1, 1);
      const startY = my + cornerOffset * (lipNorm * lipNorm) + mry * 0.18;
      const colDrop = dropPx * wx;
      const sx = clamp(dx * srcScaleX, 0, srcW - 1);
      const sw = Math.max(0.5, colStep * srcScaleX);

      for (let b = 0; b < numBands - 1; b++) {
        const f0 = b / (numBands - 1);
        const f1 = (b + 1) / (numBands - 1);
        const srcY0 = startY + chinSpan * f0;
        const srcY1 = startY + chinSpan * f1;
        const dstY0 = srcY0 + colDrop * bandDrops[b];
        const dstY1 = srcY1 + colDrop * bandDrops[b + 1];

        const sy = clamp(srcY0 * srcScaleY, 0, srcH - 1);
        const sh = Math.max(0.5, (srcY1 - srcY0) * srcScaleY);
        const dh = Math.max(0.5, dstY1 - dstY0 + 0.55);

        ctx.drawImage(img, sx, sy, sw, sh, dx, dstY0, colStep + 0.55, dh);
      }
    }

    // B. Gambar rongga mulut berbentuk lengkung bibir asli
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(leftX, cornerY);
    ctx.quadraticCurveTo(mx, upperCtrlY, rightX, cornerY);
    ctx.quadraticCurveTo(mx, lowerCtrlY, leftX, cornerY);
    ctx.closePath();

    const mouthGrad = ctx.createLinearGradient(mx, upperMidY, mx, lowerMidY);
    mouthGrad.addColorStop(0, '#3a0a16');
    mouthGrad.addColorStop(0.55, '#5f1325');
    mouthGrad.addColorStop(1, '#7a1c31');
    ctx.fillStyle = mouthGrad;
    ctx.fill();

    ctx.clip();

    if (dropPx > 3.5) {
      ctx.fillStyle = 'rgba(255, 246, 242, 0.85)';
      ctx.beginPath();
      ctx.ellipse(
        mx,
        upperMidY + dropPx * 0.12,
        openRx * 0.56,
        Math.max(1.5, dropPx * 0.18),
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();

      ctx.fillStyle = 'rgba(235, 96, 120, 0.75)';
      ctx.beginPath();
      ctx.ellipse(
        mx,
        lowerMidY - dropPx * 0.1,
        openRx * 0.58,
        Math.max(2, dropPx * 0.36),
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.restore();

    // C. Garis bibir atas & bawah halus sesuai warna & lengkungan bibir asli
    ctx.save();
    ctx.strokeStyle = appearance.lipColor;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.4, mrx * 0.11);
    ctx.beginPath();
    ctx.moveTo(leftX, cornerY);
    ctx.quadraticCurveTo(mx, upperCtrlY, rightX, cornerY);
    ctx.stroke();

    ctx.globalAlpha = 0.88;
    ctx.lineWidth = Math.max(1.5, mrx * 0.11);
    ctx.beginPath();
    ctx.moveTo(leftX + openRx * 0.1, cornerY + dropPx * 0.08);
    ctx.quadraticCurveTo(
      mx,
      lowerCtrlY + 0.5,
      rightX - openRx * 0.1,
      cornerY + dropPx * 0.08
    );
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Merender gambar avatar utuh dengan teknik Elastic Multi-Band Strip Warping (pola yang sama
 * dengan animasi mulut) pada area leher & bahu:
 * - TIDAK ADA pemotongan kotak ctx.clip() di leher, sehingga mustahil muncul garis patahan.
 * - Wajah (mata + mulut) dirender utuh ke buffer, lalu melentur secara kontinyu dengan kurva
 *   kosinus w(y) = 0.5 * (1 + cos(pi * u)) dari kepala (w = 1.0) melewati leher hingga
 *   menyatu sempurna ke bahu/dada (w = 0.0).
 */
export function renderAnimatedFaceCanvas(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  rig: AvatarRig,
  appearance: SampledFaceAppearance,
  anim: FaceAnimState,
  width: number,
  height: number
) {
  const { timeSec, mouthOpen, blink, isSpeaking, isListening, isThinking } = anim;
  const motion = rig.motionIntensity;

  // Gunakan nilai gerakan leher yang sudah di-smoothing (exponential damping) bila tersedia
  let headRollRad: number;
  let headShiftX: number;
  let headShiftY: number;

  if (
    typeof anim.smoothRollRad === 'number' &&
    typeof anim.smoothShiftXNorm === 'number' &&
    typeof anim.smoothShiftYNorm === 'number'
  ) {
    headRollRad = anim.smoothRollRad * motion;
    headShiftX = anim.smoothShiftXNorm * motion * width;
    headShiftY = anim.smoothShiftYNorm * motion * height;
  } else {
    const idleSway = Math.sin(timeSec * 1.15) * 0.009 * motion;
    const speakNod = isSpeaking
      ? Math.sin(timeSec * 5.8) * (0.005 + mouthOpen * 0.01) * motion
      : 0;
    const speakTilt = isSpeaking
      ? Math.sin(timeSec * 2.5) * (0.012 + mouthOpen * 0.016) * motion
      : 0;
    const listenTilt = isListening ? 0.022 * motion : isThinking ? -0.015 * motion : 0;

    headRollRad = idleSway + speakTilt + listenTilt;
    headShiftX =
      (Math.sin(timeSec * 0.75) * 0.0025 +
        (isSpeaking ? Math.sin(timeSec * 2.9) * 0.003 : 0)) *
      motion *
      width;
    headShiftY = (Math.sin(timeSec * 1.6) * 0.0025 + speakNod) * motion * height;
  }

  const shoulderBreathY = Math.sin(timeSec * 1.6 - 0.5) * 0.0022 * motion * height;

  // Tahap 1: Render wajah utuh (mata berkedip + mulut elastis) ke offscreen buffer
  const faceBuffer = getSharedFaceBuffer(width, height);
  if (!faceBuffer) {
    renderNeutralFaceFeatures(ctx, img, rig, appearance, mouthOpen, blink, width, height);
    return;
  }

  renderNeutralFaceFeatures(
    faceBuffer.ctx,
    img,
    rig,
    appearance,
    mouthOpen,
    blink,
    width,
    height
  );

  // Tahap 2: Deformasi Elastis Leher & Kepala mengikuti pola Strip-Warping Mulut (100% bebas clip/garis patah)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pivotX = width * 0.5;
  const pivotY = rig.neckY * height;
  const srcCanvas = faceBuffer.canvas;

  // Zona transisi elastis leher: dimulai tepat di bawah dagu/mulut hingga menyatu ke bahu/dada atas
  const mouthFloorY = (rig.mouth.y + rig.mouth.ry * 1.45) * height;
  const yTop = clamp(
    Math.max(mouthFloorY, (rig.neckY - 0.115) * height),
    height * 0.42,
    height * 0.78
  );
  const yBot = clamp(
    Math.max(yTop + height * 0.14, (rig.neckY + 0.125) * height),
    yTop + height * 0.1,
    height * 0.95
  );
  const neckSpan = Math.max(1, yBot - yTop);

  // Fungsi bobot kosinus halus C^1 (mengikuti pola wx & bandDrops pada kode mulut):
  // - Di atas yTop (Kepala & Wajah): w = 1.0 (utuh & tajam 100%)
  // - Di antara yTop .. yBot (Zona Leher): meluruh mulus mengikuti 0.5 * (1 + cos(pi * u))
  // - Di bawah yBot (Bahu & Badan): w = 0.0 (menyatu 100% tanpa patahan)
  const weightAtY = (y: number): number => {
    if (y <= yTop) return 1.0;
    if (y >= yBot) return 0.0;
    const u = (y - yTop) / neckSpan;
    return 0.5 * (1 + Math.cos(u * Math.PI));
  };

  // Posisi terdeformasi pada garis tengah (x = pivotX) dan sudut kemiringan lokal theta(y)
  const evalSpineAtY = (y: number) => {
    const w = weightAtY(y);
    const theta = headRollRad * w;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const tx = headShiftX * w;
    const ty = headShiftY * w + shoulderBreathY * (1 - w);
    const dyPivot = y - pivotY;

    return {
      cx: pivotX + tx - dyPivot * sinT,
      cy: pivotY + ty + dyPivot * cosT,
      cosT,
      sinT,
    };
  };

  // A. Render Zona Kepala & Wajah (0 .. yTop) dalam 1 panggilan utuh dengan matriks w = 1.0
  if (yTop > 1) {
    const topSpine = evalSpineAtY(0);
    const a = topSpine.cosT;
    const b = topSpine.sinT;
    const c = -topSpine.sinT;
    const d = topSpine.cosT;
    const e = topSpine.cx - a * pivotX;
    const f = topSpine.cy - b * pivotX;

    ctx.setTransform(a, b, c, d, e, f);
    const headSrcH = Math.min(height, yTop + 0.85);
    ctx.drawImage(srcCanvas, 0, 0, width, headSrcH, 0, 0, width, headSrcH);
  }

  // B. Render Zona Transisi Leher Elastis (yTop .. yBot) dengan 28 pita Jacobian Affine kontinyu
  // Setiap pita [y0, y1] memiliki tepi atas yang menyambung 100% tepat dengan pita sebelumnya
  // dan tepi bawah yang menyambung 100% tepat dengan pita berikutnya (0.000px celah/step).
  const numNeckBands = 28;
  const bandStep = neckSpan / numNeckBands;

  for (let i = 0; i < numNeckBands; i++) {
    const y0 = yTop + i * bandStep;
    const y1 = y0 + bandStep;
    const yMid = 0.5 * (y0 + y1);

    const s0 = evalSpineAtY(y0);
    const s1 = evalSpineAtY(y1);
    const sMid = evalSpineAtY(yMid);

    // Matriks affine Jacobian yang memetakan garis (x, y0) -> (X(x, y0), Y(x, y0))
    // dan garis (x, y1) -> (X(x, y1), Y(x, y1)) secara kontinyu:
    const a = sMid.cosT;
    const b = sMid.sinT;
    const c = (s1.cx - s0.cx) / bandStep;
    const d = (s1.cy - s0.cy) / bandStep;
    const e = s0.cx - a * pivotX - c * y0;
    const f = s0.cy - b * pivotX - d * y0;

    ctx.setTransform(a, b, c, d, e, f);
    const drawH = Math.min(height - y0, bandStep + 0.85);
    ctx.drawImage(srcCanvas, 0, y0, width, drawH, 0, y0, width, drawH);
  }

  // C. Render Zona Badan & Bahu Bawah (yBot .. height) dalam 1 panggilan utuh (w = 0.0)
  if (yBot < height - 1) {
    const botH = height - yBot;
    ctx.setTransform(1, 0, 0, 1, 0, shoulderBreathY);
    ctx.drawImage(srcCanvas, 0, yBot, width, botH, 0, yBot, width, botH);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
