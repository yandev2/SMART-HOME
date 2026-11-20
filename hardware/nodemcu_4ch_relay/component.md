# Daftar Komponen (BOM) — `nodemcu_4ch_relay` (4× Relay + 4× Push Button Manual)

Dokumen ini berisi daftar komponen lengkap untuk merakit papan PCB **[nodemcu_v3_4ch_relay.kicad_pcb](nodemcu_v3_4ch_relay.kicad_pcb)** (**62 modul** total di PCB, **100% Single-Layer `B.Cu`**, mendukung kontrol **AI/Web** maupun **4× Push Button Manual Offline**).

---

## 1. Ringkasan Belanja Cepat (Shopping List)

Gunakan daftar ini saat membeli komponen di toko elektronika atau marketplace:

| No | Nama Komponen & Spesifikasi | Total Qty | RefDes di PCB | Keterangan |
| :---: | :--- | :---: | :--- | :--- |
| 1 | **NodeMCU V3 LoLin (ESP8266 CH340, 30 Pin, lebar 1.1" / 27.94mm)** | **1 pcs** | `U1` | Modul mikrokontroler Wi-Fi utama |
| 2 | **Pin Header Female `1×15 Pin` (`P 2.54mm`)** | **2 pcs** | `U1` | Soket agar NodeMCU mudah dicabut saat upload kode |
| 3 | **Relay 5V 10A SPDT (`SRD-05VDC-SL-C`, 5-pin)** | **4 pcs** | `K1–K4` | Saklar pemutus beban listrik AC 220V |
| 4 | **Optocoupler `PC817` (`DIP-4` Through-Hole)** | **4 pcs** | `U2–U5` | Isolasi optik 3.3V NodeMCU ↔ 5V koil relay |
| 5 | **Transistor NPN `S8050` (`TO-92`)** *(atau `BC547`)* | **4 pcs** | `Q1–Q4` | Driver arus koil relay *(cek posisi E-B-C jika bukan S8050)* |
| 6 | **Resettable Fuse `PTC 1A` (`P 7.62mm`)** | **1 pcs** | `F1` | Sekring pengaman otomatis arus lebih 5V |
| 7 | **Dioda Schottky `1N5819` (`DO-41`)** *(alt: `1N4007`)* | **1 pcs** | `D1` | Proteksi polaritas terbalik input power `5V` |
| 8 | **Dioda Rectifier `1N4007` (`DO-41`)** | **4 pcs** | `D2–D5` | Dioda flyback pengaman lonjakan balik koil relay |
| 9 | **Elco `1000µF / 16V` (`Ø10mm, P 5.0mm`)** | **1 pcs** | `C1` | Buffer penyetabil tegangan saat 4 relay menyala serentak |
| 10 | **Kapasitor Keramik / MKT `100nF` kode `104` (`P 5.0mm`)** | **5 pcs** | `C2–C6` | `C2` filter rel 5V; `C3–C6` filter anti-bounce/noise Push Button |
| 11 | **Resistor `330Ω` (`1/4W` atau `1/2W` axial)** | **4 pcs** | `R1, R4, R7, R10` | Pembatas arus LED internal optocoupler `PC817` |
| 12 | **Resistor `1kΩ` (`1/4W` atau `1/2W` axial)** | **8 pcs** | `R2, R5, R8, R11`, `R13–R16` | 4× basis transistor (`Q1–Q4`) + 4× proteksi ESD & jembatan jalur Push Button |
| 13 | **Resistor `4.7kΩ` (`1/4W` atau `1/2W` axial)** | **4 pcs** | `R17–R20` | Pull-up eksternal `3V3` untuk `BTN1–BTN4` (`D7, D4, D3, D0`) |
| 14 | **Resistor `10kΩ` (`1/4W` atau `1/2W` axial)** | **4 pcs** | `R3, R6, R9, R12` | Pull-down basis transistor `Q1–Q4` |
| 15 | **Screw Terminal Block `2-Pin` (`KF301`, `P 5.08mm`)** | **1 pcs** | `J1` | Input adaptor `5V DC` |
| 16 | **Screw Terminal Block `3-Pin` (`KF301`, `P 5.08mm`)** | **4 pcs** | `J2–J5` | Output beban AC 220V (`NC, COM, NO`) |
| 17 | **Screw Terminal Block `5-Pin` (`KF301/MKDS`, `P 5.08mm`)** *(atau `2P + 3P` dirapatkan)* | **1 pcs** | `J6` | Terminal saklar manual Push Button (`1=GND`, `2–5=BTN1–BTN4`) |
| 18 | **Kawat Jumper / Resistor `0Ω` (`JMP1–JMP7`)** | **7 pcs** | `JMP1–JMP7` | Bisa pakai potongan kaki resistor / dioda sisa |

### Komponen Tambahan di Luar PCB (Saklar Dinding & Power)
| No | Komponen | Qty | Keterangan |
| :---: | :--- | :---: | :--- |
| 1 | **Saklar Push Button / Momentary (Bell Switch)** | **4 pcs** | Wajib tipe **Momentary (membal kembali / NO)** — `1× tekan ON, 1× tekan OFF` |
| 2 | **Adaptor / Charger HP `5V DC min. 2A`** | **1 unit** | Disambung ke terminal `J1` (`GND` & `+5V`), bukan lewat USB NodeMCU |
| 3 | **Kabel Sinyal Saklar (`5 urat`, e.g. kabel UTP/serabut `0.3–0.5mm²`)** | Secukupnya | `1× Common GND` + `4× BTN1..BTN4` (pisahkan jalurnya dari kabel 220V AC) |

---

## 2. Daftar Rinci Berdasarkan Kelompok Rangkaian PCB

### A. Mikrokontroler & Catu Daya DC
| Ref | Komponen | Nilai / Tipe | Pitch / Footprint | Fungsi |
| :--- | :--- | :--- | :--- | :--- |
| `U1` | NodeMCU V3 LoLin (`2×15 Pin Header Female`) | ESP8266 30-Pin | `2.54 mm`, lebar `27.94 mm` | Otak Wi-Fi, sinkronisasi Web/AI, pembaca 4× Push Button |
| `J1` | Screw Terminal `2-Pin` | KF301 | `5.08 mm` | Input `5V DC` (`Pin 1 = GND`, `Pin 2 = +5V`) |
| `F1` | Resettable Fuse | `PTC 1A` | `7.62 mm` | Pengaman arus lebih pada rel `+5V` |
| `D1` | Dioda Pengaman Polaritas | `1N5819` / `1N4007` | `10.16 mm` (`DO-41`) | Mencegah kerusakan jika kabel `5V` dan `GND` terbalik |
| `C1` | Elco Filter Utama | `1000µF / 16V` | `5.0 mm` (`Ø10 mm`) | Menahan drop tegangan saat 4 koil relay aktif bersamaan |
| `C2` | Kapasitor Bypass | `100nF (104)` | `5.0 mm` | Menyaring noise frekuensi tinggi di jalur `5V_SYS` |

### B. Driver Relay 4-Channel (CH 1 – CH 4)
| Channel | Relay | Optocoupler | Transistor | Dioda Flyback | R LED (`330Ω`) | R Basis (`1kΩ`) | R Pull-down (`10kΩ`) | Terminal AC | Pin GPIO |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **CH 1** | `K1` | `U2` | `Q1` | `D2` | `R1` | `R2` | `R3` | `J2` | `D1 (GPIO 5)` |
| **CH 2** | `K2` | `U3` | `Q2` | `D3` | `R4` | `R5` | `R6` | `J3` | `D2 (GPIO 4)` |
| **CH 3** | `K3` | `U4` | `Q3` | `D4` | `R7` | `R8` | `R9` | `J4` | `D5 (GPIO 14)` |
| **CH 4** | `K4` | `U5` | `Q4` | `D5` | `R10` | `R11` | `R12` | `J5` | `D6 (GPIO 12)` |

### C. Antarmuka 4× Push Button Manual (`J6`)
| Channel | Pin Terminal `J6` | Pin GPIO | Resistor Seri ESD (`1kΩ`) | Resistor Pull-up `3V3` (`4.7kΩ`) | Kapasitor Filter (`100nF`) |
| :---: | :--- | :---: | :---: | :---: | :---: |
| **Common** | `J6 Pin 1` (`GND`) | — | — | — | — |
| **BTN 1 (CH1)** | `J6 Pin 2` (`BTN1_EXT`) | `D7 (GPIO 13)` | `R13` *(pasang vertikal bridge)* | `R17` *(berdiri tegak di lingkaran, `3.2 mm`)* | `C3` |
| **BTN 2 (CH2)** | `J6 Pin 3` (`BTN2_EXT`) | `D4 (GPIO 2)` | `R14` *(pasang vertikal bridge)* | `R18` *(berdiri tegak di lingkaran, `3.8 mm`)* | `C4` |
| **BTN 3 (CH3)** | `J6 Pin 4` (`BTN3_EXT`) | `D3 (GPIO 0)` | `R15` *(pasang vertikal bridge)* | `R19` *(tidur horizontal, `7.4 mm`)* | `C5` |
| **BTN 4 (CH4)** | `J6 Pin 5` (`BTN4_EXT`) | `D0 (GPIO 16)` | `R16` *(pasang vertikal bridge)* | `R20` *(tidur horizontal, `10.16 mm`)* | `C6` |

### D. Kawat Jumper Sisi Atas (`JMP1–JMP7`)
| Ref | Pitch | Jalur yang Dijembatani |
| :--- | :---: | :--- |
| `JMP1` | `17.78 mm` | Sinyal `D2 (GPIO 4)` ke `CH 2` |
| `JMP2` | `15.24 mm` | Sinyal `D1 (GPIO 5)` ke `CH 1` |
| `JMP3` | `10.16 mm` | Sinyal `D6 (GPIO 12)` ke `CH 4` |
| `JMP4` | `16.51 mm` | Sinyal `D5 (GPIO 14)` ke `CH 3` |
| `JMP5` | `10.16 mm` | Suplai `+5V` ke koil `K2` & `D3` |
| `JMP6` | `10.16 mm` | Suplai `+5V` ke koil `K3` & `D4` |
| `JMP7` | `10.16 mm` | Suplai `+5V` ke koil `K4` & `D5` |

---

## 3. Catatan Perakitan Penting Agar Tidak Error

1. **Pasang komponen di bawah `U1` lebih dulu (`JMP1–JMP4` & `R17–R20`)** sebelum menyolder pin header female NodeMCU (`U1`):
   - `R19` & `R20` dipasang tidur horizontal biasa.
   - `R17` & `R18` dipasang **berdiri tegak** pada tanda lingkaran silkscreen (kaki satunya ditekuk ke pad sebelah, tinggi ~7 mm — tetap muat longgar di bawah NodeMCU yang terpasang di pin header female ~11 mm).
2. **Resistor `R13–R16` (`1kΩ`) dipasang berdiri tegak** (*vertical bridge*) menjembatani jalur `D6` & `D5` yang berada tepat di bawahnya menuju terminal `J6`. Gunakan resistor `1/4W` dengan selongsong isolasi pada kaki yang panjang agar tidak bersentuhan dengan kaki sebelahnya.
3. **Cek Polaritas Komponen Sebelum Dialiri Listrik**:
   - **`Q1–Q4` (`S8050`)**: Pin 1 = Emitter (`GND`), Pin 2 = Basis, Pin 3 = Kolektor (`Koil-`). Jika memakai `BC547` / `2N2222`, perhatikan pinout E-B-C-nya karena arahnya bisa terbalik!
   - **`U2–U5` (`PC817`)**: Titik/lekukan `Pin 1` menghadap sisi kiri atas (pad kotak).
   - **`D1–D5`**: Pita/gelang putih (Katoda) mengarah ke pad **kotak** (`5V`).
   - **`C1` (`1000µF`)**: Kaki positif `+` ke pad **kotak**, sisi garis strip `-` ke `GND`.
4. **Cek Jumper Pull-up `R17–R20` (`4.7kΩ`)**: Pastikan `R17–R20` tersolder baik (terutama `R20` pada `D0 / GPIO 16`), karena `GPIO 16` tidak memiliki pull-up internal pada chip ESP8266.

