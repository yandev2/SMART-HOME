'use client';

import { useState } from 'react';
import { Check, Copy, Cpu, Loader2, Pencil, Plus, Trash2, Wifi, WifiOff } from 'lucide-react';
import { isControllerOnline } from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';
import type { Controller, Device } from '@/lib/types';
import ModalDialog from './ModalDialog';

interface ControllerManagerProps {
  userId: string;
  controllers: Controller[];
  devices: Device[];
  onChanged: () => Promise<void> | void;
}

export default function ControllerManager({
  userId,
  controllers,
  devices,
  onChanged,
}: ControllerManagerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Controller | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Controller | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openAdd() {
    setEditing(null);
    setName('');
    setErrorMsg(null);
    setModalOpen(true);
  }

  function openEdit(ctrl: Controller) {
    setEditing(ctrl);
    setName(ctrl.name);
    setErrorMsg(null);
    setModalOpen(true);
  }

  async function handleCopyToken(ctrl: Controller) {
    try {
      await navigator.clipboard.writeText(ctrl.api_token);
      setCopiedId(ctrl.id);
      setTimeout(() => setCopiedId((prev) => (prev === ctrl.id ? null : prev)), 2500);
    } catch {
      // Fallback jika clipboard API diblokir
    }
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setErrorMsg('Nama NodeMCU tidak boleh kosong.');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const supabase = createClient();
      if (editing) {
        const { error } = await supabase
          .from('controllers')
          .update({ name: trimmed })
          .eq('id', editing.id)
          .eq('user_id', userId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('controllers')
          .insert({ user_id: userId, name: trimmed });
        if (error) throw error;
      }
      setModalOpen(false);
      await onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan NodeMCU.');
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
        .from('controllers')
        .delete()
        .eq('id', deleteTarget.id)
        .eq('user_id', userId);
      if (error) throw error;
      setDeleteTarget(null);
      await onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menghapus NodeMCU.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="controllers-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 id="controllers-heading" className="text-sm font-semibold text-white">
            Unit NodeMCU (ESP8266)
          </h2>
          <p className="text-xs text-slate-400">
            1 NodeMCU bisa mengontrol 1 relay maupun banyak relay sekaligus. Salin token ke
            sketch <code>.ino</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Tambah NodeMCU
        </button>
      </div>

      {controllers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center">
          <Cpu className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
          <p className="mt-2.5 text-xs font-medium text-slate-300">
            Belum ada NodeMCU terdaftar.
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            Kamu tetap bisa mengetes chat AI &amp; perangkat dalam mode simulasi, lalu
            menambahkan NodeMCU kapan saja.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {controllers.map((ctrl) => {
            const online = isControllerOnline(ctrl.last_seen);
            const linkedCount = devices.filter((d) => d.controller_id === ctrl.id).length;
            const isCopied = copiedId === ctrl.id;

            return (
              <div
                key={ctrl.id}
                className="flex min-w-0 flex-col justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="truncate text-[13px] font-semibold text-white">
                        {ctrl.name}
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
                    <p className="mt-1 text-[11px] text-slate-400">
                      {linkedCount} pin/perangkat terhubung •{' '}
                      {ctrl.last_seen
                        ? `Terakhir aktif: ${new Date(ctrl.last_seen).toLocaleString('id-ID')}`
                        : 'Belum pernah tersambung'}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(ctrl)}
                      aria-label={`Ubah nama NodeMCU ${ctrl.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(ctrl)}
                      aria-label={`Hapus NodeMCU ${ctrl.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-rose-500/15 hover:text-rose-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <span className="block text-[10px] uppercase tracking-wider text-slate-500">
                      Device Token
                    </span>
                    <code className="block truncate text-[11px] text-emerald-300">
                      {ctrl.api_token}
                    </code>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyToken(ctrl)}
                    className="inline-flex min-h-[30px] shrink-0 items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-800"
                  >
                    {isCopied ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />
                        Tersalin
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" aria-hidden="true" />
                        Salin
                      </>
                    )}
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
        title={editing ? 'Ubah Nama NodeMCU' : 'Daftarkan NodeMCU Baru'}
      >
        <form onSubmit={handleSave} className="space-y-3.5">
          <div className="flex flex-col gap-1">
            <label htmlFor="ctrl-name" className="text-xs font-medium text-slate-200">
              Nama Unit NodeMCU <span aria-hidden="true" className="text-rose-400">*</span>
            </label>
            <input
              id="ctrl-name"
              name="controller_name"
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Misal: NodeMCU Ruang Tamu (4-Channel)"
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
              {editing ? 'Simpan' : 'Buat & Generate Token'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Hapus NodeMCU?"
        maxWidthClass="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-300">
            Hapus unit <strong className="text-white">{deleteTarget?.name}</strong>? Token
            pada NodeMCU ini tidak akan berlaku lagi dan perangkat yang tertaut akan
            beralih ke Mode Simulasi.
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

