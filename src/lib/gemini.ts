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
import {
  clampWledByte,
  formatGpioLabel,
  formatWledGpioLabel,
  isControllerOnline,
  isValidWledEffect,
  sanitizeHexColor,
} from './constants';
import { computePresetTargets, executePresetActivation } from './presets';
import type {
  ActionLog,
  AssistantProfile,
  ChatMessage,
  Controller,
  Device,
  Preset,
  Room,
  WledDevice,
  WledPreset,
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
  devices: Device[],
  presets: Preset[],
  wledDevices: WledDevice[],
  wledPresets: WledPreset[]
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

  const presetListText =
    presets.length === 0
      ? '- (Belum ada mode kombinasi / preset)'
      : presets
          .map((p) => {
            const roomName = p.room_id ? roomMap.get(p.room_id) ?? 'Tanpa Ruangan' : 'Tanpa Ruangan';
            const { targetsOn, targetsOff } = computePresetTargets(p, devices);
            const onNames =
              targetsOn.length > 0 ? targetsOn.map((d) => d.name).join(', ') : '(tidak ada — matikan semua)';
            const offNote = p.turn_off_others
              ? targetsOff.length > 0
                ? `Matikan lainnya di ${roomName}: ${targetsOff.map((d) => d.name).join(', ')}`
                : `Matikan lainnya di ${roomName}`
              : 'Tidak mematikan perangkat lain';
            const kwInfo = p.keywords.trim() ? ` | Kata kunci: "${p.keywords.trim()}"` : '';
            return `- [preset_id: ${p.id}] "${p.name}"${kwInfo} | Ruang: "${roomName}" | Nyalakan: [${onNames}] | ${offNote}`;
          })
          .join('\n');

  const wledMap = new Map(wledDevices.map((w) => [w.id, w.name]));

  const wledListText =
    wledDevices.length === 0
      ? '- (Belum ada unit WLED / Smart LED WS2812)'
      : wledDevices
          .map((w) => {
            const roomName = w.room_id ? roomMap.get(w.room_id) ?? 'Tanpa Ruangan' : 'Tanpa Ruangan';
            const hwStatus = isControllerOnline(w.last_seen) ? 'Online' : 'Offline';
            const aliasInfo = w.aliases.trim() ? `, Alias: "${w.aliases.trim()}"` : '';
            const briPct = Math.round((w.brightness / 255) * 100);
            return `- [wled_id: ${w.id}] "${w.name}"${aliasInfo} | Ruang: "${roomName}" | Status: ${w.is_on ? 'ON' : 'OFF'}, Warna: ${w.color_hex}, Terang: ${briPct}% (${w.brightness}/255), Efek: ${w.effect}, Speed: ${w.speed} | Pin: ${formatWledGpioLabel(w.gpio_pin)} (${w.led_count} LED) | HW: ${hwStatus}`;
          })
          .join('\n');

  const wledPresetListText =
    wledPresets.length === 0
      ? '- (Belum ada preset WLED)'
      : wledPresets
          .map((wp) => {
            const scopeName = wp.wled_device_id
              ? wledMap.get(wp.wled_device_id) ?? 'Unit Tertentu'
              : 'Semua WLED';
            const kwInfo = wp.keywords.trim() ? ` | Kata kunci: "${wp.keywords.trim()}"` : '';
            return `- [wled_preset_id: ${wp.id}] "${wp.name}"${kwInfo} | Target: ${scopeName} | ${wp.is_on ? 'ON' : 'OFF'}, Warna: ${wp.color_hex}, Terang: ${wp.brightness}/255, Efek: ${wp.effect}`;
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
7. MODE KOMBINASI / PRESET PERINTAH:
   - Periksa daftar MODE KOMBINASI / PRESET di bawah. Jika ucapan user merujuk pada nama preset, kata kunci pemicu, atau niat/aktivitas yang cocok dengan preset tersebut (contoh: "waktunya nge game nih" cocok dengan preset Mode Gaming, atau "mode tidur"), WAJIB panggil activate_preset dengan preset_id yang sesuai!
   - activate_preset otomatis menyalakan perangkat yang terdaftar di preset dan mematikan perangkat lain di ruangan yang sama (jika opsi matikan lainnya aktif).
8. PENTING: Jika perangkat masih perlu diubah statusnya, TETAP WAJIB panggil tool kontrol (control_device, control_room, control_all_devices, atau activate_preset) MESKIPUN status hardware Offline! Database tetap harus diubah agar UI web ikut berubah dan NodeMCU langsung menyala/mati saat kembali online.
9. KEJUJURAN HASIL TOOL:
   - DILARANG KERAS mengaku sudah menyalakan/mematikan sebelum memanggil tool kontrol (kecuali jika statusnya memang SUDAH ON/OFF dari awal sebelum perintah).
   - Jika tool mengembalikan \`already_in_state: true\` atau \`changed_count: 0\`, JANGAN bilang "sudah saya matikan/nyalakan sekarang", melainkan beri tahu jujur bahwa perangkat tersebut memang sudah dalam kondisi tersebut sebelumnya.
   - Jika ada sebagian yang berubah dan sebagian sudah dalam kondisi target, sampaikan keduanya secara jujur.
   - Setelah tool mengubah status (\`ok: true\` dengan \`changed: true\` / \`changed_count > 0\`), baru kabari user (dan ingatkan jika hardware-nya sedang \`Offline\`).
9. Jika daftar perangkat kosong, ajak user menambahkannya lewat menu di dashboard.
10. TOLERANSI PERINTAH SUARA (STT): Input user sering berasal dari mikrofon (Speech-to-Text Bahasa Indonesia) sehingga kadang terdapat salah dengar fonetik ringan (contoh: "matikan labu kamar" = "Lampu Kamar", "nyalahin/nyala in" = "nyalakan", "keras" = "Teras", "kibas" = "Kipas"). Jika konteks kalimat dan kemiripan bunyi jelas mengarah ke salah satu perangkat/ruangan di database, pahami maksud sebenarnya dengan cerdas (tetap tanya singkat jika benar-benar meragukan).
11. KONTROL WLED / SMART LED WS2812 & KREASI MOOD:
    - Sistem ini juga mendukung lampu RGB WS2812 (\`PERANGKAT WLED\` dan \`PRESET WLED\`) secara terpisah dari switch relay.
    - Jika user memerintahkan ganti warna, kecerahan, efek, atau menyalakan/mematikan unit WLED (contoh: "ubah WLED kamar jadi biru", "bikin warna pink redup", "efek pelangi"), WAJIB panggil tool \`control_wled\` dengan \`wled_id\`, \`is_on: true\`, dan kode warna HEX \`#RRGGBB\`, \`brightness\` (1-255), \`effect\`, \`speed\` yang sesuai.
    - Jika user meminta salah satu preset WLED pada daftar \`PRESET WLED\`, WAJIB panggil \`activate_wled_preset\`.
    - KREASI SUASANA HATI (EMPATI + WARNA KREATIF): Bila user bercerita tentang perasaan atau suasana hati (contoh: "aku lagi sedih", "capek pengen tenang", "suasana romantis", "mau fokus ngoding", "lagi seneng banget") dan user punya unit WLED, balas dengan empati DAN kreasikan pencahayaan WLED dengan memanggil \`control_wled\` secara langsung! Contoh inspirasi:
      * Sedih / galau -> merah-ungu temaram atau biru-ungu lembut redup (misal \`#6D28D9\` / \`#7E225E\`, brightness \`75-110\`, efek \`"breathe"\`, speed \`65\`).
      * Rileks / mau tidur -> amber hangat redup (\`#FF9E44\`, brightness \`60-95\`, efek \`"solid"\` / \`"breathe"\`).
      * Fokus / kerja -> putih sejuk / cyan lembut (\`#A5F3FC\`, brightness \`210\`, efek \`"solid"\`).
      * Romantis -> rose magenta lembut (\`#E11D74\`, brightness \`115\`, efek \`"breathe"\`).
      * Senang / pesta -> efek \`"rainbow"\` atau \`"sparkle"\` terang (\`brightness: 235\`).
      Jika hanya ada 1 WLED langsung terapkan ke unit tersebut; jika ada >1 di ruangan berbeda, pilih yang paling relevan (misal ruang kamar) atau tanyakan singkat jika meragukan.
    - Tetap panggil \`control_wled\` / \`activate_wled_preset\` meskipun status hardware WLED sedang \`Offline\` agar web UI langsung ter-update dan lampu otomatis berubah saat kembali online.

RINGKASAN DATABASE USER (REAL-TIME SAAT INI):
Total Ruangan: ${summary.total_rooms} | Total NodeMCU Relay: ${summary.total_controllers} | Total Switch Relay: ${summary.total_devices} (${summary.devices_on} ON, ${summary.devices_off} OFF, ${summary.unassigned_devices_count} Tanpa Ruangan) | Total Preset Switch: ${presets.length} | Total Unit WLED: ${wledDevices.length} | Total Preset WLED: ${wledPresets.length}

MODE KOMBINASI / PRESET SWITCH:
${presetListText}

PERANGKAT WLED / SMART LED WS2812:
${wledListText}

PRESET WLED:
${wledPresetListText}

RUANGAN:
${roomListText}

UNIT NODEMCU RELAY (CONTROLLERS):
${controllerListText}

PERANGKAT SWITCH RELAY:
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
    name: 'activate_preset',
    description:
      'Mengaktifkan salah satu Mode Kombinasi / Preset milik user: menyalakan perangkat di dalam preset tersebut dan (bila diaktifkan) mematikan perangkat lain pada ruangan yang sama.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        preset_id: {
          type: Type.STRING,
          description: 'UUID preset_id persis dari daftar MODE KOMBINASI / PRESET.',
        },
      },
      required: ['preset_id'],
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
  {
    name: 'control_wled',
    description:
      'Mengontrol lampu RGB WS2812 (WLED): menyalakan/mematikan, mengganti warna HEX (#RRGGBB), mengatur kecerahan (1-255), efek animasi, dan kecepatan efek (termasuk kreasi warna sesuai mood/perasaan user).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        wled_id: {
          type: Type.STRING,
          description: 'UUID wled_id persis dari daftar PERANGKAT WLED.',
        },
        is_on: {
          type: Type.BOOLEAN,
          description: 'true untuk menyalakan (ON), false untuk mematikan (OFF).',
        },
        color_hex: {
          type: Type.STRING,
          description: 'Kode warna RGB HEX format #RRGGBB (contoh: #2563EB, #EC4899, #6D28D9).',
        },
        brightness: {
          type: Type.INTEGER,
          description: 'Kecerahan lampu skala 1 sampai 255 (misal redup 75, sedang 160, terang 255).',
        },
        effect: {
          type: Type.STRING,
          enum: ['solid', 'breathe', 'rainbow', 'chase', 'sparkle', 'fire', 'meteor', 'gradient'],
          description: 'Efek animasi strip LED WS2812.',
        },
        speed: {
          type: Type.INTEGER,
          description: 'Kecepatan animasi efek skala 0 sampai 255.',
        },
      },
      required: ['wled_id', 'is_on'],
    },
  },
  {
    name: 'activate_wled_preset',
    description:
      'Mengaktifkan salah satu Preset warna & efek WLED dari daftar PRESET WLED milik user.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        preset_id: {
          type: Type.STRING,
          description: 'UUID wled_preset_id persis dari daftar PRESET WLED.',
        },
        wled_id: {
          type: Type.STRING,
          description: 'Opsional UUID wled_id target jika preset bersifat global (Semua WLED).',
        },
      },
      required: ['preset_id'],
    },
  },
  {
    name: 'get_wled_status',
    description:
      'Membaca kondisi live terbaru seluruh unit WLED / Smart LED WS2812 dan daftar preset WLED milik user.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
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
    wledDevices: WledDevice[];
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

  if (name === 'activate_preset') {
    const presetId = typeof args.preset_id === 'string' ? args.preset_id : '';
    if (!presetId) {
      return { result: { ok: false, error: 'preset_id tidak valid.' }, actions: [] };
    }

    const [{ data: presetRow, error: presetErr }, { data: liveDevices, error: devErr }] =
      await Promise.all([
        ctx.supabase
          .from('presets')
          .select('*')
          .eq('id', presetId)
          .eq('user_id', ctx.userId)
          .single(),
        ctx.supabase
          .from('devices')
          .select('id, name, room_id, controller_id, is_on')
          .eq('user_id', ctx.userId),
      ]);

    if (presetErr || !presetRow) {
      return { result: { ok: false, error: 'Preset tidak ditemukan.' }, actions: [] };
    }
    if (devErr) {
      return {
        result: { ok: false, error: 'Gagal membaca daftar perangkat untuk preset.' },
        actions: [],
      };
    }

    const preset = presetRow as Preset;
    const outcome = await executePresetActivation({
      supabase: ctx.supabase,
      userId: ctx.userId,
      preset,
      devices: liveDevices ?? [],
    });

    if (outcome.turnedOn.length > 0) {
      syncDevicesInContext(
        ctx.devices,
        new Set(outcome.turnedOn.map((d) => d.id)),
        true
      );
    }
    if (outcome.turnedOff.length > 0) {
      syncDevicesInContext(
        ctx.devices,
        new Set(outcome.turnedOff.map((d) => d.id)),
        false
      );
    }

    const changedCount = outcome.actions.length;
    const roomName = preset.room_id
      ? roomMap.get(preset.room_id) ?? 'Tanpa Ruangan'
      : 'Tanpa Ruangan';

    const touchedDevices = [
      ...outcome.turnedOn,
      ...outcome.turnedOff,
      ...outcome.alreadyOn,
      ...outcome.alreadyOff,
    ];
    const offlineHardware = Array.from(
      new Set(
        touchedDevices
          .map((d) => resolveHardwareStatus(d.controller_id, controllerMap))
          .filter((hw) => hw.endsWith('(Offline)'))
      )
    );

    return {
      result: {
        ok: true,
        preset_name: preset.name,
        room_name: roomName,
        already_in_state: changedCount === 0,
        changed: changedCount > 0,
        changed_count: changedCount,
        turned_on: outcome.turnedOn.map((d) => d.name),
        turned_off: outcome.turnedOff.map((d) => d.name),
        already_on: outcome.alreadyOn.map((d) => d.name),
        already_off: outcome.alreadyOff.map((d) => d.name),
        offline_hardware: offlineHardware,
      },
      actions: outcome.actions,
    };
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

  if (name === 'control_wled') {
    const wledId = typeof args.wled_id === 'string' ? args.wled_id : '';
    if (!wledId) {
      return { result: { ok: false, error: 'wled_id tidak valid.' }, actions: [] };
    }

    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('wled_devices')
      .select('*')
      .eq('id', wledId)
      .eq('user_id', ctx.userId)
      .single();

    if (fetchErr || !existing) {
      return { result: { ok: false, error: 'Unit WLED tidak ditemukan.' }, actions: [] };
    }

    const row = existing as WledDevice;
    const nextOn = Boolean(args.is_on);
    const nextColor =
      typeof args.color_hex === 'string'
        ? sanitizeHexColor(args.color_hex, row.color_hex)
        : sanitizeHexColor(row.color_hex);
    const nextBri =
      args.brightness !== undefined
        ? clampWledByte(Number(args.brightness), 1, 255, row.brightness)
        : row.brightness;
    const nextEffect = isValidWledEffect(args.effect) ? args.effect : row.effect;
    const nextSpeed =
      args.speed !== undefined
        ? clampWledByte(Number(args.speed), 0, 255, row.speed)
        : row.speed;

    const { data: updated, error: updateErr } = await ctx.supabase
      .from('wled_devices')
      .update({
        is_on: nextOn,
        color_hex: nextColor,
        brightness: nextBri,
        effect: nextEffect,
        speed: nextSpeed,
        active_preset_id: null,
      })
      .eq('id', wledId)
      .eq('user_id', ctx.userId)
      .select('*')
      .single();

    if (updateErr || !updated) {
      return { result: { ok: false, error: 'Gagal memperbarui unit WLED.' }, actions: [] };
    }

    const nextRow = updated as WledDevice;
    for (let i = 0; i < ctx.wledDevices.length; i++) {
      if (ctx.wledDevices[i].id === nextRow.id) {
        ctx.wledDevices[i] = nextRow;
      }
    }

    return {
      result: {
        ok: true,
        wled_name: nextRow.name,
        is_on: nextRow.is_on,
        color_hex: nextRow.color_hex,
        brightness: nextRow.brightness,
        brightness_percent: Math.round((nextRow.brightness / 255) * 100),
        effect: nextRow.effect,
        speed: nextRow.speed,
        hardware_online: isControllerOnline(nextRow.last_seen),
      },
      actions: [
        {
          device_id: nextRow.id,
          device_name: nextRow.name,
          is_on: nextRow.is_on,
          kind: 'wled',
          color_hex: nextRow.color_hex,
          effect: nextRow.effect,
          brightness: nextRow.brightness,
        },
      ],
    };
  }

  if (name === 'activate_wled_preset') {
    const presetId = typeof args.preset_id === 'string' ? args.preset_id : '';
    const requestedWledId = typeof args.wled_id === 'string' ? args.wled_id : '';

    if (!presetId) {
      return { result: { ok: false, error: 'preset_id WLED tidak valid.' }, actions: [] };
    }

    const { data: presetRow, error: presetErr } = await ctx.supabase
      .from('wled_presets')
      .select('*')
      .eq('id', presetId)
      .eq('user_id', ctx.userId)
      .single();

    if (presetErr || !presetRow) {
      return { result: { ok: false, error: 'Preset WLED tidak ditemukan.' }, actions: [] };
    }

    const preset = presetRow as WledPreset;
    const targetWledId =
      requestedWledId ||
      preset.wled_device_id ||
      (ctx.wledDevices.length === 1 ? ctx.wledDevices[0].id : '');

    if (!targetWledId) {
      return {
        result: {
          ok: false,
          error:
            'Preset ini berlaku untuk semua unit WLED dan user memiliki lebih dari 1 unit WLED. Sertakan wled_id target atau tanyakan ke user mau dipakai di WLED mana.',
          available_wleds: ctx.wledDevices.map((w) => ({ id: w.id, name: w.name })),
        },
        actions: [],
      };
    }

    const { data: updated, error: updateErr } = await ctx.supabase
      .from('wled_devices')
      .update({
        is_on: preset.is_on,
        color_hex: sanitizeHexColor(preset.color_hex),
        brightness: clampWledByte(preset.brightness, 1, 255, 180),
        effect: preset.effect,
        speed: clampWledByte(preset.speed, 0, 255, 128),
        active_preset_id: preset.id,
      })
      .eq('id', targetWledId)
      .eq('user_id', ctx.userId)
      .select('*')
      .single();

    if (updateErr || !updated) {
      return {
        result: { ok: false, error: 'Unit WLED target untuk preset tidak ditemukan.' },
        actions: [],
      };
    }

    const nextRow = updated as WledDevice;
    for (let i = 0; i < ctx.wledDevices.length; i++) {
      if (ctx.wledDevices[i].id === nextRow.id) {
        ctx.wledDevices[i] = nextRow;
      }
    }

    return {
      result: {
        ok: true,
        preset_name: preset.name,
        wled_name: nextRow.name,
        is_on: nextRow.is_on,
        color_hex: nextRow.color_hex,
        brightness: nextRow.brightness,
        effect: nextRow.effect,
        hardware_online: isControllerOnline(nextRow.last_seen),
      },
      actions: [
        {
          device_id: nextRow.id,
          device_name: nextRow.name,
          is_on: nextRow.is_on,
          kind: 'wled',
          color_hex: nextRow.color_hex,
          effect: nextRow.effect,
          brightness: nextRow.brightness,
          preset_name: preset.name,
        },
      ],
    };
  }

  if (name === 'get_wled_status') {
    const [{ data: liveWleds }, { data: liveWledPresets }] = await Promise.all([
      ctx.supabase
        .from('wled_devices')
        .select('*')
        .eq('user_id', ctx.userId)
        .order('name'),
      ctx.supabase
        .from('wled_presets')
        .select('*')
        .eq('user_id', ctx.userId)
        .order('name'),
    ]);

    const wledList = (liveWleds ?? []) as WledDevice[];
    const wpList = (liveWledPresets ?? []) as WledPreset[];

    return {
      result: {
        ok: true,
        wled_devices: wledList.map((w) => ({
          id: w.id,
          name: w.name,
          room: w.room_id ? roomMap.get(w.room_id) ?? 'Tanpa Ruangan' : 'Tanpa Ruangan',
          is_on: w.is_on,
          color_hex: w.color_hex,
          brightness_percent: Math.round((w.brightness / 255) * 100),
          effect: w.effect,
          led_count: w.led_count,
          online: isControllerOnline(w.last_seen),
        })),
        wled_presets: wpList.map((wp) => ({
          id: wp.id,
          name: wp.name,
          keywords: wp.keywords,
          color_hex: wp.color_hex,
          effect: wp.effect,
        })),
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
  presets?: Preset[];
  wledDevices?: WledDevice[];
  wledPresets?: WledPreset[];
  onTextDelta?: (chunk: string) => void;
  onStatus?: (statusText: string) => void;
  onActions?: (actions: ActionLog[]) => void;
}): Promise<AssistantRunResult> {
  const ai = new GoogleGenAI({ apiKey: params.apiKey });
  const wledDevices = [...(params.wledDevices ?? [])];
  const systemInstruction = buildSystemInstruction(
    params.assistantProfile,
    params.rooms,
    params.controllers,
    params.devices,
    params.presets ?? [],
    wledDevices,
    params.wledPresets ?? []
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
          wledDevices,
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
