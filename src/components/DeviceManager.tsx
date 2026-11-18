'use client';

import { useEffect, useState } from 'react';
import { Lightbulb, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  NODEMCU_GPIO_OPTIONS,
  formatGpioLabel,
  isControllerOnline,
} from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';
import type { Controller, Device, Room } from '@/lib/types';
import ModalDialog from './ModalDialog';

interface DeviceManagerProps {
  userId: string;
  rooms: Room[];
  controllers: Controller[];
  devices: Device[];
  onChanged: () => Promise<void> | void;
}

export default function DeviceManager({
  userId,
  rooms,
  controllers,
  devices,
  onChanged,
}: DeviceManagerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);

  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [roomId, setRoomId] = useState('');
  const [controllerId, setControllerId] = useState('');
  const [gpioPin, setGpioPin] = useState<number>(5);
  const [activeLow, setActiveLow] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Feature-detect native <input type="checkbox" switch> dan load polyfill via ES module eksternal
  // agar tidak bentrok dengan Next.js Turbopack yang belum mendukung import.meta.resolve
  useEffect(() => {
    if (typeof window !== 'undefined' && !('switch' in HTMLInputElement.prototype)) {
      if (!document.querySelector('script[data-input-switch-polyfill]')) {
        const script = document.createElement('script');
        script.type = 'module';
        script.src =
          'https://unpkg.com/input-switch-polyfill@1.12.0/input-switch-polyfill.js';
        script.dataset.inputSwitchPolyfill = 'true';
        document.head.appendChild(script);
      }
    }
  }, []);

  const roomMap = new Map(rooms.map((r) => [r.id, r.name]));
  const controllerMap = new Map(controllers.map((c) => [c.id, c]));

  function openAdd() {
    setEditing(null);
    setName('');
    setAliases('');
    setRoomId(rooms[0]?.id ?? '');
    setControllerId(controllers[0]?.id ?? '');
    setGpioPin(5);
    setActiveLow(true);
    setErrorMsg(null);
    setModalOpen(true);
  }

  function openEdit(device: Device) {
    setEditing(device);
    setName(device.name);
    setAliases(device.aliases ?? '');
    setRoomId(device.room_id ?? '');
    setControllerId(device.controller_id ?? '');
    setGpioPin(device.gpio_pin);
    setActiveLow(device.active_low);
    setErrorMsg(null);
    setModalOpen(true);
  }

  async function handleToggle(device: Device, nextState: boolean) {
    setTogglingId(device.id);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('devices')
        .update({ is_on: nextState })
        .eq('id', device.id)
        .eq('user_id', userId);
      if (error) throw error;
      await onChanged();
    } finally {
      setTogglingId(null);
    }
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMsg('Nama perangkat wajib diisi.');
      return;
    }

    // Validasi agar 1 NodeMCU tidak bentrok memakai 2 pin GPIO yang sama
    if (controllerId) {
      const conflict = devices.find(
        (d) =>
          d.controller_id === controllerId &&
          d.gpio_pin === gpioPin &&
          d.id !== editing?.id
      );
      if (conflict) {
        setErrorMsg(
          `Pin ${formatGpioLabel(gpioPin)} pada NodeMCU tersebut sudah dipakai oleh "${conflict.name}". Pilih pin lain.`
        );
        return;
      }
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const supabase = createClient();
      const payload = {
        user_id: userId,
        name: trimmedName,
        aliases: aliases.trim(),
        room_id: roomId || null,
        controller_id: controllerId || null,
        gpio_pin: gpioPin,
        active_low: activeLow,
      };

      if (editing) {
        const { error } = await supabase
          .from('devices')
          .update(payload)
          .eq('id', editing.id)
          .eq('user_id', userId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('devices').insert({
          ...payload,
          is_on: false,
        });
        if (error) throw error;
      }

      setModalOpen(false);
      await onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan perangkat.');
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
        .from('devices')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('user_id', userId);
      if (error) throw error;
      setDeleteTarget(null);
      await onChanged();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="devices-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 id="devices-heading" className="text-sm font-semibold text-white">
            Kontrol Perangkat
          </h2>
          <p className="text-xs text-slate-400">
            Atur perangkat, pin relay NodeMCU, dan ruangan sesuai rumahmu.
          </p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Tambah Perangkat
        </button>
      </div>

      {devices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center">
          <Lightbulb className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
          <p className="mt-2.5 text-xs font-medium text-slate-300">
            Belum ada perangkat smart home.
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Klik &quot;Tambah Perangkat&quot; untuk menambahkan lampu, kipas, atau saklar.
          </p>
        </div>
      ) : (
        <div className="grid gap-2.5">
          {devices.map((device) => {
            const roomName = device.room_id
              ? roomMap.get(device.room_id) ?? 'Tanpa Ruangan'
              : 'Tanpa Ruangan';
            const ctrl = device.controller_id
              ? controllerMap.get(device.controller_id)
              : undefined;
            const online = ctrl ? isControllerOnline(ctrl.last_seen) : false;
            const switchId = `switch-${device.id}`;

            return (
              <div
                key={device.id}
                className={`min-w-0 rounded-xl border p-3 transition sm:px-3.5 sm:py-2.5 ${
                  device.is_on
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : 'border-slate-800 bg-slate-900/70'
                }`}
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                    <label
                      htmlFor={switchId}
                      className="cursor-pointer break-words text-[13px] font-semibold text-white"
                    >
                      {device.name}
                    </label>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                        device.is_on
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {device.is_on ? 'NYALA' : 'MATI'}
                    </span>
                  </div>

                  <div className="shrink-0 pt-0.5">
                    <input
                      id={switchId}
                      type="checkbox"
                      checked={device.is_on}
                      disabled={togglingId === device.id}
                      aria-label={`Toggle ${device.name}`}
                      onChange={(e) => handleToggle(device, e.target.checked)}
                      {...({ switch: '' } as Record<string, string>)}
                    />
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/70 pt-2">
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                    <span className="max-w-full truncate rounded bg-slate-800/90 px-1.5 py-0.5 text-slate-300">
                      {roomName}
                    </span>
                    {ctrl ? (
                      <span
                        className={`inline-flex max-w-full flex-wrap items-center gap-1 rounded px-1.5 py-0.5 break-words ${
                          online
                            ? 'bg-emerald-500/10 text-emerald-300'
                            : 'bg-amber-500/10 text-amber-300'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            online ? 'bg-emerald-400' : 'bg-amber-400'
                          }`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 break-words">
                          {ctrl.name} • {formatGpioLabel(device.gpio_pin)} (
                          {online ? 'Online' : 'Offline'})
                        </span>
                      </span>
                    ) : (
                      <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-slate-400">
                        Mode Simulasi
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(device)}
                      aria-label={`Edit perangkat ${device.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(device)}
                      aria-label={`Hapus perangkat ${device.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                {device.aliases && (
                  <p className="mt-1.5 truncate text-[10px] text-slate-500">
                    Alias AI: {device.aliases}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ModalDialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit Perangkat' : 'Tambah Perangkat Baru'}
      >
        <form onSubmit={handleSave} className="space-y-3.5">
          <div className="flex flex-col gap-1">
            <label htmlFor="dev-name" className="text-xs font-medium text-slate-200">
              Nama Perangkat <span aria-hidden="true" className="text-rose-400">*</span>
            </label>
            <input
              id="dev-name"
              name="device_name"
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Misal: Lampu Teras"
              className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 placeholder:text-slate-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="dev-aliases" className="text-xs font-medium text-slate-200">
              Nama Panggilan / Alias (opsional)
            </label>
            <input
              id="dev-aliases"
              name="aliases"
              type="text"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              aria-describedby="aliases-help"
              placeholder="Misal: lampu depan, lampu luar"
              className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 placeholder:text-slate-500"
            />
            <span id="aliases-help" className="text-[11px] text-slate-400">
              Pisahkan dengan koma agar AI mengenali sebutan santai kamu.
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="dev-room" className="text-xs font-medium text-slate-200">
                Ruangan / Tempat
              </label>
              <select
                id="dev-room"
                name="room_id"
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

            <div className="flex flex-col gap-1">
              <label htmlFor="dev-ctrl" className="text-xs font-medium text-slate-200">
                Unit NodeMCU
              </label>
              <select
                id="dev-ctrl"
                name="controller_id"
                value={controllerId}
                onChange={(e) => setControllerId(e.target.value)}
                className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              >
                <option value="">Mode Simulasi (Belum ada alat)</option>
                {controllers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {controllerId && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label htmlFor="dev-gpio" className="text-xs font-medium text-slate-200">
                  Pin GPIO NodeMCU
                </label>
                <select
                  id="dev-gpio"
                  name="gpio_pin"
                  value={gpioPin}
                  onChange={(e) => setGpioPin(Number(e.target.value))}
                  className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                >
                  {NODEMCU_GPIO_OPTIONS.map((opt) => (
                    <option key={opt.pin} value={opt.pin}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col justify-end gap-1 pb-1">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-200">
                  <input
                    type="checkbox"
                    checked={activeLow}
                    onChange={(e) => setActiveLow(e.target.checked)}
                    className="h-4 w-4 accent-emerald-500"
                  />
                  Relay Active LOW (umum)
                </label>
                <span className="text-[11px] text-slate-400">
                  Centang jika relay menyala saat pin bernilai LOW.
                </span>
              </div>
            </div>
          )}

          {errorMsg && (
            <p role="status" className="text-xs text-rose-400">
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
              {editing ? 'Simpan Perubahan' : 'Tambah Perangkat'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Hapus Perangkat?"
        maxWidthClass="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-300">
            Yakin ingin menghapus perangkat{' '}
            <strong className="text-white">{deleteTarget?.name}</strong>?
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

