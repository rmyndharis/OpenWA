# Panduan Deployment Docker OpenWA

Panduan ini menjelaskan cara melakukan deployment **OpenWA** (WhatsApp API Gateway) menggunakan Docker dan Docker Compose.

---

## 🚀 Persyaratan Sistem
Sebelum memulai, pastikan server Anda sudah terinstal:
*   **Docker** (versi 20.10+)
*   **Docker Compose** (versi 2.0+)

---

## 📁 Struktur Konfigurasi

OpenWA menggunakan fitur **Profiles** di Docker Compose untuk mempermudah orkestrasi layanan tambahan (database, cache, dll) sesuai kebutuhan infrastruktur Anda.

### Layanan Utama (Core)
*   **`openwa-api`**: Server backend utama REST API OpenWA.
*   **`dashboard`**: Antarmuka web (React UI) untuk mengelola sesi dan webhook.

### Layanan Tambahan (Optional Profiles)
*   **`postgres`**: Database PostgreSQL (bawaan docker).
*   **`redis`**: Caching layer untuk performa tinggi.
*   **`minio`**: Penyimpanan berkas media yang kompatibel dengan Amazon S3.
*   **`with-proxy`**: Reverse proxy Traefik otomatis.

---

## ⚡ Langkah Cepat (Development)

Untuk kebutuhan uji coba lokal dengan database bawaan SQLite dan penyimpanan lokal:

```bash
# 1. Clone repositori hasil fork Anda
git clone git@github.com:jimmimohtar/OpenWA.git
cd OpenWA

# 2. Jalankan docker compose khusus development
docker compose -f docker-compose.dev.yml up -d
```

Aplikasi dapat diakses di:
*   **Dashboard UI**: `http://localhost:2886`
*   **Swagger Docs**: `http://localhost:2785/api/docs`

---

## 🏭 Deployment Produksi

### 1. File Environment (`.env`)
Salin file `.env.example` menjadi `.env` lalu sesuaikan konfigurasi kunci keamanan Anda:

```bash
cp .env.example .env
```

Pastikan untuk mengubah nilai rahasia berikut di dalam `.env`:
*   `API_MASTER_KEY`: Kunci keamanan untuk autentikasi API.
*   `DATABASE_PASSWORD`: Sandi untuk database PostgreSQL (jika dipakai).

### 2. Memilih Skenario Deployment (Docker Profiles)

#### Skenario A: Produksi Minimalis (SQLite + Dashboard)
Cocok untuk VPS resource kecil (RAM 1GB - 2GB):
```bash
docker compose --profile with-dashboard up -d
```

#### Skenario B: Produksi Menengah (PostgreSQL + Dashboard)
Cocok untuk keandalan data lebih tinggi:
```bash
docker compose --profile postgres --profile with-dashboard up -d
```

#### Skenario C: Full Stack (PostgreSQL + Redis + S3 MinIO + Dashboard + Traefik)
Cocok untuk skala enterprise dengan multi-sesi aktif:
```bash
docker compose --profile full up -d
```

---

## ⚙️ Variabel Lingkungan Penting (Environment Variables)

Berikut variabel penting yang bisa disesuaikan di `.env`:

| Nama Variabel | Nilai Default | Deskripsi |
|---|---|---|
| `API_PORT` | `2785` | Port yang digunakan untuk akses REST API. |
| `DASHBOARD_PORT` | `2886` | Port untuk mengakses Dashboard UI. |
| `DATABASE_TYPE` | `sqlite` | Jenis database yang digunakan (`sqlite` atau `postgres`). |
| `DATABASE_NAME` | `/app/data/openwa.sqlite` | Lokasi database SQLite atau nama database PostgreSQL. |
| `ENGINE_TYPE` | `whatsapp-web.js` | Driver/mesin engine WhatsApp yang digunakan. |
| `PUPPETEER_HEADLESS` | `true` | Menjalankan browser WhatsApp secara tersembunyi. |

---

## 🔍 Pemeriksaan Status & Diagnostik

Memeriksa apakah kontainer berjalan lancar:
```bash
docker compose ps
```

Melihat log aktivitas sistem OpenWA:
```bash
docker compose logs -f openwa-api
```

Melakukan pembersihan/berhenti:
```bash
docker compose down
```

---

## 🤝 Kontribusi
Jika Anda menemukan kendala saat setup menggunakan Docker, silakan ajukan Issue atau Pull Request di repositori ini.
