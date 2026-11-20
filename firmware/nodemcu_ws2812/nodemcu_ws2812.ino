/**
 * Smart Home AI - Firmware NodeMCU (ESP8266) Khusus Lampu RGB WS2812 ("WLED Mandiri")
 *
 * Fitur Utama:
 * 1. Berdiri sendiri tanpa MQTT & tanpa layanan pihak ketiga: langsung konek Wi-Fi ke
 *    server Smart Home AI (/api/iot/led-sync) sehingga bisa dikontrol jarak jauh lewat
 *    Web Portal maupun Asisten AI (termasuk kontrol warna bebas, efek, preset, & mood AI).
 * 2. Captive Portal Setup ("SmartLED-Setup-XXXX" di 192.168.4.1):
 *    - Isi SSID Wi-Fi, Password, Device Token WLED dari tab "WLED", dan URL Server Sync.
 *    - Bisa dipanggil kapan saja dengan menahan tombol FLASH (D3/GPIO 0) di NodeMCU 5 detik,
 *      atau mengetik SETUP pada Serial Monitor.
 * 3. Animasi Smooth ~40 FPS dengan 8 Efek + Transisi Halus (Cross-Fade):
 *    - solid, breathe, rainbow, chase, sparkle, fire, meteor, gradient.
 *    - Jumlah LED (1..300) & pin Data otomatis menyesuaikan pengaturan dari Web UI.
 * 4. Tahan Offline + Tombol Darurat Bawaan (FLASH / GPIO 0):
 *    - Status warna & efek terakhir tersimpan di EEPROM.
 *    - Menekan tombol FLASH pada board NodeMCU (< 1 detik) menyalakan/mematikan LED secara
 *      instan meski Wi-Fi mati, lalu otomatis sinkron kembali saat Wi-Fi terhubung.
 *
 * Library yang wajib diinstall di Arduino IDE:
 * - Board   : esp8266 by ESP8266 Community (pilih "NodeMCU 1.0 (ESP-12E Module)")
 * - Library : "Adafruit NeoPixel" by Adafruit (via Library Manager)
 *
 * Pin Default:
 * - DATA WS2812 : D4 (GPIO 2) -> pasang resistor seri 330-470 Ohm ke pin DIN strip LED.
 * - PSU Strip   : Adaptor 5V 2A-5A langsung ke +5V & GND strip LED (satukan GND dgn NodeMCU).
 */

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <Adafruit_NeoPixel.h>

// ==================== KONFIGURASI DEFAULT ====================
const char* DEFAULT_LED_SYNC_URL = "http://192.168.0.163:3000/api/iot/led-sync";
const int DEFAULT_LED_PIN = 2;    // D4 (GPIO 2)
const int DEFAULT_LED_COUNT = 60; // Default 60 mata LED (otomatis ikut setting Web UI)

const unsigned long SYNC_INTERVAL_MS = 2000;       // Poll ke server setiap 2 detik
const unsigned long WIFI_RETRY_INTERVAL_MS = 15000;
const unsigned long PORTAL_AUTO_RETRY_MS = 120000;
const unsigned long EEPROM_SAVE_DELAY_MS = 5000;
const unsigned long FRAME_INTERVAL_MS = 35;        // ~28 FPS agar aman bagi interrupt Wi-Fi ESP8266
const int MAX_UNAUTHORIZED_BEFORE_PORTAL = 3;
// =============================================================

const uint32_t CONFIG_MAGIC = 0x574C4431; // "WLD1"
const uint32_t STATE_MAGIC = 0x4C535431;  // "LST1"
const int EEPROM_SIZE = 1024;
const int EEPROM_STATE_ADDR = 432;

struct StoredLedConfig {
  uint32_t magic;
  char ssid[64];
  char password[64];
  char deviceToken[96];
  char syncUrl[160];
  int16_t defaultLedCount;
  int16_t defaultPin;
};

struct LocalLedSnapshot {
  uint32_t magic;
  uint8_t isOn;
  uint8_t dirtyOn;
  uint8_t brightness;
  uint8_t r;
  uint8_t g;
  uint8_t b;
  uint8_t speed;
  uint8_t pin;
  uint16_t ledCount;
  char effect[16];
};

struct ScannedNetwork {
  String ssid;
  int rssi;
};

const int MAX_SCANNED_NETWORKS = 12;
ScannedNetwork scannedNetworks[MAX_SCANNED_NETWORKS];
int scannedCount = 0;

StoredLedConfig appConfig;
LocalLedSnapshot ledSnapshot;

ESP8266WebServer webServer(80);
DNSServer dnsServer;

Adafruit_NeoPixel* strip = nullptr;
int activePin = -1;
int activeLedCount = 0;

// Target state dari Server / Tombol
bool targetOn = false;
uint8_t targetBri = 180;
uint8_t targetR = 56;
uint8_t targetG = 189;
uint8_t targetB = 248;
uint8_t targetSpeed = 128;
String targetEffect = "solid";
bool dirtyOnState = false;
uint32_t localActionGen = 0;

// State interpolasi animasi saat ini (smooth fade)
float curBri = 0.0f;
float curR = 56.0f;
float curG = 189.0f;
float curB = 248.0f;

// State animasi efek
unsigned long lastFrameAt = 0;
unsigned long lastSolidRefreshAt = 0;
bool ledOutputDirty = true;
uint16_t animPhase = 0;
uint8_t fireHeat[300];

// Status Portal & Wi-Fi
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
int unauthorizedStreak = 0;
bool firstSyncSucceeded = false;
unsigned long lastErrorLogAt = 0;

bool eepromSavePending = false;
unsigned long eepromSaveAt = 0;

// Tombol fisik bawaan FLASH (GPIO 0) untuk toggle cepat offline & masuk Setup
const int FLASH_BUTTON_PIN = 0;
int lastBtnSample = HIGH;
bool btnIsPressed = false;
unsigned long btnStableSince = 0;
unsigned long btnPressedAt = 0;
bool btnHoldTriggered = false;

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
  if (url.length() > 0 && !url.endsWith("/api/iot/led-sync")) {
    url += "/api/iot/led-sync";
  }
  return url;
}

bool isSafeWs2812Gpio(int pin) {
  switch (pin) {
    case 0:
    case 2:
    case 4:
    case 5:
    case 12:
    case 13:
    case 14:
    case 15:
      return true;
    default:
      return false;
  }
}

void resetConfigToDefault() {
  memset(&appConfig, 0, sizeof(appConfig));
  appConfig.magic = CONFIG_MAGIC;
  safeCopy(appConfig.syncUrl, sizeof(appConfig.syncUrl), DEFAULT_LED_SYNC_URL);
  appConfig.defaultLedCount = DEFAULT_LED_COUNT;
  appConfig.defaultPin = DEFAULT_LED_PIN;
}

void resetSnapshotToDefault() {
  memset(&ledSnapshot, 0, sizeof(ledSnapshot));
  ledSnapshot.magic = STATE_MAGIC;
  ledSnapshot.isOn = 0;
  ledSnapshot.dirtyOn = 0;
  ledSnapshot.brightness = 180;
  ledSnapshot.r = 56;
  ledSnapshot.g = 189;
  ledSnapshot.b = 248;
  ledSnapshot.speed = 128;
  ledSnapshot.pin = DEFAULT_LED_PIN;
  ledSnapshot.ledCount = DEFAULT_LED_COUNT;
  safeCopy(ledSnapshot.effect, sizeof(ledSnapshot.effect), "solid");
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
      safeCopy(appConfig.syncUrl, sizeof(appConfig.syncUrl), DEFAULT_LED_SYNC_URL);
    }
    if (appConfig.defaultLedCount < 1 || appConfig.defaultLedCount > 300) {
      appConfig.defaultLedCount = DEFAULT_LED_COUNT;
    }
    if (!isSafeWs2812Gpio(appConfig.defaultPin)) {
      appConfig.defaultPin = DEFAULT_LED_PIN;
    }
  }

  EEPROM.get(EEPROM_STATE_ADDR, ledSnapshot);
  if (ledSnapshot.magic != STATE_MAGIC) {
    resetSnapshotToDefault();
    ledSnapshot.pin = (uint8_t)appConfig.defaultPin;
    ledSnapshot.ledCount = (uint16_t)appConfig.defaultLedCount;
  } else {
    ledSnapshot.effect[sizeof(ledSnapshot.effect) - 1] = '\0';
  }

  targetOn = ledSnapshot.isOn != 0;
  dirtyOnState = ledSnapshot.dirtyOn != 0;
  targetBri = ledSnapshot.brightness > 0 ? ledSnapshot.brightness : 180;
  targetR = ledSnapshot.r;
  targetG = ledSnapshot.g;
  targetB = ledSnapshot.b;
  targetSpeed = ledSnapshot.speed;
  targetEffect = strlen(ledSnapshot.effect) > 0 ? String(ledSnapshot.effect) : "solid";

  curBri = targetOn ? (float)targetBri : 0.0f;
  curR = (float)targetR;
  curG = (float)targetG;
  curB = (float)targetB;
}

void saveConfig() {
  appConfig.magic = CONFIG_MAGIC;
  EEPROM.put(0, appConfig);
  EEPROM.commit();
}

void saveSnapshotNow() {
  LocalLedSnapshot nextSnap;
  memset(&nextSnap, 0, sizeof(nextSnap));
  nextSnap.magic = STATE_MAGIC;
  nextSnap.isOn = targetOn ? 1 : 0;
  nextSnap.dirtyOn = dirtyOnState ? 1 : 0;
  nextSnap.brightness = targetBri;
  nextSnap.r = targetR;
  nextSnap.g = targetG;
  nextSnap.b = targetB;
  nextSnap.speed = targetSpeed;
  nextSnap.pin = (uint8_t)(activePin >= 0 ? activePin : appConfig.defaultPin);
  nextSnap.ledCount = (uint16_t)(activeLedCount > 0 ? activeLedCount : appConfig.defaultLedCount);
  safeCopy(nextSnap.effect, sizeof(nextSnap.effect), targetEffect);

  if (memcmp(&ledSnapshot, &nextSnap, sizeof(LocalLedSnapshot)) == 0) {
    eepromSavePending = false;
    return;
  }

  ledSnapshot = nextSnap;
  EEPROM.put(EEPROM_STATE_ADDR, ledSnapshot);
  EEPROM.commit();
  eepromSavePending = false;
}

void scheduleSnapshotSave() {
  eepromSavePending = true;
  eepromSaveAt = millis() + EEPROM_SAVE_DELAY_MS;
}

void clearConfig() {
  resetConfigToDefault();
  resetSnapshotToDefault();
  EEPROM.put(0, appConfig);
  EEPROM.put(EEPROM_STATE_ADDR, ledSnapshot);
  EEPROM.commit();
}

bool hasRequiredConfig() {
  return strlen(appConfig.ssid) > 0 &&
         strlen(appConfig.deviceToken) > 0 &&
         strlen(appConfig.syncUrl) > 0;
}

// -------------------- Pengaturan Strip WS2812 & Animasi --------------------

void configureStrip(int pin, int count) {
  if (!isSafeWs2812Gpio(pin)) pin = DEFAULT_LED_PIN;
  if (count < 1) count = 1;
  if (count > 300) count = 300;

  if (strip != nullptr && activePin == pin && activeLedCount == count) {
    return;
  }

  if (strip != nullptr) {
    strip->clear();
    strip->show();
    delete strip;
    strip = nullptr;
  }

  activePin = pin;
  activeLedCount = count;
  strip = new Adafruit_NeoPixel((uint16_t)count, (uint16_t)pin, NEO_GRB + NEO_KHZ800);
  strip->begin();
  strip->clear();
  strip->show();
  ledOutputDirty = true;

  Serial.printf("[LED] Strip WS2812 aktif: %d LED pada GPIO %d\n", activeLedCount, activePin);
}

uint32_t scaleColor(uint8_t r, uint8_t g, uint8_t b, float factor) {
  if (factor <= 0.0f) return 0;
  if (factor > 1.0f) factor = 1.0f;
  uint8_t sr = (uint8_t)(r * factor);
  uint8_t sg = (uint8_t)(g * factor);
  uint8_t sb = (uint8_t)(b * factor);
  return strip->Color(sr, sg, sb);
}

void colorWheel(uint8_t pos, uint8_t& outR, uint8_t& outG, uint8_t& outB) {
  pos = 255 - pos;
  if (pos < 85) {
    outR = 255 - pos * 3;
    outG = 0;
    outB = pos * 3;
  } else if (pos < 170) {
    pos -= 85;
    outR = 0;
    outG = pos * 3;
    outB = 255 - pos * 3;
  } else {
    pos -= 170;
    outR = pos * 3;
    outG = 255 - pos * 3;
    outB = 0;
  }
}

void renderLedFrame() {
  if (!strip || activeLedCount <= 0) return;

  unsigned long now = millis();
  if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
  lastFrameAt = now;

  // Interpolasi halus target kecerahan & warna (transisi lembut tanpa kaget)
  float goalBri = targetOn ? (float)targetBri : 0.0f;
  bool fading =
      (fabsf(goalBri - curBri) >= 0.6f) ||
      (fabsf((float)targetR - curR) >= 0.6f) ||
      (fabsf((float)targetG - curG) >= 0.6f) ||
      (fabsf((float)targetB - curB) >= 0.6f);

  curBri += (goalBri - curBri) * 0.20f;
  curR += ((float)targetR - curR) * 0.20f;
  curG += ((float)targetG - curG) * 0.20f;
  curB += ((float)targetB - curB) * 0.20f;

  if (!targetOn && curBri < 0.8f) {
    if (curBri > 0.0f || ledOutputDirty) {
      curBri = 0.0f;
      ledOutputDirty = false;
      strip->clear();
      strip->show();
    }
    return;
  }

  // Untuk mode "solid" yang sudah selesai transisi, kirim ulang ke strip cukup tiap 500ms
  // agar interrupt Wi-Fi & HTTPS TLS tidak terganggu pada strip > 100 LED.
  if (targetEffect == "solid" && !fading && !ledOutputDirty && (now - lastSolidRefreshAt < 500)) {
    return;
  }
  ledOutputDirty = false;
  if (targetEffect == "solid") {
    lastSolidRefreshAt = now;
  }

  float briFactor = curBri / 255.0f;
  uint8_t baseR = (uint8_t)constrain((int)curR, 0, 255);
  uint8_t baseG = (uint8_t)constrain((int)curG, 0, 255);
  uint8_t baseB = (uint8_t)constrain((int)curB, 0, 255);

  uint16_t stepAdvance = 1 + (targetSpeed / 24);
  animPhase += stepAdvance;

  if (targetEffect == "breathe") {
    // Gelombang sinus lembut dari 18% s/d 100% kecerahan
    float rad = (animPhase % 360) * 0.01745329f;
    float pulse = 0.59f + 0.41f * sinf(rad);
    uint32_t col = scaleColor(baseR, baseG, baseB, briFactor * pulse);
    for (int i = 0; i < activeLedCount; i++) {
      strip->setPixelColor(i, col);
    }
  } else if (targetEffect == "rainbow") {
    uint8_t offset = (uint8_t)((animPhase >> 1) & 0xFF);
    for (int i = 0; i < activeLedCount; i++) {
      uint8_t wr, wg, wb;
      colorWheel((uint8_t)(((i * 256 / activeLedCount) + offset) & 0xFF), wr, wg, wb);
      strip->setPixelColor(i, scaleColor(wr, wg, wb, briFactor));
    }
  } else if (targetEffect == "chase") {
    int pos = (animPhase >> 3) % activeLedCount;
    for (int i = 0; i < activeLedCount; i++) {
      int dist = (i - pos + activeLedCount) % activeLedCount;
      float f = (dist % 6 < 2) ? 1.0f : 0.12f;
      strip->setPixelColor(i, scaleColor(baseR, baseG, baseB, briFactor * f));
    }
  } else if (targetEffect == "sparkle") {
    uint32_t dimCol = scaleColor(baseR, baseG, baseB, briFactor * 0.25f);
    for (int i = 0; i < activeLedCount; i++) {
      strip->setPixelColor(i, dimCol);
    }
    int sparkles = max(1, activeLedCount / 12);
    for (int s = 0; s < sparkles; s++) {
      int idx = random(activeLedCount);
      uint8_t mixR = (uint8_t)min(255, (int)baseR + 90);
      uint8_t mixG = (uint8_t)min(255, (int)baseG + 90);
      uint8_t mixB = (uint8_t)min(255, (int)baseB + 90);
      strip->setPixelColor(idx, scaleColor(mixR, mixG, mixB, briFactor));
    }
  } else if (targetEffect == "fire") {
    int cooling = 45;
    int sparking = 90 + (targetSpeed / 3);
    for (int i = 0; i < activeLedCount; i++) {
      int cool = random(0, ((cooling * 10) / activeLedCount) + 2);
      fireHeat[i] = fireHeat[i] > cool ? fireHeat[i] - cool : 0;
    }
    for (int k = activeLedCount - 1; k >= 2; k--) {
      fireHeat[k] = (fireHeat[k - 1] + fireHeat[k - 2] + fireHeat[k - 2]) / 3;
    }
    if (random(255) < sparking) {
      int y = (int)random(min(7, activeLedCount));
      int nextHeat = (int)fireHeat[y] + (int)random(150, 255);
      fireHeat[y] = (uint8_t)min(255, nextHeat);
    }
    for (int j = 0; j < activeLedCount; j++) {
      uint8_t t192 = (uint8_t)((fireHeat[j] * 191) / 255);
      uint8_t heatRamp = (t192 & 0x3F) << 2;
      uint8_t fr, fg, fb;
      if (t192 > 0x80) {
        fr = 255; fg = 255; fb = heatRamp;
      } else if (t192 > 0x40) {
        fr = 255; fg = heatRamp; fb = 0;
      } else {
        fr = heatRamp; fg = 0; fb = 0;
      }
      strip->setPixelColor(j, scaleColor(fr, fg, fb, briFactor));
    }
  } else if (targetEffect == "meteor") {
    // Ekor komet lembut bergerak menyusuri strip
    for (int i = 0; i < activeLedCount; i++) {
      uint32_t old = strip->getPixelColor(i);
      uint8_t orr = (uint8_t)((old >> 16) & 0xFF);
      uint8_t org = (uint8_t)((old >> 8) & 0xFF);
      uint8_t orb = (uint8_t)(old & 0xFF);
      strip->setPixelColor(i, strip->Color((orr * 3) / 4, (org * 3) / 4, (orb * 3) / 4));
    }
    int head = (animPhase >> 2) % activeLedCount;
    strip->setPixelColor(head, scaleColor(baseR, baseG, baseB, briFactor));
    if (head > 0) {
      strip->setPixelColor(head - 1, scaleColor(baseR, baseG, baseB, briFactor * 0.7f));
    }
  } else if (targetEffect == "gradient") {
    // Gradasi halus antara warna utama dan warna komplementer lembut
    uint8_t secR = baseB;
    uint8_t secG = baseR;
    uint8_t secB = baseG;
    float shift = (animPhase % 360) * 0.01745329f;
    for (int i = 0; i < activeLedCount; i++) {
      float t = 0.5f + 0.5f * sinf(shift + ((float)i / activeLedCount) * 3.14159f * 2.0f);
      uint8_t mr = (uint8_t)(baseR * (1.0f - t) + secR * t);
      uint8_t mg = (uint8_t)(baseG * (1.0f - t) + secG * t);
      uint8_t mb = (uint8_t)(baseB * (1.0f - t) + secB * t);
      strip->setPixelColor(i, scaleColor(mr, mg, mb, briFactor));
    }
  } else {
    // Default: "solid"
    uint32_t col = scaleColor(baseR, baseG, baseB, briFactor);
    for (int i = 0; i < activeLedCount; i++) {
      strip->setPixelColor(i, col);
    }
  }

  strip->show();
  yield();
}

// -------------------- Tombol Bawaan NodeMCU (FLASH / GPIO 0) --------------------

void handleFlashButton() {
  // Jika pengguna memakai GPIO 0 sebagai pin Data LED, nonaktifkan pembacaan tombol FLASH
  if (activePin == FLASH_BUTTON_PIN) return;

  unsigned long now = millis();
  int raw = digitalRead(FLASH_BUTTON_PIN);
  if (raw != lastBtnSample) {
    lastBtnSample = raw;
    btnStableSince = now;
    return;
  }

  if (!btnIsPressed && raw == LOW && (now - btnStableSince >= 35)) {
    btnIsPressed = true;
    btnPressedAt = now;
    btnHoldTriggered = false;
  } else if (btnIsPressed) {
    if (!inPortalMode && !btnHoldTriggered && (now - btnPressedAt >= 5000)) {
      btnHoldTriggered = true;
      enterConfigPortal("Masuk Mode Setup via tahan tombol FLASH (5 detik).", true);
      return;
    }
    if (raw == HIGH && (now - btnStableSince >= 40)) {
      btnIsPressed = false;
      if (!btnHoldTriggered) {
        // Ketukan singkat -> toggle ON/OFF langsung (jalan meski Wi-Fi mati!)
        targetOn = !targetOn;
        dirtyOnState = true;
        ledOutputDirty = true;
        localActionGen++;
        pushScheduled = true;
        pushScheduledAt = now + 120;
        scheduleSnapshotSave();
        Serial.printf("[BTN] FLASH ditekan -> LED %s\n", targetOn ? "ON" : "OFF");
      }
    }
  }
}

// -------------------- Captive Portal (Access Point Setup) --------------------

void scanNearbyWiFi() {
  scannedCount = 0;
  WiFi.softAPdisconnect(true);
  WiFi.disconnect(false);
  WiFi.mode(WIFI_STA);
  delay(80);

  int found = WiFi.scanNetworks(false, false);
  for (int i = 0; i < found && scannedCount < MAX_SCANNED_NETWORKS; i++) {
    String candidate = WiFi.SSID(i);
    if (candidate.length() == 0) continue;
    bool dup = false;
    for (int j = 0; j < scannedCount; j++) {
      if (scannedNetworks[j].ssid == candidate) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      scannedNetworks[scannedCount].ssid = candidate;
      scannedNetworks[scannedCount].rssi = WiFi.RSSI(i);
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
  page += F("<title>Setup Smart LED WS2812</title>");
  page += F("<style>");
  page += F("*{box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}");
  page += F("body{margin:0;padding:16px;background:#090d16;color:#e2e8f0}");
  page += F(".card{max-width:440px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:14px;padding:18px}");
  page += F("h1{margin:0 0 6px;font-size:18px;color:#38bdf8}");
  page += F("p.sub{margin:0 0 14px;font-size:12px;color:#94a3b8;line-height:1.45}");
  page += F(".alert{padding:10px 12px;border-radius:10px;font-size:12px;margin-bottom:14px;line-height:1.45}");
  page += F(".warn{background:#422006;border:1px solid #92400e;color:#fde68a}");
  page += F(".err{background:#450a0a;border:1px solid #991b1b;color:#fecaca}");
  page += F("label{display:block;font-size:12px;font-weight:600;margin:10px 0 4px;color:#cbd5e1}");
  page += F("input[type=text],input[type=password],input[type=number]{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#020617;color:#f8fafc;font-size:13px}");
  page += F(".nets{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}");
  page += F(".chip{padding:5px 9px;border-radius:999px;border:1px solid #334155;background:#0f172a;color:#cbd5e1;font-size:11px;cursor:pointer}");
  page += F(".row{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:#94a3b8;font-weight:400}");
  page += F(".row input{width:auto;margin:0}");
  page += F("button.btn{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#38bdf8;color:#082f49;font-weight:700;font-size:14px;cursor:pointer}");
  page += F(".hint{font-size:11px;color:#64748b;margin-top:4px}");
  page += F("</style></head><body><div class='card'>");
  page += F("<h1>Smart Home AI • Setup Smart LED (WLED)</h1>");
  page += F("<p class='sub'>Isi jaringan Wi-Fi dan Device Token WLED dari tab <b>WLED</b> di Web Dashboard.</p>");

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
  }

  page += F("<label for='ssid'>Nama Wi-Fi (SSID)</label>");
  page += F("<input id='ssid' name='ssid' type='text' required maxlength='63' value=\"");
  page += htmlEscape(String(appConfig.ssid));
  page += F("\" placeholder='Contoh: WiFi_Rumah'>");

  page += F("<label for='pass'>Password Wi-Fi</label>");
  page += F("<input id='pass' name='password' type='password' maxlength='63' placeholder='Kosongkan jika ingin memakai password lama'>");
  page += F("<label class='row'><input type='checkbox' onclick=\"var p=document.getElementById('pass');p.type=this.checked?'text':'password'\"> Tampilkan password</label>");

  page += F("<label for='token'>Device Token WLED (dari Tab WLED)</label>");
  page += F("<input id='token' name='token' type='text' required maxlength='95' value=\"");
  page += htmlEscape(String(appConfig.deviceToken));
  page += F("\" placeholder='Salin token unit WLED di sini'>");

  page += F("<label for='url'>URL Server Sync (/api/iot/led-sync)</label>");
  page += F("<input id='url' name='sync_url' type='text' required maxlength='159' value=\"");
  page += htmlEscape(String(appConfig.syncUrl));
  page += F("\">");
  page += F("<div class='hint'>Contoh Vercel: https://domain-kamu.vercel.app/api/iot/led-sync</div>");

  page += F("<label for='ledn'>Jumlah LED Awal (1-300)</label>");
  page += F("<input id='ledn' name='led_count' type='number' min='1' max='300' value='");
  page += String(appConfig.defaultLedCount);
  page += F("'>");

  page += F("<button class='btn' type='submit'>Simpan &amp; Hubungkan</button>");
  page += F("</form></div></body></html>");
  return page;
}

void handlePortalRoot() {
  webServer.send(200, "text/html", buildPortalPage(""));
}

void handlePortalSave() {
  if (pendingRestart) {
    webServer.send(200, "text/plain", "Restarting...");
    return;
  }

  String ssid = webServer.arg("ssid");
  String password = webServer.arg("password");
  String token = webServer.arg("token");
  String syncUrl = normalizeSyncUrl(webServer.arg("sync_url"));
  int ledCountVal = webServer.arg("led_count").toInt();
  token.trim();

  if (ssid.length() == 0) {
    webServer.send(400, "text/html", buildPortalPage("Nama Wi-Fi (SSID) wajib diisi."));
    return;
  }
  if (token.length() == 0) {
    webServer.send(400, "text/html", buildPortalPage("Device Token WLED wajib diisi."));
    return;
  }
  if (!syncUrl.startsWith("http://") && !syncUrl.startsWith("https://")) {
    webServer.send(400, "text/html", buildPortalPage("URL Server Sync harus diawali http:// atau https://"));
    return;
  }
  String syncUrlLower = syncUrl;
  syncUrlLower.toLowerCase();
  if (syncUrlLower.indexOf("localhost") >= 0 || syncUrlLower.indexOf("127.0.0.1") >= 0) {
    webServer.send(400, "text/html", buildPortalPage("Jangan pakai localhost/127.0.0.1 karena NodeMCU tidak bisa mengakses localhost PC. Gunakan IP LAN PC (mis. http://192.168.0.163:3000/api/iot/led-sync) atau URL Vercel https://..."));
    return;
  }
  if (ledCountVal < 1 || ledCountVal > 300) ledCountVal = DEFAULT_LED_COUNT;

  bool sameSsid = (ssid == String(appConfig.ssid));
  if (password.length() == 0 && sameSsid && strlen(appConfig.password) > 0) {
    password = String(appConfig.password);
  }

  safeCopy(appConfig.ssid, sizeof(appConfig.ssid), ssid);
  safeCopy(appConfig.password, sizeof(appConfig.password), password);
  safeCopy(appConfig.deviceToken, sizeof(appConfig.deviceToken), token);
  safeCopy(appConfig.syncUrl, sizeof(appConfig.syncUrl), syncUrl);
  appConfig.defaultLedCount = (int16_t)ledCountVal;
  saveConfig();

  webServer.sendHeader("Connection", "close");
  webServer.send(200, "text/html",
                 F("<!DOCTYPE html><html><body style='background:#090d16;color:#e2e8f0;font-family:sans-serif;text-align:center;padding:30px'><h2 style='color:#38bdf8'>Konfigurasi WLED Tersimpan!</h2><p>NodeMCU sedang restart untuk menyambung ke Wi-Fi...</p></body></html>"));
  pendingRestart = true;
  pendingRestartAt = millis() + 1400;
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

  scanNearbyWiFi();

  uint16_t chipSuffix = (uint16_t)(ESP.getChipId() & 0xFFFF);
  char apBuf[32];
  snprintf(apBuf, sizeof(apBuf), "SmartLED-Setup-%04X", chipSuffix);
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
  webServer.on("/favicon.ico", HTTP_GET, []() { webServer.send(204, "text/plain", ""); });
  webServer.on("/generate_204", HTTP_GET, handleCaptiveRedirect);
  webServer.on("/hotspot-detect.html", HTTP_GET, handleCaptiveRedirect);
  webServer.on("/connecttest.txt", HTTP_GET, handleCaptiveRedirect);
  webServer.on("/ncsi.txt", HTTP_GET, handleCaptiveRedirect);
  webServer.onNotFound(handleCaptiveRedirect);
  webServer.begin();

  Serial.println("[PORTAL] AP Aktif: " + apSsidName + " -> http://192.168.4.1");
}

// -------------------- Koneksi Wi-Fi & Sync JSON LED --------------------

void startWiFiNonBlocking() {
  if (!hasRequiredConfig()) return;
  lastWifiAttemptAt = millis();
  Serial.printf("[WIFI] Menyambung ke \"%s\"...\n", appConfig.ssid);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFi.setAutoReconnect(true);
  if (strlen(appConfig.password) > 0) {
    WiFi.begin(appConfig.ssid, appConfig.password);
  } else {
    WiFi.begin(appConfig.ssid);
  }
}

int skipJsonWs(const String& s, int pos, int limit) {
  while (pos < limit && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\r' || s[pos] == '\n')) {
    pos++;
  }
  return pos;
}

int findJsonKeyStart(const String& s, const char* key, int limit) {
  String needle = String("\"") + key + "\"";
  int idx = s.indexOf(needle);
  if (idx < 0 || idx + (int)needle.length() >= limit) return -1;
  int after = skipJsonWs(s, idx + (int)needle.length(), limit);
  if (after < limit && s[after] == ':') {
    return skipJsonWs(s, after + 1, limit);
  }
  return -1;
}

bool readJsonBool(const String& s, const char* key, bool fallback) {
  int limit = (int)s.length();
  int p = findJsonKeyStart(s, key, limit);
  if (p < 0) return fallback;
  if (p + 4 <= limit && s.substring(p, p + 4) == "true") return true;
  if (p + 5 <= limit && s.substring(p, p + 5) == "false") return false;
  return fallback;
}

int readJsonInt(const String& s, const char* key, int fallback) {
  int limit = (int)s.length();
  int p = findJsonKeyStart(s, key, limit);
  if (p < 0 || p >= limit) return fallback;
  bool neg = false;
  if (s[p] == '-') {
    neg = true;
    p++;
  }
  int res = 0;
  bool hasDigit = false;
  while (p < limit && s[p] >= '0' && s[p] <= '9') {
    hasDigit = true;
    res = res * 10 + (s[p] - '0');
    p++;
  }
  if (!hasDigit) return fallback;
  return neg ? -res : res;
}

String readJsonString(const String& s, const char* key, const String& fallback) {
  int limit = (int)s.length();
  int p = findJsonKeyStart(s, key, limit);
  if (p < 0 || p >= limit || s[p] != '"') return fallback;
  int endQuote = s.indexOf('"', p + 1);
  if (endQuote < 0) return fallback;
  return s.substring(p + 1, endQuote);
}

void applyLedPayload(const String& payload, uint32_t genAtStart) {
  if (!readJsonBool(payload, "ok", false)) return;

  int nextPin = readJsonInt(payload, "pin", activePin);
  int nextCount = readJsonInt(payload, "n", activeLedCount);
  configureStrip(nextPin, nextCount);

  bool srvOn = readJsonBool(payload, "on", targetOn);
  int srvBri = constrain(readJsonInt(payload, "bri", targetBri), 1, 255);
  int srvR = constrain(readJsonInt(payload, "r", targetR), 0, 255);
  int srvG = constrain(readJsonInt(payload, "g", targetG), 0, 255);
  int srvB = constrain(readJsonInt(payload, "b", targetB), 0, 255);
  int srvSpd = constrain(readJsonInt(payload, "spd", targetSpeed), 0, 255);
  String srvFx = readJsonString(payload, "fx", targetEffect);

  bool changed = false;

  // Hanya terapkan "on" dari server jika tidak ada antrean perubahan tombol fisik
  if (!dirtyOnState && localActionGen == genAtStart) {
    if (targetOn != srvOn) {
      targetOn = srvOn;
      changed = true;
    }
  }

  if (targetBri != (uint8_t)srvBri ||
      targetR != (uint8_t)srvR ||
      targetG != (uint8_t)srvG ||
      targetB != (uint8_t)srvB ||
      targetSpeed != (uint8_t)srvSpd ||
      targetEffect != srvFx) {
    targetBri = (uint8_t)srvBri;
    targetR = (uint8_t)srvR;
    targetG = (uint8_t)srvG;
    targetB = (uint8_t)srvB;
    targetSpeed = (uint8_t)srvSpd;
    targetEffect = srvFx;
    changed = true;
  }

  if (changed) {
    ledOutputDirty = true;
    scheduleSnapshotSave();
    Serial.printf("[SYNC] ON=%d RGB=(%d,%d,%d) BRI=%d FX=%s\n",
                  targetOn ? 1 : 0, targetR, targetG, targetB, targetBri, targetEffect.c_str());
  }
}

void syncWithServer() {
  if (WiFi.status() != WL_CONNECTED) return;

  uint32_t genAtStart = localActionGen;
  bool needPost = dirtyOnState;

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
  if (!begun) return;

  http.setReuse(false);
  http.setTimeout(5000);
  http.addHeader("x-device-token", appConfig.deviceToken);

  int httpCode = 0;
  if (needPost) {
    http.addHeader("Content-Type", "application/json");
    String body = String("{\"on\":") + (targetOn ? "true" : "false") + "}";
    httpCode = http.POST(body);
  } else {
    httpCode = http.GET();
  }

  if (httpCode == HTTP_CODE_OK) {
    unauthorizedStreak = 0;
    String payload = http.getString();
    if (!firstSyncSucceeded) {
      firstSyncSucceeded = true;
      Serial.println("[OK] Sync pertama ke server WLED berhasil! Status di Web sekarang Online.");
    }
    if (needPost && localActionGen == genAtStart) {
      dirtyOnState = false;
      scheduleSnapshotSave();
    }
    applyLedPayload(payload, genAtStart);
  } else if (httpCode == HTTP_CODE_UNAUTHORIZED) {
    unauthorizedStreak++;
    Serial.printf("[ERR] HTTP 401 Token WLED salah (%d/%d).\n",
                  unauthorizedStreak, MAX_UNAUTHORIZED_BEFORE_PORTAL);
    if (unauthorizedStreak >= MAX_UNAUTHORIZED_BEFORE_PORTAL) {
      http.end();
      enterConfigPortal("Device Token WLED ditolak server (HTTP 401).", false);
      return;
    }
  } else {
    unsigned long nowErr = millis();
    if (nowErr - lastErrorLogAt >= 4000) {
      lastErrorLogAt = nowErr;
      Serial.printf("[ERR] Sync WLED gagal, code: %d (%s) | Heap: %u | URL: %s\n",
                    httpCode, http.errorToString(httpCode).c_str(), ESP.getFreeHeap(), url.c_str());
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
    enterConfigPortal("Diminta melalui Serial Monitor.", true);
  } else if (cmd == "RESET") {
    clearConfig();
    delay(250);
    ESP.restart();
  }
}

void setup() {
  Serial.begin(115200);
  delay(80);
  Serial.println("\n=== Smart Home AI - NodeMCU Smart LED (WS2812) ===");

  pinMode(FLASH_BUTTON_PIN, INPUT_PULLUP);
  loadConfigAndSnapshot();

  int initPin = isSafeWs2812Gpio(ledSnapshot.pin) ? ledSnapshot.pin : appConfig.defaultPin;
  int initCount = (ledSnapshot.ledCount >= 1 && ledSnapshot.ledCount <= 300)
                      ? ledSnapshot.ledCount
                      : appConfig.defaultLedCount;
  configureStrip(initPin, initCount);

  if (!hasRequiredConfig()) {
    enterConfigPortal("Konfigurasi awal Smart LED. Masukkan Wi-Fi & Device Token WLED.", false);
    return;
  }

  Serial.printf("[CFG] Sync URL: %s\n", appConfig.syncUrl);
  startWiFiNonBlocking();
}

void loop() {
  handleSerialCommands();
  handleFlashButton();
  renderLedFrame();

  if (eepromSavePending && (long)(millis() - eepromSaveAt) >= 0) {
    saveSnapshotNow();
  }

  if (inPortalMode) {
    dnsServer.processNextRequest();
    webServer.handleClient();

    if (pendingRestart && (long)(millis() - pendingRestartAt) >= 0) {
      saveSnapshotNow();
      delay(50);
      ESP.restart();
    }

    if (portalAllowAutoRetry && !pendingRestart &&
        WiFi.softAPgetStationNum() == 0 &&
        (millis() - portalEnteredAt >= PORTAL_AUTO_RETRY_MS)) {
      dnsServer.stop();
      webServer.stop();
      WiFi.softAPdisconnect(true);
      inPortalMode = false;
      startWiFiNonBlocking();
    }

    yield();
    return;
  }

  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (wasWifiConnected) {
      wasWifiConnected = false;
      lastWifiAttemptAt = now;
    } else if (hasRequiredConfig() && (long)(now - lastWifiAttemptAt) >= (long)WIFI_RETRY_INTERVAL_MS) {
      startWiFiNonBlocking();
    }
    yield();
    return;
  }

  if (!wasWifiConnected) {
    wasWifiConnected = true;
    Serial.println("[WIFI] Terhubung! IP: " + WiFi.localIP().toString());
    lastSyncTime = now - SYNC_INTERVAL_MS;
    if (dirtyOnState) {
      pushScheduled = true;
      pushScheduledAt = now + 80;
    }
  }

  bool doPush = pushScheduled && ((long)(now - pushScheduledAt) >= 0);
  bool doPoll = ((long)(now - lastSyncTime) >= (long)SYNC_INTERVAL_MS);

  if (doPush || doPoll) {
    pushScheduled = false;
    syncWithServer();
    lastSyncTime = millis();
  }

  yield();
}

