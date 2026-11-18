# Desain PCB Smart Switch — NodeMCU V3 LoLin + 4-Channel Relay (Single-Layer / Komponen Besar)

Paket desain PCB **1-Layer (`B.Cu` / Bottom Copper ONLY, `162 mm × 116 mm`)** dengan ukuran komponen **through-hole standar besar (gaya amplifier/audio)** siap cetak rumahan (sablon/setrika FeCl3, CNC) maupun pabrik, dan siap di-import langsung ke **EasyEDA** untuk **NodeMCU V3 LoLin (`30 pin`, lebar baris `27.94 mm / 1.1"`)**, **4× Relay 5V (`SRD-05VDC-SL-C`)**, serta suplai **5V DC dari adaptor charger HP**.

---

## 1. File di Folder Ini
- **[nodemcu_v3_4ch_relay_easyeda.zip](nodemcu_v3_4ch_relay_easyeda.zip)** → File utama untuk di-import ke EasyEDA.
- **[nodemcu_v3_4ch_relay.kicad_pcb](nodemcu_v3_4ch_relay.kicad_pcb)** → Source PCB format KiCad v5 (`version 20171130`), **100% Single-Layer (`0` jalur di `F.Cu`, `164` jalur di `B.Cu`)**, `49` modul, `150` pad, `45` net, plus copper pour `GND` di sisi kiri DC.

---

## 2. Keunggulan Desain Single-Layer & Komponen Standar Besar
- **100% Jalur di Bottom (`B.Cu` ONLY)**: Nol jalur tembaga di Top layer (`F.Cu`), cocok untuk etsa PCB polos 1-sisi maupun cetak single-layer di vendor PCB.
- **Kaki Komponen Besar (Non-Micro)**:
  - **Resistor `1/4W` – `1/2W`**: jarak kaki **`10.16 mm` (`0.4"`)**, pad `2.2 × 2.2 mm` (lubang `0.9 mm`).
  - **Dioda `1N4007` / `1N5819` (`DO-41`)**: jarak kaki **`10.16 mm`**, pad `2.4 × 2.4 mm` (lubang `1.0 mm`).
  - **Elco `1000µF / 16V`**: diameter `10 mm`, jarak kaki **`5.0 mm`**, pad `2.6 × 2.6 mm`.
  - **Kapasitor MKT / Keramik `100nF`**: jarak kaki **`5.0 mm`**, pad `2.2 × 2.2 mm`.
  - **Transistor `S8050` / `BC547` (`TO-92`)**: kaki diluruskan melebar ke pitch **`2.54 mm`**, pad `2.0 × 1.8 mm`.
  - **Fuse `PTC 1A`**: jarak kaki **`7.62 mm`**, pad `2.4 × 2.4 mm`.
- **Jalur Lebar & Aman**: Sinyal `0.6–0.8 mm`, Power DC `1.0–1.5 mm`, Jalur AC 220V **`2.8 mm`**, celah isolasi AC–DC minimal **`3.30 mm`**, dan bebas copper pour di zona AC kanan.

---

## 3. Cara Import ke EasyEDA & Generate File Cetak (Gerber)
1. Buka **[EasyEDA Standard](https://easyeda.com/editor)** di browser dan login.
2. Klik menu **File → Import → KiCad...**
3. Pilih file **`nodemcu_v3_4ch_relay_easyeda.zip`** *(EasyEDA mewajibkan file `.kicad_pcb` dibungkus di dalam `.zip`)*.
4. Setelah terbuka:
   - Pastikan **Copper Area (`GND`)** di Bottom layer aktif, lalu tekan **Shift + B** (*Rebuild All Copper Areas*) agar area ground terisi penuh.
   - Jalankan **Design → Check DRC** untuk verifikasi final di EasyEDA.
   - Klik **Fabrication → PCB Fabrication File (Gerber)** (atau export ke PDF / Mirror `BottomLayer` untuk cetak setrika/sablon DIY).

---

## 4. Pemetaan Pin NodeMCU V3 LoLin ↔ Relay & Web Dashboard

> **Orientasi Pemasangan `U1` (NodeMCU V3 LoLin)**: Antena PCB menghadap ke **ATAS**, port Micro-USB menghadap ke **BAWAH**.

| Channel | Pin NodeMCU | GPIO Firmware | Driver | Relay & Terminal | Setting di Web Dashboard |
| :---: | :---: | :---: | :--- | :--- | :--- |
| **CH 1** | `D1` (Pin 4) | `GPIO 5` | `U2 (PC817)` + `Q1 (S8050)` | `K1` → `J2 (NC, COM, NO)` | Pin `D1 (GPIO 5)`, `Active LOW = Aktif` |
| **CH 2** | `D2` (Pin 5) | `GPIO 4` | `U3 (PC817)` + `Q2 (S8050)` | `K2` → `J3 (NC, COM, NO)` | Pin `D2 (GPIO 4)`, `Active LOW = Aktif` |
| **CH 3** | `D5` (Pin 10) | `GPIO 14` | `U4 (PC817)` + `Q3 (S8050)` | `K3` → `J4 (NC, COM, NO)` | Pin `D5 (GPIO 14)`, `Active LOW = Aktif` |
| **CH 4** | `D6` (Pin 11) | `GPIO 12` | `U5 (PC817)` + `Q4 (S8050)` | `K4` → `J5 (NC, COM, NO)` | Pin `D6 (GPIO 12)`, `Active LOW = Aktif` |

---

## 5. Daftar Kawat Jumper Sisi Atas (`JMP1–JMP7`)
Karena menggunakan 1-layer murni, terdapat **7 kawat jumper lurus horizontal** di sisi atas komponen (pakai potongan kaki resistor/dioda atau resistor `0Ω`) agar jalur tanpa persilangan dan EasyEDA DRC bersih:

| Ref | Pitch | Keterangan Jalur |
| :--- | :---: | :--- |
| `JMP1` | `26.67 mm` | Jembatan sinyal `GPIO 4 (D2 → CH2)` melompati jalur `5V_SYS`, `3V3`, dan `GPIO5_R` |
| `JMP2` | `22.86 mm` | Jembatan sinyal `GPIO 5 (D1 → CH1)` melompati jalur `5V_SYS` dan `3V3` |
| `JMP3` | `10.16 mm` | Jembatan sinyal `GPIO 12 (D6 → CH4)` melompati jalur `GND` |
| `JMP4` | `19.05 mm` | Jembatan sinyal `GPIO 14 (D5 → CH3)` melompati jalur `GND` dan `GPIO12_R` |
| `JMP5` | `10.16 mm` | Jembatan suplai `+5V` ke koil & flyback **CH 2 (`K2`)** melompati tulang `GND` |
| `JMP6` | `10.16 mm` | Jembatan suplai `+5V` ke koil & flyback **CH 3 (`K3`)** melompati tulang `GND` |
| `JMP7` | `10.16 mm` | Jembatan suplai `+5V` ke koil & flyback **CH 4 (`K4`)** melompati tulang `GND` |

*(Catatan: Untuk mempermudah solder `JMP1–JMP4` yang berada di atas/bawah area NodeMCU, disarankan memasang `U1` memakai soket **Pin Header Female `1×15`**, lalu jumper disolder rata PCB sebelum NodeMCU ditancapkan.)*

---

## 6. Daftar Komponen (BOM — Ukuran Standar Besar)

| Ref | Komponen & Nilai | Ukuran / Pitch | Qty | Catatan |
| :--- | :--- | :---: | :---: | :--- |
| `U1` | Pin Header Female `1×15 Pin` × 2 | `2.54 mm` (antar baris `27.94 mm`) | 2 | Soket **NodeMCU V3 LoLin** |
| `J1` | Screw Terminal `2-Pin` (KF301) | `5.08 mm` | 1 | Input `5V DC` charger HP (`Pin 1 = GND [bulat]`, `Pin 2 = +5V [kotak]`) |
| `F1` | Resettable Fuse `PTC 1A` / Fuse | `7.62 mm` | 1 | Pengaman arus lebih jalur 5V |
| `D1` | Dioda `1N5819` atau `1N4007` (`DO-41`) | `10.16 mm` | 1 | Pengaman polaritas terbalik (`1=Katoda [kotak]`, `2=Anoda`) |
| `C1` | Elco `1000µF / 16V` | `Ø10 mm, P 5.0 mm` | 1 | Menahan lonjakan arus saat 4 relay aktif bersamaan (`1=+ [kotak]`, `2=-`) |
| `C2` | Kapasitor MKT / Keramik `100nF (104)` | `P 5.0 mm` | 1 | Filter noise jalur 5V |
| `U2–U5` | Optocoupler `PC817` (`DIP-4`) | `7.62 × 2.54 mm` | 4 | Isolasi `3.3V` NodeMCU dari driver `5V` |
| `Q1–Q4` | Transistor NPN `S8050` / `BC547` (`TO-92`) | `P 2.54 mm` inline | 4 | **Cek pinout**: susunan kaki pada PCB `Pin 1 = E (bawah/GND)`, `Pin 2 = B (tengah)`, `Pin 3 = C (atas/Koil-)` *(cocok langsung untuk `S8050` sisi datar menghadap kanan; jika pakai `2N2222`/`BC547`, sesuaikan kaki E-B-C saat menekuk!)* |
| `D2–D5` | Dioda Flyback `1N4007` (`DO-41`) | `10.16 mm` | 4 | Dipasang paralel terbalik pada koil relay (`1=Katoda [+5V]`, `2=Anoda [Koil-]`) |
| `R1, R4, R7, R10` | Resistor `330Ω` 1/4W–1/2W | `10.16 mm` | 4 | Pembatas arus LED PC817 |
| `R2, R5, R8, R11` | Resistor `1kΩ` 1/4W–1/2W | `10.16 mm` | 4 | Resistor basis transistor `Q1–Q4` |
| `R3, R6, R9, R12` | Resistor `10kΩ` 1/4W–1/2W | `10.16 mm` | 4 | Pull-down basis `Q1–Q4` |
| `K1–K4` | Relay 5V 10A SPDT (`SRD-05VDC-SL-C`) | Standar Songle | 4 | Beban AC 220V terpisah di sisi kanan PCB |
| `J2–J5` | Screw Terminal `3-Pin` (KF301) | `5.08 mm` | 4 | Output AC 220V (`1=NC [atas]`, `2=COM [tengah]`, `3=NO [bawah]`) |
| `JMP1–JMP7` | Kawat Jumper / Resistor `0Ω` | `10.16 – 26.67 mm` | 7 | Disolder di sisi atas PCB |
| `H1–H4` | Lubang Baut `M3` | `Ø3.2 mm` | 4 | Di keempat sudut PCB |

---

## 7. Catatan Penting Catu Daya & Keselamatan
- **Gunakan terminal `J1` untuk sumber 5V Charger HP** (minimal `5V 2A`), bukan mencolokkan beban 4 koil relay lewat port USB NodeMCU, agar dioda proteksi USB pada NodeMCU V3 tidak kelebihan beban.
- Saat **upload firmware** via kabel USB ke NodeMCU, cabut dulu suplai eksternal `5V` di `J1` (atau cabut NodeMCU dari soketnya).
- Pastikan pemasangan **`Q1–Q4` (`E-B-C`)** dan polaritas **`D1–D5`, `C1`, `U2–U5`** sesuai tanda pad kotak/silkscreen sebelum menyalakan daya.
