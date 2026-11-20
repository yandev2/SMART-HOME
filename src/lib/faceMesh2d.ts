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
    lidColor: rgbCss(lidR, lidG, lidB),
    lipColor: finalLipCss,
    lashColor: 'rgb(34, 26, 26)',
    detectedMouthY,
    smileCurveNorm,
  };
}

/**
 * Merender gambar avatar utuh TANPA grid segitiga kasar sehingga bebas garis celah:
 * 1. Bahu/badan di bawah neckY bernapas pelan.
 * 2. Kepala di atas neckY bergerak miring & mengangguk halus berporos leher.
 * 3. Kelopak mata berkedip sesuai warna kulit/kelopak asli gambar.
 * 4. Mulut terbuka tepat pada garis bibir terdeteksi, mengikuti lekuk bibir asli
 *    dengan rongga mulut lembut + bibir bawah ikut turun.
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

  const idleSway = Math.sin(timeSec * 1.15) * 0.011 * motion;
  const speakNod = isSpeaking
    ? Math.sin(timeSec * 6.5) * (0.007 + mouthOpen * 0.013) * motion
    : 0;
  const speakTilt = isSpeaking
    ? Math.sin(timeSec * 2.8) * (0.016 + mouthOpen * 0.022) * motion
    : 0;
  const listenTilt = isListening ? 0.028 * motion : isThinking ? -0.018 * motion : 0;

  const headRollRad = idleSway + speakTilt + listenTilt;
  const headShiftX =
    (Math.sin(timeSec * 0.75) * 0.003 + (isSpeaking ? Math.sin(timeSec * 3.1) * 0.004 : 0)) *
    motion *
    width;
  const headShiftY = (Math.sin(timeSec * 1.6) * 0.003 + speakNod) * motion * height;
  const shoulderBreathY = Math.sin(timeSec * 1.6 - 0.5) * 0.0025 * motion * height;

  const pivotX = width * 0.5;
  const pivotY = rig.neckY * height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // 1. Gambar bagian bahu / baju (di bawah batas leher) agar tetap stabil & menyatu
  const neckPx = rig.neckY * height;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, Math.max(0, neckPx - height * 0.03), width, height);
  ctx.clip();
  ctx.translate(0, shoulderBreathY);
  ctx.drawImage(img, 0, 0, width, height);
  ctx.restore();

  // 2. Gambar bagian kepala & wajah berporos di leher (bebas garis segitiga!)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, Math.min(height, neckPx + height * 0.035));
  ctx.clip();

  ctx.translate(pivotX + headShiftX, pivotY + headShiftY);
  ctx.rotate(headRollRad);
  ctx.translate(-pivotX, -pivotY);
  ctx.drawImage(img, 0, 0, width, height);

  // 3. Animasi Kedipan Mata langsung di dalam transformasi kepala
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

      // Kelopak kulit turun menutupi bola mata secara lembut
      ctx.fillStyle = appearance.lidColor;
      ctx.beginPath();
      ctx.rect(ex - erx * 1.2, topY - 4, erx * 2.4, currentLidY - topY + 4);
      ctx.fill();

      // Garis bulu mata saat menutup penuh atau setengah menutup
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

  // 4. Animasi Mulut mengikuti bentuk & letak bibir asli karakter
  if (mouthOpen > 0.03) {
    const mx = rig.mouth.x * width;
    const my = appearance.detectedMouthY * height;
    const mrx = rig.mouth.rx * width;
    const mry = rig.mouth.ry * height;

    const dropPx = mouthOpen * mry * 1.35;
    const widthScale = 0.72 + mouthOpen * 0.16;
    const openRx = mrx * widthScale;
    const cornerOffset = appearance.smileCurveNorm * openRx * 0.85;

    // A. Geser potongan piksel bibir bawah & dagu sedikit ke bawah agar rahang ikut bergerak
    const imgEl = img as HTMLImageElement;
    const srcW = imgEl.naturalWidth || imgEl.width || width;
    const srcH = imgEl.naturalHeight || imgEl.height || height;
    const patchRx = mrx * 1.25;
    const patchTop = my - mry * 0.1;
    const patchH = mry * 2.15;

    const sx = clamp((mx - patchRx) / width, 0, 1) * srcW;
    const sy = clamp(patchTop / height, 0, 1) * srcH;
    const sw = clamp((patchRx * 2) / width, 0.02, 1) * srcW;
    const sh = clamp(patchH / height, 0.02, 1) * srcH;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(
      mx,
      my + mry * 0.8 + dropPx * 0.65,
      patchRx,
      mry * 1.25 + dropPx * 0.45,
      0,
      0,
      Math.PI * 2
    );
    ctx.clip();

    // Isi area belakang bibir atas->bawah dengan gradasi kulit lembut (bebas tepi kotak)
    const skinFade = ctx.createRadialGradient(
      mx,
      my + dropPx * 0.25,
      patchRx * 0.25,
      mx,
      my + dropPx * 0.25,
      patchRx
    );
    skinFade.addColorStop(0, appearance.skinColor);
    skinFade.addColorStop(0.75, appearance.skinColor);
    skinFade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = skinFade;
    ctx.beginPath();
    ctx.ellipse(mx, my + dropPx * 0.2, patchRx, mry * 0.7 + dropPx * 0.65, 0, 0, Math.PI * 2);
    ctx.fill();

    // Gambar potongan bibir bawah & dagu asli yang digeser turun
    ctx.drawImage(
      img,
      sx,
      sy,
      sw,
      sh,
      mx - patchRx,
      patchTop + dropPx * 0.75,
      patchRx * 2,
      patchH
    );
    ctx.restore();

    // B. Gambar rongga mulut berbentuk lengkung bibir asli (kiri-tengah-kanan)
    const leftX = mx - openRx;
    const rightX = mx + openRx;
    const cornerY = my + cornerOffset;
    const upperMidY = my - dropPx * 0.14;
    const lowerMidY = my + dropPx;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(leftX, cornerY);
    ctx.quadraticCurveTo(mx, upperMidY, rightX, cornerY);
    ctx.quadraticCurveTo(mx, lowerMidY, leftX, cornerY);
    ctx.closePath();

    const mouthGrad = ctx.createLinearGradient(mx, upperMidY, mx, lowerMidY);
    mouthGrad.addColorStop(0, '#3a0a16');
    mouthGrad.addColorStop(0.55, '#5f1325');
    mouthGrad.addColorStop(1, '#7a1c31');
    ctx.fillStyle = mouthGrad;
    ctx.fill();

    // Klip ke dalam rongga mulut untuk gigi atas tipis & lidah hangat
    ctx.clip();

    if (dropPx > 3.5) {
      // Highlight gigi atas sangat halus
      ctx.fillStyle = 'rgba(255, 246, 242, 0.85)';
      ctx.beginPath();
      ctx.ellipse(mx, upperMidY + dropPx * 0.12, openRx * 0.56, Math.max(1.5, dropPx * 0.18), 0, 0, Math.PI * 2);
      ctx.fill();

      // Lidah lembut di bagian bawah rongga mulut
      ctx.fillStyle = 'rgba(235, 96, 120, 0.75)';
      ctx.beginPath();
      ctx.ellipse(mx, lowerMidY - dropPx * 0.1, openRx * 0.58, Math.max(2, dropPx * 0.36), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // C. Garis bibir atas & bawah halus sesuai warna bibir asli gambar
    ctx.save();
    ctx.strokeStyle = appearance.lipColor;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.4, mrx * 0.11);
    ctx.beginPath();
    ctx.moveTo(leftX, cornerY);
    ctx.quadraticCurveTo(mx, upperMidY, rightX, cornerY);
    ctx.stroke();

    ctx.globalAlpha = 0.72;
    ctx.lineWidth = Math.max(1.1, mrx * 0.09);
    ctx.beginPath();
    ctx.moveTo(leftX + openRx * 0.15, cornerY + dropPx * 0.12);
    ctx.quadraticCurveTo(mx, lowerMidY + 0.5, rightX - openRx * 0.15, cornerY + dropPx * 0.12);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}
