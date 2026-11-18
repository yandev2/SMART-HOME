import {
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  GoogleGenAI,
  type Part,
  ThinkingLevel,
  Type,
} from '@google/genai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatGpioLabel, isControllerOnline } from './constants';
import type {
  ActionLog,
  AssistantProfile,
  ChatMessage,
  Controller,
  Device,
  Room,
} from './types';

// generateContentStream + gemini-3.5-flash-lite + ThinkingLevel.MINIMAL (~600ms TTFT)
const MODEL_ID = 'gemini-3.5-flash-lite';
const MAX_TOOL_ROUNDS = 4;

export type SafeController = Pick<Controller, 'id' | 'user_id' | 'name' | 'last_seen' | 'created_at'>;

function buildHomeSnapshot(
  rooms: Room[],
  controllers: SafeController[],
  devices: Device[]
) {
  const roomMap = new Map(rooms.map((r) => [r.id, r.name]));
  const controllerMap = new Map(controllers.map((c) => [c.id, c]));

  const roomSummaries = rooms.map((r) => {
    const inRoom = devices.filter((d) => d.room_id === r.id);
    const onCount = inRoom.filter((d) => d.is_on).length;
    return {
      id: r.id,
      name: r.name,
      device_count: inRoom.length,
      devices_on: onCount,
      devices_off: inRoom.length - onCount,
      device_names: inRoom.map((d) => d.name),
    };
  });

  const controllerSummaries = controllers.map((c) => {
    const linked = devices.filter((d) => d.controller_id === c.id);
    return {
      id: c.id,
      name: c.name,
      online: isControllerOnline(c.last_seen),
      last_seen: c.last_seen,
      device_count: linked.length,
    };
  });

  const unassignedCount = devices.filter((d) => !d.room_id).length;
  const devicesOn = devices.filter((d) => d.is_on).length;

  return {
    roomMap,
    controllerMap,
    summary: {
      total_rooms: rooms.length,
      total_controllers: controllers.length,
      total_devices: devices.length,
      devices_on: devicesOn,
      devices_off: devices.length - devicesOn,
      unassigned_devices_count: unassignedCount,
    },
    roomSummaries,
    controllerSummaries,
  };
}

function buildSystemInstruction(
  profile: AssistantProfile,
  rooms: Room[],
  controllers: SafeController[],
  devices: Device[]
): string {
  const { roomMap, controllerMap, summary, roomSummaries, controllerSummaries } =
    buildHomeSnapshot(rooms, controllers, devices);

  const roomListText =
    roomSummaries.length === 0
      ? '- (Belum ada ruangan)'
      : roomSummaries
          .map(
            (r) =>
              `- [room_id: ${r.id}] "${r.name}" (${r.device_count} perangkat: ${r.devices_on} ON, ${r.devices_off} OFF${r.device_names.length > 0 ? ` -> ${r.device_names.join(', ')}` : ''})`
          )
          .join('\n');

  const controllerListText =
    controllerSummaries.length === 0
      ? '- (Belum ada NodeMCU terdaftar)'
      : controllerSummaries
          .map(
            (c) =>
              `- [controller_id: ${c.id}] "${c.name}" | Koneksi: ${c.online ? 'Online' : 'Offline'} | Terakhir aktif: ${c.last_seen ? new Date(c.last_seen).toLocaleString('id-ID') : 'Belum pernah'} | Terhubung ${c.device_count} perangkat`
          )
          .join('\n');

  const deviceListText =
    devices.length === 0
      ? '- (Belum ada perangkat)'
      : devices
          .map((d) => {
            const roomName = d.room_id ? roomMap.get(d.room_id) ?? 'Tanpa Ruangan' : 'Tanpa Ruangan';
            const ctrl = d.controller_id ? controllerMap.get(d.controller_id) : undefined;
            const ctrlStatus = ctrl
              ? `${ctrl.name} (${isControllerOnline(ctrl.last_seen) ? 'Online' : 'Offline'})`
              : 'Mode Simulasi';
            const aliasInfo = d.aliases.trim() ? `, Alias: "${d.aliases.trim()}"` : '';
            return `- [device_id: ${d.id}] "${d.name}"${aliasInfo} | Ruang: "${roomName}" | Pin: ${formatGpioLabel(d.gpio_pin)} | Status: ${d.is_on ? 'ON' : 'OFF'} | HW: ${ctrlStatus}`;
          })
          .join('\n');

  const genderText =
    profile.gender === 'perempuan'
      ? 'Perempuan (gunakan gaya sapaan dan ekspresi khas asisten perempuan yang natural)'
      : 'Laki-laki (gunakan gaya sapaan dan ekspresi khas asisten laki-laki yang natural)';

  const stylesText =
    profile.styles.length > 0 ? profile.styles.join(', ') : 'santai, ceria';

  const customDescBlock = profile.description.trim()
    ? `\nPREFERENSI RESPONS KHUSUS DARI USER:\n${profile.description.trim()}\n`
    : '';

  return `Kamu adalah "${profile.name}", asisten Smart Home AI pribadi milik user yang sedang login.
- Gender: ${genderText}.
- Gaya bicara: ${stylesText} (gunakan bahasa Indonesia yang natural; ringkas 2-4 kalimat saat ngobrol/kontrol, atau tampilkan daftar rapi jika user meminta daftar perangkat/ruangan).
${customDescBlock}
ATURAN WAJIB:
1. Ngobrol santai -> balas langsung sesuai karaktermu tanpa memanggil tool.
2. Pertanyaan informasi rumah user (contoh: "sebutkan semua perangkat", "di kamar ada berapa perangkat", "statusnya gimana", "NodeMCU mana yang aktif") -> jawab akurat berdasarkan DATA DATABASE USER DI BAWAH atau panggil \`get_device_status\` untuk pengecekan live. Jangan pernah mengarang perangkat/ruangan yang tidak ada di data!
3. CEK STATUS SEBELUM BERTINDAK: Sebelum memanggil tool kontrol (\`control_device\`, \`control_room\`, \`control_all_devices\`), selalu periksa dulu status (\`Status: ON\` atau \`Status: OFF\`) di DATA DATABASE USER DI BAWAH:
   - Jika perangkat yang diminta user MEMANG SUDAH dalam kondisi yang diminta (misalnya disuruh mematikan padahal \`Status: OFF\`, atau disuruh menyalakan padahal \`Status: ON\`), JANGAN memanggil tool kontrol dan JANGAN pura-pura baru menyalakan/mematikan! Beri tahu user dengan santai bahwa perangkat itu memang sudah menyala/mati dari tadi (sebelumnya).
   - Jika user menyebut kategori umum seperti "lampu" atau "kipas" yang cocok dengan beberapa perangkat (misal \`Lampu Kamar\` dan \`Lampu Teras\`):
     * Jika SEMUA perangkat yang cocok sudah dalam kondisi yang diminta (misal keduanya sudah \`OFF\` saat disuruh "matikan lampu"), langsung beri tahu user bahwa semua lampu tersebut memang sudah mati dari tadi (tanpa memanggil tool).
     * Jika hanya ADA 1 perangkat yang kondisinya masih berbeda (misal cuma \`Lampu Kamar\` yang masih \`ON\`), langsung ubah perangkat yang masih berbeda tersebut.
     * Jika ada lebih dari 1 perangkat yang masih perlu diubah dan user tidak menyebut spesifik atau "semua", tanya balik singkat mau perangkat yang mana (misal: "Lampu Kamar atau Lampu Teras nih, atau mau dua-duanya?").
4. Perintah menyalakan/mematikan 1 perangkat yang statusnya memang berbeda -> WAJIB panggil \`control_device\`.
5. Perintah menyalakan/mematikan semua perangkat di 1 ruangan (selama masih ada minimal 1 perangkat yang statusnya berbeda) -> WAJIB panggil \`control_room\`.
6. Perintah menyalakan/mematikan SEMUA perangkat di rumah (selama masih ada minimal 1 perangkat yang statusnya berbeda) -> WAJIB panggil \`control_all_devices\`.
7. PENTING: Jika perangkat masih perlu diubah statusnya, TETAP WAJIB panggil tool kontrol (\`control_device\`, \`control_room\`, atau \`control_all_devices\`) MESKIPUN status hardware \`Offline\`! Database tetap harus diubah agar UI web ikut berubah dan NodeMCU langsung menyala/mati saat kembali online.
8. KEJUJURAN HASIL TOOL:
   - DILARANG KERAS mengaku sudah menyalakan/mematikan sebelum memanggil tool kontrol (kecuali jika statusnya memang SUDAH ON/OFF dari awal sebelum perintah).
   - Jika tool mengembalikan \`already_in_state: true\` atau \`changed_count: 0\`, JANGAN bilang "sudah saya matikan/nyalakan sekarang", melainkan beri tahu jujur bahwa perangkat tersebut memang sudah dalam kondisi tersebut sebelumnya.
   - Jika ada sebagian yang berubah dan sebagian sudah dalam kondisi target, sampaikan keduanya secara jujur.
   - Setelah tool mengubah status (\`ok: true\` dengan \`changed: true\` / \`changed_count > 0\`), baru kabari user (dan ingatkan jika hardware-nya sedang \`Offline\`).
9. Jika daftar perangkat kosong, ajak user menambahkannya lewat menu di dashboard.
10. TOLERANSI PERINTAH SUARA (STT): Input user sering berasal dari mikrofon (Speech-to-Text Bahasa Indonesia) sehingga kadang terdapat salah dengar fonetik ringan (contoh: "matikan labu kamar" = "Lampu Kamar", "nyalahin/nyala in" = "nyalakan", "keras" = "Teras", "kibas" = "Kipas"). Jika konteks kalimat dan kemiripan bunyi jelas mengarah ke salah satu perangkat/ruangan di database, pahami maksud sebenarnya dengan cerdas (tetap tanya singkat jika benar-benar meragukan).

RINGKASAN DATABASE USER (REAL-TIME SAAT INI):
Total Ruangan: ${summary.total_rooms} | Total NodeMCU: ${summary.total_controllers} | Total Perangkat: ${summary.total_devices} (${summary.devices_on} ON, ${summary.devices_off} OFF, ${summary.unassigned_devices_count} Tanpa Ruangan)

RUANGAN:
${roomListText}

UNIT NODEMCU (CONTROLLERS):
${controllerListText}

PERANGKAT:
${deviceListText}`;
}

const functionDeclarations: FunctionDeclaration[] = [
  {
    name: 'control_device',
    description:
      'Menyalakan atau mematikan satu perangkat smart home tertentu berdasarkan device_id.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        device_id: {
          type: Type.STRING,
          description: 'UUID device_id persis dari daftar perangkat.',
        },
        is_on: {
          type: Type.BOOLEAN,
          description: 'true untuk menyalakan (ON), false untuk mematikan (OFF).',
        },
      },
      required: ['device_id', 'is_on'],
    },
  },
  {
    name: 'control_room',
    description:
      'Menyalakan atau mematikan SEMUA perangkat di dalam satu ruangan berdasarkan room_id.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        room_id: {
          type: Type.STRING,
          description: 'UUID room_id persis dari daftar ruangan.',
        },
        is_on: {
          type: Type.BOOLEAN,
          description: 'true untuk menyalakan semua (ON), false untuk mematikan semua (OFF).',
        },
      },
      required: ['room_id', 'is_on'],
    },
  },
  {
    name: 'control_all_devices',
    description:
      'Menyalakan atau mematikan SEMUA perangkat milik user di seluruh rumah sekaligus (termasuk yang tanpa ruangan).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        is_on: {
          type: Type.BOOLEAN,
          description: 'true untuk menyalakan semua perangkat (ON), false untuk mematikan semua (OFF).',
        },
      },
      required: ['is_on'],
    },
  },
  {
    name: 'get_device_status',
    description:
      'Membaca data terbaru dari database milik user yang login: ringkasan rumah, daftar ruangan & jumlah perangkatnya, status NodeMCU, dan kondisi setiap perangkat (ON/OFF).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        target_type: {
          type: Type.STRING,
          enum: ['device', 'room', 'unassigned', 'all'],
          description:
            'Tipe pengecekan: device (1 perangkat), room (1 ruangan), unassigned (tanpa ruangan), atau all (semua data rumah user).',
        },
        target_id: {
          type: Type.STRING,
          description: 'UUID device_id atau room_id jika target_type device/room.',
        },
      },
      required: ['target_type'],
    },
  },
];

function resolveHardwareStatus(
  controllerId: string | null,
  controllerMap: Map<string, SafeController>
): string {
  const ctrl = controllerId ? controllerMap.get(controllerId) : undefined;
  if (!ctrl) return 'Mode Simulasi';
  return isControllerOnline(ctrl.last_seen)
    ? `${ctrl.name} (Online)`
    : `${ctrl.name} (Offline)`;
}

type ToolDeviceRow = {
  id: string;
  name: string;
  is_on: boolean;
  controller_id: string | null;
};

function syncDevicesInContext(ctxDevices: Device[], updatedIds: Set<string>, isOn: boolean): void {
  for (const device of ctxDevices) {
    if (updatedIds.has(device.id)) {
      device.is_on = isOn;
    }
  }
}

async function controlDeviceGroup(params: {
  supabase: SupabaseClient;
  userId: string;
  isOn: boolean;
  roomId?: string;
  roomName?: string;
  controllerMap: Map<string, SafeController>;
  ctxDevices: Device[];
}): Promise<{ result: Record<string, unknown>; actions: ActionLog[] }> {
  const { supabase, userId, isOn, roomId, roomName, controllerMap, ctxDevices } = params;

  let query = supabase
    .from('devices')
    .select('id, name, is_on, controller_id')
    .eq('user_id', userId);

  if (roomId) {
    query = query.eq('room_id', roomId);
  }

  const { data: currentDevices, error: fetchError } = await query;

  if (fetchError) {
    return {
      result: {
        ok: false,
        error: roomId
          ? 'Gagal membaca perangkat di ruangan.'
          : 'Gagal membaca daftar perangkat.',
      },
      actions: [],
    };
  }

  const allDevices = (currentDevices ?? []) as ToolDeviceRow[];
  const stateLabel = isOn ? 'ON (Menyala)' : 'OFF (Mati)';

  if (allDevices.length === 0) {
    return {
      result: {
        ok: true,
        ...(roomName ? { room_name: roomName } : {}),
        affected_count: 0,
        changed_count: 0,
        already_in_state_count: 0,
        already_in_state: false,
        devices: [],
        message: roomName
          ? `Belum ada perangkat di ruangan ${roomName}.`
          : 'Belum ada perangkat yang terdaftar.',
      },
      actions: [],
    };
  }

  const toChange = allDevices.filter((d) => d.is_on !== isOn);
  const alreadyInState = allDevices.filter((d) => d.is_on === isOn);

  let finalList: ToolDeviceRow[] = allDevices;
  let changedList: ToolDeviceRow[] = [];

  if (toChange.length > 0) {
    const targetIds = toChange.map((d) => d.id);
    const { data: updatedRows, error: updateError } = await supabase
      .from('devices')
      .update({ is_on: isOn })
      .eq('user_id', userId)
      .in('id', targetIds)
      .select('id, name, is_on, controller_id');

    if (updateError) {
      return {
        result: {
          ok: false,
          error: roomId
            ? 'Gagal memperbarui perangkat di ruangan.'
            : 'Gagal memperbarui semua perangkat.',
        },
        actions: [],
      };
    }

    changedList = (updatedRows ?? []) as ToolDeviceRow[];
    const changedById = new Map(changedList.map((d) => [d.id, d]));
    finalList = allDevices.map((d) => changedById.get(d.id) ?? d);
    syncDevicesInContext(ctxDevices, new Set(changedById.keys()), isOn);
  }

  const allAlreadyInState = toChange.length === 0;
  const scopeLabel = roomName ? `di ruangan ${roomName}` : 'di rumah';

  const message = allAlreadyInState
    ? `Semua perangkat ${scopeLabel} (${alreadyInState.map((d) => d.name).join(', ')}) memang sudah dalam kondisi ${stateLabel} sebelumnya, tidak ada perubahan.`
    : alreadyInState.length > 0
      ? `${changedList.map((d) => d.name).join(', ')} diubah ke ${stateLabel}; sedangkan ${alreadyInState.map((d) => d.name).join(', ')} memang sudah ${stateLabel} sebelumnya.`
      : `Berhasil mengubah ${changedList.length} perangkat ${scopeLabel} ke ${stateLabel}.`;

  return {
    result: {
      ok: true,
      ...(roomName ? { room_name: roomName } : {}),
      already_in_state: allAlreadyInState,
      changed: changedList.length > 0,
      affected_count: changedList.length,
      changed_count: changedList.length,
      already_in_state_count: alreadyInState.length,
      changed_devices: changedList.map((d) => d.name),
      already_in_state_devices: alreadyInState.map((d) => d.name),
      message,
      devices: finalList.map((d) => ({
        name: d.name,
        is_on: d.is_on,
        hardware_status: resolveHardwareStatus(d.controller_id, controllerMap),
      })),
    },
    actions: changedList.map((d) => ({
      device_id: d.id,
      device_name: d.name,
      is_on: d.is_on,
    })),
  };
}

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: {
    userId: string;
    supabase: SupabaseClient;
    rooms: Room[];
    controllers: SafeController[];
    devices: Device[];
  }
): Promise<{ result: Record<string, unknown>; actions: ActionLog[] }> {
  const roomMap = new Map(ctx.rooms.map((r) => [r.id, r.name]));
  const controllerMap = new Map(ctx.controllers.map((c) => [c.id, c]));

  if (name === 'control_device') {
    const deviceId = typeof args.device_id === 'string' ? args.device_id : '';
    const isOn = Boolean(args.is_on);

    if (!deviceId) {
      return { result: { ok: false, error: 'device_id tidak valid.' }, actions: [] };
    }

    const { data: existing, error: fetchError } = await ctx.supabase
      .from('devices')
      .select('id, name, is_on, controller_id')
      .eq('id', deviceId)
      .eq('user_id', ctx.userId)
      .single();

    if (fetchError || !existing) {
      return { result: { ok: false, error: 'Perangkat tidak ditemukan.' }, actions: [] };
    }

    const stateLabel = isOn ? 'ON (Menyala)' : 'OFF (Mati)';
    const hardwareStatus = resolveHardwareStatus(existing.controller_id, controllerMap);

    if (existing.is_on === isOn) {
      return {
        result: {
          ok: true,
          already_in_state: true,
          changed: false,
          device_name: existing.name,
          is_on: existing.is_on,
          hardware_status: hardwareStatus,
          message: `${existing.name} memang sudah dalam kondisi ${stateLabel} sebelumnya, tidak perlu diubah lagi.`,
        },
        actions: [],
      };
    }

    const { data: updated, error } = await ctx.supabase
      .from('devices')
      .update({ is_on: isOn })
      .eq('id', deviceId)
      .eq('user_id', ctx.userId)
      .select('id, name, is_on, controller_id')
      .single();

    if (error || !updated) {
      return { result: { ok: false, error: 'Perangkat tidak ditemukan.' }, actions: [] };
    }

    syncDevicesInContext(ctx.devices, new Set([updated.id]), updated.is_on);

    return {
      result: {
        ok: true,
        already_in_state: false,
        changed: true,
        device_name: updated.name,
        is_on: updated.is_on,
        hardware_status: resolveHardwareStatus(updated.controller_id, controllerMap),
      },
      actions: [
        {
          device_id: updated.id,
          device_name: updated.name,
          is_on: updated.is_on,
        },
      ],
    };
  }

  if (name === 'control_room') {
    const roomId = typeof args.room_id === 'string' ? args.room_id : '';
    const isOn = Boolean(args.is_on);

    if (!roomId) {
      return { result: { ok: false, error: 'room_id tidak valid.' }, actions: [] };
    }

    const roomName = roomMap.get(roomId);
    if (!roomName) {
      return { result: { ok: false, error: 'Ruangan tidak ditemukan.' }, actions: [] };
    }

    return controlDeviceGroup({
      supabase: ctx.supabase,
      userId: ctx.userId,
      isOn,
      roomId,
      roomName,
      controllerMap,
      ctxDevices: ctx.devices,
    });
  }

  if (name === 'control_all_devices') {
    const isOn = Boolean(args.is_on);

    return controlDeviceGroup({
      supabase: ctx.supabase,
      userId: ctx.userId,
      isOn,
      controllerMap,
      ctxDevices: ctx.devices,
    });
  }

  if (name === 'get_device_status') {
    const targetType = typeof args.target_type === 'string' ? args.target_type : 'all';
    const targetId = typeof args.target_id === 'string' ? args.target_id : '';

    // Query live dari database khusus milik user yang login (scoped user_id + RLS)
    const [{ data: liveRooms }, { data: liveControllers }, { data: liveDevices }] =
      await Promise.all([
        ctx.supabase.from('rooms').select('*').eq('user_id', ctx.userId).order('name'),
        ctx.supabase
          .from('controllers')
          .select('id, user_id, name, last_seen, created_at')
          .eq('user_id', ctx.userId)
          .order('name'),
        ctx.supabase
          .from('devices')
          .select('*')
          .eq('user_id', ctx.userId)
          .order('name'),
      ]);

    const roomsList = liveRooms ?? ctx.rooms;
    const controllersList = (liveControllers ?? ctx.controllers) as SafeController[];
    const devicesList = liveDevices ?? ctx.devices;

    const snapshot = buildHomeSnapshot(roomsList, controllersList, devicesList);

    let filtered = devicesList;
    if (targetType === 'device' && targetId) {
      filtered = devicesList.filter((d) => d.id === targetId);
    } else if (targetType === 'room' && targetId) {
      filtered = devicesList.filter((d) => d.room_id === targetId);
    } else if (targetType === 'unassigned') {
      filtered = devicesList.filter((d) => !d.room_id);
    }

    return {
      result: {
        ok: true,
        summary: snapshot.summary,
        rooms: snapshot.roomSummaries,
        controllers: snapshot.controllerSummaries,
        devices: filtered.map((d) => {
          const ctrl = d.controller_id
            ? snapshot.controllerMap.get(d.controller_id)
            : undefined;
          return {
            id: d.id,
            name: d.name,
            aliases: d.aliases,
            room: d.room_id
              ? snapshot.roomMap.get(d.room_id) ?? 'Tanpa Ruangan'
              : 'Tanpa Ruangan',
            gpio_pin: formatGpioLabel(d.gpio_pin),
            is_on: d.is_on,
            updated_at: d.updated_at,
            hardware: ctrl
              ? { name: ctrl.name, online: isControllerOnline(ctrl.last_seen) }
              : { name: 'Mode Simulasi', online: true },
          };
        }),
      },
      actions: [],
    };
  }

  return { result: { ok: false, error: `Tool "${name}" tidak dikenal.` }, actions: [] };
}

export interface AssistantRunResult {
  reply: string;
  actions: ActionLog[];
}

export async function streamSmartHomeAssistant(params: {
  apiKey: string;
  assistantProfile: AssistantProfile;
  userId: string;
  message: string;
  history: ChatMessage[];
  supabase: SupabaseClient;
  rooms: Room[];
  controllers: SafeController[];
  devices: Device[];
  onTextDelta?: (chunk: string) => void;
  onStatus?: (statusText: string) => void;
  onActions?: (actions: ActionLog[]) => void;
}): Promise<AssistantRunResult> {
  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  const systemInstruction = buildSystemInstruction(
    params.assistantProfile,
    params.rooms,
    params.controllers,
    params.devices
  );

  // Bangun riwayat percakapan singkat agar konteks obrolan tetap nyambung & ringan
  const contents: Content[] = params.history
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  contents.push({
    role: 'user',
    parts: [{ text: params.message }],
  });

  const allActions: ActionLog[] = [];
  let finalReply = '';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const stream = await ai.models.generateContentStream({
      model: MODEL_ID,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations }],
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
      },
    });

    const modelParts: Part[] = [];
    const functionCalls: FunctionCall[] = [];

    for await (const chunk of stream) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        modelParts.push(part);
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        } else if (part.text && !part.thought) {
          finalReply += part.text;
          params.onTextDelta?.(part.text);
        }
      }
    }

    if (functionCalls.length === 0) {
      break;
    }

    params.onStatus?.('Menjalankan perintah perangkat...');

    // Simpan respons model (termasuk thoughtSignature/functionCall) ke contents
    contents.push({
      role: 'model',
      parts: modelParts,
    });

    // Eksekusi seluruh tool call secara paralel
    const executed = await Promise.all(
      functionCalls.map(async (call) => {
        const name = call.name ?? '';
        const args = (call.args ?? {}) as Record<string, unknown>;
        const { result, actions } = await executeToolCall(name, args, {
          userId: params.userId,
          supabase: params.supabase,
          rooms: params.rooms,
          controllers: params.controllers,
          devices: params.devices,
        });
        return { call, result, actions };
      })
    );

    const roundActions: ActionLog[] = [];
    const responseParts: Part[] = executed.map(({ call, result, actions }) => {
      if (actions.length > 0) {
        roundActions.push(...actions);
        allActions.push(...actions);
      }
      return {
        functionResponse: {
          name: call.name ?? '',
          id: call.id,
          response: result,
        },
      };
    });

    if (roundActions.length > 0) {
      params.onActions?.(roundActions);
    }

    contents.push({
      role: 'user',
      parts: responseParts,
    });
  }

  return {
    reply:
      finalReply.trim() ||
      'Waduh, sinyalku barusan agak keselek nih! Coba ulangi lagi ya.',
    actions: allActions,
  };
}
