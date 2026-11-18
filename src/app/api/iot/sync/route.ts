import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

async function handleSync(request: Request) {
  try {
    const url = new URL(request.url);
    const token =
      request.headers.get('x-device-token')?.trim() ||
      url.searchParams.get('token')?.trim();

    if (!token) {
      return NextResponse.json(
        { ok: false, error: 'Missing x-device-token header' },
        { status: 401 }
      );
    }

    const supabase = createAdminClient();

    // Cari controller berdasarkan token unik
    const { data: controller, error: ctrlError } = await supabase
      .from('controllers')
      .select('id, name')
      .eq('api_token', token)
      .maybeSingle();

    if (ctrlError || !controller) {
      return NextResponse.json(
        { ok: false, error: 'Invalid device token' },
        { status: 401 }
      );
    }

    // Perbarui last_seen dan ambil daftar pin relay untuk controller ini
    const [, { data: devices, error: devError }] = await Promise.all([
      supabase
        .from('controllers')
        .update({ last_seen: new Date().toISOString() })
        .eq('id', controller.id),
      supabase
        .from('devices')
        .select('gpio_pin, is_on, active_low')
        .eq('controller_id', controller.id)
        .order('gpio_pin', { ascending: true }),
    ]);

    if (devError) {
      return NextResponse.json(
        { ok: false, error: 'Failed to load devices' },
        { status: 500 }
      );
    }

    // Payload dibuat sekompak mungkin untuk hemat RAM NodeMCU ESP8266
    return NextResponse.json({
      ok: true,
      pins: (devices ?? []).map((d) => ({
        pin: d.gpio_pin,
        on: d.is_on,
        al: d.active_low,
      })),
    });
  } catch (err) {
    console.error('IoT Sync Error:', err);
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return handleSync(request);
}

export async function POST(request: Request) {
  return handleSync(request);
}

