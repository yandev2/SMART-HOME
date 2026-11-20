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

interface MeshVertex {
  u: number;
  v: number;
  kind: 'normal' | 'upperLip' | 'lowerLip';
  x: number;
  y: number;
}

interface MeshTriangle {
  a: number;
  b: number;
  c: number;
}

export interface FaceMeshModel {
  vertices: MeshVertex[];
  triangles: MeshTriangle[];
  splitRow: number;
}

const GRID_COLS = 22;
const GRID_ROWS = 22;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Membangun jaring segitiga 22x22 dengan baris belah khusus pada garis mulut
 * agar bibir atas & rahang bawah dapat membuka bersih tanpa merusak area lain.
 */
export function buildFaceMesh(rig: AvatarRig): FaceMeshModel {
  const splitRow = clamp(Math.round(rig.mouth.y * GRID_ROWS), 3, GRID_ROWS - 3);
  const splitV = splitRow / GRID_ROWS;

  const vertices: MeshVertex[] = [];
  const gridIdx: number[][] = [];
  const lowerLipIdx = new Map<number, number>();

  for (let r = 0; r <= GRID_ROWS; r++) {
    const rowArr: number[] = [];
    const v = r / GRID_ROWS;
    for (let c = 0; c <= GRID_COLS; c++) {
      const u = c / GRID_COLS;
      const inMouthSpan =
        r === splitRow && Math.abs(u - rig.mouth.x) <= rig.mouth.rx * 1.1;

      const idx = vertices.length;
      vertices.push({
        u,
        v: inMouthSpan ? splitV : v,
        kind: inMouthSpan ? 'upperLip' : 'normal',
        x: u,
        y: v,
      });
      rowArr.push(idx);

      if (inMouthSpan) {
        const lowerIdx = vertices.length;
        vertices.push({
          u,
          v: splitV,
          kind: 'lowerLip',
          x: u,
          y: splitV,
        });
        lowerLipIdx.set(c, lowerIdx);
      }
    }
    gridIdx.push(rowArr);
  }

  const triangles: MeshTriangle[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const useLowerForTopEdge = r === splitRow;
    for (let c = 0; c < GRID_COLS; c++) {
      const tl = useLowerForTopEdge
        ? (lowerLipIdx.get(c) ?? gridIdx[r][c])
        : gridIdx[r][c];
      const tr = useLowerForTopEdge
        ? (lowerLipIdx.get(c + 1) ?? gridIdx[r][c + 1])
        : gridIdx[r][c + 1];
      const bl = gridIdx[r + 1][c];
      const br = gridIdx[r + 1][c + 1];

      triangles.push({ a: tl, b: tr, c: br });
      triangles.push({ a: tl, b: br, c: bl });
    }
  }

  return { vertices, triangles, splitRow };
}

export interface FaceAnimState {
  timeSec: number;
  mouthOpen: number; // 0..1
  blink: number;     // 0..1
  isSpeaking: boolean;
  isListening: boolean;
  isThinking: boolean;
}

function drawAffineTriangle(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  w: number,
  h: number,
  v0: MeshVertex,
  v1: MeshVertex,
  v2: MeshVertex
) {
  const sx0 = v0.u * w;
  const sy0 = v0.v * h;
  const sx1 = v1.u * w;
  const sy1 = v1.v * h;
  const sx2 = v2.u * w;
  const sy2 = v2.v * h;

  const dx0 = v0.x * w;
  const dy0 = v0.y * h;
  const dx1 = v1.x * w;
  const dy1 = v1.y * h;
  const dx2 = v2.x * w;
  const dy2 = v2.y * h;

  const denom = sx0 * (sy1 - sy2) - sy0 * (sx1 - sx2) + (sx1 * sy2 - sx2 * sy1);
  if (Math.abs(denom) < 1e-4) return;

  // Perluasan klip 0.45px dari titik tengah segitiga menghilangkan celah garis antarpiksel
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const pad = (px: number, py: number): [number, number] => {
    const vx = px - cx;
    const vy = py - cy;
    const len = Math.hypot(vx, vy) || 1;
    return [px + (vx / len) * 0.45, py + (vy / len) * 0.45];
  };
  const [p0x, p0y] = pad(dx0, dy0);
  const [p1x, p1y] = pad(dx1, dy1);
  const [p2x, p2y] = pad(dx2, dy2);

  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
  const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
  const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
  const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
  const e =
    (dx0 * (sx1 * sy2 - sx2 * sy1) +
      dx1 * (sx2 * sy0 - sx0 * sy2) +
      dx2 * (sx0 * sy1 - sx1 * sy0)) /
    denom;
  const f =
    (dy0 * (sx1 * sy2 - sx2 * sy1) +
      dy1 * (sx2 * sy0 - sx0 * sy2) +
      dy2 * (sx0 * sy1 - sx1 * sy0)) /
    denom;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0x, p0y);
  ctx.lineTo(p1x, p1y);
  ctx.lineTo(p2x, p2y);
  ctx.closePath();
  ctx.clip();

  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0, w, h);
  ctx.restore();
}

/**
 * Menggambar seluruh frame animasi wajah (kedip mata, bukaan mulut + rongga mulut,
 * dan gerakan kepala berporos leher) ke Canvas 2D.
 */
export function renderAnimatedFaceMesh(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  mesh: FaceMeshModel,
  rig: AvatarRig,
  anim: FaceAnimState,
  width: number,
  height: number
) {
  const { timeSec, mouthOpen, blink, isSpeaking, isListening, isThinking } = anim;
  const motion = rig.motionIntensity;

  // Hitung parameter gerakan kepala 2.5D & napas bahu
  const idleSway = Math.sin(timeSec * 1.15) * 0.012 * motion;
  const speakNod = isSpeaking
    ? Math.sin(timeSec * 6.5) * (0.008 + mouthOpen * 0.014) * motion
    : 0;
  const speakTilt = isSpeaking
    ? Math.sin(timeSec * 2.8) * (0.018 + mouthOpen * 0.022) * motion
    : 0;
  const listenTilt = isListening ? 0.032 * motion : isThinking ? -0.02 * motion : 0;

  const headRollRad = idleSway + speakTilt + listenTilt;
  const cosR = Math.cos(headRollRad);
  const sinR = Math.sin(headRollRad);
  const headShiftX =
    (Math.sin(timeSec * 0.75) * 0.004 + (isSpeaking ? Math.sin(timeSec * 3.1) * 0.005 : 0)) *
    motion;
  const headShiftY =
    (Math.sin(timeSec * 1.6) * 0.004 + speakNod) * motion;
  const shoulderBreathY = Math.sin(timeSec * 1.6 - 0.5) * 0.003 * motion;

  const pivotX = 0.5;
  const pivotY = rig.neckY;

  const mx = rig.mouth.x;
  const my = rig.mouth.y;
  const mrx = rig.mouth.rx;
  const mry = rig.mouth.ry;
  const jawDropMax = mouthOpen * mry * 1.35;

  for (const vert of mesh.vertices) {
    let x = vert.u;
    let y = vert.v;

    // 1. Deformasi kedipan mata (kiri & kanan)
    if (blink > 0.01) {
      const eyes = [rig.leftEye, rig.rightEye];
      for (const eye of eyes) {
        const enx = (x - eye.x) / (eye.rx * 1.45);
        const eny = (y - eye.y) / (eye.ry * 1.65);
        const wEye = Math.exp(-(enx * enx * 1.35 + eny * eny * 1.55));
        if (wEye > 0.01) {
          const closeLineY = eye.y + eye.ry * 0.16;
          const pullStrength = y <= eye.y ? 1.08 : 0.72;
          y += blink * wEye * (closeLineY - y) * pullStrength;
        }
      }
    }

    // 2. Deformasi bukaan mulut & dagu (split-lip seam)
    if (mouthOpen > 0.02) {
      const horizNorm = Math.abs(x - mx) / (mrx * 1.08);
      if (horizNorm < 1.35) {
        const horizWeight = Math.cos(clamp(horizNorm / 1.35, 0, 1) * (Math.PI / 2));
        if (vert.kind === 'upperLip') {
          y -= jawDropMax * 0.22 * horizWeight;
        } else if (vert.kind === 'lowerLip') {
          y += jawDropMax * 0.92 * horizWeight;
        } else if (y > my) {
          const distBelow = y - my;
          const vertFalloff = Math.exp(-Math.pow(distBelow / (mry * 2.4), 2));
          y += jawDropMax * 0.85 * horizWeight * vertFalloff;
        } else {
          const distAbove = my - y;
          const upperFalloff = Math.exp(-Math.pow(distAbove / (mry * 1.25), 2));
          y -= jawDropMax * 0.18 * horizWeight * upperFalloff;
        }
      }
    }

    // 3. Gerakan kepala berporos leher + napas bahu halus
    const headWeight = smoothstep(rig.neckY + 0.08, rig.neckY - 0.14, vert.v);
    if (headWeight > 0.001) {
      const dx = x - pivotX;
      const dy = y - pivotY;
      const rx = pivotX + dx * cosR - dy * sinR + headShiftX;
      const ry = pivotY + dx * sinR + dy * cosR + headShiftY;
      x = x + (rx - x) * headWeight;
      y = y + (ry - y) * headWeight;
    }
    y += shoulderBreathY * (1 - headWeight);

    vert.x = x;
    vert.y = y;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Gambar rongga mulut lembut di posisi bibir yang terdeformasi bila mulut sedang membuka
  if (mouthOpen > 0.04) {
    const dxCenter = mx - pivotX;
    const dyCenter = my - pivotY;
    const wCenter = smoothstep(rig.neckY + 0.08, rig.neckY - 0.14, my);
    const rxCenter =
      mx + (pivotX + dxCenter * cosR - dyCenter * sinR + headShiftX - mx) * wCenter;
    const ryCenter =
      my + (pivotY + dxCenter * sinR + dyCenter * cosR + headShiftY - my) * wCenter;

    const cavityCx = rxCenter * width;
    const cavityCy = (ryCenter + jawDropMax * 0.34) * height;
    const cavityRx = Math.max(2, mrx * 0.8 * width);
    const cavityRy = Math.max(1.5, jawDropMax * 0.68 * height);

    ctx.save();
    ctx.translate(cavityCx, cavityCy);
    ctx.rotate(headRollRad * wCenter);

    const grad = ctx.createRadialGradient(0, -cavityRy * 0.1, 1, 0, 0, Math.max(cavityRx, cavityRy));
    grad.addColorStop(0, '#360a14');
    grad.addColorStop(0.7, '#581322');
    grad.addColorStop(1, 'rgba(88, 19, 34, 0.7)');

    ctx.beginPath();
    ctx.ellipse(0, 0, cavityRx, cavityRy, 0, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Siluet lidah lembut di bagian bawah rongga mulut
    if (cavityRy > 3) {
      ctx.beginPath();
      ctx.ellipse(0, cavityRy * 0.48, cavityRx * 0.62, cavityRy * 0.42, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(225, 85, 110, 0.55)';
      ctx.fill();
    }
    ctx.restore();
  }

  // Render semua segitiga mesh
  for (const tri of mesh.triangles) {
    drawAffineTriangle(
      ctx,
      img,
      width,
      height,
      mesh.vertices[tri.a],
      mesh.vertices[tri.b],
      mesh.vertices[tri.c]
    );
  }
}
