import { NextResponse } from 'next/server';
import { hexToRgb, isValidWledEffect } from '@/lib/constants';
import { createAdminClient } from '@/lib/supabase/admin';

function parseOfflinePowerUpdate(rawBody: string): boolean | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { on?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.on === 'boolean') {
      return parsed.on;
    }
    return null;
  } catch {
    return null;
  }
}

async function handleLedSync(request: Request) {
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

    const offlineOn =
      request.method === 'POST' ? parseOfflinePowerUpdate(await request.text()) : null;

    const supabase = createAdminClient();

    const { data: wled, error: fetchError } = await supabase
      .from('wled_devices')
      .select(
        'id, name, gpio_pin, led_count, is_on, brightness, color_hex, effect, speed'
      )
      .eq('api_token', token)
      .maybeSingle();

    if (fetchError || !wled) {
      return NextResponse.json(
        { ok: false, error: 'Invalid WLED device token' },
        { status: 401 }
      );
    }

    const nextOn = offlineOn !== null ? offlineOn : Boolean(wled.is_on);

    const updatePayload: Record<string, unknown> = {
      last_seen: new Date().toISOString(),
    };
    if (offlineOn !== null && offlineOn !== wled.is_on) {
      updatePayload.is_on = offlineOn;
    }

    await supabase.from('wled_devices').update(updatePayload).eq('id', wled.id);

    const { r, g, b } = hexToRgb(wled.color_hex);
    const fx = isValidWledEffect(wled.effect) ? wled.effect : 'solid';

    // Payload ultra-kompak untuk RAM ESP8266 NodeMCU WS2812
    return NextResponse.json({
      ok: true,
      on: nextOn,
      bri: Math.min(255, Math.max(1, Math.round(Number(wled.brightness) || 180))),
      r,
      g,
      b,
      fx,
      spd: Math.min(255, Math.max(0, Math.round(Number(wled.speed) ?? 128))),
      n: Math.min(300, Math.max(1, Math.round(Number(wled.led_count) || 60))),
      pin: Math.round(Number(wled.gpio_pin) ?? 2),
    });
  } catch (err) {
    console.error('IoT LED Sync Error:', err);
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return handleLedSync(request);
}

export async function POST(request: Request) {
  return handleLedSync(request);
}

