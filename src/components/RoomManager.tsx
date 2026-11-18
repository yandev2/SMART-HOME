'use client';

import { useState } from 'react';
import { DoorOpen, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { Device, Room } from '@/lib/types';
import ModalDialog from './ModalDialog';

interface RoomManagerProps {
  userId: string;
  rooms: Room[];
  devices: Device[];
  onChanged: () => Promise<void> | void;
}

export default function RoomManager({
  userId,
  rooms,
  devices,
  onChanged,
}: RoomManagerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [roomName, setRoomName] = useState('');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Room | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openAdd() {
    setEditingRoom(null);
    setRoomName('');
    setErrorMsg(null);
    setModalOpen(true);
  }

  function openEdit(room: Room) {
    setEditingRoom(room);
    setRoomName(room.name);
    setErrorMsg(null);
    setModalOpen(true);
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = roomName.trim();
    if (!trimmed) {
      setErrorMsg('Nama ruangan tidak boleh kosong.');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const supabase = createClient();
      if (editingRoom) {
        const { error } = await supabase
          .from('rooms')
          .update({ name: trimmed })
          .eq('id', editingRoom.id)
          .eq('user_id', userId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('rooms')
          .insert({ user_id: userId, name: trimmed });
        if (error) throw error;
      }
      setModalOpen(false);
      await onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan ruangan.');
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
        .from('rooms')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('user_id', userId);
      if (error) throw error;
      setDeleteTarget(null);
      await onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menghapus ruangan.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="rooms-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 id="rooms-heading" className="text-sm font-semibold text-white">
            Daftar Ruangan / Tempat
          </h2>
          <p className="text-xs text-slate-400">
            Ubah atau tambah nama ruangan kapan saja — asisten AI langsung mengenalinya.
          </p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Tambah Ruangan
        </button>
      </div>

      {rooms.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center">
          <DoorOpen className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
          <p className="mt-2.5 text-xs font-medium text-slate-300">
            Belum ada ruangan yang ditambahkan.
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Contoh: Ruang Tamu, Kamar Tidur, Teras Depan, atau Dapur.
          </p>
        </div>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.map((room) => {
            const count = devices.filter((d) => d.room_id === room.id).length;
            return (
              <div
                key={room.id}
                className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3.5 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[13px] font-medium text-white">{room.name}</h3>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {count} perangkat terpasang
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(room)}
                    aria-label={`Ubah nama ruangan ${room.name}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(room)}
                    aria-label={`Hapus ruangan ${room.name}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ModalDialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingRoom ? 'Ubah Nama Ruangan' : 'Tambah Ruangan Baru'}
      >
        <form onSubmit={handleSave} className="space-y-3.5">
          <div className="flex flex-col gap-1">
            <label htmlFor="room-name" className="text-xs font-medium text-slate-200">
              Nama Ruangan <span aria-hidden="true" className="text-rose-400">*</span>
            </label>
            <input
              id="room-name"
              name="room_name"
              type="text"
              required
              autoFocus
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Misal: Kamar Tidur Utama"
              className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 placeholder:text-slate-500"
            />
          </div>

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
              {editingRoom ? 'Simpan Perubahan' : 'Tambah Ruangan'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Hapus Ruangan?"
        maxWidthClass="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-300">
            Yakin ingin menghapus ruangan{' '}
            <strong className="text-white">{deleteTarget?.name}</strong>? Perangkat di
            dalamnya tidak ikut terhapus, hanya status ruangannya menjadi &quot;Tanpa
            Ruangan&quot;.
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

