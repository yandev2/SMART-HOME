'use client';

import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { ASSISTANT_STYLE_OPTIONS } from '@/lib/constants';
import type { AssistantGender, AssistantProfile } from '@/lib/types';

interface AssistantSettingsFormProps {
  initialProfile: AssistantProfile;
  onProfileChanged: (profile: AssistantProfile) => void;
}

export default function AssistantSettingsForm({
  initialProfile,
  onProfileChanged,
}: AssistantSettingsFormProps) {
  const [name, setName] = useState(initialProfile.name);
  const [gender, setGender] = useState<AssistantGender>(initialProfile.gender);
  const [styles, setStyles] = useState<string[]>(initialProfile.styles);
  const [description, setDescription] = useState(initialProfile.description);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  function toggleStyle(styleId: string) {
    setStyles((prev) =>
      prev.includes(styleId)
        ? prev.filter((item) => item !== styleId)
        : [...prev, styleId]
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFeedback({ type: 'error', text: 'Nama asisten tidak boleh kosong.' });
      return;
    }
    if (styles.length === 0) {
      setFeedback({ type: 'error', text: 'Pilih minimal 1 gaya bicara asisten.' });
      return;
    }

    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch('/api/settings/assistant', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          gender,
          styles,
          description: description.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Gagal menyimpan profil asisten.');
      }

      onProfileChanged(data.profile);
      setFeedback({
        type: 'success',
        text: `Profil asisten "${data.profile.name}" berhasil disimpan! Langsung berlaku di obrolan berikutnya.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menyimpan profil asisten.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="assistant-profile-heading" className="space-y-3">
      <div>
        <h2 id="assistant-profile-heading" className="text-sm font-semibold text-white">
          Kepribadian &amp; Identitas Asisten
        </h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Atur nama, gender, gaya bicara, dan deskripsi respons asisten sesuai selera kamu.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-3.5 rounded-xl border border-slate-800 bg-slate-900/70 p-4"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="assistant-name" className="text-xs font-medium text-slate-200">
            Nama Asisten <span aria-hidden="true" className="text-rose-400">*</span>
          </label>
          <input
            id="assistant-name"
            name="assistant_name"
            type="text"
            required
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Misal: Surya, Luna, Jarvis, atau X"
            className="min-h-[38px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 placeholder:text-slate-500"
          />
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-slate-200">
            Gender Asisten <span aria-hidden="true" className="text-rose-400">*</span>
          </legend>
          <div className="grid grid-cols-2 gap-2">
            <label
              className={`flex min-h-[38px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                gender === 'laki-laki'
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200'
                  : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
              }`}
            >
              <input
                type="radio"
                name="assistant_gender"
                value="laki-laki"
                checked={gender === 'laki-laki'}
                onChange={() => setGender('laki-laki')}
                className="h-3.5 w-3.5 accent-emerald-500"
              />
              Laki-laki
            </label>

            <label
              className={`flex min-h-[38px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                gender === 'perempuan'
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200'
                  : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
              }`}
            >
              <input
                type="radio"
                name="assistant_gender"
                value="perempuan"
                checked={gender === 'perempuan'}
                onChange={() => setGender('perempuan')}
                className="h-3.5 w-3.5 accent-emerald-500"
              />
              Perempuan
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-slate-200">
            Gaya Bicara (bisa pilih banyak){' '}
            <span aria-hidden="true" className="text-rose-400">*</span>
          </legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {ASSISTANT_STYLE_OPTIONS.map((opt) => {
              const checked = styles.includes(opt.id);
              return (
                <label
                  key={opt.id}
                  className={`flex min-h-[34px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                    checked
                      ? 'border-emerald-500/70 bg-emerald-500/15 text-emerald-200'
                      : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    name="assistant_styles"
                    value={opt.id}
                    checked={checked}
                    onChange={() => toggleStyle(opt.id)}
                    className="h-3.5 w-3.5 accent-emerald-500"
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1">
          <label htmlFor="assistant-desc" className="text-xs font-medium text-slate-200">
            Deskripsi Gaya Respons (Opsional)
          </label>
          <textarea
            id="assistant-desc"
            name="assistant_description"
            rows={2}
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-describedby="assistant-desc-help"
            placeholder="Contoh: Panggil aku Bos, balas selalu pakai emoji..."
            className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-[13px] text-slate-100 placeholder:text-slate-500"
          />
          <span id="assistant-desc-help" className="text-[11px] text-slate-400">
            Opsional ({description.length}/500 karakter). Kosongkan jika cukup pakai pilihan
            gaya bicara di atas.
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
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Simpan Karakter Asisten
          </button>
        </div>
      </form>
    </section>
  );
}

