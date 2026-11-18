'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import ModalDialog from './ModalDialog';

interface ApiKeyManagerProps {
  assistantName: string;
  initialHasKey: boolean;
  initialMaskedKey: string | null;
  onStatusChanged: (hasKey: boolean, maskedKey: string | null) => void;
}

export default function ApiKeyManager({
  assistantName,
  initialHasKey,
  initialMaskedKey,
  onStatusChanged,
}: ApiKeyManagerProps) {
  const [hasKey, setHasKey] = useState(initialHasKey);
  const [maskedKey, setMaskedKey] = useState<string | null>(initialMaskedKey);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

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
        body: JSON.stringify({ apiKey: trimmed }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Gagal menyimpan API Key.');
      }

      setHasKey(true);
      setMaskedKey(data.maskedKey);
      setApiKeyInput('');
      onStatusChanged(true, data.maskedKey);
      setFeedback({
        type: 'success',
        text: 'API Key berhasil diverifikasi, dienkripsi, dan disimpan ke database!',
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

  async function handleDelete() {
    setDeleting(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/settings/api-key', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Gagal menghapus API Key.');
      }
      setHasKey(false);
      setMaskedKey(null);
      setDeleteOpen(false);
      onStatusChanged(false, null);
      setFeedback({
        type: 'success',
        text: 'API Key berhasil dihapus dari akun kamu.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menghapus API Key.',
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="apikey-heading" className="space-y-3">
      <div>
        <h2 id="apikey-heading" className="text-sm font-semibold text-white">
          Pengaturan Gemini API Key
        </h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Setiap user menggunakan Gemini API Key masing-masing. Key kamu dienkripsi di
          server (AES-256-GCM) sebelum disimpan ke Supabase dan tidak pernah dikirim ulang ke
          browser.
        </p>
      </div>

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
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
            ) : (
              <KeyRound className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            )}
            <div>
              <p className="text-xs font-semibold text-white">
                {hasKey ? 'Gemini API Key Aktif' : 'Gemini API Key Belum Diatur'}
              </p>
              <p className="text-[11px] text-slate-300">
                {hasKey
                  ? `Tersimpan terenkripsi (${maskedKey})`
                  : `Tambahkan API Key dari Google AI Studio agar Asisten ${assistantName} bisa merespons.`}
              </p>
            </div>
          </div>

          {hasKey && (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/20"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Hapus Key
            </button>
          )}
        </div>
      </div>

      <form
        onSubmit={handleSave}
        className="space-y-3.5 rounded-xl border border-slate-800 bg-slate-900/70 p-4"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="gemini-api-key" className="text-xs font-medium text-slate-200">
            {hasKey ? 'Ganti Gemini API Key' : 'Masukkan Gemini API Key'}{' '}
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
              placeholder="Tempel Gemini API Key kamu di sini..."
              className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-3 pr-10 text-slate-100 placeholder:text-slate-500"
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
          <p id="apikey-help" className="text-[11px] text-slate-400">
            Belum punya API Key? Buat gratis di{' '}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-emerald-400 underline hover:text-emerald-300"
            >
              Google AI Studio
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
            . Key akan otomatis diuji sebelum disimpan.
          </p>
        </div>

        <div className="flex items-start gap-2 rounded-lg bg-slate-950/70 p-2.5 text-[11px] text-slate-400">
          <ShieldCheck
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400"
            aria-hidden="true"
          />
          <span>
            Keamanan: API Key hanya didekripsi di server saat memproses chat kamu dan
            dilindungi Row Level Security (RLS) Supabase per akun.
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
            disabled={saving}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Simpan &amp; Verifikasi Key
          </button>
        </div>
      </form>

      <ModalDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Hapus Gemini API Key?"
        maxWidthClass="max-w-sm"
      >
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-300">
            Asisten chat tidak akan bisa merespons sampai kamu memasukkan API Key Gemini baru.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setDeleteOpen(false)}
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

