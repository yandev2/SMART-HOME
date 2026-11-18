'use client';

import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

export default function AuthForm() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'error' | 'success';
    text: string;
  } | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatusMessage(null);
    setLoading(true);

    try {
      const supabase = createClient();

      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) {
          setStatusMessage({ type: 'error', text: error.message });
          return;
        }
        window.location.assign('/dashboard');
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        if (error) {
          setStatusMessage({ type: 'error', text: error.message });
          return;
        }
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          setStatusMessage({
            type: 'error',
            text: 'Email ini sudah terdaftar. Silakan login melalui tab Masuk.',
          });
          setMode('login');
          return;
        }
        if (data.session) {
          window.location.assign('/dashboard');
        } else {
          setStatusMessage({
            type: 'success',
            text: 'Akun berhasil dibuat! Cek email kamu untuk konfirmasi, atau langsung login jika konfirmasi email dimatikan di Supabase.',
          });
          setMode('login');
        }
      }
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal menghubungi server autentikasi.',
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5 shadow-xl">
      <div className="mb-4 flex rounded-lg bg-slate-950 p-1">
        <button
          type="button"
          onClick={() => {
            setMode('login');
            setStatusMessage(null);
          }}
          className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${
            mode === 'login'
              ? 'bg-emerald-500 text-slate-950'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          Masuk
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('register');
            setStatusMessage(null);
          }}
          className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${
            mode === 'register'
              ? 'bg-emerald-500 text-slate-950'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          Daftar Akun
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3.5">
        <div className="flex flex-col gap-1">
          <label htmlFor="auth-email" className="text-xs font-medium text-slate-200">
            Email <span aria-hidden="true" className="text-rose-400">*</span>
          </label>
          <input
            id="auth-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="next"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="kamu@contoh.com"
            className="min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 placeholder:text-slate-500"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="auth-password" className="text-xs font-medium text-slate-200">
            Password <span aria-hidden="true" className="text-rose-400">*</span>
          </label>
          <div className="relative">
            <input
              id="auth-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              required
              minLength={6}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              enterKeyHint="done"
              aria-describedby="password-hint"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Minimal 6 karakter"
              className="min-h-[40px] w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-3 pr-10 text-slate-100 placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-pressed={showPassword}
              aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
              className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <span id="password-hint" className="text-[11px] text-slate-400">
            Minimal 6 karakter.
          </span>
        </div>

        {statusMessage && (
          <div
            role="status"
            aria-live="polite"
            className={`rounded-lg border px-3 py-2 text-xs ${
              statusMessage.type === 'error'
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            {statusMessage.text}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="inline-flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {mode === 'login' ? 'Masuk ke Smart Home' : 'Buat Akun Baru'}
        </button>
      </form>
    </div>
  );
}

