# Panduan Rangkaian Smart LED WS2812 (`nodemcu_ws2812`)

Skema ini menggunakan **NodeMCU kedua** (terpisah 100% dari NodeMCU Relay) untuk mengontrol **lampu LED RGB WS2812 / NeoPixel** secara jarak jauh via Wi-Fi → Vercel/Supabase (tanpa MQTT) serta terintegrasi dengan Web Dashboard dan Asisten AI.

---

## 1. Kebutuhan Komponen
- **1× NodeMCU ESP8266** (V3 LoLin atau Amica)
- **1× Strip LED WS2812 / WS2812B (5V DC)** (1–300 mata LED)
- **1× Adaptor `5V DC` (`2A – 5A`)** (sesuaikan panjang strip: ~`60 mA` per LED saat putih maksimal, `60 LED` ideal minimal `5V 3A`)
- **1× Resistor `330Ω – 470Ω`** *(pengaman jalur data antara NodeMCU & pin `DIN` LED)*
- **1× Elco `1000µF / 10V–16V`** *(penahan lonjakan arus pada kabel `5V` & `GND` strip LED)*

---

## 2. Skema Pengkabelan (Wiring)

```
  [Adaptor 5V DC 2A-5A]
     ├── (+) +5V ──┬───────► (+5V) Strip LED WS2812
     │             ├──[+] Elco 1000µF
     │             └───────► (VIN / 5V) NodeMCU
     │
     └── (-) GND ──┬───────► (GND) Strip LED WS2812
                   ├──[-] Elco 1000µF
                   └───────► (GND) NodeMCU  <-- WAJIB SATUKAN GND!

  [NodeMCU Pin D4 (GPIO 2)] ──► [Resistor 330Ω] ──► (DIN) Strip LED WS2812
```

> [!WARNING]
> - **Jangan menyuplai strip LED `> 10` mata LED lewat pin USB/VU NodeMCU**, karena bisa memutus dioda USB NodeMCU! Alirkan `5V` dari adaptor langsung ke strip LED.
> - **Pastikan `GND` adaptor, `GND` strip LED, dan `GND` NodeMCU saling tersambung**, jika tidak maka lampu akan berkedip acak (*glitch*).

---

## 3. Cara Upload Firmware & Setup
1. Buka **[nodemcu_ws2812.ino](../../firmware/nodemcu_ws2812/nodemcu_ws2812.ino)** di Arduino IDE.
2. Instal library **`Adafruit NeoPixel`** lewat *Sketch → Include Library → Manage Libraries...*.
3. Pilih board **NodeMCU 1.0 (ESP-12E Module)** lalu upload. *(Cabut sementara pin data `D4` jika ada kendala saat upload).*
4. Buka Web Dashboard Smart Home AI → tab **WLED** → klik **+ Tambah WLED** → salin **Device Token WLED**.
5. Hubungkan HP ke Wi-Fi **`SmartLED-Setup-XXXX`**, buka `http://192.168.4.1`, lalu masukkan SSID Wi-Fi, Password, Token WLED, dan URL `/api/iot/led-sync`.

---

## 4. Fitur Offline Bawaan
- Menekan singkat tombol **FLASH (`D3 / GPIO 0`)** di board NodeMCU akan langsung menyalakan/mematikan strip LED meski Wi-Fi sedang mati, dan otomatis tersinkron ke Web saat Wi-Fi pulih.
- Menahan tombol **FLASH selama 5 detik** akan membuka kembali Wi-Fi Portal Setup (`SmartLED-Setup-XXXX`).

