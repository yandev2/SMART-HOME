import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionLog, Device, Preset } from './types';

export type PresetTargetDevice = Pick<
  Device,
  'id' | 'name' | 'room_id' | 'controller_id' | 'is_on'
>;

export function computePresetTargets<T extends PresetTargetDevice>(
  preset: Pick<Preset, 'room_id' | 'device_ids' | 'turn_off_others'>,
  devices: T[]
): { targetsOn: T[]; targetsOff: T[] } {
  const onSet = new Set(Array.isArray(preset.device_ids) ? preset.device_ids : []);
  const targetsOn = devices.filter((d) => onSet.has(d.id));
  const targetsOff = preset.turn_off_others
    ? devices.filter((d) => !onSet.has(d.id) && d.room_id === preset.room_id)
    : [];

  return { targetsOn, targetsOff };
}

export interface PresetExecutionOutcome {
  turnedOn: PresetTargetDevice[];
  turnedOff: PresetTargetDevice[];
  alreadyOn: PresetTargetDevice[];
  alreadyOff: PresetTargetDevice[];
  actions: ActionLog[];
}

/**
 * Menjalankan aktivasi preset secara konsisten baik dari AI tool (`activate_preset`)
 * maupun dari tombol 1-klik di dashboard: hanya meng-update perangkat yang statusnya berbeda.
 */
export async function executePresetActivation(params: {
  supabase: SupabaseClient;
  userId: string;
  preset: Pick<Preset, 'room_id' | 'device_ids' | 'turn_off_others'>;
  devices: PresetTargetDevice[];
}): Promise<PresetExecutionOutcome> {
  const { supabase, userId, preset, devices } = params;
  const { targetsOn, targetsOff } = computePresetTargets(preset, devices);

  const toTurnOn = targetsOn.filter((d) => !d.is_on);
  const alreadyOn = targetsOn.filter((d) => d.is_on);
  const toTurnOff = targetsOff.filter((d) => d.is_on);
  const alreadyOff = targetsOff.filter((d) => !d.is_on);

  const [onRes, offRes] = await Promise.all([
    toTurnOn.length > 0
      ? supabase
          .from('devices')
          .update({ is_on: true })
          .eq('user_id', userId)
          .in(
            'id',
            toTurnOn.map((d) => d.id)
          )
          .select('id, name, room_id, controller_id, is_on')
      : Promise.resolve({ data: [] as PresetTargetDevice[], error: null }),
    toTurnOff.length > 0
      ? supabase
          .from('devices')
          .update({ is_on: false })
          .eq('user_id', userId)
          .in(
            'id',
            toTurnOff.map((d) => d.id)
          )
          .select('id, name, room_id, controller_id, is_on')
      : Promise.resolve({ data: [] as PresetTargetDevice[], error: null }),
  ]);

  if (onRes.error) {
    throw new Error(onRes.error.message || 'Gagal menyalakan perangkat pada preset.');
  }
  if (offRes.error) {
    throw new Error(offRes.error.message || 'Gagal mematikan perangkat lain pada preset.');
  }

  const turnedOn = (onRes.data ?? []) as PresetTargetDevice[];
  const turnedOff = (offRes.data ?? []) as PresetTargetDevice[];

  const actions: ActionLog[] = [
    ...turnedOn.map((d) => ({ device_id: d.id, device_name: d.name, is_on: true })),
    ...turnedOff.map((d) => ({ device_id: d.id, device_name: d.name, is_on: false })),
  ];

  return { turnedOn, turnedOff, alreadyOn, alreadyOff, actions };
}

