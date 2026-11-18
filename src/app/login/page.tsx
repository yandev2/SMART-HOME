import { redirect } from 'next/navigation';
import AuthForm from '@/components/AuthForm';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const hasEnv =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  if (hasEnv) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      redirect('/dashboard');
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-2.5 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
            <span className="text-lg" aria-hidden="true">
              ⚡
            </span>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-white">
            Surya Home AI
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Asisten rumah pintar yang santai, ceria, dan siap kendalikan NodeMCU kamu.
          </p>
        </div>

        {!hasEnv ? (
          <div
            role="alert"
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-200"
          >
            <p className="font-semibold text-amber-100">
              Konfigurasi .env.local belum diisi
            </p>
            <p className="mt-1 text-amber-200/90">
              Salin file <code>.env.example</code> menjadi <code>.env.local</code>, lalu
              isi URL &amp; Key Supabase kamu.
            </p>
          </div>
        ) : (
          <AuthForm />
        )}
      </div>
    </main>
  );
}

