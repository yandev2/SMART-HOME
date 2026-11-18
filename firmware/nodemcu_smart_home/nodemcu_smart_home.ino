/**
 * Smart Home AI - Firmware Dinamis NodeMCU (ESP8266) dengan Captive Portal
 *
 * Alur Kerja Firmware:
 * 1. Flash pertama kali (EEPROM masih kosong) -> NodeMCU otomatis masuk Mode Access Point
 *    ("SmartHome-Setup-XXXX") dan membuka Portal Web (192.168.4.1).
 * 2. Pengguna mengisi Nama Wi-Fi (SSID), Password Wi-Fi, Device Token dari Web Dashboard,
 *    serta URL Server Sync.
 * 3. Konfigurasi disimpan permanen di EEPROM lalu NodeMCU menyambung ke Wi-Fi.
 * 4. Jika suatu saat Wi-Fi gagal konek, password salah, atau terputus melewati batas timeout
 *    -> NodeMCU otomatis masuk kembali ke Mode Access Point & Portal Web untuk meminta ulang
 *    SSID, Password Wi-Fi, dan Token.
 *
 * Library & Board yang dibutuhkan di Arduino IDE:
 * - Board   : esp8266 by ESP8266 Community (pilih "NodeMCU 1.0 (ESP-12E Module)")
 * - Library : TIDAK PERLU install library eksternal tambahan!
 *   (Semua library: ESP8266WiFi, ESP8266HTTPClient, ESP8266WebServer, DNSServer, EEPROM sudah bawaan core ESP8266)
 */

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include <EEPROM.h>

// ==================== KONFIGURASI DEFAULT ====================
// URL default yang muncul di form Captive Portal (bisa diubah langsung dari Web Portal)
// Contoh lokal  : "http://192.168.0.163:3000/api/iot/sync"
// Contoh Vercel : "https://nama-project-kamu.vercel.app/api/iot/sync"
const char* DEFAULT_SYNC_URL = "http://192.168.0.163:3000/api/iot/sync";

// Interval polling ke server (ms). 2500ms = 2.5 detik (batas Online di Web = 30 detik).
const unsigned long SYNC_INTERVAL_MS = 2500;

// Batas waktu mencoba koneksi Wi-Fi sebelum masuk ke mode Access Point (ms)
const unsigned long WIFI_BOOT_TIMEOUT_MS = 18000;
const unsigned long WIFI_RECONNECT_TIMEOUT_MS = 20000;

// Jika masuk mode AP karena timeout/router mati sementara (bukan password salah / HTTP 401 / manual)
// dan tidak ada HP yang terhubung ke AP selama interval ini, coba hubungkan Wi-Fi ulang otomatis.
const unsigned long PORTAL_AUTO_RETRY_MS = 120000;

// Jumlah error HTTP 401 beruntun sebelum meminta Token ulang via Access Point
const int MAX_UNAUTHORIZED_BEFORE_PORTAL = 3;
// =============================================================

const uint32_t CONFIG_MAGIC = 0x53484132; // "SHA2"
const int EEPROM_SIZE = 512;

struct StoredConfig {
  uint32_t magic;
  char ssid[64];
  char password[64];
  char deviceToken[96];
  char syncUrl[160];
};

struct PinState {
  int pin;
  bool activeLow;
  bool lastOn;
};

struct ScannedNetwork {
  String ssid;
  int rssi;
  bool open;
};

const int MAX_MANAGED_PINS = 12;
PinState managedPins[MAX_MANAGED_PINS];
int managedPinCount = 0;

const int MAX_SCANNED_NETWORKS = 12;
ScannedNetwork scannedNetworks[MAX_SCANNED_NETWORKS];
int scannedCount = 0;

StoredConfig appConfig;
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
unsigned long wifiDisconnectedAt = 0;
bool firstSyncSucceeded = false;
int unauthorizedStreak = 0;

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

void loadConfig() {
  EEPROM.begin(EEPROM_SIZE);
  EEPROM.get(0, appConfig);

  if (appConfig.magic != CONFIG_MAGIC) {
    resetConfigToDefault();
    return;
  }

  appConfig.ssid[sizeof(appConfig.ssid) - 1] = '\0';
  appConfig.password[sizeof(appConfig.password) - 1] = '\0';
  appConfig.deviceToken[sizeof(appConfig.deviceToken) - 1] = '\0';
  appConfig.syncUrl[sizeof(appConfig.syncUrl) - 1] = '\0';

  if (strlen(appConfig.syncUrl) == 0) {
    safeCopy(appConfig.syncUrl, sizeof(appConfig.syncUrl), DEFAULT_SYNC_URL);
  }
}

void saveConfig() {
  appConfig.magic = CONFIG_MAGIC;
  EEPROM.put(0, appConfig);
  EEPROM.commit();
}

void clearConfig() {
  resetConfigToDefault();
  EEPROM.put(0, appConfig);
  EEPROM.commit();
}

bool hasRequiredConfig() {
  return strlen(appConfig.ssid) > 0 &&
         strlen(appConfig.deviceToken) > 0 &&
         strlen(appConfig.syncUrl) > 0;
}

// -------------------- Kontrol GPIO Relay --------------------

bool isSafeEsp8266Gpio(int pin) {
  // GPIO 6..11 terhubung ke SPI Flash internal ESP8266 dan menyebabkan crash jika dipakai.
  switch (pin) {
    case 0:   // D3
    case 2:   // D4 (LED internal)
    case 4:   // D2 (Direkomendasikan)
    case 5:   // D1 (Direkomendasikan)
    case 12:  // D6 (Direkomendasikan)
    case 13:  // D7 (Direkomendasikan)
    case 14:  // D5 (Direkomendasikan)
    case 15:  // D8
    case 16:  // D0
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

void applyPinState(int pin, bool isOn, bool activeLow) {
  if (!isSafeEsp8266Gpio(pin)) {
    Serial.printf("[WARN] GPIO %d dilewati karena tidak aman untuk relay ESP8266.\n", pin);
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

    // Tulis level output sebelum pinMode(OUTPUT) agar relay tidak berkedip saat inisialisasi
    digitalWrite(pin, level);
    pinMode(pin, OUTPUT);

    Serial.printf(
      "[INIT] GPIO %d (%s) -> %s\n",
      pin,
      activeLow ? "Active-LOW" : "Active-HIGH",
      isOn ? "ON" : "OFF"
    );
    return;
  }

  bool changed = (managedPins[idx].lastOn != isOn) || (managedPins[idx].activeLow != activeLow);
  managedPins[idx].activeLow = activeLow;
  managedPins[idx].lastOn = isOn;
  digitalWrite(pin, level);

  if (changed) {
    Serial.printf("[SYNC] GPIO %d -> %s\n", pin, isOn ? "ON" : "OFF");
  }
}

void removeUnseenPins(const bool seen[]) {
  int writeIdx = 0;
  for (int i = 0; i < managedPinCount; i++) {
    if (seen[i]) {
      if (writeIdx != i) {
        managedPins[writeIdx] = managedPins[i];
      }
      writeIdx++;
    } else {
      int offLevel = toOutputLevel(false, managedPins[i].activeLow);
      digitalWrite(managedPins[i].pin, offLevel);
      Serial.printf("[CLEANUP] GPIO %d dihapus dari Web -> OFF\n", managedPins[i].pin);
    }
  }
  managedPinCount = writeIdx;
}

// -------------------- Captive Portal (Mode Access Point) --------------------

void scanNearbyWiFi() {
  scannedCount = 0;
  WiFi.softAPdisconnect(true);
  WiFi.disconnect(false);
  WiFi.mode(WIFI_STA);
  delay(120);

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
  page.reserve(4200);

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
  page += F("input{width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#020617;color:#f8fafc;font-size:13px}");
  page += F("input:focus{outline:none;border-color:#10b981}");
  page += F(".nets{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}");
  page += F(".chip{padding:5px 9px;border-radius:999px;border:1px solid #334155;background:#0f172a;color:#cbd5e1;font-size:11px;cursor:pointer}");
  page += F(".chip:hover{border-color:#10b981;color:#34d399}");
  page += F(".row{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;color:#94a3b8}");
  page += F(".row input{width:auto;margin:0}");
  page += F("button.btn{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#10b981;color:#022c22;font-weight:700;font-size:14px;cursor:pointer}");
  page += F("button.btn:hover{background:#34d399}");
  page += F(".hint{font-size:11px;color:#64748b;margin-top:4px}");
  page += F("</style></head><body><div class='card'>");
  page += F("<h1>Smart Home AI • Setup NodeMCU</h1>");
  page += F("<p class='sub'>Isi jaringan Wi-Fi dan Device Token dari menu <b>NodeMCU</b> di Web Dashboard.</p>");

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
  page += F("<input id='pass' name='password' type='password' maxlength='63' placeholder='Masukkan password Wi-Fi'>");
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

  safeCopy(appConfig.ssid, sizeof(appConfig.ssid), ssid);
  safeCopy(appConfig.password, sizeof(appConfig.password), password);
  safeCopy(appConfig.deviceToken, sizeof(appConfig.deviceToken), token);
  safeCopy(appConfig.syncUrl, sizeof(appConfig.syncUrl), syncUrl);
  saveConfig();

  String okHtml;
  okHtml.reserve(900);
  okHtml += F("<!DOCTYPE html><html lang='id'><head><meta charset='UTF-8'>");
  okHtml += F("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  okHtml += F("<title>Menyimpan...</title>");
  okHtml += F("<style>body{margin:0;padding:24px;background:#090d16;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center}");
  okHtml += F(".box{max-width:420px;margin:20px auto;background:#111827;border:1px solid #10b981;border-radius:14px;padding:20px}</style></head>");
  okHtml += F("<body><div class='box'><h2 style='color:#34d399;margin-top:0'>Konfigurasi Tersimpan!</h2>");
  okHtml += F("<p style='font-size:13px;line-height:1.5'>NodeMCU sedang restart untuk menyambung ke Wi-Fi <b>");
  okHtml += htmlEscape(ssid);
  okHtml += F("</b>.<br><br>Jika password salah atau gagal konek dalam 18 detik, Access Point setup akan muncul kembali secara otomatis.</p>");
  okHtml += F("</div></body></html>");

  webServer.sendHeader("Connection", "close");
  webServer.send(200, "text/html", okHtml);
  Serial.println("[PORTAL] Konfigurasi baru disimpan. Menjadwalkan restart NodeMCU...");
  pendingRestart = true;
  pendingRestartAt = millis() + 1500;
}

void handleCaptiveRedirect() {
  webServer.sendHeader("Location", "http://192.168.4.1/", true);
  webServer.send(302, "text/plain", "");
}

void enterConfigPortal(const String& reason, bool allowAutoRetry) {
  if (inPortalMode) return;

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
  webServer.on("/generate_204", HTTP_GET, handleCaptiveRedirect);       // Android
  webServer.on("/hotspot-detect.html", HTTP_GET, handleCaptiveRedirect); // Apple/iOS
  webServer.on("/connecttest.txt", HTTP_GET, handleCaptiveRedirect);     // Windows
  webServer.on("/ncsi.txt", HTTP_GET, handleCaptiveRedirect);            // Windows
  webServer.onNotFound(handleCaptiveRedirect);
  webServer.begin();

  Serial.println("[PORTAL] Wi-Fi AP Aktif : " + apSsidName + " (tanpa password)");
  Serial.println("[PORTAL] Buka browser ke: http://192.168.4.1");
  Serial.println("==========================================\n");
}

// -------------------- Koneksi Wi-Fi & Sinkronisasi Server --------------------

bool lastWifiAuthFailed = false;

bool connectWiFiWithTimeout(unsigned long timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;

  lastWifiAuthFailed = false;
  Serial.printf("[WIFI] Menghubungkan ke \"%s\"", appConfig.ssid);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  if (strlen(appConfig.password) > 0) {
    WiFi.begin(appConfig.ssid, appConfig.password);
  } else {
    WiFi.begin(appConfig.ssid);
  }

  unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED) {
#ifdef WL_WRONG_PASSWORD
    if (WiFi.status() == WL_WRONG_PASSWORD) {
      Serial.println("\n[WIFI] Password Wi-Fi salah (WL_WRONG_PASSWORD)!");
      portalReason = "Password Wi-Fi salah. Silakan masukkan ulang SSID, Password Wi-Fi, dan Token.";
      lastWifiAuthFailed = true;
      return false;
    }
#endif
    if (millis() - startedAt >= timeoutMs) {
      Serial.println("\n[WIFI] Timeout menyambung ke Wi-Fi!");
      portalReason = "Gagal terhubung ke Wi-Fi (timeout). Periksa nama Wi-Fi, password, atau token.";
      return false;
    }
    delay(400);
    yield();
    Serial.print(".");
  }

  Serial.println("\n[WIFI] Terhubung! IP: " + WiFi.localIP().toString());
  wifiDisconnectedAt = 0;
  return true;
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

void applySyncPayload(const String& payload) {
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
      applyPinState(pin, isOn, activeLow);
      int idx = findPinIndex(pin);
      if (idx >= 0 && idx < MAX_MANAGED_PINS) {
        seen[idx] = true;
      }
    }

    cursor = objEnd + 1;
  }

  removeUnseenPins(seen);

  if (!firstSyncSucceeded) {
    firstSyncSucceeded = true;
    Serial.printf("[OK] Sync pertama berhasil (%d pin terkelola).\n", managedPinCount);
  }
}

void syncWithServer() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  HTTPClient http;
  String url = String(appConfig.syncUrl);
  bool isHttps = url.startsWith("https://");

  WiFiClient wifiClient;
  WiFiClientSecure secureClient;

  bool begun = false;
  if (isHttps) {
    secureClient.setInsecure();
    secureClient.setTimeout(6000);
    begun = http.begin(secureClient, url);
  } else {
    wifiClient.setTimeout(6000);
    begun = http.begin(wifiClient, url);
  }

  if (!begun) {
    Serial.println("[ERR] Format URL Server Sync tidak valid: " + url);
    return;
  }

  http.setTimeout(6000);
  http.addHeader("x-device-token", appConfig.deviceToken);

  int httpCode = http.GET();
  if (httpCode == HTTP_CODE_OK) {
    unauthorizedStreak = 0;
    String payload = http.getString();
    applySyncPayload(payload);
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
    Serial.printf("[ERR] Sync HTTP gagal, code: %d (%s) | FreeHeap: %u\n",
                  httpCode, http.errorToString(httpCode).c_str(), ESP.getFreeHeap());
  }

  http.end();
}

void handleSerialCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  cmd.toUpperCase();

  if (cmd == "SETUP") {
    enterConfigPortal("Diminta manual melalui Serial Monitor.", false);
  } else if (cmd == "RESET") {
    Serial.println("[RESET] Menghapus konfigurasi EEPROM dan restart ke Mode Setup...");
    clearConfig();
    delay(300);
    ESP.restart();
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Smart Home AI NodeMCU Boot ===");
  Serial.println("[INFO] Ketik SETUP (buka portal) atau RESET (hapus config) di Serial Monitor.");

  loadConfig();

  if (!hasRequiredConfig()) {
    enterConfigPortal("Konfigurasi awal setelah flash. Silakan masukkan Wi-Fi, Password, dan Token.", false);
    return;
  }

  if (!connectWiFiWithTimeout(WIFI_BOOT_TIMEOUT_MS)) {
    enterConfigPortal(portalReason, !lastWifiAuthFailed);
    return;
  }

  syncWithServer();
  lastSyncTime = millis();
}

void loop() {
  handleSerialCommands();

  if (inPortalMode) {
    dnsServer.processNextRequest();
    webServer.handleClient();

    if (pendingRestart && (long)(millis() - pendingRestartAt) >= 0) {
      Serial.println("[PORTAL] Restarting NodeMCU...");
      delay(50);
      ESP.restart();
    }

    if (portalAllowAutoRetry && !pendingRestart &&
        WiFi.softAPgetStationNum() == 0 &&
        (millis() - portalEnteredAt >= PORTAL_AUTO_RETRY_MS)) {
      Serial.println("[PORTAL] Belum ada klien terhubung; mencoba konek Wi-Fi ulang...");
      delay(50);
      ESP.restart();
    }

    yield();
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
#ifdef WL_WRONG_PASSWORD
    if (WiFi.status() == WL_WRONG_PASSWORD) {
      enterConfigPortal("Password Wi-Fi salah. Silakan masukkan ulang SSID, Password Wi-Fi, dan Token.", false);
      return;
    }
#endif

    if (wifiDisconnectedAt == 0) {
      wifiDisconnectedAt = millis();
      Serial.println("[WIFI] Koneksi terputus! Mencoba menyambung ulang...");
      WiFi.reconnect();
    } else if (millis() - wifiDisconnectedAt >= WIFI_RECONNECT_TIMEOUT_MS) {
      enterConfigPortal("Koneksi Wi-Fi terputus / timeout. Silakan masukkan ulang Wi-Fi dan Token.", true);
      return;
    }

    delay(100);
    yield();
    return;
  }

  wifiDisconnectedAt = 0;

  unsigned long now = millis();
  if (now - lastSyncTime >= SYNC_INTERVAL_MS) {
    syncWithServer();
    lastSyncTime = millis();
  }
  yield();
}
