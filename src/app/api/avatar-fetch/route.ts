import dns from 'node:dns/promises';
import net from 'node:net';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

function isPrivateIp(ip: string): boolean {
  let clean = ip.trim().toLowerCase();
  if (clean.startsWith('::ffff:')) {
    clean = clean.slice(7);
  }

  const version = net.isIP(clean);
  if (version === 4) {
    const parts = clean.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (version === 6) {
    if (clean === '::1' || clean === '::') return true;
    if (clean.startsWith('fe80:') || clean.startsWith('fc') || clean.startsWith('fd')) {
      return true;
    }
    return false;
  }

  return true;
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Format URL gambar tidak valid.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('URL gambar harus menggunakan http:// atau https://.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('URL lokal atau privat tidak diizinkan.');
  }

  if (net.isIP(hostname) !== 0) {
    if (isPrivateIp(hostname)) {
      throw new Error('Alamat IP privat tidak diizinkan.');
    }
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true });
  if (!records || records.length === 0 || records.some((r) => isPrivateIp(r.address))) {
    throw new Error('Domain mengarah ke alamat jaringan yang tidak diizinkan.');
  }

  return parsed;
}

async function fetchImageFollowingSafeRedirects(initialUrl: string): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; hop < 3; hop++) {
    const validUrl = await assertPublicUrl(current);
    const res = await fetch(validUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8',
        'User-Agent': 'SmartHomeAI-AvatarFetcher/1.0',
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        throw new Error('Redirect gambar tidak memiliki tujuan.');
      }
      current = new URL(loc, validUrl).toString();
      continue;
    }

    return res;
  }

  throw new Error('Terlalu banyak redirect pada URL gambar.');
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as { url?: string } | null;
    const url = body?.url?.trim();
    if (!url) {
      return NextResponse.json({ error: 'URL gambar wajib diisi.' }, { status: 400 });
    }

    const upstream = await fetchImageFollowingSafeRedirects(url);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Gagal mengunduh gambar (HTTP ${upstream.status}).` },
        { status: 400 }
      );
    }

    const contentType = (upstream.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (!ALLOWED_MIME.has(contentType)) {
      return NextResponse.json(
        { error: 'URL harus berupa gambar PNG, JPG, WebP, atau GIF (SVG tidak diizinkan).' },
        { status: 400 }
      );
    }

    const contentLength = Number(upstream.headers.get('content-length') ?? '0');
    if (contentLength > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: 'Ukuran gambar maksimal 4 MB.' },
        { status: 400 }
      );
    }

    const arrayBuffer = await upstream.arrayBuffer();
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: 'Ukuran gambar tidak valid atau melebihi 4 MB.' },
        { status: 400 }
      );
    }

    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const normalizedMime = contentType === 'image/jpg' ? 'image/jpeg' : contentType;

    return NextResponse.json({
      dataUrl: `data:${normalizedMime};base64,${base64}`,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Gagal mengambil gambar dari URL.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

