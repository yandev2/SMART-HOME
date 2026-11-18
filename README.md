# Surya Home AI — Asisten Smart Home Dinamis

Asisten Smart Home berbasis Web yang bisa diajak ngobrol santai, ceria, dan bercanda menggunakan **Gemini API (`@google/genai`)**, dengan kontrol perangkat dinamis via **Supabase** dan **NodeMCU ESP8266**.

## Fitur Utama
- **Asisten AI Santai & Ceria (`gemini-4-hydrogen`)**: Bisa membedakan obrolan santai dengan perintah menyalakan, mematikan, atau mengecek kondisi perangkat rumah (via *Interactions API & Function Calling*).
- **Manajemen Ruangan & Perangkat Dinamis**: Tambah, ubah nama, dan hapus ruangan serta perangkat langsung lewat form menu di Web Dashboard — AI langsung mengenali perubahan tanpa ubah kode.
- **Fleksibel 1 atau Banyak Relay per NodeMCU**: 1 unit NodeMCU bisa mengontrol 1 relay maupun banyak relay sekaligus melalui pemetaan pin GPIO di Web, dengan satu sketch firmware yang sama.
- **Realtime Dashboard**: Status perangkat ter-update otomatis menggunakan Supabase Realtime.

---

## Cara Setup

### 1. Siapkan Database Supabase
1. Buat project gratis di [Supabase](https://supabase.com).
2. Buka **SQL Editor** di Dashboard Supabase, lalu jalankan isi file `supabase/schema.sql`.
3. (Opsional untuk testing cepat) Di **Authentication -> Providers -> Email**, kamu bisa mematikan *Confirm email* agar akun baru bisa langsung login tanpa verifikasi email.

### 2. Konfigurasi Environment Variable
Salin `.env.example` menjadi `.env.local` lalu isi nilainya:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
APP_ENCRYPTION_KEY=string-acak-minimal-32-karakter
```

- Kunci Supabase ada di **Project Settings -> API**.
- `APP_ENCRYPTION_KEY` digunakan untuk mengenkripsi Gemini API Key tiap user di database Supabase (jika dikosongkan, sistem otomatis menurunkannya dari `SUPABASE_SERVICE_ROLE_KEY`).
- **Gemini API Key** tidak disimpan di `.env`: setiap user cukup login lalu memasukkan API Key miliknya sendiri (dari [Google AI Studio](https://aistudio.google.com/apikey)) melalui tab **API Key** di Web Dashboard.

### 3. Jalankan Aplikasi Web
```bash
npm install
npm run dev
```
Buka `http://localhost:3000`, daftar akun, lalu tambahkan **Ruangan**, **NodeMCU**, dan **Perangkat**.

### 4. Upload Firmware ke NodeMCU (ESP8266)
1. Buka `firmware/nodemcu_smart_home/nodemcu_smart_home.ino` di Arduino IDE.
2. Install board **esp8266** (`NodeMCU 1.0 (ESP-12E Module)`) melalui Boards Manager. Tidak perlu install library eksternal tambahan.
3. (Opsional) Sesuaikan `DEFAULT_SYNC_URL` ke URL server web kamu (misal URL Vercel atau `http://<IP-LAN-PC>:3000/api/iot/sync`) — bisa juga diisi nanti lewat Portal Web NodeMCU.
4. Upload ke NodeMCU. Setelah flash pertama, NodeMCU otomatis memancarkan Access Point **`SmartHome-Setup-XXXX`** (buka `http://192.168.4.1`) untuk mengisi **Nama Wi-Fi**, **Password Wi-Fi**, dan **Device Token** dari menu **NodeMCU** di Web Dashboard.
5. Jika suatu saat Wi-Fi gagal terhubung, password salah, atau terputus melewati batas timeout, NodeMCU otomatis kembali masuk ke mode Access Point agar kamu bisa mengatur ulang Wi-Fi dan Token.

