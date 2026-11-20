'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import ModalDialog from './ModalDialog';

interface PublicKeyItem {
  id: string;
  label: string;
  maskedKey: string;
  addedAt: string;
  priority: number;
  isPrimary: boolean;
}

interface TokenQuotaItem {
  id: string;
  label: string;
  maskedKey: string;
  priority: number;
  isPrimary: boolean;
  isActiveNow: boolean;
  status: 'ready' | 'cooldown' | 'exhausted';
  cooldownRemainingSec: number;
  usedToday: number;
  remainingToday: number;
  limitToday: number;
  usedLastMinute: number;
  limitPerMinute: number;
  failoverCountToday: number;
  lastError: string | null;
}

interface ApiKeyManagerProps {
  assistantName: string;
  initialHasKey: boolean;
  initialMaskedKey: string | null;
  onStatusChanged: (hasKey: boolean, maskedKey: string | null) => void;
}

function notifyKeysUpdated() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('smart-home-keys-updated'));
  }
}

export default function ApiKeyManager({
  assistantName,
  initialHasKey,
  initialMaskedKey,
  onStatusChanged,
}: ApiKeyManagerProps) {
  const [hasKey, setHasKey] = useState(initialHasKey);
  const [maskedKey, setMaskedKey] = useState<string | null>(initialMaskedKey);
  const [keys, setKeys] = useState<PublicKeyItem[]>([]);
  const [tokenStats, setTokenStats] = useState<Record<string, TokenQuotaItem>>({});
  const [maxTokens, setMaxTokens] = useState(10);
  const [loadingList, setLoadingList] = useState(true);

  const [labelInput, setLabelInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [makePrimary, setMakePrimary] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PublicKeyItem | 'all' | null>(
    null
  );
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const loadKeysAndStats = useCallback(async () => {
    setLoadingList(true);
    try {
      const [keysRes, quotaRes] = await Promise.all([
        fetch('/api/settings/api-key', { cache: 'no-store' }),
        fetch('/api/settings/quota', { cache: 'no-store' }),
      ]);

      if (keysRes.ok) {
        const data = (await keysRes.json()) as {
          hasKey: boolean;
          maskedKey: string | null;
          maxTokens?: number;
          keys?: PublicKeyItem[];
        };
        const list = Array.isArray(data.keys) ? data.keys : [];
        setKeys(list);
        setHasKey(Boolean(data.hasKey));
        setMaskedKey(data.maskedKey ?? null);
        if (typeof data.maxTokens === 'number') {
          setMaxTokens(data.maxTokens);
        }
      }

      if (quotaRes.ok) {
        const qData = (await quotaRes.json()) as {
          tokens?: TokenQuotaItem[];
        };
        const map: Record<string, TokenQuotaItem> = {};
        for (const t of qData.tokens ?? []) {
          map[t.id] = t;
        }
        setTokenStats(map);
      }
    } catch {
      // Abaikan jika gagal memuat daftar
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadKeysAndStats();
  }, [loadKeysAndStats]);

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setFeedback({ type: 'error', text: 'API Key Gemini wajib diisi.' });
      return;
    }

    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch('/api/settings/api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: trimmed,
          label: labelInput.trim() || undefined,
          makePrimary,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Gagal menyimpan API Key.');
      }

      const list: PublicKeyItem[] = Array.isArray(data.keys) ? data.keys : [];
      setKeys(list);
      setHasKey(Boolean(data.hasKey));
      setMaskedKey(data.maskedKey ?? null);
      setApiKeyInput('');
      setLabelInput('');
      setMakePrimary(false);
      onStatusChanged(Boolean(data.hasKey), data.maskedKey ?? null);
      notifyKeysUpdated();
      void loadKeysAndStats();

      setFeedback({
        type: 'success',
        text: `Token berhasil diverifikasi & ditambahkan! Total ${list.length} token aktif di akun kamu.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan API Key.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSetPrimary(item: PublicKeyItem) {
    setActingId(item.id);
    setFeedback(null);
    try {
      const res = await fetch('/api/settings/api-key', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, action: 'set-primary' }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Gagal mengubah urutan token.');
      }
      const list: PublicKeyItem[] = Array.isArray(data.keys) ? data.keys : [];
      setKeys(list);
      setMaskedKey(data.maskedKey ?? null);
      onStatusChanged(Boolean(data.hasKey), data.maskedKey ?? null);
      notifyKeysUpdated();
      void loadKeysAndStats();
      setFeedback({
        type: 'success',
        text: `"${item.label}" kini menjadi Token Utama (#1).`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal mengubah prioritas token.',
      });
    } finally {
      setActingId(null);
    }
  }

  async function handleResetCooldown(item: PublicKeyItem) {
    setActingId(item.id);
    try {
      await fetch('/api/settings/api-key', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, action: 'reset-cooldown' }),
      });
      notifyKeysUpdated();
      await loadKeysAndStats();
    } finally {
      setActingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setFeedback(null);

    try {
      const query =
        deleteTarget === 'all'
          ? ''
          : `?id=${encodeURIComponent(deleteTarget.id)}`;
      const res = await fetch(`/api/settings/api-key${query}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Gagal menghapus token.');
      }

      const list: PublicKeyItem[] = Array.isArray(data.keys) ? data.keys : [];
      const nextHas = Boolean(data.hasKey);
      setKeys(list);
      setHasKey(nextHas);
      setMaskedKey(data.maskedKey ?? null);
      setDeleteTarget(null);
      onStatusChanged(nextHas, data.maskedKey ?? null);
      notifyKeysUpdated();
      void loadKeysAndStats();

      setFeedback({
        type: 'success',
        text:
          deleteTarget === 'all'
            ? 'Seluruh token berhasil dihapus dari akun kamu.'
            : `Token "${deleteTarget.label}" berhasil dihapus.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menghapus token.',
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="apikey-heading" className="space-y-3">
      <div>
        <h2 id="apikey-heading" className="text-sm font-semibold text-white">
          Multi-Token Gemini API &amp; Auto-Failover
        </h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Tambahkan beberapa token Gemini API sebagai cadangan. Jika Token #1 mencapai limit
          atau habis, sistem otomatis berpindah (*auto-switch*) ke Token #2, #3, dst. tanpa
          jeda. Semua token terenkripsi (AES-256-GCM) dan terisolasi khusus untuk akunmu.
        </p>
      </div>

      {/* Ringkasan Status Pool Token */}
      <div
        className={`rounded-xl border p-3.5 ${
          hasKey
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : 'border-amber-500/40 bg-amber-500/10'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            {hasKey ? (
              <Layers className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
            ) : (
              <KeyRound className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            )}
            <div>
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-xs font-semibold text-white">
                  {hasKey
                    ? `${keys.length || 1} Token Gemini Terdaftar`
                    : 'Gemini API Key Belum Diatur'}
                </p>
                {keys.length > 1 && (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
                    Auto-Failover Aktif ({keys.length * 1500} RPD)
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-300">
                {hasKey
                  ? `Terisolasi per akun (${maskedKey})`
                  : `Tambahkan minimal 1 API Key dari Google AI Studio agar Asisten ${assistantName} bisa merespons.`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadKeysAndStats()}
              disabled={loadingList}
              aria-label="Segarkan daftar token"
              className="inline-flex min-h-[30px] items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-900/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${loadingList ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>Refresh</span>
            </button>

            {keys.length > 1 && (
              <button
                type="button"
                onClick={() => setDeleteTarget('all')}
                className="inline-flex min-h-[30px] items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/20"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                <span>Hapus Semua</span>
              </button>
            )}
          </div>
        </div>

        {/* Daftar Kartu Token Berdasarkan Urutan Prioritas */}
        {keys.length > 0 && (
          <div className="mt-3 space-y-2 border-t border-slate-800/80 pt-3">
            {keys.map((item, idx) => {
              const stat = tokenStats[item.id];
              const isPrimary = idx === 0;
              const isActiveNow = stat ? stat.isActiveNow : isPrimary;
              const status = stat?.status ?? 'ready';
              const usedToday = stat?.usedToday ?? 0;
              const limitToday = stat?.limitToday ?? 1500;
              const usedLastMin = stat?.usedLastMinute ?? 0;

              return (
                <div
                  key={item.id}
                  className={`flex flex-wrap items-center justify-between gap-2.5 rounded-lg border p-2.5 transition ${
                    isActiveNow
                      ? 'border-emerald-500/50 bg-slate-950/90'
                      : 'border-slate-800 bg-slate-950/60'
                  }`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                          isPrimary
                            ? 'bg-emerald-500 text-slate-950'
                            : 'bg-slate-800 text-slate-300'
                        }`}
                      >
                        #{idx + 1} {isPrimary ? 'UTAMA' : 'CADANGAN'}
                      </span>

                      <span className="truncate text-xs font-semibold text-white">
                        {item.label}
                      </span>

                      {status === 'ready' ? (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            isActiveNow
                              ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30'
                              : 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/25'
                          }`}
                        >
                          <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" />
                          {isActiveNow ? 'Aktif Dipakai' : 'Siap Siaga'}
                        </span>
                      ) : status === 'cooldown' ? (
                        <span className="inline-flex items-center rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-amber-500/30">
                          Cooldown ({stat?.cooldownRemainingSec ?? 0}d)
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-medium text-rose-300 ring-1 ring-rose-500/30">
                          Kuota Hari Ini Habis
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                      <span className="font-mono text-slate-300">{item.maskedKey}</span>
                      <span>
                        Hari ini:{' '}
                        <strong className="text-slate-200">
                          {usedToday} / {limitToday.toLocaleString('id-ID')}
                        </strong>
                      </span>
                      <span>
                        1 mnt: <strong className="text-slate-200">{usedLastMin}/15</strong>
                      </span>
                      {stat && stat.failoverCountToday > 0 && (
                        <span className="text-amber-300">
                          Auto-switch: {stat.failoverCountToday}x
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {status === 'cooldown' && (
                      <button
                        type="button"
                        onClick={() => void handleResetCooldown(item)}
                        disabled={actingId === item.id}
                        title="Pulihkan status cooldown token ini"
                        className="inline-flex min-h-[28px] items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                      >
                        Pulihkan
                      </button>
                    )}

                    {!isPrimary && (
                      <button
                        type="button"
                        onClick={() => void handleSetPrimary(item)}
                        disabled={actingId === item.id}
                        title="Jadikan sebagai Token Utama (#1)"
                        className="inline-flex min-h-[28px] items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-medium text-slate-200 hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-50"
                      >
                        <ArrowUpCircle className="h-3 w-3" aria-hidden="true" />
                        <span>Utamakan</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setDeleteTarget(item)}
                      disabled={actingId === item.id}
                      aria-label={`Hapus ${item.label}`}
                      className="inline-flex min-h-[28px] items-center gap-1 rounded-md border border-rose-500/35 bg-rose-500/10 px-2 py-1 text-[10px] font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                      <span>Hapus</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Form Tambah Token Baru / Cadangan */}
      <form
        onSubmit={handleSave}
        className="space-y-3.5 rounded-xl border border-slate-800 bg-slate-900/70 p-4"
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-white">
            {hasKey
              ? `Tambah Token Cadangan Baru (${keys.length}/${maxTokens})`
              : 'Tambahkan Token Gemini Utama (#1)'}
          </span>
          {keys.length > 0 && (
            <span className="text-[10px] text-emerald-400">
              +1.500 RPD &amp; +15 RPM per token baru
            </span>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1 sm:col-span-1">
            <label htmlFor="gemini-key-label" className="text-xs font-medium text-slate-200">
              Label Token (Opsional)
            </label>
            <input
              id="gemini-key-label"
              name="gemini_key_label"
              type="text"
              maxLength={40}
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              placeholder={
                keys.length === 0 ? 'Token Utama #1' : `Cadangan #${keys.length + 1}`
              }
              className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500"
            />
          </div>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <label htmlFor="gemini-api-key" className="text-xs font-medium text-slate-200">
              Gemini API Key{' '}
              <span aria-hidden="true" className="text-rose-400">
                *
              </span>
            </label>
            <div className="relative">
              <input
                id="gemini-api-key"
                name="gemini_api_key"
                type={showInput ? 'text' : 'password'}
                required
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="apikey-help"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Tempel Gemini API Key dari Google AI Studio..."
                className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-3 pr-10 text-xs text-slate-100 placeholder:text-slate-500"
              />
              <button
                type="button"
                onClick={() => setShowInput((prev) => !prev)}
                aria-pressed={showInput}
                aria-label={showInput ? 'Sembunyikan API Key' : 'Tampilkan API Key'}
                className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                {showInput ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        </div>

        {keys.length > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={makePrimary}
              onChange={(e) => setMakePrimary(e.target.checked)}
              className="h-3.5 w-3.5 accent-emerald-500"
            />
            <span>Jadikan langsung sebagai Token Utama (#1)</span>
          </label>
        )}

        <p id="apikey-help" className="text-[11px] text-slate-400">
          Tips: Kamu bisa membuat API Key tambahan dari akun Google lain di{' '}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-emerald-400 underline hover:text-emerald-300"
          >
            Google AI Studio
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>{' '}
          untuk melipatgandakan kuota harian &amp; mencegah limit.
        </p>

        <div className="flex items-start gap-2 rounded-lg bg-slate-950/70 p-2.5 text-[11px] text-slate-400">
          <ShieldCheck
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400"
            aria-hidden="true"
          />
          <span>
            Isolasi &amp; Keamanan: Setiap token dienkripsi tersendiri dengan AES-256-GCM,
            dikunci pada <code>user_id</code> akunmu via Row Level Security (RLS), dan tidak
            pernah dibagikan ke user lain.
          </span>
        </div>

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

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving || keys.length >= maxTokens}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>
              {hasKey ? 'Tambah & Verifikasi Token Cadangan' : 'Simpan & Verifikasi Token'}
            </span>
          </button>
        </div>
      </form>

      <ModalDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title={
          deleteTarget === 'all'
            ? 'Hapus Semua Token Gemini?'
            : `Hapus ${deleteTarget?.label ?? 'Token'}?`
        }
        maxWidthClass="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-300">
            {deleteTarget === 'all'
              ? `Semua token Gemini di akunmu akan dihapus. Asisten ${assistantName} tidak akan bisa merespons sampai kamu menambahkan token baru.`
              : keys.length <= 1
                ? `Ini adalah satu-satunya token di akunmu. Jika dihapus, Asisten ${assistantName} tidak bisa merespons sampai kamu memasukkan token baru.`
                : `Token "${deleteTarget?.label}" (${deleteTarget?.maskedKey}) akan dihapus dari antrean failover akunmu. Token lainnya tetap aktif.`}
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
              onClick={() => void handleConfirmDelete()}
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
