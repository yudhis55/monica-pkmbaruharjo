# Monev CKG — Puskesmas Baruharjo

Memeriksa apakah pasien yang ditugaskan ke tiap pegawai **sudah diinput di Sehat IndonesiaKu (SSI)**, dengan mencocokkan Excel penugasan terhadap snapshot kunjungan SSI.

## Dua peran, satu basis data

Aplikasi yang sama bisa berjalan di dua tempat; keduanya memakai `DATABASE_URL` yang sama, jadi datanya tidak perlu disalin.

| Peran | Tempat | Yang dikerjakan |
|---|---|---|
| **Dasbor** | Vercel (`monica.pkmbaruharjo.my.id`, region `sin1`) | laporan publik, admin, impor Excel, penanda, ekspor PDF/Excel |
| **Penarik data** | PC puskesmas (`npm start`, `localhost:4321`) | masuk SSI (captcha), tarik kunjungan, simpan ke database |

Alasannya diukur, bukan diasumsikan (20 Nov 2026):

| Dari mana | `GET /api/crypto-key` | `GET /auth/login` | Keterangan |
|---|---|---|---|
| Jaringan Indonesia (PC puskesmas) | **200** | **200** | normal, ±260 ms |
| Vercel `iad1` (Washington) | **403** | **403** | HTML generik `403 Forbidden`, tanpa `cf-ray` |
| Vercel `sin1` (Singapura) | **403** | **403** | sama — bukan soal jarak, tapi penolakan IP cloud/asing |

Header permintaan identik di ketiga kasus (UA Chrome, `accept`, `referer`), jadi bukan soal header. SSI menolak rentang IP pusat data. Karena itu instance Vercel **menyembunyikan** tombol cek sesi/masuk/tarik data dan menampilkan petunjuk; `ssiFetchAvailable` di `/api/status` bernilai `false` di sana. Paksa dengan `MONEV_SSI_FETCH=on|off` bila perlu.

### Prosedur harian

1. Di PC puskesmas: `npm start` (butuh `DATABASE_URL` yang sama dengan Vercel).
2. Buka `http://localhost:4321/admin`, masuk SSI (captcha sekali), klik **Tarik data SSI**.
3. Dasbor Vercel otomatis menampilkan angka baru — database sama, tanpa langkah sinkron.

Alternatif tanpa menjalankan server lokal: `npx tsx src/cli.ts sync --push https://monica.pkmbaruharjo.my.id --push-token <MONEV_INGEST_TOKEN>`; pengirim memakai `x-ingest-token`, potongan 500 kunjungan per permintaan (batas body Vercel 4,5 MB).

### Yang sudah terbukti soal SSI

| Pertanyaan | Hasil uji |
|---|---|
| Ada Cloudflare/challenge? | **Tidak.** `server: Google Frontend`, tanpa `cf-ray`. |
| Butuh browser untuk login? | **Tidak.** `POST /api/user-management/login` menerima JSON biasa. |
| Login butuh apa? | `email`, `password`, `captcha_id`, `captcha_code` — captcha 1 gambar, 4 karakter. |
| Captcha bisa diotomatiskan? | **Tidak.** Harus dibaca manusia, sekali per sesi. |
| Endpoint baca memeriksa token? | **Tidak.** Hanya *keberadaan* cookie `token_eksternal` yang dicek. |

Satu-satunya langkah manusia: **mengetik 4 karakter captcha sekali per sesi**. Sesudah itu `refresh_token` dirotasi otomatis tiap 6 jam.

### Kapan layar login muncul

Endpoint baca SSI hanya memeriksa keberadaan cookie, bukan keabsahannya. Konsekuensinya: token yang sudah dicabut tetap bisa menarik data, token kosong → 401, dan `refresh-token` adalah satu-satunya pemeriksaan kredensial yang jujur.

> Catatan dokumen lama (`FLOW-SEHATINDONESIAKU.md`) menyebut Cloudflare dan "login manual via browser". Itu tidak lagi berlaku — sudah diverifikasi ulang.

## Deploy: Vercel + Supabase

Artefak yang dipakai: `api/index.ts` (satu fungsi untuk semua path), `vercel.json`
(`maxDuration: 300`, `includeFiles: web/**`), skema di `src/core/db/schema.ts` (string TS, ikut ter-bundel).

### 1. Environment variables di Vercel (Production)

| Variabel | Nilai |
|---|---|
| `DATABASE_URL` | pooler Supabase, port **6543** (`postgres.<ref>@aws-0-<region>.pooler.supabase.com`) |
| `MONEV_ADMIN_PASSWORD` | sandi halaman admin (wajib: Vercel bukan localhost) |
| `MONEV_COOKIE_SECURE` | `1` (opsional; atribut `Secure` otomatis saat protokol HTTPS) |
| `MONEV_INGEST_TOKEN` | hanya bila memakai pengirim lokal `sync --push` |
| `MONEV_SYNC_MAX_PAGES` | default Vercel `2` |
| `MONEV_SYNC_MAX_MS` | default Vercel `200000` |

`DATABASE_URL` di shell lokal **menimpa** `.env` (`loadEnvFile` tidak menimpa variabel proses),
jadi pastikan tidak ada nilai lama yang tertinggal di environment.

### 2. Deploy

```bash
npm i -g vercel
vercel login
vercel link          # pilih project / buat baru
vercel env add DATABASE_URL production
vercel env add MONEV_ADMIN_PASSWORD production
vercel --prod
```

Node runtime: `24.x` (ikuti `engines` di package.json). Framework preset: **Other**.
Tanpa build step: Vercel membangun fungsi dari `api/index.ts`.

### 3. Sesudah deploy

1. `GET /api/health` → `{"ok":true}`.
2. Buka `/admin`, login sandi, lalu login SSI (captcha) sekali.
3. Tarik data: `POST /api/sync?pages=1` berulang sampai `done: true` (atau `MONEV_SYNC_MAX_PAGES`).
4. Impor Excel penugasan (maks 4,5 MB per upload — batas body Vercel).

## Deploy: container + disk persisten

Sync penuh bisa makan **beberapa menit** saat SSI lambat (terukur 19 Nov 2026: 6 menit
untuk 10.000 baris, dengan retry). Karena itu aplikasi ini **tidak cocok untuk fungsi
serverless** dengan batas 60–300 detik — pakai proses yang hidup terus.

```bash
docker build -t monev-ckg .
docker run -d --name monev -p 4321:4321 -v monev-data:/data \
  -e MONEV_ADMIN_PASSWORD=rahasia \
  -e MONEV_TRUST_PROXY=1 -e MONEV_COOKIE_SECURE=1 \
  monev-ckg
```

- Database SQLite ada di volume `/data` (`MONEV_DB=/data/monev.db`).
- `GET /api/health` untuk healthcheck (dipakai `HEALTHCHECK` di image).
- Di belakang nginx/Caddy: set `MONEV_TRUST_PROXY=1` (IP asli untuk batas percobaan login)
  dan `MONEV_COOKIE_SECURE=1` (cookie hanya lewat HTTPS).
- Cookie admin **stateless** (`v1.<exp>.<hmac>`): restart atau beberapa instance tetap
  menerima cookie yang sama. Mengganti `MONEV_ADMIN_PASSWORD` membatalkan semuanya.

Runtime memakai Node 24 langsung (`node src/cli.ts serve`) — tanpa tsx, tanpa build step.

## Instalasi

```bash
npm install
cp .env.example .env
```

### 1. Login lewat web

```bash
npm run serve     # http://127.0.0.1:4321
```

Isi email, kata sandi, lalu kode captcha yang tampil. Kredensial hanya dipakai sekali untuk `POST login` dan **tidak disimpan**; yang tersimpan hanya `token_eksternal` + `refresh_token` di SQLite.

Cadangan bila captcha bermasalah — tempel cookie dari DevTools (harus memuat `token_eksternal` dan `refresh_token`), atau impor dari scraper lama:

```bash
npx tsx src/cli.ts session:import                    # dari tesscrapeckg/.env
npx tsx src/cli.ts session:import --from jar.json    # dari cookie jar
```

Setiap token diverifikasi dengan `GET /api/user-management/menu` sebelum disimpan.

### 2. Tarik data

Tombol **Tarik data SSI** di web, atau:

```bash
npx tsx src/cli.ts sync                                              # di prod
npx tsx src/cli.ts sync --push https://prod --push-token xxx         # opsional: collector terpisah
```

Token dianggap segar selama < 6 jam; `sync` memperpanjang sesi otomatis di dalam kunci tulis DB.

### 3. Impor penugasan & lihat laporan

Lewat web (unggah dari browser) atau CLI:

```bash
npx tsx src/cli.ts assign:inspect --file penugasan.xlsx   # deteksi kolom
npx tsx src/cli.ts assign:import  --file penugasan.xlsx
npx tsx src/cli.ts report --out hasil.xlsx
```

Laporan membaca **batch terakhir** yang diimpor.

## Aturan penilaian

| Status | Arti |
|---|---|
| `LENGKAP` | Ditemukan, `screening_count_done > 0` dan `done = all` |
| `DIINPUT_SEBAGIAN` | Ditemukan, sudah mulai, belum tuntas |
| `BELUM_DIINPUT` | Ditemukan, tapi `Belum Dilakukan` / 0 dari N |
| `AMBIGU` | Tidak ada NIK, dan nama+tanggal lahir tidak menunjuk tepat satu pasien |

- **Dasar hitung per batch (diatur admin)**: `selesai` (semua item screening selesai, bawaan),
  `ada_atau_sebagian` (minimal 1 item), `terdaftar` (asal kunjungan ada di tahun itu).
  Disimpan di `assignment_batch.match_rule`, diubah lewat `PATCH /api/batches/:id` atau panel
  *Dasar hitung* di halaman admin. Berlaku untuk semua tahun di batch itu agar angka sebanding.
- **Batas tahun (aturan v2)**: kunjungan hanya dianggap bukti bila `register_date` berada di tahun
  penugasan (kolom `Tahun` Excel atau tanggal target). Kunjungan tahun lain **tidak** dihitung,
  dan kunjungan **tanpa `register_date` tidak pernah** dijadikan bukti. Efek nyata pada batch
  September 2026: `LENGKAP` turun 1.407 → 833 karena 817 baris sebelumnya bersandar pada kunjungan 2025.
- **Nama pasien** boleh datang dari dua sumber: kolom `Nama` di Excel, atau — bila kosong —
  nama dari kunjungan SSI dengan NIK yang sama (**tahun mana pun**, karena nama adalah identitas,
  bukan bukti pekerjaan). Laporan menandai sumbernya (`nameSource`: `excel` / `ssi`) dan UI menampilkan
  label kecil `SSI`. Pasien yang belum pernah berkunjung di faskes ini tetap tanpa nama
  (2.323 dari 3.820 baris pada batch September), karena aplikasi tidak memakai endpoint
  pendaftaran/pencarian pasien.
- **Capaian = diinput + gagal input.** Pasien yang sudah ditandai *Tidak Valid*, *Faskes Lain*,
  atau *Data Hilang* dianggap beres, jadi keluar dari "belum diinput" dan menambah capaian.
  *Data Hilang* = pegawai mengklaim sudah input tetapi pasien tidak muncul di SSI saat data ditarik
  (galat SSI); hanya pegawai yang bisa menyatakannya karena buktinya di luar data SSI.
  `diinput + gagalDitandai + perluTindakan = assigned` (diuji). `pctCapaian` adalah angka capaian;
  `pctLengkap` (input saja) tetap tersedia sebagai kolom terpisah di Excel.
- **Impor ulang penugasan mengganti isi batch** (bukan menambah): baris yang hilang dari file
  baru ikut hilang, baris ganda (NIK + petugas) digabung, tanda dari Excel mengikuti file,
  sedangkan tanda manual (`supervisor`, `admin:excel`, `setor:<petugas>`) dipertahankan untuk
  NIK + petugas yang sama. Setoran yang tidak lagi menutup data (file baru menambah pasien)
  dicabut otomatis — `revokeSubmission` — dan dilaporkan sebagai `setoranDireset`.
- **Kolom `Keterangan` pada impor penugasan** adalah tanda dari pegawai: teks bebas dipetakan ke kode
  kanonik (`Data Tidak Valid` → `nik_tidak_valid`, `Faskes Lain` → `faskes_lain`,
  `Data Hilang` → `data_hilang`; `OK`/`sudah diinput`/`selesai` → tidak ditandai). Teks yang tidak
  dikenali menjadi `lainnya` dan muncul sebagai tab **Gagal lainnya** — tetap dihitung gagal, tidak
  pernah jatuh ke "belum diinput".
- **Tanda massal dari Excel**: admin mengunggah file `NIK` + `Alasan` (hanya *Tidak Valid*, *Faskes
  Lain*, atau *Data Hilang*). Tanda tidak menimpa pasien yang sudah `LENGKAP`, tidak membedakan petugas
  (NIK yang dipegang dua petugas: baris yang belum diinput dipilih lebih dulu), dan NIK di luar
  batch dilaporkan. Alasan di luar dua opsi ditolak dan dilaporkan, tidak dipetakan diam-diam
  ke "Lainnya".
- **State captcha di DB** (`ssi_captcha`), bukan memori proses: gambar captcha dan POST login
  boleh dilayani instance berbeda, dan captcha sekali pakai (baris dihapus saat diambil).
- **Kunci sinkron memakai lease** (`sync_lock.expires_at`), bukan `pid`: aman untuk serverless.
  Lease diperpanjang tiap halaman; pemilik mati di host yang sama tetap bisa diambil alih.
- **Rentang tarik data diatur admin** (Status sistem): disimpan di `app_setting` dan menang atas
  `SSI_SWEEP_START`/`SSI_SWEEP_END`. Berlaku untuk tombol *Tarik data SSI* dan `sync` di CLI.
- **Tandai & unduh daftar pasien hanya untuk admin.** Tombolnya disembunyikan bagi tamu, dan server
  menolak `POST /api/flags/set` serta `GET /api/patients.xlsx` tanpa sesi admin (401).
- **Header laporan memakai pemilih batch**, bukan tahun: satu batch = satu periode, sehingga laporan,
  PDF, dan unduhan selalu merujuk ke himpunan data yang sama. Waktu sinkron SSI terakhir tampil di header.
- Pencocokan utama **NIK 16 digit**. NIK kosong/15 digit/17 digit diperlakukan sebagai tanpa NIK.
- Fallback **nama ternormalisasi + tanggal lahir** hanya dipakai bila NIK tidak ada. Bila hasilnya >1 NIK → `AMBIGU` (tidak menebak).
- `LENGKAP` memakai **angka** `screening_count_done/all`, bukan label `self_check_status`; label terbukti tidak konsisten dengan hitungan.
- Baris Excel tanpa petugas atau dengan NIK cacat **ditolak saat impor** dan dilaporkan (`skippedDetail`).

### Empat hasil akhir di tabel pasien

`Hasil` pada tabel pasien hanya punya empat nilai, jadi tidak perlu membaca kolom sebab terpisah:

| Hasil | Aturan |
|---|---|
| **Diinput** | `status = LENGKAP` |
| **Faskes lain** | ditandai `faskes_lain` (Excel pegawai atau dialog Tandai) |
| **Data tidak valid** | **hanya** ditandai `nik_tidak_valid` / `nik_tidak_terdaftar` (penginput/supervisor) |
| **Belum diinput** | sisanya (termasuk `AMBIGU` yang belum ditandai) |

**Tidak ada kategori yang disimpulkan dari data mentah.** SSI menolak NIK setelah pasien dicoba
didaftarkan; itu hanya bisa diketahui dari laporan penginput, jadi "Data tidak valid" selalu berasal
dari tanda manusia (kolom `Keterangan` di Excel, atau dialog Tandai).

NIK sekarang **wajib 16 digit saat impor**. NIK cacat ditolak di pintu masuk
(`NIK wajib 16 digit: "12345"`) dan BUKAN dihitung sebagai "Data tidak valid", karena penolakan
SSI belum terjadi pada tahap itu.

### Kolom wajib dan opsional saat impor

Kontrak impor dibuat tetap supaya file dari banyak pegawai selalu bisa dicocokkan:

| Kolom | Wajib | Catatan |
|---|---|---|
| `Petugas` (atau `Nama Petugas`, `Pegawai`, `Operator`) | **ya** | nama penginput per baris |
| `NIK` | **ya** | harus 16 digit; NIK 15/17 digit atau berisi huruf → baris ditolak |
| `Tahun` (atau `Tanggal target`) | **ya** | mengisi filter tahun |
| `Nama` | tidak | dipakai untuk tampilan; pencocokan tetap lewat NIK |
| `Tanggal lahir` | tidak | tidak lagi dicocokkan karena NIK wajib; disimpan untuk tampilan/sidik |
| `Keterangan` / `Alasan` / `Status` | tidak | tanda gagal dari pegawai |

Pelanggaran kontrak dibalas **400** dengan pesan yang menyebut kolom mana yang hilang.

### Batch penugasan

Batch = satu periode penugasan (mis. "September 2026"). Semua baris punya `batch_id`, dan
pengelolaannya ada di halaman admin:

| Aksi | Endpoint |
|---|---|
| Daftar batch + jumlah baris/petugas | `GET /api/batches` |
| Buat batch (nama + tahun) | `POST /api/batches` `{name, year}` |
| Ubah nama/periode/status | `PATCH /api/batches/:id` (`aktif`, `selesai`, `arsip`) |
| Hapus batch + semua barisnya | `DELETE /api/batches/:id` |
| Impor ke batch | `POST /api/assign/import` dengan `batchId` (susulan) atau `batchName` (baru) |

Laporan memakai **batch aktif terbaru**; `?batch=` bisa memilih batch aktif lain. Menghapus batch
menghapus barisnya dan tanda gagalnya (cascade), jadi tombolnya memakai konfirmasi dengan jumlah baris.

### Dua kategori yang dipakai monev

Status di atas adalah bahan; yang ditampilkan ke supervisor hanya dua:

| Kategori | Aturan |
|---|---|
| **Diinput** | `status = LENGKAP` |
| **Tidak diinput** | semua status lain (`DIINPUT_SEBAGIAN`, `BELUM_DIINPUT`, `AMBIGU`) |

`Tidak diinput` lalu dipecah menurut **sebab**, dan sebab yang bisa dibaca otomatis hanya satu:
NIK kosong/tidak valid. Sisanya **tidak bisa dibedakan dari data** — "tidak ditemukan di SSI"
bisa berarti sudah dientry faskes lain, NIK salah, atau pegawai belum mengerjakan. Karena itu sebabnya
diberi tanda manusia, dan angka `perlu tindakan` = `tidak diinput` − `sudah ditandai`.

| Sebab (`fail_reason`) | Label | Sumber |
|---|---|---|
| `nik_tidak_valid` | NIK tidak valid | otomatis (NIK kosong) atau tanda |
| `faskes_lain` | Sudah dientry faskes lain | tanda |
| `nik_tidak_terdaftar` | NIK tidak terdaftar | tanda |
| `pasien_tidak_ditemukan` | Pasien tidak ditemukan | tanda |
| `lainnya` | Lainnya | tanda |

Tanda masuk lewat dua jalur, keduanya tersimpan di tabel `assignment`
(`fail_reason`, `note`, `flagged_by`, `flagged_at`):

1. **Kolom tanda di Excel pegawai** — header yang dikenali: `Keterangan`, `Alasan`, `Catatan`,
   `Status input`, `Tanda`, `Hasil`, `Gagal`, `Status`, `Cek`, `Verifikasi`. Teks bebas dipetakan ke kode
   (`mapFailReason`); teks yang tidak dikenali jadi `lainnya` dan **teks aslinya disimpan di `note`**.
   Baris tanpa teks = tidak ditandai.
2. **Panel `tandai` di web** — supervisor memilih sebab dan menulis catatan, atau membatalkan tanda.
   Tanda manual menimpa usulan Excel (`flagged_by` = `supervisor` / `excel`).

### Layanan: arti `LENGKAP` yang sebenarnya

`screening_count_done/all` hanya menghitung **formulir skrining langsung**, bukan layanan.
Diuji pada data nyata: kunjungan berstatus `Lengkap` dengan form 9/9 bisa punya **0 dari 14 layanan** terkirim.
Angka layanan tidak ada di `list-kunjungan-umum`; harus diambil per kunjungan lewat
`POST /api/pkg/ssi/detail-screening-ssi` (`{ reg_id }`). Biaya ±1,5 detik per pasien.

`detail:fetch` mengambil rincian **hanya untuk pasien yang ditugaskan** (bukan 13 ribu kunjungan),
menyimpannya di tabel `visit_detail` dengan cache 12 jam, lalu laporan menampilkan kolom `Layanan` (`terkirim/total`).

| Kolom | Asal | Arti |
|---|---|---|
| `Screening` | `list-kunjungan-umum` | formulir skrining langsung tuntas |
| `Layanan` | `detail-screening-ssi` | layanan puskesmas yang benar-benar sudah dikirim |

`—` pada kolom Layanan berarti rinciannya belum diambil, bukan nol.

## Perintah

| Perintah | Fungsi |
|---|---|
| `session:import` | impor token dari `.env` scraper / cookie jar |
| `session:check` | tampilkan waktu pembaruan sesi |
| `session:refresh` | perpanjang sesi (serial, lintas-proses) |
| `sync` | sapuan penuh SSI; `--push` untuk kirim ke prod |
| `detail:fetch` | rincian layanan pasien yang ditugaskan (`--batch N --force`) |
| `assign:inspect` / `assign:import` | deteksi kolom / impor penugasan |
| `report` | rekap JSON atau Excel |
| `serve` | web app (juga menyajikan font lokal di `/fonts/*`)|

## API

| Endpoint | Keterangan |
|---|---|
| `GET /api/status` | sesi, jumlah kunjungan, status sync terakhir |
| `GET /api/session/captcha` | ambil captcha (`id` + gambar data-URL) |
| `POST /api/session/login` | `{email,password,captchaId,code}` — login langsung ke SSI |
| `POST /api/session` | `{cookie}` — verifikasi lalu simpan sesi |
| `POST /api/session/refresh` | perpanjang sesi |
| `GET /api/status` | `sessionError` berisi penolakan terakhir dari SSI, bila ada |
| `POST /api/sync` | sapuan penuh (409 bila proses lain sedang menyapu) |
| `POST /api/assign/inspect` / `/import` | `{base64,filename}` atau `{path}` |
| `GET /api/flags/options` | daftar sebab gagal + petugas batch aktif |
| `POST /api/flags/set` | `{id,failReason,note}` — tandai/koreksi satu pasien; `failReason:null` menghapus |
| `POST /api/flags/bulk` | `{petugas,failReason}` — tandai semua yang belum diinput & belum ditandai |
| `GET /api/admin` | `{needPassword, unlocked}` |
| `POST /api/admin/login` / `/api/admin/logout` | buka/kunci sesi admin |
| `GET /api/report.pdf` | rekap capaian per petugas sebagai **PDF satu halaman A4 landscape** (judul, batch + tahun, faskes). `?year=` ikut filter tahun |
| `GET /api/flags/template` | template Excel tanda massal: kolom `NIK` + `Alasan` (dropdown *Tidak Valid* / *Faskes Lain*) |
| `POST /api/flags/import` | terapkan tanda dari Excel (admin). Hanya dua sebab; NIK yang sudah diinput / tidak ada di batch dilaporkan, bukan diterapkan |
| `POST /api/petugas/setor` | admin: tandai satu petugas **sudah setor**. Sisa pasien yang belum diinput ditandai `data_hilang` (`flagged_by = setor:<petugas>`); `{batal:true}` menghapus hanya tanda dari setoran itu. `{hitungGagal:false}` hanya mencatat setoran tanpa menandai |
| `GET /api/assign/template` | template impor penugasan (admin): kolom paten `Petugas · NIK · Tahun · Nama Pasien · Tanggal lahir · Tanggal target · Keterangan`, NIK diformat teks, `Keterangan` berupa dropdown 3 kategori |
| `GET /api/patients.xlsx` | daftar pasien sesuai filter (`?year=&petugas=&status=&q=`), **NIK penuh** + sumber nama + sebab gagal; sheet `Info` mencatat filter yang dipakai |
| `GET /robots.txt`, `GET /sitemap.xml` | aturan indeks (halaman publik boleh, admin/API tidak) dan sitemap satu URL |
| `GET /api/report` | laporan JSON (+ `diinput`, `tidakDiinput`, `gagalDitandai`, `perluTindakan`) serta `matchYears`/`visitsMatched`; `?year=2026` menyaring per tahun |
| `GET /api/report.xlsx` | laporan Excel (2 sheet); ikut `?year=` |
| `POST /api/ingest/visits` | `{visits:[...]}` + header `x-ingest-token` |

## Halaman

| URL | Isi | Untuk siapa |
|---|---|---|
| `/` | Laporan: capaian, dua kategori, sebab, per petugas, daftar pasien, tombol tanda | dibaca sambil memverifikasi |
| `/admin` | Status sistem, cek/perpanjang sesi, tarik data, rincian layanan, impor Excel, ekspor, login SSI — **ber-sandi** | saat menyiapkan data |

Halaman `/` sengaja hampir read-only: satu-satunya aksi adalah menandai sebab gagal per pasien
(dialog, bukan form inline). Impor, login, dan sinkronisasi ada di `/admin`.

### Sandi admin

`MONEV_ADMIN_PASSWORD` melindungi `/admin` dan semua endpoint tulis
(`/api/sync`, `/api/detail`, `/api/session*`, `/api/assign*`, `/api/ingest*`).
Sesi admin = cookie `monev_admin` yang HttpOnly, SameSite=Strict, berlaku 8 jam;
token hanya di memori, jadi restart server mengunci ulang.
5 sandi salah berturut-turut dari satu IP = jeda 60 detik.

- Bila `HOST` bukan `127.0.0.1`/`localhost` dan sandi kosong, **server menolak start**.
- Tanpa sandi di localhost, admin terbuka (mode pengembangan).
- `/kelola` tetap ada sebagai redirect 302 ke `/admin`.
- Pembacaan laporan (`/api/report`, `/api/status`, halaman `/`) tidak butuh sandi.

**Cek sesi saat halaman dibuka** — `POST /api/session/probe` memanggil `GET /api/user-management/menu`
(±0,4 detik), bukan sweep. Di-cache 60 detik per proses, jadi reload berulang tidak membebani SSI.
Tanpa cron. Pemeriksaan ini **tidak menulis** `session_error` (mode tampilan); hanya
`?force=1&record=1` dari tombol "Cek sesi sekarang" yang boleh menandai sesi ditolak.
Alasannya: `/menu` bisa 401 walau `list-kunjungan-umum` masih melayani data.

## Tampilan

Dua tema, dipilih dengan **satu tombol ikon** di kanan atas: bulan = arahkan ke gelap, matahari = arahkan ke terang.
Disimpan di `localStorage`, tidak mengikuti `prefers-color-scheme` — hasil di komputer puskesmas harus sama.

Tipografi dinaikkan untuk pembaca orang tua: body 17px (mobile 16px), teks tabel 17px,
angka utama 64px, target sentuh tombol ≥44px, warna muted dibuat lebih gelap
(`#55554f` terang, `#b4b4af` gelap) dan badge status selalu menyertakan kata, bukan warna saja.

- Font **Geist** (UI) dan **Geist Mono** (label/angka/tabel) disajikan dari `web/fonts/*.woff2`
  melalui `GET /fonts/:file`; tidak ada permintaan ke CDN, jadi tetap utuh tanpa internet.
- Latar kotak-kotak: dua `linear-gradient` 1px, kotak 48×48px, warna `--grid`
  (`#f0f0f0` terang, `#161719` gelap). Panel menutupi grid, jadi grid hanya terlihat di sela antar-panel.
- Tema terang memakai palet monokrom (`--text #0a0a0a`, hairline `#e6e6e6`, aksen tombol hitam)
  dan teal (`#0f7a6b`) hanya untuk status "diinput". Tema gelap memakai teal `#3fdec9` sebagai aksen.

## Ketergantungan vendor

`vendor/Du44SBtj.js` (+ `D6l4LlDU.js`, `x9SshGGZ.js`) adalah bundle HPKE dari aplikasi SSI, disalin apa adanya dari `C:/PKM/tesscrapeckg/vendor`. Jangan diedit. Shim membaca `process.env.ASIK_WEB_CTK`; `src/core/ssi/crypto.ts` yang menyetel nilainya dari cookie `asik_web_ctk`.

## Catatan operasional

- **Kunci sweep lintas-proses**: tabel `sync_lock` menyimpan `pid` + `host`. Kunci pemilik yang sudah mati diambil alih otomatis, jadi server yang di-restart di tengah sweep tidak memblokir 10 menit.
- **Run yatim** (`status='running'` dari proses mati) ditutup sebagai `interrupted` saat server start.
- **Refresh sesi** berjalan di dalam `BEGIN IMMEDIATE` + `busy_timeout`, sehingga CLI dan web tidak pernah memakai `refresh_token` yang sama dua kali.
- **Rantai refresh**: timer tiap 1 jam memperpanjang sesi yang berumur > 6 jam, di dalam kunci tulis DB. Kegagalan refresh dicatat sebagai `session_error` dan tidak membatalkan sapuan.
- **Login tidak memblokir**: hanya form yang ditawarkan; sapuan tetap boleh dijalankan.
- **Lockout login**: SSI menolak percobaan beruntun (HTTP 501, "coba lagi 2 menit"). UI menampilkan pesannya apa adanya.
- **Server SSI** mengembalikan 503 sesekali; klien retry dengan backoff eksponensial, dan rotasi kunci HPKE otomatis saat `ERROR_TOKEN_EXPIRED`.
- `ctk` dari cookie di-URL-decode sebelum dipakai HPKE — tanpa itu `atob` gagal.
- **Rentang setahun bisa 500, per bulan lolos.** 23 Nov 2026: `2026-01-01..2026-12-31` membalas `500 Gagal memuat data` setelah ±2 menit, termasuk untuk `limit=10`; per bulan, Januari dan Februari tetap 500 tetapi Maret–November lolos. Kalau sapuan setahun gagal, pecah per bulan:
  ```powershell
  foreach ($m in 3..12) {
    node src/cli.ts sync --start ("2026-{0:d2}-01" -f $m) --end ("2026-{0:d2}-31" -f $m)
  }
  ```
  Tiap rentang punya cursor sendiri (`sweep.range`), jadi bulan yang gagal tidak menghalangi bulan lain dan bisa diulang belakangan.

## Tes

```bash
npm test          # 27 tes: normalisasi, verdict, agregasi dua kategori, rincian layanan, kunci lintas-proses
npm run typecheck
```

## Diagnostik SSI (sebelum deploy / saat data tidak mau ditarik)

```bash
npx tsx scripts/probe-ssi.mjs                                  # rentang default (2020-01-01 .. 2030-12-31)
npx tsx scripts/probe-ssi.mjs --start 2026-01-01 --end 2026-12-31
```

Tiga panggilan yang diuji: `crypto-key` (koneksi + kunci), `user-management/menu` (sesi),
`list-kunjungan-umum` (data). Skrip hanya membaca. Kalau sesi mati, skrip berhenti cepat
dengan instruksi login lewat `/admin`.

Rentang tanggal juga mengatur volume tarikan: `screening_start_date`/`screening_end_date`
(`SSI_SWEEP_START`/`SSI_SWEEP_END`). Terukur 19 Nov 2026: 2020–2030 → 13.900 kunjungan,
tanpa rentang / 2026 saja → 7.945.

Ukuran halaman default **2.000** (`SSI_PAGE_SIZE`). Limit 5.000 terbukti membuat SSI membalas
`500 Gagal memuat data` untuk rentang lebar (5.000 gagal setelah retry; 2.000 dan 1.000 berhasil),
jadi `runSync` menurunkan ukuran halaman otomatis pada halaman pertama bila 5xx terjadi.
