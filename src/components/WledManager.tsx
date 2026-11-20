'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  Check,
  Copy,
  Database,
  Loader2,
  Palette,
  Pencil,
  Plus,
  Power,
  Sparkles,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  WLED_EFFECT_OPTIONS,
  WLED_GPIO_OPTIONS,
  WLED_QUICK_COLORS,
  clampWledByte,
  formatWledGpioLabel,
  isControllerOnline,
  sanitizeHexColor,
} from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';
import type { Room, WledDevice, WledEffect, WledPreset } from '@/lib/types';
import ModalDialog from './ModalDialog';

interface WledManagerProps {
  userId: string;
  rooms: Room[];
  wledDevices: WledDevice[];
  wledPresets: WledPreset[];
  tableReady: boolean;
  onChanged: () => Promise<void> | void;
}

interface LocalDraftState {
  is_on: boolean;
  color_hex: string;
  brightness: number;
  effect: WledEffect;
  speed: number;
  active_preset_id: string | null;
}

export default function WledManager({
  userId,
  rooms,
  wledDevices,
  wledPresets,
  tableReady,
  onChanged,
}: WledManagerProps) {
  const roomMap = new Map(rooms.map((r) => [r.id, r.name]));

  // Draft lokal per WLED untuk UI mulus saat geser slider / color picker (dengan debounce commit ke DB)
  const [drafts, setDrafts] = useState<Record<string, LocalDraftState>>({});
  const debounceTimersRef = useRef<Record<string, number>>({});

  // Sync draft saat data server berubah
  useEffect(() => {
    setDrafts((prev) => {
      const next: Record<string, LocalDraftState> = {};
      for (const dev of wledDevices) {
        // Jika sedang ada pending debounce pada device tersebut, pertahankan sementara nilai lokal
        if (debounceTimersRef.current[dev.id] && prev[dev.id]) {
          next[dev.id] = prev[dev.id];
        } else {
          next[dev.id] = {
            is_on: dev.is_on,
            color_hex: sanitizeHexColor(dev.color_hex),
            brightness: clampWledByte(dev.brightness, 1, 255, 180),
            effect: dev.effect,
            speed: clampWledByte(dev.speed, 0, 255, 128),
            active_preset_id: dev.active_preset_id,
          };
        }
      }
      return next;
    });
  }, [wledDevices]);

  useEffect(() => {
    const timers = debounceTimersRef.current;
    return () => {
      Object.values(timers).forEach((t) => window.clearTimeout(t));
    };
  }, []);

  // Modal tambah/edit WLED device
  const [deviceModalOpen, setDeviceModalOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<WledDevice | null>(null);
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [roomId, setRoomId] = useState('');
  const [gpioPin, setGpioPin] = useState<number>(2);
  const [ledCount, setLedCount] = useState<number>(60);
  const [savingDevice, setSavingDevice] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const [deleteDeviceTarget, setDeleteDeviceTarget] = useState<WledDevice | null>(null);
  const [deletingDevice, setDeletingDevice] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Modal tambah/edit Preset WLED
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<WledPreset | null>(null);
  const [presetName, setPresetName] = useState('');
  const [presetKeywords, setPresetKeywords] = useState('');
  const [presetDeviceId, setPresetDeviceId] = useState<string>(''); // '' = semua WLED
  const [presetIsOn, setPresetIsOn] = useState(true);
  const [presetColorHex, setPresetColorHex] = useState('#A855F7');
  const [presetBrightness, setPresetBrightness] = useState(180);
  const [presetEffect, setPresetEffect] = useState<WledEffect>('solid');
  const [presetSpeed, setPresetSpeed] = useState(128);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [deletePresetTarget, setDeletePresetTarget] = useState<WledPreset | null>(null);
  const [deletingPreset, setDeletingPreset] = useState(false);

  function getState(dev: WledDevice): LocalDraftState {
    return (
      drafts[dev.id] ?? {
        is_on: dev.is_on,
        color_hex: sanitizeHexColor(dev.color_hex),
        brightness: clampWledByte(dev.brightness, 1, 255, 180),
        effect: dev.effect,
        speed: clampWledByte(dev.speed, 0, 255, 128),
        active_preset_id: dev.active_preset_id,
      }
    );
  }

  async function commitWledPatch(
    deviceId: string,
    patch: Partial<{
      is_on: boolean;
      color_hex: string;
      brightness: number;
      effect: WledEffect;
      speed: number;
      active_preset_id: string | null;
    }>
  ) {
    const supabase = createClient();
    const { error } = await supabase
      .from('wled_devices')
      .update(patch)
      .eq('id', deviceId)
      .eq('user_id', userId);
    if (!error) {
      await onChanged();
    }
  }

  function updateWledState(
    dev: WledDevice,
    patch: Partial<LocalDraftState>,
    debounceMs = 0
  ) {
    const current = getState(dev);
    const merged: LocalDraftState = {
      ...current,
      ...patch,
    };

    setDrafts((prev) => ({ ...prev, [dev.id]: merged }));

    if (debounceTimersRef.current[dev.id]) {
      window.clearTimeout(debounceTimersRef.current[dev.id]);
      delete debounceTimersRef.current[dev.id];
    }

    if (debounceMs > 0) {
      debounceTimersRef.current[dev.id] = window.setTimeout(() => {
        delete debounceTimersRef.current[dev.id];
        void commitWledPatch(dev.id, patch);
      }, debounceMs);
    } else {
      void commitWledPatch(dev.id, patch);
    }
  }

  function openAddDevice() {
    setEditingDevice(null);
    setName('');
    setAliases('');
    setRoomId(rooms[0]?.id ?? '');
    setGpioPin(2);
    setLedCount(60);
    setDeviceError(null);
    setDeviceModalOpen(true);
  }

  function openEditDevice(dev: WledDevice) {
    setEditingDevice(dev);
    setName(dev.name);
    setAliases(dev.aliases ?? '');
    setRoomId(dev.room_id ?? '');
    setGpioPin(dev.gpio_pin);
    setLedCount(dev.led_count);
    setDeviceError(null);
    setDeviceModalOpen(true);
  }

  async function handleSaveDevice(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setDeviceError('Nama unit WLED wajib diisi.');
      return;
    }

    const safeLedCount = clampWledByte(ledCount, 1, 300, 60);

    setSavingDevice(true);
    setDeviceError(null);
    try {
      const supabase = createClient();
      const payload = {
        user_id: userId,
        name: trimmed,
        aliases: aliases.trim(),
        room_id: roomId || null,
        gpio_pin: gpioPin,
        led_count: safeLedCount,
      };

      if (editingDevice) {
        const { error } = await supabase
          .from('wled_devices')
          .update(payload)
          .eq('id', editingDevice.id)
          .eq('user_id', userId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('wled_devices').insert({
          ...payload,
          is_on: true,
          color_hex: '#38BDF8',
          brightness: 180,
          effect: 'solid',
          speed: 128,
        });
        if (error) throw error;
      }

      setDeviceModalOpen(false);
      await onChanged();
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Gagal menyimpan perangkat WLED.');
    } finally {
      setSavingDevice(false);
    }
  }

  async function handleDeleteDevice() {
    if (!deleteDeviceTarget) return;
    setDeletingDevice(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('wled_devices')
        .delete()
        .eq('id', deleteDeviceTarget.id)
        .eq('user_id', userId);
      if (error) throw error;
      setDeleteDeviceTarget(null);
      await onChanged();
    } finally {
      setDeletingDevice(false);
    }
  }

  async function handleCopyToken(dev: WledDevice) {
    try {
      await navigator.clipboard.writeText(dev.api_token);
      setCopiedId(dev.id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === dev.id ? null : prev));
      }, 2500);
    } catch {
      // Abaikan jika clipboard diblokir browser
    }
  }

  function openSavePresetFromDevice(dev: WledDevice) {
    const st = getState(dev);
    setEditingPreset(null);
    setPresetName('');
    setPresetKeywords('');
    setPresetDeviceId(dev.id);
    setPresetIsOn(true);
    setPresetColorHex(st.color_hex);
    setPresetBrightness(st.brightness);
    setPresetEffect(st.effect);
    setPresetSpeed(st.speed);
    setPresetError(null);
    setPresetModalOpen(true);
  }

  function openEditPreset(preset: WledPreset) {
    setEditingPreset(preset);
    setPresetName(preset.name);
    setPresetKeywords(preset.keywords ?? '');
    setPresetDeviceId(preset.wled_device_id ?? '');
    setPresetIsOn(preset.is_on);
    setPresetColorHex(sanitizeHexColor(preset.color_hex));
    setPresetBrightness(clampWledByte(preset.brightness, 1, 255, 180));
    setPresetEffect(preset.effect);
    setPresetSpeed(clampWledByte(preset.speed, 0, 255, 128));
    setPresetError(null);
    setPresetModalOpen(true);
  }

  async function handleSavePreset(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = presetName.trim();
    if (!trimmed) {
      setPresetError('Nama preset WLED wajib diisi.');
      return;
    }

    setSavingPreset(true);
    setPresetError(null);
    try {
      const supabase = createClient();
      const payload = {
        user_id: userId,
        wled_device_id: presetDeviceId || null,
        name: trimmed,
        keywords: presetKeywords.trim(),
        is_on: presetIsOn,
        color_hex: sanitizeHexColor(presetColorHex),
        brightness: clampWledByte(presetBrightness, 1, 255, 180),
        effect: presetEffect,
        speed: clampWledByte(presetSpeed, 0, 255, 128),
      };

      if (editingPreset) {
        const { error } = await supabase
          .from('wled_presets')
          .update(payload)
          .eq('id', editingPreset.id)
          .eq('user_id', userId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('wled_presets').insert(payload);
        if (error) throw error;
      }

      setPresetModalOpen(false);
      await onChanged();
    } catch (err) {
      setPresetError(err instanceof Error ? err.message : 'Gagal menyimpan preset WLED.');
    } finally {
      setSavingPreset(false);
    }
  }

  async function handleDeletePreset() {
    if (!deletePresetTarget) return;
    setDeletingPreset(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('wled_presets')
        .delete()
        .eq('id', deletePresetTarget.id)
        .eq('user_id', userId);
      if (error) throw error;
      setDeletePresetTarget(null);
      await onChanged();
    } finally {
      setDeletingPreset(false);
    }
  }

  function applyPresetToDevice(dev: WledDevice, preset: WledPreset) {
    updateWledState(dev, {
      is_on: preset.is_on,
      color_hex: sanitizeHexColor(preset.color_hex),
      brightness: clampWledByte(preset.brightness, 1, 255, 180),
      effect: preset.effect,
      speed: clampWledByte(preset.speed, 0, 255, 128),
      active_preset_id: preset.id,
    });
  }

  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  const syncEndpointUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/iot/led-sync`
      : 'https://domain-kamu.vercel.app/api/iot/led-sync';

  return (
    <section aria-labelledby="wled-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 id="wled-heading" className="text-sm font-semibold text-white">
            Smart LED WS2812 (WLED Mandiri)
          </h2>
          <p className="text-xs text-slate-400">
            Daftarkan NodeMCU khusus LED RGB tanpa mengganggu unit Relay. Bisa dikontrol manual
            dari sini atau langsung lewat AI (termasuk suasana hati &amp; warna kreatif).
          </p>
        </div>

        <button
          type="button"
          onClick={openAddDevice}
          disabled={!tableReady}
          className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Tambah WLED
        </button>
      </div>

      {!tableReady && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-100">
          <div className="flex items-start gap-2.5">
            <Database className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-semibold">Tabel Supabase WLED belum dibuat</p>
              <p className="text-amber-200/90">
                Jalankan ulang isi file <code>supabase/schema.sql</code> di Supabase SQL Editor
                untuk membuat tabel <code>public.wled_devices</code> dan{' '}
                <code>public.wled_presets</code>, lalu muat ulang halaman ini.
              </p>
            </div>
          </div>
        </div>
      )}

      {tableReady && wledDevices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-7 text-center">
          <Palette className="mx-auto h-9 w-9 text-slate-600" aria-hidden="true" />
          <p className="mt-2.5 text-xs font-medium text-slate-300">
            Belum ada unit WLED / WS2812 terdaftar.
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Klik &quot;Tambah WLED&quot; untuk mendaftarkan strip lampu RGB pertama Anda (mis.
            &quot;WLED Kamar A&quot;), lalu salin tokennya ke{' '}
            <code>firmware/nodemcu_ws2812/nodemcu_ws2812.ino</code>.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {wledDevices.map((dev) => {
            const st = getState(dev);
            const online = isControllerOnline(dev.last_seen);
            const roomName = dev.room_id
              ? roomMap.get(dev.room_id) ?? 'Tanpa Ruangan'
              : 'Tanpa Ruangan';
            const isCopied = copiedId === dev.id;
            const unitPresets = wledPresets.filter(
              (p) => p.wled_device_id === dev.id || p.wled_device_id === null
            );

            return (
              <div
                key={dev.id}
                className={`flex min-w-0 flex-col gap-3.5 rounded-xl border p-4 transition ${
                  st.is_on
                    ? 'border-slate-700 bg-slate-900/80 shadow-lg shadow-slate-950/50'
                    : 'border-slate-800 bg-slate-900/60'
                }`}
              >
                {/* Header Unit */}
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <span
                      className="mt-0.5 h-5 w-5 shrink-0 rounded-full ring-2 ring-slate-700 transition"
                      style={{
                        backgroundColor: st.is_on ? st.color_hex : '#1e293b',
                        boxShadow: st.is_on ? `0 0 14px ${st.color_hex}88` : 'none',
                      }}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="truncate text-sm font-semibold text-white">
                          {dev.name}
                        </h3>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            online
                              ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {online ? (
                            <Wifi className="h-2.5 w-2.5" aria-hidden="true" />
                          ) : (
                            <WifiOff className="h-2.5 w-2.5" aria-hidden="true" />
                          )}
                          {online ? 'Online' : 'Offline'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {roomName} • {dev.led_count} LED • {formatWledGpioLabel(dev.gpio_pin)}
                      </p>
                      {dev.aliases && (
                        <p className="mt-0.5 truncate text-[10px] text-slate-500">
                          Alias AI: {dev.aliases}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        updateWledState(dev, {
                          is_on: !st.is_on,
                          active_preset_id: null,
                        })
                      }
                      aria-label={st.is_on ? `Matikan ${dev.name}` : `Nyalakan ${dev.name}`}
                      className={`inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition ${
                        st.is_on
                          ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      <Power className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{st.is_on ? 'ON' : 'OFF'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditDevice(dev)}
                      aria-label={`Edit ${dev.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteDeviceTarget(dev)}
                      aria-label={`Hapus ${dev.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {/* Pilihan Warna Cepat + Color Picker */}
                <div className="space-y-2 rounded-lg border border-slate-800/80 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-slate-300">
                      Warna Lampu
                    </span>
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-300">
                        {st.color_hex}
                      </code>
                      <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-200 hover:border-slate-500">
                        <input
                          type="color"
                          value={st.color_hex}
                          onChange={(e) =>
                            updateWledState(
                              dev,
                              {
                                is_on: true,
                                color_hex: sanitizeHexColor(e.target.value),
                                ...(st.effect === 'rainbow' || st.effect === 'fire'
                                  ? { effect: 'solid' }
                                  : {}),
                                active_preset_id: null,
                              },
                              180
                            )
                          }
                          aria-label={`Pilih warna bebas untuk ${dev.name}`}
                          className="h-4 w-4 cursor-pointer rounded border-0 bg-transparent p-0"
                        />
                        <span>Bebas</span>
                      </label>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {WLED_QUICK_COLORS.map((swatch) => {
                      const active =
                        st.color_hex.toUpperCase() === swatch.hex.toUpperCase() && st.is_on;
                      return (
                        <button
                          key={swatch.hex}
                          type="button"
                          title={swatch.name}
                          onClick={() =>
                            updateWledState(dev, {
                              is_on: true,
                              color_hex: swatch.hex,
                              ...(st.effect === 'rainbow' || st.effect === 'fire'
                                ? { effect: 'solid' }
                                : {}),
                              active_preset_id: null,
                            })
                          }
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium transition ${
                            active
                              ? 'border-white bg-slate-800 text-white'
                              : 'border-slate-800 bg-slate-900/90 text-slate-300 hover:border-slate-600'
                          }`}
                        >
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: swatch.hex }}
                            aria-hidden="true"
                          />
                          <span>{swatch.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Slider Kecerahan, Efek, & Kecepatan */}
                <div className="grid gap-3 rounded-lg border border-slate-800/80 bg-slate-950/60 p-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-300">Kecerahan</span>
                      <span className="font-medium text-emerald-300">
                        {Math.round((st.brightness / 255) * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={255}
                      value={st.brightness}
                      onChange={(e) =>
                        updateWledState(
                          dev,
                          {
                            brightness: Number(e.target.value),
                            active_preset_id: null,
                          },
                          200
                        )
                      }
                      aria-label={`Kecerahan ${dev.name}`}
                      className="w-full accent-emerald-400"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-300">Kecepatan Efek</span>
                      <span className="font-medium text-sky-300">
                        {Math.round((st.speed / 255) * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={st.speed}
                      onChange={(e) =>
                        updateWledState(
                          dev,
                          {
                            speed: Number(e.target.value),
                            active_preset_id: null,
                          },
                          200
                        )
                      }
                      aria-label={`Kecepatan efek ${dev.name}`}
                      className="w-full accent-sky-400"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`effect-${dev.id}`}
                      className="mb-1 block text-[11px] font-medium text-slate-300"
                    >
                      Efek Animasi
                    </label>
                    <select
                      id={`effect-${dev.id}`}
                      value={st.effect}
                      onChange={(e) =>
                        updateWledState(dev, {
                          is_on: true,
                          effect: e.target.value as WledEffect,
                          active_preset_id: null,
                        })
                      }
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-white focus:border-emerald-500 focus:outline-none"
                    >
                      {WLED_EFFECT_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label} — {opt.note}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Preset WLED */}
                <div className="space-y-2 rounded-lg border border-slate-800/80 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Bookmark className="h-3.5 w-3.5 text-violet-400" aria-hidden="true" />
                      <span className="text-[11px] font-medium text-slate-200">
                        Preset Warna &amp; Efek
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => openSavePresetFromDevice(dev)}
                      className="inline-flex items-center gap-1 rounded-md bg-violet-500/20 px-2 py-1 text-[10px] font-semibold text-violet-200 ring-1 ring-violet-500/30 hover:bg-violet-500/30"
                    >
                      <Plus className="h-3 w-3" aria-hidden="true" />
                      Simpan Preset Ini
                    </button>
                  </div>

                  {unitPresets.length === 0 ? (
                    <p className="text-[11px] text-slate-500">
                      Belum ada preset. Atur warna &amp; efek di atas lalu klik &quot;Simpan
                      Preset Ini&quot;.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {unitPresets.map((preset) => {
                        const isActive = st.active_preset_id === preset.id && st.is_on;
                        return (
                          <div
                            key={preset.id}
                            className={`inline-flex items-center overflow-hidden rounded-lg border text-[11px] ${
                              isActive
                                ? 'border-emerald-400/70 bg-emerald-500/15 text-emerald-100'
                                : 'border-slate-800 bg-slate-900 text-slate-200'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => applyPresetToDevice(dev, preset)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 font-medium hover:bg-slate-800/70"
                            >
                              <span
                                className="h-2.5 w-2.5 rounded-full"
                                style={{ backgroundColor: preset.color_hex }}
                                aria-hidden="true"
                              />
                              <span>{preset.name}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditPreset(preset)}
                              aria-label={`Edit preset ${preset.name}`}
                              className="px-1.5 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                            >
                              <Pencil className="h-2.5 w-2.5" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletePresetTarget(preset)}
                              aria-label={`Hapus preset ${preset.name}`}
                              className="px-1.5 py-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                            >
                              <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Token & URL Sync untuk firmware/nodemcu_ws2812 */}
                <div className="space-y-1.5 rounded-lg border border-slate-800/80 bg-slate-950/70 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                      Device Token WLED
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyToken(dev)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 hover:text-emerald-300"
                    >
                      {isCopied ? (
                        <>
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Tersalin
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" aria-hidden="true" />
                          Salin Token
                        </>
                      )}
                    </button>
                  </div>
                  <code className="block truncate rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
                    {dev.api_token}
                  </code>
                  <p className="truncate text-[10px] text-slate-500">
                    URL Sync: <code>{syncEndpointUrl}</code>
                  </p>
                  {isLocalhost && (
                    <p className="text-[10px] leading-snug text-amber-300/90">
                      Catatan: NodeMCU tidak bisa memanggil <code>localhost</code>. Ganti menjadi IP
                      LAN PC Anda (misal <code>http://192.168.0.x:3000/api/iot/led-sync</code>)
                      atau URL Vercel saat mengisi Captive Portal.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tips AI Kreatif */}
      {tableReady && wledDevices.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl border border-violet-500/25 bg-violet-500/10 p-3 text-xs text-violet-100">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" aria-hidden="true" />
          <p className="leading-relaxed">
            <strong>Kontrol AI Kreatif:</strong> Coba chat atau bicara ke Asisten seperti{' '}
            <em>&quot;Ubah WLED jadi ungu redup&quot;</em>,{' '}
            <em>&quot;Aktifkan preset gaming&quot;</em>, atau{' '}
            <em>&quot;Aku lagi sedih nih&quot;</em> — AI akan merangkai warna, kecerahan, dan efek
            yang cocok secara otomatis.
          </p>
        </div>
      )}

      {/* Modal Tambah / Edit Unit WLED */}
      <ModalDialog
        open={deviceModalOpen}
        onClose={() => !savingDevice && setDeviceModalOpen(false)}
        title={editingDevice ? 'Ubah Unit WLED' : 'Tambah Unit WLED (WS2812)'}
      >
        <form onSubmit={handleSaveDevice} className="space-y-3">
          {deviceError && (
            <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {deviceError}
            </p>
          )}

          <div>
            <label htmlFor="wled-name" className="mb-1 block text-xs font-medium text-slate-300">
              Nama Unit WLED
            </label>
            <input
              id="wled-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: WLED Kamar A"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="wled-room" className="mb-1 block text-xs font-medium text-slate-300">
                Ruangan
              </label>
              <select
                id="wled-room"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Tanpa Ruangan</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="wled-count" className="mb-1 block text-xs font-medium text-slate-300">
                Jumlah Mata LED (1–300)
              </label>
              <input
                id="wled-count"
                type="number"
                min={1}
                max={300}
                required
                value={ledCount}
                onChange={(e) => setLedCount(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label htmlFor="wled-pin" className="mb-1 block text-xs font-medium text-slate-300">
              Pin Data WS2812 di NodeMCU
            </label>
            <select
              id="wled-pin"
              value={gpioPin}
              onChange={(e) => setGpioPin(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
            >
              {WLED_GPIO_OPTIONS.map((opt) => (
                <option key={opt.pin} value={opt.pin}>
                  {opt.label} — {opt.note}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="wled-aliases" className="mb-1 block text-xs font-medium text-slate-300">
              Alias / Panggilan Suara AI (opsional)
            </label>
            <input
              id="wled-aliases"
              type="text"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="Contoh: lampu rgb kamar, strip led, neon"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setDeviceModalOpen(false)}
              className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={savingDevice}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
            >
              {savingDevice && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {editingDevice ? 'Simpan Perubahan' : 'Simpan Unit WLED'}
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal Tambah / Edit Preset WLED */}
      <ModalDialog
        open={presetModalOpen}
        onClose={() => !savingPreset && setPresetModalOpen(false)}
        title={editingPreset ? 'Ubah Preset WLED' : 'Simpan Preset WLED'}
      >
        <form onSubmit={handleSavePreset} className="space-y-3">
          {presetError && (
            <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {presetError}
            </p>
          )}

          <div>
            <label htmlFor="wp-name" className="mb-1 block text-xs font-medium text-slate-300">
              Nama Preset
            </label>
            <input
              id="wp-name"
              type="text"
              required
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="Contoh: Gaming Neon / Sunset / Tidur"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="wp-keywords" className="mb-1 block text-xs font-medium text-slate-300">
              Kata Kunci Pemicu Suara AI (opsional)
            </label>
            <input
              id="wp-keywords"
              type="text"
              value={presetKeywords}
              onChange={(e) => setPresetKeywords(e.target.value)}
              placeholder="Contoh: main game, santai sore, mau tidur"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="wp-scope" className="mb-1 block text-xs font-medium text-slate-300">
              Berlaku Untuk
            </label>
            <select
              id="wp-scope"
              value={presetDeviceId}
              onChange={(e) => setPresetDeviceId(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
            >
              <option value="">Semua Unit WLED (Preset Global)</option>
              {wledDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  Hanya {d.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="wp-color" className="mb-1 block text-xs font-medium text-slate-300">
                Warna ({presetColorHex})
              </label>
              <input
                id="wp-color"
                type="color"
                value={presetColorHex}
                onChange={(e) => setPresetColorHex(sanitizeHexColor(e.target.value))}
                className="h-9 w-full cursor-pointer rounded-lg border border-slate-700 bg-slate-950 p-1"
              />
            </div>
            <div>
              <label htmlFor="wp-effect" className="mb-1 block text-xs font-medium text-slate-300">
                Efek Animasi
              </label>
              <select
                id="wp-effect"
                value={presetEffect}
                onChange={(e) => setPresetEffect(e.target.value as WledEffect)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              >
                {WLED_EFFECT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-slate-300">
                Kecerahan ({Math.round((presetBrightness / 255) * 100)}%)
              </label>
              <input
                type="range"
                min={1}
                max={255}
                value={presetBrightness}
                onChange={(e) => setPresetBrightness(Number(e.target.value))}
                className="w-full accent-emerald-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-300">
                Kecepatan ({Math.round((presetSpeed / 255) * 100)}%)
              </label>
              <input
                type="range"
                min={0}
                max={255}
                value={presetSpeed}
                onChange={(e) => setPresetSpeed(Number(e.target.value))}
                className="w-full accent-sky-400"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setPresetModalOpen(false)}
              className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={savingPreset}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
            >
              {savingPreset && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Simpan Preset
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal Konfirmasi Hapus Unit WLED */}
      <ModalDialog
        open={Boolean(deleteDeviceTarget)}
        onClose={() => !deletingDevice && setDeleteDeviceTarget(null)}
        title="Hapus Unit WLED?"
      >
        <p className="text-xs leading-relaxed text-slate-300">
          Unit WLED <strong>{deleteDeviceTarget?.name}</strong> beserta preset khusus miliknya akan
          dihapus. Sistem Relay NodeMCU Anda tidak akan terpengaruh.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setDeleteDeviceTarget(null)}
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={() => void handleDeleteDevice()}
            disabled={deletingDevice}
            className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
          >
            {deletingDevice && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Hapus WLED
          </button>
        </div>
      </ModalDialog>

      {/* Modal Konfirmasi Hapus Preset WLED */}
      <ModalDialog
        open={Boolean(deletePresetTarget)}
        onClose={() => !deletingPreset && setDeletePresetTarget(null)}
        title="Hapus Preset WLED?"
      >
        <p className="text-xs leading-relaxed text-slate-300">
          Preset <strong>{deletePresetTarget?.name}</strong> akan dihapus permanen.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setDeletePresetTarget(null)}
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={() => void handleDeletePreset()}
            disabled={deletingPreset}
            className="inline-flex items-center gap-1.5 rounded-lg bg-rose-500 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-400 disabled:opacity-60"
          >
            {deletingPreset && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Hapus Preset
          </button>
        </div>
      </ModalDialog>
    </section>
  );
}

