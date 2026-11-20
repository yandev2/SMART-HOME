/**
 * Smart Home AI - Firmware Offline-First NodeMCU (ESP8266) + 4x Push Button
 *
 * Fitur Utama:
 * 1. Kontrol Manual 4 Push Button (1x tekan ON, 1x tekan OFF / toggle per channel)
 *    tetap responsif (< 20ms) meskipun Wi-Fi rumah mati, router padam, atau belum tersambung.
 * 2. Sinkronisasi Dua Arah Otomatis (Push Button <-> NodeMCU <-> Server <-> Web/AI):
 *    - Menekan push button langsung memicu POST /api/iot/sync (jeda batching 120ms).
 *    - Menggunakan generasi sentuhan (touchGen) & flag dirty per pin agar balasan GET lama
 *      atau kondisi baru pulih dari Wi-Fi mati TIDAK pernah menimpa status saklar fisik.
 * 3. Status relay & antrean sync (dirtyMask) tersimpan aman di EEPROM (dengan jeda simpan
 *    5 detik untuk menghemat umur flash) sehingga tetap sinkron meski sempat mati lampu.
 * 4. Captive Portal Non-Blocking:
 *    - Otomatis terbuka hanya saat flash pertama (EEPROM kosong) atau Token ditolak 3x (HTTP 401).
 *    - Bisa dipicu manual kapan saja dengan menahan BTN1 (D7) + BTN2 (D3) selama 5 detik
 *      atau mengetik SETUP pada Serial Monitor.
 *
 * Pemetaan Pin Hardware (Skema nodemcu_4ch_relay):
 * - CH 1 : Relay D1 (GPIO 5)  <-> Push Button BTN1 D7 (GPIO 13 -> GND, Pull-up 4.7k ke 3V3)
 * - CH 2 : Relay D2 (GPIO 4)  <-> Push Button BTN2 D4 (GPIO 2  -> GND, Pull-up 4.7k ke 3V3)
 * - CH 3 : Relay D5 (GPIO 14) <-> Push Button BTN3 D3 (GPIO 0  -> GND, Pull-up 4.7k ke 3V3)
 * - CH 4 : Relay D6 (GPIO 12) <-> Push Button BTN4 D0 (GPIO 16 -> GND, wajib Pull-up 4.7k ke 3V3)
 *
 * Library & Board di Arduino IDE:
 * - Board   : esp8266 by ESP8266 Community (pilih "NodeMCU 1.0 (ESP-12E Module)")
 * - Library : Tidak perlu library eksternal (ESP8266WiFi, ESP8266HTTPClient,
 *             ESP8266WebServer, DNSServer, EEPROM sudah bawaan core ESP8266).
 */

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <EEPROM.h>

// ==================== KONFIGURASI DEFAULT ====================
// Contoh lokal  : "http://192.168.0.163:3000/api/iot/sync"
// Contoh Vercel : "https://nama-project-kamu.vercel.app/api/iot/sync"
const char* DEFAULT_SYNC_URL = "http://192.168.0.163:3000/api/iot/sync";

// Interval polling normal ke server (ms) saat idle
const unsigned long SYNC_INTERVAL_MS = 2500;
// Jeda cepat (ms) setelah menekan push button sebelum langsung mengirim POST
const unsigned long PUSH_DEBOUNCE_MS = 120;
// Jeda minimum antar retry POST jika server/jaringan sedang bermasalah
const unsigned long SYNC_RETRY_BACKOFF_MS = 2500;
// Interval percobaan sambung ulang Wi-Fi di background saat router mati
const unsigned long WIFI_RETRY_INTERVAL_MS = 15000;
// Jeda simpan EEPROM setelah perubahan relay terakhir (proteksi umur flash)
const unsigned long EEPROM_SAVE_DELAY_MS = 5000;
// Jika masuk portal karena token 401 dan tidak ada HP konek, retry STA setelah 2 menit
const unsigned long PORTAL_AUTO_RETRY_MS = 120000;
// Jumlah error HTTP 401 beruntun sebelum meminta Token ulang via Access Point
const int MAX_UNAUTHORIZED_BEFORE_PORTAL = 3;

// Timing Push Button (Active-LOW: idle HIGH via pull-up, ditekan = LOW ke GND)
const unsigned long BTN_ARM_HIGH_MS = 120;        // Wajib stabil HIGH dulu saat boot
const unsigned long BTN_PRESS_DEBOUNCE_MS = 35;   // Tahan noise / EMI relay
const unsigned long BTN_RELEASE_DEBOUNCE_MS = 45; // Pastikan tombol benar-benar dilepas
const unsigned long BTN_COOLDOWN_MS = 180;        // Jeda antar penekanan berikutnya
const unsigned long BTN_SETUP_HOLD_MS = 5000;     // Tahan BTN1 + BTN2 = masuk Portal Setup
// =============================================================

const int NUM_BOARD_CHANNELS = 4;
const int BOARD_RELAY_PINS[NUM_BOARD_CHANNELS] = {5, 4, 14, 12};   // D1, D2, D5, D6
const int BOARD_BUTTON_PINS[NUM_BOARD_CHANNELS] = {13, 2, 0, 16};  // D7, D4, D3, D0
const bool BOARD_RELAY_ACTIVE_LOW = true;

const uint32_t CONFIG_MAGIC = 0x53484132; // "SHA2" (kompatibel dengan versi sebelumnya)
const uint32_t STATE_MAGIC = 0x524C5931;  // "RLY1"
const int EEPROM_SIZE = 1024;
const int EEPROM_STATE_ADDR = 416; // Aman di luar sizeof(StoredConfig)

struct StoredConfig {
  uint32_t magic;
  char ssid[64];
  char password[64];
  char deviceToken[96];
  char syncUrl[160];
};

struct LocalRelaySnapshot {
  uint32_t magic;
  uint8_t onMask;       // Bit 0..3: status terakhir CH1..CH4
  uint8_t dirtyMask;    // Bit 0..3: perubahan fisik yang belum terkirim ke server
  uint8_t restoreBoot;  // 1 = pulihkan status terakhir saat nyala, 0 = mulai OFF semua
  uint8_t reserved;
};

struct PinState {
  int pin;
  bool activeLow;
  bool lastOn;
  bool isBoardChannel;
  bool dirty;
  uint32_t touchGen;
};

struct ButtonTracker {
  int pin;
  int relayPin;
  bool armed;
  bool isPressed;
  int lastSample;
  unsigned long highStableSince;
  unsigned long sampleStableSince;
  unsigned long cooldownUntil;
};

struct ScannedNetwork {
  String ssid;
  int rssi;
  bool open;
};

const int MAX_MANAGED_PINS = 12;
PinState managedPins[MAX_MANAGED_PINS];
int managedPinCount = 0;

ButtonTracker buttons[NUM_BOARD_CHANNELS];

const int MAX_SCANNED_NETWORKS = 12;
ScannedNetwork scannedNetworks[MAX_SCANNED_NETWORKS];
int scannedCount = 0;

StoredConfig appConfig;
LocalRelaySnapshot relaySnapshot;

ESP8266WebServer webServer(80);
DNSServer dnsServer;

bool inPortalMode = false;
bool portalAllowAutoRetry = false;
String portalReason = "";
String apSsidName = "";

unsigned long portalEnteredAt = 0;
bool pendingRestart = false;
unsigned long pendingRestartAt = 0;

unsigned long lastSyncTime = 0;
unsigned long pushScheduledAt = 0;
bool pushScheduled = false;
unsigned long lastWifiAttemptAt = 0;
bool wasWifiConnected = false;
bool firstSyncSucceeded = false;
int unauthorizedStreak = 0;

bool eepromStateSavePending = false;
unsigned long eepromStateSaveAt = 0;

bool setupComboTriggered = false;
unsigned long setupComboHeldSince = 0;

int findPinIndex(int pin);
void enterConfigPortal(const String& reason, bool allowAutoRetry);
void startWiFiNonBlocking();

// -------------------- Helper String & EEPROM --------------------

void safeCopy(char* dest, size_t destSize, const String& src) {
  if (destSize == 0) return;
  size_t len = src.length();
  if (len >= destSize) len = destSize - 1;
  memcpy(dest, src.c_str(), len);
  dest[len] = '\0';
}

String htmlEscape(const String& input) {
  String out;
  out.reserve(input.length() + 16);
  for (size_t i = 0; i < input.length(); i++) {
    char c = input[i];
    if (c == '&') out += F("&amp;");
    else if (c == '<') out += F("&lt;");
    else if (c == '>') out += F("&gt;");
    else if (c == '"') out += F("&quot;");
    else if (c == '\'') out += F("&#39;");
    else out += c;
  }
  return out;
}

String normalizeSyncUrl(String url) {
  url.trim();
  if (url.length() >= 7 && url.substring(0, 7).equalsIgnoreCase("http://")) {
    url = "http://" + url.substring(7);
  } else if (url.length() >= 8 && url.substring(0, 8).equalsIgnoreCase("https://")) {
    url = "https://" + url.substring(8);
  }
  while (url.endsWith("/")) {
    url.remove(url.length() - 1);
  }
  if (url.length() > 0 && !url.endsWith("/api/iot/sync")) {
    url += "/api/iot/sync";
  }
  return url;
}

void resetConfigToDefault() {
  memset(&appConfig, 0, sizeof(appConfig));
  appConfig.magic = CONFIG_MAGIC;
  safeCopy(appConfig.syncUrl, sizeof(appConfig.syncUrl), DEFAULT_SYNC_URL);
}

void resetSnapshotToDefault() {
  memset(&relaySnapshot, 0, sizeof(relaySnapshot));
  relaySnapshot.magic = STATE_MAGIC;
  relaySnapshot.onMask = 0;
  relaySnapshot.dirtyMask = 0;
  relaySnapshot.restoreBoot = 1; // Default: pulihkan status terakhir setelah mati lampu
  relaySnapshot.reserved = 0;
}

void loadConfigAndSnapshot() {
  EEPROM.begin(EEPROM_SIZE);
  EEPROM.get(0, appConfig);

  if (appConfig.magic != CONFIG_MAGIC) {
    resetConfigToDefault();
  } else {
    appConfig.ssid[sizeof(appConfig.ssid) - 1] = '\0';
    appConfig.password[sizeof(appConfig.password) - 1] = '\0';
    appConfig.deviceToken[sizeof(appConfig.deviceToken) - 1] = '\0';
    appConfig.syncUrl[sizeof(appConfig.syncUrl) - 1] = '\0';

    if (strlen(appConfig.syncUrl) == 0) {
      safeCopy(appConfig.syncUrl, sizeof(appConfig.syncUrl), DEFAULT_SYNC_URL);
    }
  }

  EEPROM.get(EEPROM_STATE_ADDR, relaySnapshot);
  if (relaySnapshot.magic != STATE_MAGIC) {
    resetSnapshotToDefault();
  }
}

void saveConfig() {
  appConfig.magic = CONFIG_MAGIC;
  EEPROM.put(0, appConfig);
  EEPROM.commit();
}

void saveSnapshotNow() {
  uint8_t onMask = 0;
  uint8_t dirtyMask = 0;
  for (int i = 0; i < NUM_BOARD_CHANNELS; i++) {
    int idx = findPinIndex(BOARD_RELAY_PINS[i]);
    if (idx >= 0) {
      if (managedPins[idx].lastOn) onMask |= (1 << i);
      if (managedPins[idx].dirty) dirtyMask |= (1 << i);
    }
  }

  relaySnapshot.magic = STATE_MAGIC;
  if (relaySnapshot.onMask == onMask && relaySnapshot.dirtyMask == dirtyMask) {
    eepromStateSavePending = false;
    return;
  }

  relaySnapshot.onMask = onMask;
  relaySnapshot.dirtyMask = dirtyMask;
  EEPROM.put(EEPROM_STATE_ADDR, relaySnapshot);
  EEPROM.commit();
  eepromStateSavePending = false;
  Serial.printf("[EEPROM] Status relay disimpan (on=0x%02X, dirty=0x%02X).\n", onMask, dirtyMask);
}

void scheduleSnapshotSave() {
  eepromStateSavePending = true;
  eepromStateSaveAt = millis() + EEPROM_SAVE_DELAY_MS;
}

void clearConfig() {
  resetConfigToDefault();
  resetSnapshotToDefault();
  EEPROM.put(0, appConfig);
  EEPROM.put(EEPROM_STATE_ADDR, relaySnapshot);
  EEPROM.commit();
}

bool hasRequiredConfig() {
  return strlen(appConfig.ssid) > 0 &&
         strlen(appConfig.deviceToken) > 0 &&
         strlen(appConfig.syncUrl) > 0;
}

// -------------------- Kontrol GPIO Relay & Push Button --------------------

bool isSafeEsp8266Gpio(int pin) {
  switch (pin) {
    case 0:   // D3 (BTN2)
    case 2:   // D4 (BTN3 / LED internal)
    case 4:   // D2 (Relay CH2)
    case 5:   // D1 (Relay CH1)
    case 12:  // D6 (Relay CH4)
    case 13:  // D7 (BTN1)
    case 14:  // D5 (Relay CH3)
    case 15:  // D8
    case 16:  // D0 (BTN4)
      return true;
    default:
      return false;
  }
}

int toOutputLevel(bool isOn, bool activeLow) {
  return activeLow ? (isOn ? LOW : HIGH) : (isOn ? HIGH : LOW);
}

int findPinIndex(int pin) {
  for (int i = 0; i < managedPinCount; i++) {
    if (managedPins[i].pin == pin) {
      return i;
    }
  }
  return -1;
}

bool hasDirtyPins() {
  for (int i = 0; i < managedPinCount; i++) {
    if (managedPins[i].dirty) return true;
  }
  return false;
}

void registerOrUpdatePin(
  int pin,
  bool isOn,
  bool activeLow,
  bool isBoardChannel,
  bool fromLocalAction,
  bool markDirty
) {
  if (!isSafeEsp8266Gpio(pin)) {
    Serial.printf("[WARN] GPIO %d dilewati karena tidak aman.\n", pin);
    return;
  }

  int level = toOutputLevel(isOn, activeLow);
  int idx = findPinIndex(pin);

  if (idx < 0) {
    if (managedPinCount >= MAX_MANAGED_PINS) {
      Serial.println("[ERR] Batas MAX_MANAGED_PINS tercapai.");
      return;
    }

    idx = managedPinCount++;
    managedPins[idx].pin = pin;
    managedPins[idx].activeLow = activeLow;
    managedPins[idx].lastOn = isOn;
    managedPins[idx].isBoardChannel = isBoardChannel;
    managedPins[idx].dirty = markDirty;
    managedPins[idx].touchGen = fromLocalAction ? 1 : 0;

    // Tulis level output sebelum pinMode(OUTPUT) agar relay tidak berkedip saat boot
    digitalWrite(pin, level);
    pinMode(pin, OUTPUT);

    Serial.printf(
      "[INIT] Relay GPIO %d (%s) -> %s\n",
      pin,
      activeLow ? "Active-LOW" : "Active-HIGH",
      isOn ? "ON" : "OFF"
    );
    return;
  }

  if (isBoardChannel) {
    managedPins[idx].isBoardChannel = true;
  }

  bool changed = (managedPins[idx].lastOn != isOn) || (managedPins[idx].activeLow != activeLow);
  managedPins[idx].activeLow = activeLow;
  managedPins[idx].lastOn = isOn;
  digitalWrite(pin, level);

  if (fromLocalAction) {
    managedPins[idx].touchGen++;
    if (markDirty) {
      managedPins[idx].dirty = true;
    }
  }

  if (changed) {
    Serial.printf(
      "[%s] Relay GPIO %d -> %s\n",
      fromLocalAction ? "BTN" : "SYNC",
      pin,
      isOn ? "ON" : "OFF"
    );
    scheduleSnapshotSave();
  }
}

void removeUnseenNonBoardPins(const bool seen[]) {
  int writeIdx = 0;
  for (int i = 0; i < managedPinCount; i++) {
    if (seen[i] || managedPins[i].isBoardChannel) {
      if (writeIdx != i) {
        managedPins[writeIdx] = managedPins[i];
      }
      writeIdx++;
    } else {
      int offLevel = toOutputLevel(false, managedPins[i].activeLow);
      digitalWrite(managedPins[i].pin, offLevel);
      Serial.printf("[CLEANUP] Pin eksternal GPIO %d dihapus dari Web -> OFF\n", managedPins[i].pin);
    }
  }
  managedPinCount = writeIdx;
}

void initLocalBoardHardware() {
  unsigned long now = millis();
  bool shouldRestore = (relaySnapshot.restoreBoot != 0);

  for (int i = 0; i < NUM_BOARD_CHANNELS; i++) {
    bool initialOn = shouldRestore ? ((relaySnapshot.onMask & (1 << i)) != 0) : false;
    bool initialDirty = shouldRestore ? ((relaySnapshot.dirtyMask & (1 << i)) != 0) : true;

    // Jika mode mulai OFF semua namun state sebelumnya di server ON, tandai dirty supaya sync
    if (!shouldRestore && ((relaySnapshot.onMask & (1 << i)) != 0)) {
      initialDirty = true;
    }

    registerOrUpdatePin(
      BOARD_RELAY_PINS[i],
      initialOn,
      BOARD_RELAY_ACTIVE_LOW,
      true,
      false,
      initialDirty
    );

    int btnPin = BOARD_BUTTON_PINS[i];
    if (btnPin == 16) {
      // GPIO 16 tidak punya internal pull-up -> wajib pull-up eksternal 4.7k ke 3V3 di PCB
      pinMode(btnPin, INPUT);
    } else {
      pinMode(btnPin, INPUT_PULLUP);
    }

    buttons[i].pin = btnPin;
    buttons[i].relayPin = BOARD_RELAY_PINS[i];
    buttons[i].armed = false;
    buttons[i].isPressed = false;
    buttons[i].lastSample = digitalRead(btnPin);
    buttons[i].highStableSince = (buttons[i].lastSample == HIGH) ? now : 0;
    buttons[i].sampleStableSince = now;
    buttons[i].cooldownUntil = 0;
  }

  if (hasDirtyPins()) {
    pushScheduled = true;
    pushScheduledAt = now + 200;
  }
}

void triggerLocalButtonToggle(int chIndex) {
  int relayPin = buttons[chIndex].relayPin;
  int idx = findPinIndex(relayPin);
  bool nextOn = true;
  bool activeLow = BOARD_RELAY_ACTIVE_LOW;

  if (idx >= 0) {
    nextOn = !managedPins[idx].lastOn;
    activeLow = managedPins[idx].activeLow;
  }

  registerOrUpdatePin(relayPin, nextOn, activeLow, true, true, true);

  // Jadwalkan push kilat ke server (batching 120ms bila menekan >1 tombol hampir bersamaan)
  pushScheduled = true;
  pushScheduledAt = millis() + PUSH_DEBOUNCE_MS;
}

void enterConfigPortal(const String& reason, bool allowAutoRetry);

void handleLocalButtons() {
  unsigned long now = millis();

  for (int i = 0; i < NUM_BOARD_CHANNELS; i++) {
    ButtonTracker& b = buttons[i];
    int raw = digitalRead(b.pin);

    // Tahap 1: pastikan pin benar-benar stabil HIGH dulu setelah boot
    // (Melindungi jika D0 belum ada pull-up eksternal atau tombol tertahan saat dinyalakan)
    if (!b.armed) {
      if (raw == HIGH) {
        if (b.highStableSince == 0) {
          b.highStableSince = now;
        } else if (now - b.highStableSince >= BTN_ARM_HIGH_MS) {
          b.armed = true;
          b.isPressed = false;
          b.lastSample = HIGH;
          b.sampleStableSince = now;
          Serial.printf("[BTN] CH%d (GPIO %d) siap digunakan.\n", i + 1, b.pin);
        }
      } else {
        b.highStableSince = 0;
      }
      continue;
    }

    // Tahap 2: catat perubahan level mentah untuk debounce
    if (raw != b.lastSample) {
      b.lastSample = raw;
      b.sampleStableSince = now;
      continue;
    }

    // Tahap 3: State machine Idle (HIGH) <-> Pressed (LOW)
    if (!b.isPressed) {
      if (raw == LOW &&
          (long)(now - b.cooldownUntil) >= 0 &&
          (now - b.sampleStableSince >= BTN_PRESS_DEBOUNCE_MS)) {
        b.isPressed = true;
        triggerLocalButtonToggle(i);
      }
    } else {
      if (raw == HIGH && (now - b.sampleStableSince >= BTN_RELEASE_DEBOUNCE_MS)) {
        b.isPressed = false;
        b.cooldownUntil = now + BTN_COOLDOWN_MS;
      }
    }
  }

  // Combo masuk Portal Setup: tahan BTN1 (CH1) + BTN2 (CH2) selama 5 detik
  if (!inPortalMode && NUM_BOARD_CHANNELS >= 2 &&
      buttons[0].armed && buttons[1].armed &&
      buttons[0].isPressed && buttons[1].isPressed) {
    if (setupComboHeldSince == 0) {
      setupComboHeldSince = now;
      setupComboTriggered = false;
    } else if (!setupComboTriggered && (now - setupComboHeldSince >= BTN_SETUP_HOLD_MS)) {
      setupComboTriggered = true;
      enterConfigPortal("Masuk Mode Setup via kombinasi tahan BTN1 + BTN2 (5 detik).", true);
    }
  } else {
    setupComboHeldSince = 0;
    setupComboTriggered = false;
  }
}

void handleDeferredEepromSave() {
  if (eepromStateSavePending && (long)(millis() - eepromStateSaveAt) >= 0) {
    saveSnapshotNow();
  }
}

// -------------------- Captive Portal (Mode Access Point) --------------------

void scanNearbyWiFi() {
  scannedCount = 0;
  WiFi.softAPdisconnect(true);
  WiFi.disconnect(false);
  WiFi.mode(WIFI_STA);
  delay(80);

  Serial.println("[AP] Memindai jaringan Wi-Fi sekitar...");
  int found = WiFi.scanNetworks(false, false);
  for (int i = 0; i < found && scannedCount < MAX_SCANNED_NETWORKS; i++) {
    String candidate = WiFi.SSID(i);
    if (candidate.length() == 0) continue;

    bool duplicate = false;
    for (int j = 0; j < scannedCount; j++) {
      if (scannedNetworks[j].ssid == candidate) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      scannedNetworks[scannedCount].ssid = candidate;
      scannedNetworks[scannedCount].rssi = WiFi.RSSI(i);
      scannedNetworks[scannedCount].open = (WiFi.encryptionType(i) == ENC_TYPE_NONE);
      scannedCount++;
    }
  }
  WiFi.scanDelete();
}

String buildPortalPage(const String& errorMsg) {
  String page;
  page.reserve(4600);

  page += F("<!DOCTYPE html><html lang='id'><head><meta charset='UTF-8'>");
  page += F("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  page += F("<title>Setup NodeMCU Smart Home</title>");
  page += F("<style>");
  page += F("*{box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}");
  page += F("body{margin:0;padding:16px;background:#090d16;color:#e2e8f0}");
  page += F(".card{max-width:440px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:14px;padding:18px}");
  page += F("h1{margin:0 0 6px;font-size:18px;color:#34d399}");
  page += F("p.sub{margin:0 0 14px;font-size:12px;color:#94a3b8;line-height:1.45}");
  page += F(".alert{padding:10px 12px;border-radius:10px;font-size:12px;margin-bottom:14px;line-height:1.45}");
  page += F(".warn{background:#422006;border:1px solid #92400e;color:#fde68a}");
  page += F(".err{background:#450a0a;border:1px solid #991b1b;color:#fecaca}");
  page += F("label{display:block;font-size:12px;font-weight:600;margin:10px 0 4px;color:#cbd5e1}");
  page += F("input[type=text],input[type=password]{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#020617;color:#f8fafc;font-size:13px}");
  page += F("input:focus{outline:none;border-color:#10b981}");
  page += F(".nets{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}");
  page += F(".chip{padding:5px 9px;border-radius:999px;border:1px solid #334155;background:#0f172a;color:#cbd5e1;font-size:11px;cursor:pointer}");
  page += F(".chip:hover{border-color:#10b981;color:#34d399}");
  page += F(".row{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:#cbd5e1;font-weight:400}");
  page += F(".row input{width:auto;margin:0}");
  page += F("button.btn{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#10b981;color:#022c22;font-weight:700;font-size:14px;cursor:pointer}");
  page += F("button.btn:hover{background:#34d399}");
  page += F(".hint{font-size:11px;color:#64748b;margin-top:4px}");
  page += F("</style></head><body><div class='card'>");
  page += F("<h1>Smart Home AI • Setup NodeMCU</h1>");
  page += F("<p class='sub'>Isi jaringan Wi-Fi dan Device Token dari menu <b>NodeMCU</b> di Web Dashboard. Ke-4 Push Button tetap aktif selama mode setup.</p>");

  if (portalReason.length() > 0) {
    page += F("<div class='alert warn'>");
    page += htmlEscape(portalReason);
    page += F("</div>");
  }
  if (errorMsg.length() > 0) {
    page += F("<div class='alert err'>");
    page += htmlEscape(errorMsg);
    page += F("</div>");
  }

  page += F("<form method='POST' action='/save'>");
  page += F("<label>Pilih Wi-Fi (2.4 GHz)</label>");
  if (scannedCount > 0) {
    page += F("<div class='nets'>");
    for (int i = 0; i < scannedCount; i++) {
      page += F("<button type='button' class='chip' onclick=\"document.getElementById('ssid').value=this.dataset.s\" data-s=\"");
      page += htmlEscape(scannedNetworks[i].ssid);
      page += F("\">");
      page += htmlEscape(scannedNetworks[i].ssid);
      page += F(" (");
      page += String(scannedNetworks[i].rssi);
      page += F("dBm)</button>");
    }
    page += F("</div>");
  } else {
    page += F("<div class='hint'>Tidak ada Wi-Fi terdeteksi, ketik manual di bawah.</div>");
  }

  page += F("<label for='ssid'>Nama Wi-Fi (SSID)</label>");
  page += F("<input id='ssid' name='ssid' type='text' required maxlength='63' value=\"");
  page += htmlEscape(String(appConfig.ssid));
  page += F("\" placeholder='Contoh: WiFi_Rumah'>");

  page += F("<label for='pass'>Password Wi-Fi</label>");
  page += F("<input id='pass' name='password' type='password' maxlength='63' placeholder='Kosongkan jika ingin memakai password lama'>");
  page += F("<label class='row'><input type='checkbox' onclick=\"var p=document.getElementById('pass');p.type=this.checked?'text':'password'\"> Tampilkan password</label>");

  page += F("<label for='token'>Device Token (dari Web Dashboard)</label>");
  page += F("<input id='token' name='token' type='text' required maxlength='95' value=\"");
  page += htmlEscape(String(appConfig.deviceToken));
  page += F("\" placeholder='Contoh: 05d49be934e82dddc5a4b321887f...'>");

  page += F("<label for='url'>URL Server Sync (/api/iot/sync)</label>");
  page += F("<input id='url' name='sync_url' type='text' required maxlength='159' value=\"");
  page += htmlEscape(String(appConfig.syncUrl));
  page += F("\" placeholder='https://domain-kamu.vercel.app/api/iot/sync'>");
  page += F("<div class='hint'>Jika tes lokal pakai IP LAN PC, misal: http://192.168.1.10:3000/api/iot/sync</div>");

  page += F("<label class='row' style='margin-top:12px'><input type='checkbox' name='restore_boot' value='1'");
  if (relaySnapshot.restoreBoot != 0) page += F(" checked");
  page += F("> Pulihkan status relay terakhir (EEPROM) saat listrik menyala</label>");

  page += F("<button class='btn' type='submit'>Simpan &amp; Hubungkan</button>");
  page += F("</form></div></body></html>");
  return page;
}

void handlePortalRoot() {
  webServer.send(200, "text/html", buildPortalPage(""));
}

void handlePortalSave() {
  if (pendingRestart) {
    webServer.send(200, "text/plain", "NodeMCU sedang restart...");
    return;
  }

  String ssid = webServer.arg("ssid");
  String password = webServer.arg("password");
  String token = webServer.arg("token");
  String syncUrl = normalizeSyncUrl(webServer.arg("sync_url"));
  bool restoreBoot = webServer.hasArg("restore_boot");

  token.trim();

  if (ssid.length() == 0) {
    webServer.send(400, "text/html", buildPortalPage("Nama Wi-Fi (SSID) wajib diisi."));
    return;
  }
  if (token.length() == 0) {
    webServer.send(400, "text/html", buildPortalPage("Device Token dari Web Dashboard wajib diisi."));
    return;
  }
  if (!syncUrl.startsWith("http://") && !syncUrl.startsWith("https://")) {
    webServer.send(400, "text/html", buildPortalPage("URL Server Sync harus diawali http:// atau https://"));
    return;
  }

  // Jika SSID sama dan kolom password dikosongkan saat ganti token/setting, pertahankan password lama
  bool sameSsid = (ssid == String(appConfig.ssid));
  if (password.length() == 0 && sameSsid && strlen(appConfig.password) > 0) {
    password = String(appConfig.password);
  }

  safeCopy(appConfig.ssid, sizeof(appConfig.ssid), ssid);
  safeCopy(appConfig.password, sizeof(appConfig.password), password);
  safeCopy(appConfig.deviceToken, sizeof(appConfig.deviceToken), token);
  safeCopy(appConfig.syncUrl, sizeof(appConfig.syncUrl), syncUrl);
  saveConfig();

  relaySnapshot.restoreBoot = restoreBoot ? 1 : 0;
  saveSnapshotNow();

  String okHtml;
  okHtml.reserve(900);
  okHtml += F("<!DOCTYPE html><html lang='id'><head><meta charset='UTF-8'>");
  okHtml += F("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  okHtml += F("<title>Menyimpan...</title>");
  okHtml += F("<style>body{margin:0;padding:24px;background:#090d16;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center}");
  okHtml += F(".box{max-width:420px;margin:20px auto;background:#111827;border:1px solid #10b981;border-radius:14px;padding:20px}</style></head>");
  okHtml += F("<body><div class='box'><h2 style='color:#34d399;margin-top:0'>Konfigurasi Tersimpan!</h2>");
  okHtml += F("<p style='font-size:13px;line-height:1.5'>NodeMCU akan restart dan menyambung ke Wi-Fi <b>");
  okHtml += htmlEscape(ssid);
  okHtml += F("</b>.<br><br>Ke-4 tombol Push Button tetap bekerja otomatis meski Wi-Fi sedang tidak tersedia.</p>");
  okHtml += F("</div></body></html>");

  webServer.sendHeader("Connection", "close");
  webServer.send(200, "text/html", okHtml);
  Serial.println("[PORTAL] Konfigurasi disimpan. Menjadwalkan restart NodeMCU...");
  pendingRestart = true;
  pendingRestartAt = millis() + 1500;
}

void handleCaptiveRedirect() {
  webServer.sendHeader("Location", "http://192.168.4.1/", true);
  webServer.send(302, "text/plain", "");
}

void enterConfigPortal(const String& reason, bool allowAutoRetry) {
  if (inPortalMode) return;

  saveSnapshotNow();
  inPortalMode = true;
  portalAllowAutoRetry = allowAutoRetry && hasRequiredConfig();
  portalEnteredAt = millis();
  pendingRestart = false;
  portalReason = reason;
  unauthorizedStreak = 0;

  Serial.println("\n==========================================");
  Serial.println("[PORTAL] Masuk ke Mode Access Point Setup");
  Serial.println("[PORTAL] Alasan: " + reason);

  scanNearbyWiFi();

  uint16_t chipSuffix = (uint16_t)(ESP.getChipId() & 0xFFFF);
  char apBuf[32];
  snprintf(apBuf, sizeof(apBuf), "SmartHome-Setup-%04X", chipSuffix);
  apSsidName = String(apBuf);

  IPAddress apIP(192, 168, 4, 1);
  IPAddress netMask(255, 255, 255, 0);

  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIP, apIP, netMask);
  WiFi.softAP(apSsidName.c_str());

  dnsServer.setErrorReplyCode(DNSReplyCode::NoError);
  dnsServer.start(53, "*", apIP);

  webServer.on("/", HTTP_GET, handlePortalRoot);
  webServer.on("/save", HTTP_POST, handlePortalSave);
  webServer.on("/favicon.ico", HTTP_GET, []() {
    webServer.send(204, "text/plain", "");
  });
  webServer.on("/generate_204", HTTP_GET, handleCaptiveRedirect);
  webServer.on("/hotspot-detect.html", HTTP_GET, handleCaptiveRedirect);
  webServer.on("/connecttest.txt", HTTP_GET, handleCaptiveRedirect);
  webServer.on("/ncsi.txt", HTTP_GET, handleCaptiveRedirect);
  webServer.onNotFound(handleCaptiveRedirect);
  webServer.begin();

  Serial.println("[PORTAL] Wi-Fi AP Aktif : " + apSsidName + " (tanpa password)");
  Serial.println("[PORTAL] Buka browser ke: http://192.168.4.1");
  Serial.println("==========================================\n");
}

// -------------------- Koneksi Wi-Fi Non-Blocking & Sync Dua Arah --------------------

void startWiFiNonBlocking() {
  if (!hasRequiredConfig()) return;

  lastWifiAttemptAt = millis();
  Serial.printf("[WIFI] Menyambung ke \"%s\" di latar belakang (Push Button tetap aktif)...\n", appConfig.ssid);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  if (strlen(appConfig.password) > 0) {
    WiFi.begin(appConfig.ssid, appConfig.password);
  } else {
    WiFi.begin(appConfig.ssid);
  }
}

int skipJsonWs(const String& s, int pos, int limit) {
  while (pos < limit) {
    char c = s[pos];
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
      pos++;
    } else {
      break;
    }
  }
  return pos;
}

int findJsonKeyValueStart(const String& s, const char* key, int from, int limit) {
  String needle = String("\"") + key + "\"";
  int pos = from;
  while (pos < limit) {
    int idx = s.indexOf(needle, pos);
    if (idx < 0 || idx + (int)needle.length() >= limit) return -1;
    int after = skipJsonWs(s, idx + (int)needle.length(), limit);
    if (after < limit && s[after] == ':') {
      return skipJsonWs(s, after + 1, limit);
    }
    pos = idx + (int)needle.length();
  }
  return -1;
}

bool readJsonBool(const String& s, const char* key, int from, int limit, bool defaultVal) {
  int valPos = findJsonKeyValueStart(s, key, from, limit);
  if (valPos < 0) return defaultVal;
  if (valPos + 4 <= limit && s.substring(valPos, valPos + 4) == "true") return true;
  if (valPos + 5 <= limit && s.substring(valPos, valPos + 5) == "false") return false;
  return defaultVal;
}

int readJsonInt(const String& s, const char* key, int from, int limit, int defaultVal) {
  int valPos = findJsonKeyValueStart(s, key, from, limit);
  if (valPos < 0 || valPos >= limit) return defaultVal;
  bool negative = false;
  if (s[valPos] == '-') {
    negative = true;
    valPos++;
  }
  int result = 0;
  bool hasDigit = false;
  while (valPos < limit && s[valPos] >= '0' && s[valPos] <= '9') {
    hasDigit = true;
    result = result * 10 + (s[valPos] - '0');
    valPos++;
  }
  if (!hasDigit) return defaultVal;
  return negative ? -result : result;
}

void applySyncPayload(const String& payload, const uint32_t startTouchGen[]) {
  int len = (int)payload.length();
  if (!readJsonBool(payload, "ok", 0, len, false)) {
    Serial.println("[ERR] Respons server ok != true: " + payload);
    return;
  }

  int pinsStart = findJsonKeyValueStart(payload, "pins", 0, len);
  if (pinsStart < 0 || pinsStart >= len || payload[pinsStart] != '[') {
    Serial.println("[ERR] Format JSON pins tidak valid: " + payload);
    return;
  }

  int pinsEnd = payload.indexOf(']', pinsStart + 1);
  if (pinsEnd < 0) {
    Serial.println("[ERR] Format array pins terpotong: " + payload);
    return;
  }

  bool seen[MAX_MANAGED_PINS] = {false};
  int cursor = pinsStart + 1;
  while (cursor < pinsEnd) {
    int objStart = payload.indexOf('{', cursor);
    if (objStart < 0 || objStart >= pinsEnd) break;

    int objEnd = payload.indexOf('}', objStart + 1);
    if (objEnd < 0 || objEnd > pinsEnd) break;

    int pin = readJsonInt(payload, "pin", objStart + 1, objEnd, -1);
    bool isOn = readJsonBool(payload, "on", objStart + 1, objEnd, false);
    bool activeLow = readJsonBool(payload, "al", objStart + 1, objEnd, true);

    if (pin >= 0) {
      int idx = findPinIndex(pin);
      if (idx >= 0) {
        seen[idx] = true;

        // ANTI RACE-CONDITION:
        // Jika pin ini sedang dirty ATAU baru saja disentuh fisik saat HTTP berjalan,
        // jangan timpa status relay fisiknya memakai data server yang lebih tua!
        bool touchedInFlight = (managedPins[idx].touchGen != startTouchGen[idx]);
        if (managedPins[idx].dirty || touchedInFlight) {
          managedPins[idx].activeLow = activeLow;
          digitalWrite(pin, toOutputLevel(managedPins[idx].lastOn, activeLow));
        } else {
          registerOrUpdatePin(pin, isOn, activeLow, managedPins[idx].isBoardChannel, false, false);
        }
      } else {
        registerOrUpdatePin(pin, isOn, activeLow, false, false, false);
        int newIdx = findPinIndex(pin);
        if (newIdx >= 0 && newIdx < MAX_MANAGED_PINS) {
          seen[newIdx] = true;
        }
      }
    }

    cursor = objEnd + 1;
  }

  removeUnseenNonBoardPins(seen);

  if (!firstSyncSucceeded) {
    firstSyncSucceeded = true;
    Serial.printf("[OK] Sync pertama berhasil (%d pin aktif).\n", managedPinCount);
  }
}

String buildDirtyUpdatesJson(uint32_t sentTouchGen[], bool included[]) {
  String body;
  body.reserve(160);
  body += F("{\"updates\":[");
  bool first = true;

  for (int i = 0; i < managedPinCount; i++) {
    included[i] = false;
    sentTouchGen[i] = managedPins[i].touchGen;
    if (!managedPins[i].dirty) continue;

    if (!first) body += ',';
    body += F("{\"pin\":");
    body += String(managedPins[i].pin);
    body += F(",\"on\":");
    body += managedPins[i].lastOn ? F("true") : F("false");
    body += '}';
    first = false;
    included[i] = true;
  }

  body += F("]}");
  return body;
}

void syncWithServer() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  uint32_t startTouchGen[MAX_MANAGED_PINS] = {0};
  bool includedInPost[MAX_MANAGED_PINS] = {false};
  bool needPost = hasDirtyPins();
  String postBody = "";

  if (needPost) {
    postBody = buildDirtyUpdatesJson(startTouchGen, includedInPost);
  } else {
    for (int i = 0; i < managedPinCount; i++) {
      startTouchGen[i] = managedPins[i].touchGen;
    }
  }

  HTTPClient http;
  String url = String(appConfig.syncUrl);
  bool isHttps = url.startsWith("https://");

  WiFiClient wifiClient;
  WiFiClientSecure secureClient;

  bool begun = false;
  if (isHttps) {
    secureClient.setInsecure();
    secureClient.setTimeout(5000);
    begun = http.begin(secureClient, url);
  } else {
    wifiClient.setTimeout(5000);
    begun = http.begin(wifiClient, url);
  }

  if (!begun) {
    Serial.println("[ERR] Format URL Server Sync tidak valid: " + url);
    return;
  }

  http.setTimeout(5000);
  http.addHeader("x-device-token", appConfig.deviceToken);

  int httpCode = 0;
  if (needPost) {
    http.addHeader("Content-Type", "application/json");
    httpCode = http.POST(postBody);
  } else {
    httpCode = http.GET();
  }

  if (httpCode == HTTP_CODE_OK) {
    unauthorizedStreak = 0;
    String payload = http.getString();

    if (needPost) {
      bool anyCleared = false;
      for (int i = 0; i < managedPinCount; i++) {
        // Bersihkan dirty hanya jika tidak ada sentuhan baru selama POST berlangsung
        if (includedInPost[i] && managedPins[i].touchGen == startTouchGen[i]) {
          managedPins[i].dirty = false;
          anyCleared = true;
        }
      }
      if (anyCleared) {
        scheduleSnapshotSave();
      }
      Serial.println("[SYNC-UP] Perubahan push button berhasil dikirim ke server.");
    }

    applySyncPayload(payload, startTouchGen);
    pushScheduled = hasDirtyPins();
    if (pushScheduled) {
      pushScheduledAt = millis() + PUSH_DEBOUNCE_MS;
    }
  } else if (httpCode == HTTP_CODE_UNAUTHORIZED) {
    unauthorizedStreak++;
    Serial.printf("[ERR] HTTP 401: DEVICE_TOKEN tidak valid (%d/%d).\n",
                  unauthorizedStreak, MAX_UNAUTHORIZED_BEFORE_PORTAL);
    if (unauthorizedStreak >= MAX_UNAUTHORIZED_BEFORE_PORTAL) {
      http.end();
      enterConfigPortal("Device Token ditolak oleh server (HTTP 401). Silakan masukkan Token baru.", false);
      return;
    }
  } else if (httpCode == 301 || httpCode == 302 || httpCode == 307 || httpCode == 308) {
    Serial.printf("[ERR] HTTP %d (Redirect): Gunakan URL final (https://...) tanpa redirect.\n", httpCode);
  } else {
    Serial.printf("[ERR] Sync %s gagal, code: %d (%s) | FreeHeap: %u\n",
                  needPost ? "POST" : "GET",
                  httpCode, http.errorToString(httpCode).c_str(), ESP.getFreeHeap());
    if (needPost) {
      pushScheduled = true;
      pushScheduledAt = millis() + SYNC_RETRY_BACKOFF_MS;
    }
  }

  http.end();
}

void handleSerialCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  cmd.toUpperCase();

  if (cmd == "SETUP") {
    enterConfigPortal("Diminta manual melalui Serial Monitor.", true);
  } else if (cmd == "RESET") {
    Serial.println("[RESET] Menghapus konfigurasi EEPROM dan restart ke Mode Setup...");
    clearConfig();
    delay(300);
    ESP.restart();
  }
}

void setup() {
  Serial.begin(115200);
  delay(80);
  Serial.println("\n=== Smart Home AI NodeMCU Boot (Offline-First + 4x Push Button) ===");
  Serial.println("[INFO] Ketik SETUP / RESET di Serial, atau tahan BTN1+BTN2 5 detik untuk Portal.");

  loadConfigAndSnapshot();

  // PRIORITAS #1: Aktifkan 4 relay + 4 push button langsung sebelum mengurus Wi-Fi!
  initLocalBoardHardware();

  if (!hasRequiredConfig()) {
    enterConfigPortal("Konfigurasi awal setelah flash. Silakan masukkan Wi-Fi, Password, dan Token.", false);
    return;
  }

  startWiFiNonBlocking();
}

void loop() {
  // SELALU eksekusi input tombol & perintah serial terlebih dahulu (nol blocking!)
  handleSerialCommands();
  handleLocalButtons();
  handleDeferredEepromSave();

  if (inPortalMode) {
    dnsServer.processNextRequest();
    webServer.handleClient();

    if (pendingRestart && (long)(millis() - pendingRestartAt) >= 0) {
      saveSnapshotNow();
      Serial.println("[PORTAL] Restarting NodeMCU...");
      delay(50);
      ESP.restart();
    }

    if (portalAllowAutoRetry && !pendingRestart &&
        WiFi.softAPgetStationNum() == 0 &&
        (millis() - portalEnteredAt >= PORTAL_AUTO_RETRY_MS)) {
      Serial.println("[PORTAL] Belum ada klien; kembali mencoba Wi-Fi STA...");
      dnsServer.stop();
      webServer.stop();
      WiFi.softAPdisconnect(true);
      inPortalMode = false;
      startWiFiNonBlocking();
    }

    yield();
    return;
  }

  bool connected = (WiFi.status() == WL_CONNECTED);
  unsigned long now = millis();

  if (!connected) {
    if (wasWifiConnected) {
      wasWifiConnected = false;
      Serial.println("[WIFI] Koneksi terputus — mode offline aktif, Push Button tetap jalan.");
      lastWifiAttemptAt = now;
    } else if (hasRequiredConfig() && (long)(now - lastWifiAttemptAt) >= (long)WIFI_RETRY_INTERVAL_MS) {
      // Coba sambung ulang secara berkala tanpa memutus eksekusi Push Button
      startWiFiNonBlocking();
    }

    yield();
    return;
  }

  if (!wasWifiConnected) {
    wasWifiConnected = true;
    Serial.println("[WIFI] Terhubung! IP: " + WiFi.localIP().toString());
    // Begitu Wi-Fi menyala kembali, segera sinkronkan antrean sentuhan offline (atau tarik state server)
    lastSyncTime = now - SYNC_INTERVAL_MS;
    if (hasDirtyPins()) {
      pushScheduled = true;
      pushScheduledAt = now + 80;
    }
  }

  bool shouldPushNow = pushScheduled && ((long)(now - pushScheduledAt) >= 0);
  bool shouldPollNow = ((long)(now - lastSyncTime) >= (long)SYNC_INTERVAL_MS);

  if (shouldPushNow || shouldPollNow) {
    pushScheduled = false;
    syncWithServer();
    lastSyncTime = millis();
  }

  yield();
}
