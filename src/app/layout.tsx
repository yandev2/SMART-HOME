import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Surya Home — Asisten Smart Home AI',
  description:
    'Asisten Smart Home AI yang santai, ceria, dan terintegrasi dengan Gemini API, Supabase, serta NodeMCU ESP8266.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}

