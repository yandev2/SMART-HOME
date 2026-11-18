# Desain PCB Smart Switch — ESP-01S + 2 Channel Relay (Input 5V Charger HP)

Desain referensi skematik, daftar komponen (BOM), netlist koneksi, dan panduan layout PCB 2-layer untuk menjalankan firmware `firmware/nodemcu_smart_home/nodemcu_smart_home.ino` pada modul **ESP-01 / ESP-01S** dengan **2 channel relay 5V** dan catu daya dari **adaptor modul charger HP 5V DC**.

---

## 1. Spesifikasi & Target Ukuran PCB
- **Ukuran PCB Rekomendasi**: `70 mm × 52 mm` (2-Layer FR4, ketebalan tembaga `1 oz`, `1.6 mm`).
- **Lubang Baut Mounting**: `4 × M3` di keempat sudut (`3.2 mm` drill, `6 mm` pad/keepout, inset `4 mm` dari tepi).
- **Input Daya**: `5V DC` (min. `1A`, disarankan `2A`) dari adaptor charger HP melalui Micro-USB / USB-C Power-Only atau Terminal 2-Pin.
- **Channel Output**: `2 × Relay SPDT 5V 10A` (`GPIO 0` = Channel 1, `GPIO 2` = Channel 2, logika **Active-LOW** `active_low = true`).

---

## 2. Daftar Komponen (BOM)

| Ref | Komponen / Nilai | Footprint Rekomendasi | Jml | Fungsi |
| :--- | :--- | :--- | :---: | :--- |
| `J1` | Micro-USB Female / Terminal KF301 2-Pin (5.0mm) | `USB_Micro-B` / `TerminalBlock_2P_5.0mm` | 1 | Input daya `5V DC` dari charger HP |
| `F1` | Resettable Fuse PTC `500mA` / `1A` | `Fuse_1206` / Axial | 1 | Pengaman arus lebih pada jalur 5V |
| `D1` | Dioda Schottky `SS14` / `1N5819` | `DO-214AC (SMA)` / `DO-41` | 1 | Pengaman polaritas terbalik (jika pakai terminal kabel) |
| `U1` | Regulator LDO `AMS1117-3.3` | `SOT-223` | 1 | Penurun tegangan `5V -> 3.3V` untuk ESP-01S |
| `C1` | Kapasitor Elco `470uF / 16V` | `CP_Radial_D8.0mm_P3.5mm` | 1 | Buffer arus lonjakan saat kedua koil relay aktif |
| `C3` | Kapasitor Elco `100uF / 10V` | `CP_Radial_D5.0mm_P2.0mm` | 1 | Stabilitas tegangan `3.3V` saat TX Wi-Fi ESP-01S |
| `C2, C4, C5` | Kapasitor Keramik `100nF (0.1uF)` | `C_0805` / `C_Disc_D5.0mm` | 3 | Filter noise frekuensi tinggi (`5V`, `3V3`, dan `RST`) |
| `U2` | Socket Header `2×4 Pin` 2.54mm Female (untuk **ESP-01S**) | `PinSocket_2x04_P2.54mm_Vertical` | 1 | Dudukan modul ESP-01 / ESP-01S |
| `H_PROG` | Pin Header `1×4 Pin` 2.54mm | `PinHeader_1x04_P2.54mm_Vertical` | 1 | Port USB-TTL (`3V3, TX, RX, GND`) untuk flashing |
| `SW1, SW2` | Tactile Push Button 2/4-Pin `6×6mm` | `SW_PUSH_6mm` | 2 | `SW1` = FLASH (`GPIO0->GND`), `SW2` = RESET (`RST->GND`) |
| `R1, R2, R3, R4` | Resistor `10kΩ` 1/4W | `R_0805` / `R_Axial_0207` | 4 | Pull-up boot wajib: `GPIO0`, `GPIO2`, `CH_PD`, `RST` |
| `U3, U4` | Optocoupler `PC817` | `DIP-4` | 2 | Isolasi logika `3.3V` dari noise koil relay `5V` |
| `R5, R6` | Resistor `330Ω` | `R_0805` / `R_Axial_0207` | 2 | Pembatas arus LED optocoupler (`~6.3 mA` dari `3.3V`) |
| `Q1, Q2` | Transistor NPN `S8050` / `2N2222` / `BC547` | `TO-92` / `SOT-23` | 2 | Driver arus koil relay `5V` (`~75mA` per koil) |
| `R7, R8, R11, R12` | Resistor `1kΩ` | `R_0805` / `R_Axial_0207` | 4 | Resistor base transistor (`R7,R8`) & indikator LED (`R11,R12`) |
| `R9, R10` | Resistor `10kΩ` | `R_0805` / `R_Axial_0207` | 2 | Pull-down base transistor `Q1, Q2` agar tidak mengambang |
| `D2, D3` | Dioda Flyback `1N4148` atau `1N4007` | `SOD-123` / `DO-41` | 2 | Peredam EMF balik koil relay *(pasang terbalik di koil)* |
| `LED_PWR, LED1, LED2` | LED 3mm atau SMD 0805 | `LED_D3.0mm` / `LED_0805` | 3 | Indikator Power (`3.3V`), Relay 1, dan Relay 2 (+ `R_PWR 1kΩ`) |
| `K1, K2` | Relay 5V SPDT 10A (`SRD-05VDC-SL-C`) | `Relay_SPDT_Songle_SRD` | 2 | Saklar beban AC 220V |
| `J2, J3` | Terminal Screw `3-Pin` Pitch `5.08mm` | `TerminalBlock_KF301_3P_5.08mm` | 2 | Terminal output beban AC (`NO`, `COM`, `NC`) |

---

## 3. Netlist Koneksi Pin-by-Pin

### A. Jalur Daya (`5V Charger HP` → `3.3V`)
1. `J1 (5V)` → `F1` → `D1 (Anode -> Cathode)` → Net **`5V_SYS`**
2. `J1 (GND)` → Net **`GND`**
3. `C1 (470uF +)` ke `5V_SYS`, `( - )` ke `GND`
4. `C2 (100nF)` antara `5V_SYS` dan `GND`
5. `U1 (AMS1117-3.3)`:
   - `Pin 3 (VIN)` → `5V_SYS`
   - `Pin 1 (GND)` → `GND`
   - `Pin 2 / Tab (VOUT)` → Net **`3V3`**
6. `C3 (100uF +)` ke `3V3`, `( - )` ke `GND`
7. `C4 (100nF)` antara `3V3` dan `GND` (ditempatkan sedekat mungkin dengan `U2 Pin 8`)
8. `3V3` → `R_PWR (1kΩ)` → `LED_PWR (+)` → `LED_PWR (-)` → `GND`

### B. Koneksi `ESP-01S (U2)` & Kontrol Flashing
| Pin `U2` | Nama Pin | Terhubung ke Net / Komponen |
| :---: | :--- | :--- |
| `1` | `GND` | `GND` |
| `2` | `GPIO2` | Net **`CTRL_CH2`** + `R2 (10kΩ)` ke `3V3` |
| `3` | `GPIO0` | Net **`CTRL_CH1`** + `R1 (10kΩ)` ke `3V3` + `SW1 (FLASH)` ke `GND` |
| `4` | `RXD (GPIO3)` | `H_PROG` Pin `RX` *(terhubung ke TX pada USB-TTL saat flash)* |
| `5` | `TXD (GPIO1)` | `H_PROG` Pin `TX` *(terhubung ke RX pada USB-TTL saat flash)* |
| `6` | `CH_PD / EN` | `R3 (10kΩ)` ke `3V3` *(wajib HIGH untuk boot normal)* |
| `7` | `RST` | `R4 (10kΩ)` ke `3V3` + `C5 (100nF)` ke `GND` + `SW2 (RESET)` ke `GND` |
| `8` | `VCC` | **`3V3`** *(JANGAN pernah hubungkan ke `5V_SYS`!)* |

### C. Driver Relay Channel 1 (`GPIO 0` — Active LOW)
1. `3V3` → `R5 (330Ω)` → `U3 Pin 1 (Anode PC817)`
2. `U3 Pin 2 (Cathode PC817)` → Net **`CTRL_CH1`** (`GPIO0`)
3. `5V_SYS` → `U3 Pin 4 (Collector)`
4. `U3 Pin 3 (Emitter)` → `R7 (1kΩ)` → **`Q1 Base`**
5. **`Q1 Base`** → `R9 (10kΩ)` → `GND`
6. **`Q1 Emitter`** → `GND`
7. `5V_SYS` → `K1 Coil A` dan **`D2 Cathode`**
8. **`Q1 Collector`** → `K1 Coil B` dan **`D2 Anode`**
9. `5V_SYS` → `R11 (1kΩ)` → `LED1 (+)` → `LED1 (-)` → **`Q1 Collector`**

### D. Driver Relay Channel 2 (`GPIO 2` — Active LOW)
- Identik dengan Channel 1, menggunakan `U4 (PC817)`, `R6 (330Ω)` ke **`CTRL_CH2`** (`GPIO2`), `R8 (1kΩ)`, `R10 (10kΩ)`, `Q2`, `D3`, `LED2`, `R12 (1kΩ)`, dan koil `K2`.

### E. Output Tegangan Tinggi AC 220V (Terpisah di Sisi Kanan PCB)
- `K1.COM` → `J2 Pin 2 (COM1)` (lebar jalur `>= 3.0 mm`)
- `K1.NO` → `J2 Pin 1 (NO1)` (lebar jalur `>= 3.0 mm`)
- `K1.NC` → `J2 Pin 3 (NC1)` (lebar jalur `>= 2.5 mm`)
- `K2.COM` → `J3 Pin 2 (COM2)` (lebar jalur `>= 3.0 mm`)
- `K2.NO` → `J3 Pin 1 (NO2)` (lebar jalur `>= 3.0 mm`)
- `K2.NC` → `J3 Pin 3 (NC2)` (lebar jalur `>= 2.5 mm`)

---

## 4. Aturan Keselamatan PCB & DRC (Wajib Saat Routing di KiCad / EasyEDA)
1. **Zona Isolasi Tegas**: Tempatkan seluruh komponen DC (`J1`, `U1`, `U2`, `SW1-2`, `H_PROG`, `U3-4`, `Q1-2`) di **38 mm sisi kiri** PCB, dan kontak AC + terminal (`K1`, `K2`, `J2`, `J3`) di **32 mm sisi kanan** PCB.
2. **Routing Isolation Slot (`Edge.Cuts` / Board Cutout)**: Buat slot celah udara selebar **2.0 mm** tepat di bawah celah antara pin koil `K1/K2` (5V) dan pin `COM` `K1/K2` (AC 220V).
3. **Tanpa Copper Pour di Zona AC**: Ground plane / copper pour (`GND`) hanya boleh mengisi area DC di sisi kiri (berhenti minimal **6 mm** sebelum pin `COM` relay & terminal AC).
4. **Lebar Jalur (`Trace Width`)**:
   - Jalur AC 220V (`COM`, `NO`, `NC`): **`2.5 mm – 3.5 mm`** (lebih bagus jalur ganda Top + Bottom dihubungkan via atau *exposed copper* untuk disolder tipis).
   - Jalur Daya `5V_SYS` & `3V3`: **`0.8 mm – 1.2 mm`**.
   - Jalur Sinyal GPIO / Opto: **`0.3 mm – 0.4 mm`**.

---

## 5. Pengaturan Firmware & Web Dashboard
1. **Arduino IDE**:
   - Pilih Board: **`Generic ESP8266 Module`** (Flash Size: `1MB (FS:none OTA:~502KB)` untuk ESP-01S 1MB, Builtin LED: `2`, Upload Speed: `115200`).
   - Cara masuk mode flash via board PCB: tahan **`SW1 (FLASH)`**, tekan & lepas **`SW2 (RESET)`**, lalu lepas **`SW1`** → klik **Upload**.
2. **Web Dashboard**:
   - Tambahkan controller baru di menu **NodeMCU**, salin tokennya.
   - Tambahkan perangkat Relay 1 dengan pin **`D3 (GPIO 0)`** (`Active LOW` = aktif/centang) dan Relay 2 dengan pin **`D4 (GPIO 2)`** (`Active LOW` = aktif/centang).

