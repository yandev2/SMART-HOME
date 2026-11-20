'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ImagePlus,
  Link2,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Square,
  Upload,
  UserCircle2,
} from 'lucide-react';
import { DEFAULT_AVATAR_RIG } from '@/lib/constants';
import {
  analyzeFaceAppearance,
  compressAvatarSourceToDataUrl,
  readFileAsDataUrl,
} from '@/lib/faceMesh2d';
import type { AssistantProfile, AvatarMode, AvatarRig } from '@/lib/types';
import MeshAvatarCanvas from './MeshAvatarCanvas';

interface AvatarCustomizerProps {
  profile: AssistantProfile;
  onProfileChanged: (next: AssistantProfile) => void;
}

type PinKey = 'leftEye' | 'rightEye' | 'mouth' | 'neckY';

const PIN_LABELS: Record<PinKey, string> = {
  leftEye: 'Mata Kiri',
  rightEye: 'Mata Kanan',
  mouth: 'Mulut',
  neckY: 'Batas Leher',
};

function clampCoord(val: number, min = 0.08, max = 0.92): number {
  return Number(Math.min(max, Math.max(min, val)).toFixed(3));
}

export default function AvatarCustomizer({
  profile,
  onProfileChanged,
}: AvatarCustomizerProps) {
  const [avatarMode, setAvatarMode] = useState<AvatarMode>(
    profile.avatarMode ?? 'default'
  );
  const [imageDataUrl, setImageDataUrl] = useState<string>(
    profile.customAvatar?.imageDataUrl ?? ''
  );
  const [rig, setRig] = useState<AvatarRig>(
    profile.customAvatar?.rig ?? DEFAULT_AVATAR_RIG
  );

  const [imageUrlInput, setImageUrlInput] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activePin, setActivePin] = useState<PinKey>('mouth');
  const [draggingPin, setDraggingPin] = useState<PinKey | null>(null);
  const [liveStatusText, setLiveStatusText] = useState('');
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Simulasi bicara & kedip langsung di dalam kalibrator
  const [simulating, setSimulating] = useState(false);
  const [simMouth, setSimMouth] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAvatarMode(profile.avatarMode ?? 'default');
    if (profile.customAvatar?.imageDataUrl) {
      setImageDataUrl(profile.customAvatar.imageDataUrl);
      setRig(profile.customAvatar.rig);
    }
  }, [profile]);

  useEffect(() => {
    if (!simulating) {
      setSimMouth(0);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      const wave =
        Math.abs(Math.sin(t * 7.2) * Math.cos(t * 3.1)) * 0.75 +
        (Math.sin(t * 14) > 0.35 ? 0.2 : 0);
      setSimMouth(Math.min(1, Math.max(0.08, wave)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [simulating]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedback(null);
    setSimulating(false);

    if (!file.type.startsWith('image/')) {
      setFeedback({ type: 'error', text: 'Pilih file gambar PNG, JPG, atau WebP.' });
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      setFeedback({ type: 'error', text: 'Ukuran file maksimal 6 MB.' });
      return;
    }

    try {
      const rawUrl = await readFileAsDataUrl(file);
      const compressed = await compressAvatarSourceToDataUrl(rawUrl);
      setImageDataUrl(compressed);
      setAvatarMode('custom');
      setFeedback({
        type: 'success',
        text: 'Gambar dimuat! Geser 4 penanda agar pas dengan mata, mulut & leher karakter.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal memproses gambar.',
      });
    } finally {
      e.target.value = '';
    }
  }

  async function handleFetchUrl() {
    const trimmed = imageUrlInput.trim();
    if (!trimmed) {
      setFeedback({ type: 'error', text: 'Masukkan URL gambar dari internet terlebih dahulu.' });
      return;
    }

    setFetchingUrl(true);
    setFeedback(null);
    setSimulating(false);

    try {
      const res = await fetch('/api/avatar-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = (await res.json().catch(() => null)) as {
        dataUrl?: string;
        error?: string;
      } | null;

      if (!res.ok || !data?.dataUrl) {
        throw new Error(data?.error || 'Gagal mengunduh gambar dari URL tersebut.');
      }

      const compressed = await compressAvatarSourceToDataUrl(data.dataUrl);
      setImageDataUrl(compressed);
      setAvatarMode('custom');
      setImageUrlInput('');
      setFeedback({
        type: 'success',
        text: 'Gambar dari URL berhasil diambil! Sesuaikan pin lalu klik Simulasi Bicara.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal mengambil gambar.',
      });
    } finally {
      setFetchingUrl(false);
    }
  }

  function handleAutoSnapMouth() {
    if (!imageDataUrl) return;
    const img = new Image();
    img.onload = () => {
      const detected = analyzeFaceAppearance(img, rig);
      setRig((prev) => ({
        ...prev,
        mouth: {
          ...prev.mouth,
          y: Number(detected.detectedMouthY.toFixed(3)),
        },
      }));
      setLiveStatusText('Posisi bibir disesuaikan otomatis');
      setFeedback({
        type: 'success',
        text: 'Pin Mulut (M) otomatis diarahkan tepat ke garis bibir terdeteksi!',
      });
    };
    img.src = imageDataUrl;
  }

  function updatePinPosition(pin: PinKey, nx: number, ny: number) {
    setRig((prev) => {
      if (pin === 'leftEye') {
        return { ...prev, leftEye: { ...prev.leftEye, x: clampCoord(nx), y: clampCoord(ny) } };
      }
      if (pin === 'rightEye') {
        return { ...prev, rightEye: { ...prev.rightEye, x: clampCoord(nx), y: clampCoord(ny) } };
      }
      if (pin === 'mouth') {
        return {
          ...prev,
          mouth: { ...prev.mouth, x: clampCoord(nx, 0.1, 0.9), y: clampCoord(ny, 0.15, 0.92) },
        };
      }
      return { ...prev, neckY: clampCoord(ny, 0.35, 0.95) };
    });
  }

  function clientToNormalized(clientX: number, clientY: number): { nx: number; ny: number } | null {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      nx: clampCoord((clientX - rect.left) / rect.width),
      ny: clampCoord((clientY - rect.top) / rect.height),
    };
  }

  function handlePinPointerDown(pin: PinKey, e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return;
    e.stopPropagation();
    setActivePin(pin);
    setDraggingPin(pin);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePinPointerMove(pin: PinKey, e: React.PointerEvent<HTMLButtonElement>) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const coords = clientToNormalized(e.clientX, e.clientY);
    if (coords) {
      updatePinPosition(pin, coords.nx, coords.ny);
    }
  }

  function handlePinPointerUp(pin: PinKey) {
    if (draggingPin === pin) {
      setDraggingPin(null);
      setLiveStatusText(`${PIN_LABELS[pin]} dipindahkan`);
    }
  }

  function handlePinKeyDown(pin: PinKey, e: React.KeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 0.03 : 0.012;
    let dx = 0;
    let dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else return;

    e.preventDefault();
    setActivePin(pin);
    setRig((prev) => {
      if (pin === 'leftEye') {
        return {
          ...prev,
          leftEye: {
            ...prev.leftEye,
            x: clampCoord(prev.leftEye.x + dx),
            y: clampCoord(prev.leftEye.y + dy),
          },
        };
      }
      if (pin === 'rightEye') {
        return {
          ...prev,
          rightEye: {
            ...prev.rightEye,
            x: clampCoord(prev.rightEye.x + dx),
            y: clampCoord(prev.rightEye.y + dy),
          },
        };
      }
      if (pin === 'mouth') {
        return {
          ...prev,
          mouth: {
            ...prev.mouth,
            x: clampCoord(prev.mouth.x + dx, 0.1, 0.9),
            y: clampCoord(prev.mouth.y + dy, 0.15, 0.92),
          },
        };
      }
      return { ...prev, neckY: clampCoord(prev.neckY + dy, 0.35, 0.95) };
    });
    setLiveStatusText(`${PIN_LABELS[pin]} digeser`);
  }

  // Fallback single-tap: klik pada area gambar langsung memindahkan pin aktif ke titik tersebut
  function handleStageClick(e: React.MouseEvent<HTMLDivElement>) {
    if (simulating || !imageDataUrl) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const coords = clientToNormalized(e.clientX, e.clientY);
    if (coords) {
      updatePinPosition(activePin, coords.nx, coords.ny);
      setLiveStatusText(`${PIN_LABELS[activePin]} dipindahkan`);
    }
  }

  async function handleSave(modeToSave: AvatarMode = avatarMode) {
    if (modeToSave === 'custom' && !imageDataUrl) {
      setFeedback({ type: 'error', text: 'Upload atau ambil gambar terlebih dahulu.' });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const payload: AssistantProfile = {
        name: profile.name,
        gender: profile.gender,
        styles: profile.styles,
        description: profile.description,
        avatarMode: modeToSave,
        customAvatar:
          modeToSave === 'custom'
            ? { imageDataUrl, rig }
            : profile.customAvatar ?? null,
      };

      const res = await fetch('/api/settings/assistant', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as {
        profile?: AssistantProfile;
        error?: string;
      } | null;

      if (!res.ok || !data?.profile) {
        throw new Error(data?.error || 'Gagal menyimpan pengaturan avatar.');
      }

      onProfileChanged(data.profile);
      setFeedback({
        type: 'success',
        text:
          modeToSave === 'custom'
            ? 'Custom Voice Avatar berhasil disimpan! Langsung aktif di Mode Voice.'
            : 'Avatar dikembalikan ke Avatar Bawaan (SVG).',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan custom avatar.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="custom-avatar-heading" className="space-y-3">
      <div>
        <h2 id="custom-avatar-heading" className="text-sm font-semibold text-white">
          Avatar Mode Voice (Custom Gambar)
        </h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Pakai gambar karakter PNG/JPG/WebP pilihanmu sendiri (tanpa <code>.moc3</code>),
          lengkap dengan animasi kedip mata, lip-sync mulut, dan gerakan kepala.
        </p>
      </div>

      <div className="space-y-3.5 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-slate-200">
            Pilihan Avatar
          </legend>
          <div className="grid grid-cols-2 gap-2">
            <label
              className={`flex min-h-[40px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                avatarMode === 'default'
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200'
                  : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
              }`}
            >
              <input
                type="radio"
                name="avatar_mode_choice"
                checked={avatarMode === 'default'}
                onChange={() => {
                  setAvatarMode('default');
                  setSimulating(false);
                }}
                className="h-3.5 w-3.5 accent-emerald-500"
              />
              Avatar Bawaan
            </label>

            <label
              className={`flex min-h-[40px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                avatarMode === 'custom'
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200'
                  : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
              }`}
            >
              <input
                type="radio"
                name="avatar_mode_choice"
                checked={avatarMode === 'custom'}
                onChange={() => setAvatarMode('custom')}
                className="h-3.5 w-3.5 accent-emerald-500"
              />
              Custom Gambar
            </label>
          </div>
        </fieldset>

        {avatarMode === 'default' ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
            <span className="flex items-center gap-2">
              <UserCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              Sedang memilih karakter vektor bawaan.
            </span>
            {profile.avatarMode === 'custom' && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSave('default')}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Terapkan Avatar Bawaan
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3.5">
            {/* Input Gambar: Upload atau URL Internet */}
            <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/25">
                  <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Upload Gambar</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                </label>
                <span className="text-[11px] text-slate-400">
                  atau tempel link gambar dari internet:
                </span>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Link2
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                    aria-hidden="true"
                  />
                  <input
                    type="url"
                    aria-label="URL gambar dari internet"
                    value={imageUrlInput}
                    onChange={(e) => setImageUrlInput(e.target.value)}
                    placeholder="https://contoh.com/karakter.png"
                    className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-900 py-1.5 pl-8 pr-3 text-slate-100 placeholder:text-slate-500"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void handleFetchUrl()}
                  disabled={fetchingUrl}
                  className="inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  {fetchingUrl && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  )}
                  Ambil
                </button>
              </div>
            </div>

            {!imageDataUrl ? (
              <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center">
                <ImagePlus className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
                <p className="mt-2 text-xs font-medium text-slate-300">
                  Belum ada gambar karakter.
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Disarankan potret menghadap depan (PNG transparan atau JPG/WebP).
                </p>
              </div>
            ) : (
              <>
                {/* Baris Pilih Pin & Tombol Simulasi */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div
                    role="group"
                    aria-label="Pilih titik kalibrasi aktif"
                    className="flex flex-wrap gap-1"
                  >
                    {(['leftEye', 'rightEye', 'mouth', 'neckY'] as PinKey[]).map((key) => (
                      <button
                        key={key}
                        type="button"
                        disabled={simulating}
                        aria-pressed={activePin === key && !simulating}
                        onClick={() => setActivePin(key)}
                        className="rounded-md border border-slate-700 px-2 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-slate-800 aria-[pressed=true]:border-emerald-500 aria-[pressed=true]:bg-emerald-500/20 aria-[pressed=true]:text-emerald-200 disabled:opacity-50"
                      >
                        {PIN_LABELS[key]}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => setSimulating((prev) => !prev)}
                    className={`inline-flex min-h-[34px] items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition ${
                      simulating
                        ? 'bg-amber-400 text-slate-950 hover:bg-amber-300'
                        : 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/40 hover:bg-sky-500/30'
                    }`}
                  >
                    {simulating ? (
                      <>
                        <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                        Selesai Tes
                      </>
                    ) : (
                      <>
                        <Play className="h-3 w-3 fill-current" aria-hidden="true" />
                        Simulasi Bicara
                      </>
                    )}
                  </button>
                </div>

                {/* Panggung Kalibrasi / Pratinjau Animasi Mesh */}
                <div className="flex flex-col items-center gap-2">
                  <div
                    ref={stageRef}
                    onClick={handleStageClick}
                    className="relative aspect-square w-full max-w-[260px] overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-inner"
                  >
                    {simulating ? (
                      <MeshAvatarCanvas
                        imageDataUrl={imageDataUrl}
                        rig={rig}
                        mouthLevel={simMouth}
                        isSpeaking
                      />
                    ) : (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={imageDataUrl}
                          alt="Pratinjau kalibrasi karakter"
                          draggable={false}
                          className="pointer-events-none h-full w-full select-none object-contain"
                        />

                        {/* Garis Batas Leher (neckY) */}
                        <div
                          style={{ top: `${rig.neckY * 100}%` }}
                          className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-amber-400/75"
                        />

                        {/* Area elips visual mata & mulut */}
                        <div
                          style={{
                            left: `${rig.leftEye.x * 100}%`,
                            top: `${rig.leftEye.y * 100}%`,
                            width: `${rig.leftEye.rx * 200}%`,
                            height: `${rig.leftEye.ry * 200}%`,
                          }}
                          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-400/80 bg-sky-400/15"
                        />
                        <div
                          style={{
                            left: `${rig.rightEye.x * 100}%`,
                            top: `${rig.rightEye.y * 100}%`,
                            width: `${rig.rightEye.rx * 200}%`,
                            height: `${rig.rightEye.ry * 200}%`,
                          }}
                          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-emerald-400/80 bg-emerald-400/15"
                        />
                        <div
                          style={{
                            left: `${rig.mouth.x * 100}%`,
                            top: `${rig.mouth.y * 100}%`,
                            width: `${rig.mouth.rx * 200}%`,
                            height: `${rig.mouth.ry * 200}%`,
                          }}
                          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-rose-400/80 bg-rose-400/15"
                        />

                        {/* 4 Handle Crosshair Transparan + Focusable agar wajah tetap terlihat jelas */}
                        <button
                          type="button"
                          onPointerDown={(e) => handlePinPointerDown('leftEye', e)}
                          onPointerMove={(e) => handlePinPointerMove('leftEye', e)}
                          onPointerUp={() => handlePinPointerUp('leftEye')}
                          onLostPointerCapture={() => handlePinPointerUp('leftEye')}
                          onKeyDown={(e) => handlePinKeyDown('leftEye', e)}
                          aria-label="Pin Mata Kiri. Seret atau gunakan tombol panah untuk menggeser."
                          style={{
                            left: `${rig.leftEye.x * 100}%`,
                            top: `${rig.leftEye.y * 100}%`,
                            touchAction: 'none',
                            WebkitUserSelect: 'none',
                            userSelect: 'none',
                          }}
                          className={`group absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-sky-400 bg-sky-400/10 ${
                            draggingPin === 'leftEye' ? 'cursor-grabbing scale-110' : 'cursor-grab'
                          }`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-sky-300 shadow" />
                          <span className="pointer-events-none absolute -top-4 rounded bg-sky-500 px-1 text-[8px] font-bold text-slate-950">
                            L
                          </span>
                        </button>

                        <button
                          type="button"
                          onPointerDown={(e) => handlePinPointerDown('rightEye', e)}
                          onPointerMove={(e) => handlePinPointerMove('rightEye', e)}
                          onPointerUp={() => handlePinPointerUp('rightEye')}
                          onLostPointerCapture={() => handlePinPointerUp('rightEye')}
                          onKeyDown={(e) => handlePinKeyDown('rightEye', e)}
                          aria-label="Pin Mata Kanan. Seret atau gunakan tombol panah untuk menggeser."
                          style={{
                            left: `${rig.rightEye.x * 100}%`,
                            top: `${rig.rightEye.y * 100}%`,
                            touchAction: 'none',
                            WebkitUserSelect: 'none',
                            userSelect: 'none',
                          }}
                          className={`group absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-emerald-400 bg-emerald-400/10 ${
                            draggingPin === 'rightEye' ? 'cursor-grabbing scale-110' : 'cursor-grab'
                          }`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow" />
                          <span className="pointer-events-none absolute -top-4 rounded bg-emerald-400 px-1 text-[8px] font-bold text-slate-950">
                            R
                          </span>
                        </button>

                        <button
                          type="button"
                          onPointerDown={(e) => handlePinPointerDown('mouth', e)}
                          onPointerMove={(e) => handlePinPointerMove('mouth', e)}
                          onPointerUp={() => handlePinPointerUp('mouth')}
                          onLostPointerCapture={() => handlePinPointerUp('mouth')}
                          onKeyDown={(e) => handlePinKeyDown('mouth', e)}
                          aria-label="Pin Mulut. Seret atau gunakan tombol panah untuk menggeser."
                          style={{
                            left: `${rig.mouth.x * 100}%`,
                            top: `${rig.mouth.y * 100}%`,
                            touchAction: 'none',
                            WebkitUserSelect: 'none',
                            userSelect: 'none',
                          }}
                          className={`group absolute flex h-7 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-rose-400 bg-rose-500/5 ${
                            draggingPin === 'mouth' ? 'cursor-grabbing scale-110' : 'cursor-grab'
                          }`}
                        >
                          <span className="h-1 w-4 rounded-full bg-rose-400/80 shadow" />
                          <span className="pointer-events-none absolute -bottom-4 rounded bg-rose-500 px-1 text-[8px] font-bold text-white">
                            M
                          </span>
                        </button>

                        <button
                          type="button"
                          onPointerDown={(e) => handlePinPointerDown('neckY', e)}
                          onPointerMove={(e) => handlePinPointerMove('neckY', e)}
                          onPointerUp={() => handlePinPointerUp('neckY')}
                          onLostPointerCapture={() => handlePinPointerUp('neckY')}
                          onKeyDown={(e) => handlePinKeyDown('neckY', e)}
                          aria-label="Pin Batas Leher. Seret ke atas/bawah atau gunakan panah atas/bawah."
                          style={{
                            left: '86%',
                            top: `${rig.neckY * 100}%`,
                            touchAction: 'none',
                            WebkitUserSelect: 'none',
                            userSelect: 'none',
                          }}
                          className={`absolute flex h-6 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-amber-400 text-[9px] font-bold text-slate-950 shadow-md ${
                            draggingPin === 'neckY' ? 'cursor-grabbing scale-110' : 'cursor-grab'
                          }`}
                        >
                          Leher
                        </button>
                      </>
                    )}
                  </div>

                  <p className="text-[11px] text-slate-400">
                    {simulating
                      ? 'Pratinjau animasi kedip mata, lip-sync mulut & gerakan kepala aktif.'
                      : 'Seret pin L / R / M / Leher (atau klik area gambar untuk memindahkan pin terpilih).'}
                  </p>
                  <div className="sr-only" aria-live="polite">
                    {liveStatusText}
                  </div>
                </div>

                {/* Slider Ukuran Area Mata, Mulut & Gerak Kepala */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <label htmlFor="rig-eye-size" className="text-[11px] font-medium text-slate-300">
                      Area Mata
                    </label>
                    <input
                      id="rig-eye-size"
                      type="range"
                      min={0.035}
                      max={0.11}
                      step={0.005}
                      value={rig.leftEye.rx}
                      onChange={(e) => {
                        const rx = Number(e.target.value);
                        const ry = Number((rx * 0.7).toFixed(3));
                        setRig((prev) => ({
                          ...prev,
                          leftEye: { ...prev.leftEye, rx, ry },
                          rightEye: { ...prev.rightEye, rx, ry },
                        }));
                      }}
                      className="h-2 w-full cursor-pointer accent-emerald-500"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label htmlFor="rig-mouth-size" className="text-[11px] font-medium text-slate-300">
                      Area Mulut
                    </label>
                    <input
                      id="rig-mouth-size"
                      type="range"
                      min={0.04}
                      max={0.15}
                      step={0.005}
                      value={rig.mouth.rx}
                      onChange={(e) => {
                        const rx = Number(e.target.value);
                        const ry = Number((rx * 0.65).toFixed(3));
                        setRig((prev) => ({
                          ...prev,
                          mouth: { ...prev.mouth, rx, ry },
                        }));
                      }}
                      className="h-2 w-full cursor-pointer accent-emerald-500"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label htmlFor="rig-head-motion" className="text-[11px] font-medium text-slate-300">
                      Gerak Kepala
                    </label>
                    <input
                      id="rig-head-motion"
                      type="range"
                      min={0.2}
                      max={1.5}
                      step={0.1}
                      value={rig.motionIntensity}
                      onChange={(e) =>
                        setRig((prev) => ({
                          ...prev,
                          motionIntensity: Number(e.target.value),
                        }))
                      }
                      className="h-2 w-full cursor-pointer accent-emerald-500"
                    />
                  </div>
                </div>
              </>
            )}

            {feedback && (
              <div
                role="status"
                aria-live="polite"
                className={`rounded-lg border px-3 py-2 text-xs ${
                  feedback.type === 'error'
                    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                }`}
              >
                {feedback.text}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setRig(DEFAULT_AVATAR_RIG)}
                  className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  Reset Pin
                </button>
                <button
                  type="button"
                  disabled={simulating || !imageDataUrl}
                  onClick={handleAutoSnapMouth}
                  className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
                >
                  <Sparkles className="h-3 w-3" aria-hidden="true" />
                  Pas-kan Bibir Otomatis
                </button>
              </div>

              <button
                type="button"
                onClick={() => void handleSave('custom')}
                disabled={saving || !imageDataUrl}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Simpan Custom Avatar
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

