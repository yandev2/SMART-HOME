'use client';

import { useMemo, useState } from 'react';
import {
  Database,
  Layers,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { computePresetTargets, executePresetActivation } from '@/lib/presets';
import { createClient } from '@/lib/supabase/client';
import type { Device, Preset, Room } from '@/lib/types';
import ModalDialog from './ModalDialog';

interface PresetManagerProps {
  userId: string;
  rooms: Room[];
  devices: Device[];
  presets: Preset[];
  tableReady: boolean;
  onChanged: () => Promise<void> | void;
}

export default function PresetManager({
  userId,
  rooms,
  devices,
  presets,
  tableReady,
  onChanged,
}: PresetManagerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Preset | null>(null);

  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [roomId, setRoomId] = useState('');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [turnOffOthers, setTurnOffOthers] = useState(true);
  const [showAllRoomsDevices, setShowAllRoomsDevices] = useState(false);

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [statusFeedback, setStatusFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Preset | null>(null);
  const [deleting, setDeleting] = useState(false);

  const roomMap = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  const deviceMap = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);

  function openAdd() {
    setEditing(null);
    setName('');
    setKeywords('');
    setRoomId(rooms[0]?.id ?? '');
    setSelectedDeviceIds([]);
    setTurnOffOthers(true);
    setShowAllRoomsDevices(false);
    setErrorMsg(null);
    setModalOpen(true);
  }

  function openEdit(preset: Preset) {
    setEditing(preset);
    setName(preset.name);
    setKeywords(preset.keywords ?? '');
    const targetRoom = preset.room_id ?? '';
    setRoomId(targetRoom);
    const validIds = (preset.device_ids ?? []).filter((id) => deviceMap.has(id));
    setSelectedDeviceIds(validIds);
    setTurnOffOthers(preset.turn_off_others);
    const hasForeignDevice = validIds.some((id) => {
      const dev = deviceMap.get(id);
      return dev && (dev.room_id ?? '') !== targetRoom;
    });
    setShowAllRoomsDevices(hasForeignDevice);
    setErrorMsg(null);
    setModalOpen(true);
  }

  function toggleDeviceId(id: string) {
    setSelectedDeviceIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  // Perangkat yang tampil di daftar checkbox berdasarkan pilihan ruangan
  const visibleDevices = useMemo(() => {
    if (showAllRoomsDevices || rooms.length === 0) {
      return devices;
    }
    return devices.filter((d) => (d.room_id ?? '') === roomId);
  }, [devices, rooms.length, roomId, showAllRoomsDevices]);

  // Pratinjau otomatis perangkat mana yang akan ON dan OFF saat preset dijalankan
  const previewTargets = useMemo(() => {
    return computePresetTargets(
      {
        room_id: roomId || null,
        device_ids: selectedDeviceIds,
        turn_off_others: turnOffOthers,
      },
      devices
    );
  }, [roomId, selectedDeviceIds, turnOffOthers, devices]);

  async function handleActivate(preset: Preset) {
    setActivatingId(preset.id);
    setStatusFeedback(null);
    try {
      const supabase = createClient();
      const outcome = await executePresetActivation({
        supabase,
        userId,
        preset,
        devices,
      });
      await onChanged();

      if (outcome.actions.length === 0) {
        setStatusFeedback({
          type: 'success',
          text: `"${preset.name}" memang sudah aktif — semua perangkat sudah pada posisinya.`,
        });
      } else {
        const parts: string[] = [];
        if (outcome.turnedOn.length > 0) {
          parts.push(`Nyala: ${outcome.turnedOn.map((d) => d.name).join(', ')}`);
        }
        if (outcome.turnedOff.length > 0) {
          parts.push(`Mati: ${outcome.turnedOff.map((d) => d.name).join(', ')}`);
        }
        setStatusFeedback({
          type: 'success',
          text: `"${preset.name}" diaktifkan (${parts.join(' • ')}).`,
        });
      }
    } catch (err) {
      setStatusFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal mengaktifkan preset.',
      });
    } finally {
      setActivatingId(null);
    }
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMsg('Nama mode / preset wajib diisi.');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const supabase = createClient();
      const payload = {
        user_id: userId,
        name: trimmedName,
        keywords: keywords.trim(),
        room_id: roomId || null,
        device_ids: selectedDeviceIds.filter((id) => deviceMap.has(id)),
        turn_off_others: turnOffOthers,
      };

      if (editing) {
        const { error } = await supabase
          .from('presets')
          .update(payload)
          .eq('id', editing.id)
          .eq('user_id', userId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('presets').insert(payload);
        if (error) throw error;
      }

      setModalOpen(false);
      await onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan preset.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('presets')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('user_id', userId);
      if (error) throw error;
      setDeleteTarget(null);
      await onChanged();
    } catch (err) {
      setStatusFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menghapus preset.',
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="presets-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 id="presets-heading" className="text-sm font-semibold text-white">
            Mode Kombinasi / Preset
          </h2>
          <p className="text-xs text-slate-400">
            Buat preset bebas sebanyak apa pun — nyalakan perangkat pilihan &amp; matikan
            sisanya di ruangan yang sama lewat suara atau 1 klik.
          </p>
        </div>

        <button
          type="button"
          onClick={openAdd}
          disabled={!tableReady}
          className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Buat Mode
        </button>
      </div>

      {!tableReady ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100"
        >
          <Database className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold text-amber-50">
              Tabel <code>public.presets</code> belum ada di Supabase
            </p>
            <p className="mt-0.5 text-[11px] text-amber-200/90">
              Jalankan SQL terbaru di <code>supabase/schema.sql</code> lewat{' '}
              <strong>Supabase → SQL Editor</strong> untuk mengaktifkan fitur Mode
              Kombinasi.
            </p>
          </div>
        </div>
      ) : presets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-4 text-center">
          <Layers className="mx-auto h-6 w-6 text-slate-600" aria-hidden="true" />
          <p className="mt-1.5 text-xs font-medium text-slate-300">
            Belum ada mode kombinasi.
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Contoh: &ldquo;Mode Gaming&rdquo; (Nyalakan Lampu RGB + AC, matikan lampu utama)
            lalu ucapkan &ldquo;waktunya nge game nih&rdquo;.
          </p>
        </div>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {presets.map((preset) => {
            const roomName = preset.room_id
              ? roomMap.get(preset.room_id) ?? 'Tanpa Ruangan'
              : 'Tanpa Ruangan';
            const { targetsOn, targetsOff } = computePresetTargets(preset, devices);
            const busy = activatingId === preset.id;

            return (
              <div
                key={preset.id}
                className="flex min-w-0 flex-col justify-between gap-2.5 rounded-xl border border-slate-800 bg-slate-900/70 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="break-words text-[13px] font-semibold text-white">
                        {preset.name}
                      </h3>
                      <span className="max-w-full truncate rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                        {roomName}
                      </span>
                    </div>

                    {preset.keywords && (
                      <p className="mt-1 truncate text-[10px] text-slate-400">
                        Pemicu: {preset.keywords}
                      </p>
                    )}

                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {targetsOn.length > 0 ? (
                        targetsOn.map((d) => (
                          <span
                            key={d.id}
                            className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300"
                          >
                            {d.name}: ON
                          </span>
                        ))
                      ) : (
                        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                          Semua perangkat mati
                        </span>
                      )}
                      {preset.turn_off_others && targetsOff.length > 0 && (
                        <span className="rounded-full bg-slate-800/90 px-2 py-0.5 text-[10px] text-slate-400">
                          +{targetsOff.length} lainnya OFF
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-slate-800/70 pt-2">
                  <button
                    type="button"
                    onClick={() => void handleActivate(preset)}
                    disabled={busy}
                    className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/35 transition hover:bg-emerald-500 hover:text-slate-950 disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Play className="h-3 w-3 fill-current" aria-hidden="true" />
                    )}
                    Aktifkan
                  </button>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(preset)}
                      aria-label={`Edit preset ${preset.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(preset)}
                      aria-label={`Hapus preset ${preset.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {statusFeedback && (
        <p
          role="status"
          aria-live="polite"
          className={`rounded-lg border px-3 py-2 text-xs ${
            statusFeedback.type === 'error'
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {statusFeedback.text}
        </p>
      )}

      <ModalDialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit Mode Kombinasi' : 'Buat Mode Kombinasi Baru'}
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleSave} className="space-y-3.5">
          <div className="flex flex-col gap-1">
            <label htmlFor="preset-name" className="text-xs font-medium text-slate-200">
              Nama Mode / Preset{' '}
              <span aria-hidden="true" className="text-rose-400">
                *
              </span>
            </label>
            <input
              id="preset-name"
              name="preset_name"
              type="text"
              required
              autoFocus
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Misal: Mode Gaming, Mode Tidur, Mode Nonton"
              className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 placeholder:text-slate-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="preset-keywords" className="text-xs font-medium text-slate-200">
              Kata Kunci Ucapan AI (opsional)
            </label>
            <input
              id="preset-keywords"
              name="preset_keywords"
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              aria-describedby="preset-keywords-help"
              placeholder="Misal: nge game, main game, mabar"
              className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 placeholder:text-slate-500"
            />
            <span id="preset-keywords-help" className="text-[11px] text-slate-400">
              Pisahkan dengan koma agar perintah santai seperti &ldquo;waktunya nge game
              nih&rdquo; langsung memicu preset ini.
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="preset-room" className="text-xs font-medium text-slate-200">
              Ruangan Target
            </label>
            <select
              id="preset-room"
              name="preset_room_id"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
            >
              <option value="">Tanpa Ruangan</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <legend className="text-xs font-medium text-slate-200">
                Perangkat yang Menyala (ON)
              </legend>
              {rooms.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllRoomsDevices((prev) => !prev)}
                  className="text-[11px] font-medium text-emerald-400 underline hover:text-emerald-300"
                >
                  {showAllRoomsDevices
                    ? 'Tampilkan ruangan ini saja'
                    : 'Tampilkan semua ruangan'}
                </button>
              )}
            </div>

            {visibleDevices.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
                Belum ada perangkat pada pilihan ruangan ini.
              </p>
            ) : (
              <div className="grid max-h-48 gap-1.5 overflow-y-auto overscroll-contain pr-1 sm:grid-cols-2">
                {visibleDevices.map((dev) => {
                  const checked = selectedDeviceIds.includes(dev.id);
                  const devRoom = dev.room_id
                    ? roomMap.get(dev.room_id) ?? 'Tanpa Ruangan'
                    : 'Tanpa Ruangan';
                  return (
                    <label
                      key={dev.id}
                      className={`flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-1.5 text-xs transition ${
                        checked
                          ? 'border-emerald-500/70 bg-emerald-500/15 text-emerald-100'
                          : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        name="preset_devices"
                        value={dev.id}
                        checked={checked}
                        onChange={() => toggleDeviceId(dev.id)}
                        className="h-4 w-4 shrink-0 accent-emerald-500"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{dev.name}</span>
                        {showAllRoomsDevices && (
                          <span className="block truncate text-[10px] text-slate-400">
                            {devRoom}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <label className="flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 text-xs text-slate-200">
            <input
              type="checkbox"
              name="turn_off_others"
              checked={turnOffOthers}
              onChange={(e) => setTurnOffOthers(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
            />
            <span>
              <strong className="font-medium text-white">
                Matikan perangkat lain di ruangan yang sama
              </strong>
              <span className="block text-[11px] text-slate-400">
                Perangkat di ruangan terpilih yang tidak dicentang di atas otomatis mati
                (perangkat ruangan lain tetap aman).
              </span>
            </span>
          </label>

          {/* Pratinjau efek preset */}
          <div className="space-y-1 rounded-lg border border-slate-800 bg-slate-950/80 p-2.5 text-[11px]">
            <p className="text-emerald-300">
              <strong>Akan NYALA:</strong>{' '}
              {previewTargets.targetsOn.length > 0
                ? previewTargets.targetsOn.map((d) => d.name).join(', ')
                : '(tidak ada)'}
            </p>
            <p className="text-slate-400">
              <strong>Akan MATI ({roomId ? roomMap.get(roomId) ?? 'Ruangan' : 'Tanpa Ruangan'}):</strong>{' '}
              {turnOffOthers
                ? previewTargets.targetsOff.length > 0
                  ? previewTargets.targetsOff.map((d) => d.name).join(', ')
                  : '(tidak ada perangkat lain di ruangan ini)'
                : '(dinonaktifkan — tidak mematikan perangkat lain)'}
            </p>
          </div>

          {errorMsg && (
            <p role="status" aria-live="polite" className="text-xs text-rose-400">
              {errorMsg}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="min-h-[36px] rounded-lg border border-slate-700 px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {editing ? 'Simpan Perubahan' : 'Simpan Mode'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Hapus Mode Kombinasi?"
        maxWidthClass="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-300">
            Yakin ingin menghapus mode{' '}
            <strong className="text-white">{deleteTarget?.name}</strong>? Perangkat di
            dalamnya tidak ikut terhapus.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setDeleteTarget(null)}
              className="min-h-[36px] rounded-lg border border-slate-700 px-3.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-60"
            >
              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Ya, Hapus
            </button>
          </div>
        </div>
      </ModalDialog>
    </section>
  );
}

