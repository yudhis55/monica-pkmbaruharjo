# Flow Pengambilan Data Pasien Sehat IndonesiaKu (CKG / SSI)

Dokumen ini menjelaskan alur lengkap untuk mengambil daftar pasien dari aplikasi **Sehat IndonesiaKu** (`https://sehatindonesiaku.kemkes.go.id`), termasuk login, session, enkripsi/dekripsi payload `_d`, pagination, penyimpanan JSON, dan ekspor ke Excel.

Dokumen ini dibuat untuk dipakai oleh AI agent lain agar tidak perlu menebak lagi.

---

## 1. Ringkasan Arsitektur

Aplikasi target adalah SPA berbasis **Nuxt/Vue**. Request API bukan plain JSON, tetapi body berisi satu field `_d` yang merupakan envelope HPKE yang di-obfuscate.

Alur besarnya:

```text
Browser (login manual)
  -> cookie session + localStorage user_eksternal
  -> simpan ke .env
  -> CLI Node/TypeScript
  -> HPKE encrypt request _d
  -> POST /api/pkg/ssi/list-kunjungan-umum
  -> terima response _d
  -> HPKE decrypt response
  -> simpan JSON
  -> export Excel
```

Prinsip penting:

- Browser hanya dipakai untuk **login / refresh session**.
- Setelah cookie valid, semua request data dilakukan **full HTTP**.
- Request body `_d` dienkripsi ke **server public key**; client tidak bisa mendekripsi request body sendiri.
- Response body `_d` dienkripsi ke **client public key**; client bisa mendekripsi response dengan private key di cookie `asik_web_ctk`.

---

## 2. Struktur Project

```text
C:\PKM\tesscrapeckg
├── .env                         # session aktif (jangan commit)
├── .env.example                 # contoh format env
├── package.json
├── tsconfig.json
├── src
│   ├── cli.ts                   # entrypoint command
│   ├── crypto.ts                # encrypt/decrypt _d
│   ├── exportExcel.ts           # JSON -> Excel
│   ├── menu.ts                  # menu interaktif
│   ├── session.ts               # baca env/cookie/user
│   ├── sessionCheck.ts          # cek session
│   ├── sessionLogin.ts          # buka browser login & capture .env
│   └── ssiClient.ts             # HTTP client + pagination
├── scripts
│   └── verify-decrypt.ts        # decrypt file response _d
└── vendor
    ├── D6l4LlDU.js              # shim runtime config
    ├── Du44SBtj.js              # implementasi HPKE asli aplikasi
    └── x9SshGGZ.js              # shim schema validator
```

`vendor/Du44SBtj.js` adalah salinan implementasi crypto dari bundle aplikasi. Ini sengaja dipakai agar algoritma HPKE dan format envelope **persis sama** dengan aplikasi asli.

---

## 3. Endpoint dan Cookie

### 3.1 Base URL

```text
https://sehatindonesiaku.kemkes.go.id
```

### 3.2 Endpoint utama

```text
POST /api/pkg/ssi/list-kunjungan-umum
```

Endpoint lain yang relevan:

```text
GET  /api/crypto-key
GET  /api/user-management/menu
POST /api/pkg/ssi/check-nik
POST /api/pkg/ssi/register-pre
POST /api/pkg/ssi/detail-screening-ssi
```

### 3.3 Cookie yang diperlukan

Ambil dari request header `cookie` saat aplikasi sudah login:

```text
cf_clearance
access_menu
asik_web_stk
asik_web_ctk
token_eksternal
refresh_token
user_id
key_token
```

Yang paling penting untuk crypto:

- `asik_web_ctk`: berisi key material HPKE.
- `cf_clearance`: Cloudflare clearance.
- `access_menu`, `token_eksternal`, `refresh_token`, `key_token`, `user_id`: session/auth.

Jangan pernah mencetak atau meng-commit nilai cookie penuh.

---

## 4. Session Login (Browser Hanya untuk Login)

### 4.1 Kenapa perlu browser?

Aplikasi memakai login session, Cloudflare, dan kemungkinan single-session. Login manual lebih aman daripada mencoba meniru form login.

### 4.2 Alur `session-login`

Implementasi ada di `src/sessionLogin.ts`.

1. Buka Chromium/Chrome persistent context dengan profile `.sisyphus/chrome-profile`.
2. Buka `https://sehatindonesiaku.kemkes.go.id/auth/login`.
3. User login manual.
4. Script polling cookie sampai menemukan:
   - `asik_web_ctk`
   - `token_eksternal`
   - `access_menu`
   - `key_token`
5. Setelah cookie ada, script membuka halaman aplikasi dan mengambil:
   ```js
   localStorage.getItem("user_eksternal")
   ```
6. Script menyusun cookie header dan menulis `.env`.

### 4.3 `.env` yang dihasilkan

```env
SSI_BASE_URL="https://sehatindonesiaku.kemkes.go.id"
SSI_COOKIE_HEADER="cf_clearance=...; access_menu=...; user_id=...; key_token=...; asik_web_stk=...; asik_web_ctk=...; token_eksternal=...; refresh_token=..."
SSI_CTK="eyJjc2s..."
SSI_USER_EKSTERNAL_JSON='{"id":"...","name":"...","organitazion_ihs":"...","partner_code":"...","user_type":"..."}'
SSI_REFERER="https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan"
SSI_TIMEOUT_MS="60000"
```

Catatan:

- `SSI_CTK` = nilai cookie `asik_web_ctk` setelah URL-decode.
- `SSI_USER_EKSTERNAL_JSON` tidak ada di header request; harus diambil dari localStorage.
- `.env` dimuat otomatis oleh CLI memakai `process.loadEnvFile('.env')`.

### 4.4 Command login

```powershell
npm run cli -- session-login
```

Jika Playwright tidak menemukan Chrome:

```powershell
npx playwright install chromium
```

Atau gunakan Chrome lokal (kode memakai `channel: "chrome"`).

---

## 5. Session Check

Command:

```powershell
npm run cli -- session-check
```

Implementasi `src/sessionCheck.ts` memanggil:

```text
GET /api/user-management/menu
```

Dengan header cookie dari `.env`.

Respons sukses berisi menu user. Contoh output:

```json
{
  "ok": true,
  "status": 200,
  "hasAccessMenu": true,
  "menuCount": 7,
  "ssiUser": {
    "user_id": "1221065",
    "fullname": "Nama User",
    "faskes_code": "1000057936",
    "partner_code": "",
    "partner_category_code": ""
  }
}
```

Jika 401/403 atau cookie hilang, jalankan `session-login` lagi.

---

## 6. Crypto: HPKE dan Envelope `_d`

Bagian ini paling penting untuk agent lain.

### 6.1 Runtime config

Aplikasi menggunakan public runtime config:

```text
clientEncryptDecrypt = "true"
```

Jika aktif, `useFetchSsi` membungkus payload:

```js
{ _d: "<encrypted>" }
```

Jika crypto key belum siap, aplikasi mencoba:

```text
GET /api/crypto-key
```

Jika server mengembalikan error code:

```text
ENCRYPTED_PAYLOAD_REQUIRED
```

maka request diulang sekali setelah refresh key.

### 6.2 Key material di cookie `asik_web_ctk`

Nilai `asik_web_ctk` adalah base64 dari JSON:

```json
{
  "csk": "<base64 JSON JWK EC P-256 private key>",
  "spk": "<base64 raw public key>"
}
```

Detail:

- `csk` = client secret key.
  - Setelah base64-decode, isinya JWK:
    ```json
    {
      "key_ops": ["deriveBits"],
      "ext": true,
      "kty": "EC",
      "crv": "P-256",
      "x": "...",
      "y": "...",
      "d": "..."
    }
    ```
  - Dipakai untuk **mendekripsi response** dari server.
- `spk` = server public key.
  - Base64 dari 65 byte uncompressed P-256 point (`0x04 || X || Y`).
  - Dipakai untuk **mengenkripsi request** ke server.

Catatan keamanan: `csk` adalah private key client. Jangan pernah commit, log, atau bagikan nilainya.

### 6.3 Suite HPKE

Dari bundle aplikasi:

```js
new HPKE({
  kem: DhkemP256HkdfSha256,
  kdf: HkdfSha256,
  aead: Chacha20Poly1305
})
```

Artinya:

- KEM: `DHKEM(P-256, HKDF-SHA256)`
- KDF: `HKDF-SHA256`
- AEAD: `ChaCha20-Poly1305`
- Mode: HPKE Base (tanpa PSK/auth)

### 6.4 Format envelope `_d`

Envelope dibuat oleh fungsi setara `sealPayload` di bundle:

```js
const { ct, enc } = await hpke.seal(
  { recipientPublicKey: serverPublicKey },
  new TextEncoder().encode(JSON.stringify(plaintext))
);

const ctLen = decimalString(ct.byteLength);
const buffer = concat(
  [ctLen.length],
  asciiBytes(ctLen),
  ct,
  enc
);

return obfuscateBase64(base64(buffer));
```

Jadi isi `_d` sebelum obfuscation:

```text
[1 byte panjang digit][digit panjang ciphertext][ciphertext][enc]
```

- `ct` = ciphertext + AEAD tag.
- `enc` = encapsulated ephemeral public key.
- Panjang ciphertext ditulis sebagai string desimal (bukan biner), didahului panjang digitnya.

### 6.5 Obfuscation base64

Fungsi `pa` di bundle menambahkan prefix/suffix acak 5 karakter base36:

```text
randomPrefix(5) + base64WithoutPadding + randomSuffix(5) + paddingCount
```

`paddingCount` adalah jumlah karakter `=` yang dihapus.

Saat decrypt, fungsi `ga` melakukan kebalikannya:

```text
validate prefix == suffix
restore padding "=" sebanyak digit terakhir
```

Karena itu `_d` tidak bisa langsung di-base64-decode tanpa langkah deobfuscation.

### 6.6 Proses decrypt response

```text
1. Terima JSON response: { "_d": "..." }
2. Deobfuscate _d -> base64 standar
3. Base64 decode -> Uint8Array
4. Baca byte pertama = panjang digit
5. Baca digit panjang ciphertext
6. Ambil ciphertext
7. Sisa byte = enc
8. HPKE open dengan csk private key
9. Decode plaintext UTF-8
10. JSON.parse
```

Catatan: request `_d` **tidak bisa didekripsi** oleh client karena dienkripsi ke server public key. Yang bisa didekripsi adalah response `_d`.

### 6.7 Jangan implement ulang HPKE dari nol

Gunakan `vendor/Du44SBtj.js` yang sudah mengekspor:

```ts
import { u as useCrypto } from '../vendor/Du44SBtj.js';

const crypto = useCrypto();
const encrypted = await crypto.encrypt(plainObject);
const decrypted = await crypto.decrypt(encryptedString);
```

Shim `vendor/D6l4LlDU.js` menyediakan:

- runtime config `cpid = "asik_web"`
- cookie value dari env `ASIK_WEB_CTK`
- JSON parser untuk hasil decrypt

Shim `vendor/x9SshGGZ.js` menyediakan validator minimal untuk `{ csk, spk }`.

---

## 7. Payload `list-kunjungan-umum`

### 7.1 Plaintext payload

Dari kode halaman aplikasi:

```js
const payload = {
  page: page,
  limit: pageSize,
  faskes_code: faskesCode,
  screening_start_date: screeningDate,
  screening_end_date: screeningDate,
  partner_code: userType ? partnerCode : "",
  ticket_number: "",
  patient_nik: "",
  patient_name: "",
  status: ""
};
```

Jika user mencari:

- nama -> isi `patient_name`
- NIK -> isi `patient_nik`
- ticket -> isi `ticket_number`

### 7.2 User object

Sebelum enkripsi, aplikasi menambahkan object `user`:

```js
{
  user_id,
  fullname,
  faskes_code,
  partner_code,
  partner_category_code
}
```

Mapping `partner_category_code`:

```text
MITRA -> mitra
FKTP  -> klinik
lain  -> ""
```

Sumber data: localStorage `user_eksternal`.

Contoh:

```json
{
  "id": "1221065",
  "name": "Nama User",
  "organitazion_ihs": "1000057936",
  "partner_code": "",
  "user_type": ""
}
```

### 7.3 Request body final

```json
{
  "_d": "<obfuscated HPKE envelope>"
}
```

### 7.4 Headers penting

```text
accept: application/json
content-type: application/json
origin: https://sehatindonesiaku.kemkes.go.id
referer: https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan
cookie: <full cookie header>
user-agent: browser UA
```

`referer` tergantung halaman. Contoh yang umum:

- `/ckg-pendaftaran-individu`
- `/ckg-pelayanan`

Jika hasil kosong/aneh, coba ganti referer.

---

## 8. Pagination dan Ambil Semua Data

### 8.1 Bentuk response setelah decrypt

```json
{
  "statusCode": 200,
  "data": {
    "list": [],
    "meta": {
      "limit": 10,
      "page": 1,
      "total_data": 0,
      "total_page": 0
    }
  }
}
```

### 8.2 Ambil semua halaman

Implementasi `listKunjunganUmumAll` di `src/ssiClient.ts`:

```text
1. Request page 1 dengan pageSize
2. Baca meta.total_page dan meta.total_data
3. Loop page 2 .. total_page
4. Gabungkan semua item ke satu array
5. Kembalikan { list, meta }
```

Command:

```powershell
npm run cli -- list --all --page-size 50 --start-date 2026-09-01 --end-date 2026-09-30 --referer "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan" --out september.json
```

Penjelasan:

- `--all` = ambil semua halaman
- `--page-size` = jumlah row per request (bukan total limit)
- `--start-date` / `--end-date` = rentang tanggal screening
- `--screening-date` = satu tanggal (start=end)
- `--out` = simpan JSON ke file
- `--referer` = header referer

Jika API membatasi page size, turunkan `--page-size` ke `10` atau `20`.

---

## 9. Menu Interaktif

Jalankan:

```powershell
npm run cli -- menu
```

Menu:

```text
1. Session check
2. Browser login / capture .env
3. Ambil list-kunjungan-umum
4. POST endpoint SSI lain
5. Export JSON hasil ke Excel
6. Keluar
```

Menu hanya interface terminal. Tidak membuka browser kecuali opsi 2, dan tidak berjalan di background.

---

## 10. Ekspor JSON ke Excel

Command:

```powershell
npm run cli -- export-excel --input september.json --out hasil.xlsx
```

Atau lewat menu opsi `5`.

### 10.1 Field yang diekspor

Dari setiap item list:

| Kolom | Sumber |
|---|---|
| `fullname` | `patient.fullname` |
| `gender` | `patient.gender` |
| `nik` | `patient.nik` |
| `birth_date` | `patient.birth_date` |
| `ticket_number` | `ticket_number` |
| `attend_date` | `treatment.attend_date` |
| `done_date` | `treatment.done_date` |
| `finished_date` | `treatment.finished_date` |
| `register_date` | `treatment.register_date` |
| `started_date` | `treatment.started_date` |

### 10.2 Format tanggal WIB

Kolom tanggal dengan timezone diubah ke format lokal Indonesia, timezone `Asia/Jakarta`:

```text
2026-09-21T15:26:03.621Z
-> 21/09/2026 22.26.03
```

Implementasi ada di `src/exportExcel.ts` memakai:

```ts
new Date(value).toLocaleString('id-ID', {
  timeZone: 'Asia/Jakarta',
  hour12: false,
})
```

---

## 11. Troubleshooting

### 11.1 `Missing SSI_COOKIE_HEADER`

Penyebab:

- `.env` belum ada
- `.env` tidak punya `SSI_COOKIE_HEADER`
- CLI dijalankan dari folder yang salah

Solusi:

- Jalankan `npm run cli -- session-login`
- Pastikan `.env` ada di root project
- Cek `process.loadEnvFile('.env')` di `src/cli.ts`

### 11.2 `Missing SSI_CTK/ASIK_WEB_CTK`

Penyebab:

- cookie `asik_web_ctk` tidak ada di `.env`
- `SSI_CTK` kosong

Solusi:

- Ambil dari cookie `asik_web_ctk`
- URL-decode nilainya
- Jalankan `session-login` lagi

### 11.3 `Executable doesn't exist at ... chrome.exe`

Penyebab:

- Playwright belum install browser

Solusi:

```powershell
npx playwright install chromium
```

Atau pakai Chrome lokal dengan `channel: "chrome"` di `src/sessionLogin.ts`.

### 11.4 `list` kosong

Kemungkinan:

- tanggal tidak ada kunjungan
- `faskes_code` salah
- `partner_code` salah
- `referer` salah
- filter `status` tidak cocok

Solusi:

- Coba tanggal yang diketahui ada data
- Coba tanpa filter status
- Coba referer `/ckg-pelayanan` atau `/ckg-pendaftaran-individu`

### 11.5 `401` / `403`

Session expired atau Cloudflare menolak.

Solusi:

- Jalankan `session-check`
- Jika gagal, `session-login` lagi
- Pastikan tidak membuka sesi paralel dengan akun yang sama jika aplikasi membatasi

### 11.6 `ENCRYPTED_PAYLOAD_REQUIRED`

Artinya server minta payload terenkripsi atau key sudah berubah.

Solusi:

- Client otomatis mencoba `GET /api/crypto-key`
- Jika masih gagal, refresh cookie/`asik_web_ctk`
- Pastikan `clientEncryptDecrypt` dianggap `true`

### 11.7 Gagal decrypt response

Penyebab:

- `SSI_CTK` tidak cocok dengan session yang membuat response
- cookie kedaluwarsa
- envelope `_d` corrupt

Solusi:

- Ambil response baru dan cookie baru dari session yang sama
- Jangan mencampur response lama dengan `asik_web_ctk` baru

### 11.8 Aplikasi tidak bisa dibuka di dua browser

Kemungkinan aplikasi memakai single-session atau Cloudflare clearance.

Solusi:

- Gunakan satu browser/profile untuk login
- Setelah cookie disimpan, tutup browser dan pakai full HTTP
- Jangan jalankan dua automation browser dengan akun yang sama

---

## 12. Perintah Penting

```powershell
# install dependency
npm install

# cek session
npm run cli -- session-check

# login browser + capture .env
npm run cli -- session-login

# ambil satu halaman
npm run cli -- list --page 1 --limit 10 --screening-date 2026-09-21 --referer "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan"

# ambil semua halaman
npm run cli -- list --all --page-size 50 --start-date 2026-09-01 --end-date 2026-09-30 --referer "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan" --out september.json

# export Excel
npm run cli -- export-excel --input september.json --out hasil.xlsx

# menu interaktif
npm run cli -- menu

# typecheck
npm run typecheck
```

---

## 13. Aturan untuk AI Agent Lain

Jika agent lain membaca dokumen ini, urutan yang harus dilakukan:

1. Jangan mencoba menebak algoritma crypto. Pakai `vendor/Du44SBtj.js`.
2. Jangan mencoba mendekripsi request `_d` tanpa server private key.
3. Pastikan `SSI_CTK` dan `SSI_COOKIE_HEADER` berasal dari session yang sama.
4. Jalankan `session-check` sebelum `list`.
5. Gunakan `--all` untuk semua halaman; jangan hanya page 1.
6. Simpan output ke file dengan `--out`.
7. Untuk Excel, gunakan `export-excel`.
8. Jangan log cookie, token, `csk`, NIK, atau data pasien.
9. Jangan commit `.env`.
10. Jika response 401/403, refresh session via browser.

---

## 14. Keamanan dan Kepatuhan

Data ini mengandung data pribadi dan data kesehatan. Hanya akses jika punya izin resmi dan hak akses. Patuhi UU PDP dan kebijakan instansi.

- Jangan membagikan cookie/session.
- Jangan menyimpan `.env` di repository.
- Rotasi token setelah sesi testing selesai.
- Simpan hasil ekspor di tempat aman.
- Redaksi data sensitif jika hanya butuh contoh.
- Jangan menjalankan request di luar scope izin.
