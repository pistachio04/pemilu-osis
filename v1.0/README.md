# 🗳️ E-Voting Pemilihan Ketua OSIS (Google Apps Script)

Web app pemilihan Ketua OSIS berbasis Google Spreadsheet + Apps Script.

| Halaman | URL | Fungsi |
|---|---|---|
| Pemilihan (siswa) | `URL_WEB_APP` | Login NISN + password → pilih kandidat |
| Dashboard (admin) | `URL_WEB_APP?page=dashboard` | Pantau hasil secara real-time, buka/tutup pemilihan |

## File

| File | Keterangan |
|---|---|
| `Code.gs` | Backend (login, simpan suara, hitung hasil, setup sheet) |
| `Index.html` | Halaman login & pemilihan siswa |
| `Dashboard.html` | Dashboard admin (grafik, statistik, partisipasi per kelas) |
| `Styles.html` | CSS bersama |
| `appsscript.json` | Manifest (opsional, hanya jika memakai `clasp`) |

## Cara Instalasi

1. Buat **Google Spreadsheet** baru.
2. Klik menu **Extensions → Apps Script**.
3. Di editor Apps Script:
   - Ganti isi `Code.gs` dengan isi file `Code.gs`.
   - Klik **+ → HTML**, buat file bernama `Index`, `Dashboard`, dan `Styles` (tanpa `.html`), lalu salin isinya masing-masing.
4. Pilih fungsi **`setupSpreadsheet`** di dropdown → klik **Run** → izinkan akses (Authorize).
   Sheet `Pemilih`, `Kandidat`, `Suara`, `Admin`, dan `Pengaturan` akan dibuat beserta contoh data.
5. Isi data asli:
   - **Pemilih** → `NISN | Password | Nama | Kelas` (kolom `Status` & `Waktu Memilih` dibiarkan kosong, diisi otomatis).
   - **Kandidat** → `No Urut | Nama Ketua | Nama Wakil | Visi | Misi | Foto (URL)`.
     Misi bisa ditulis per baris (Alt+Enter / Ctrl+Enter di dalam sel).
     Foto boleh link Google Drive (set berbagi: *Siapa saja yang memiliki link*).
   - **Admin** → username & password panitia. **Segera ganti `admin / admin123`!**
   - **Pengaturan** → `Judul`, `Nama Sekolah`, `Status Pemilihan` (`BUKA` / `TUTUP`).
6. Klik **Deploy → New deployment → ⚙️ Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   - Klik **Deploy**, salin URL-nya.
7. Bagikan URL ke siswa. Dashboard: tambahkan `?page=dashboard` di akhir URL.

> ⚠️ Setiap kali kode diubah, lakukan **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy** agar perubahan aktif di URL yang sama.

## Fitur

**Siswa**
- Login dengan NISN + password dari sheet `Pemilih` (nol di depan NISN tetap dikenali).
- Hanya bisa memilih **satu kali**; status otomatis tercatat `SUDAH`.
- Konfirmasi sebelum mengirim suara, lalu otomatis kembali ke halaman login (cocok untuk 1 perangkat bergantian di bilik suara).
- Auto-logout setelah 3 menit tanpa aktivitas.

**Admin / Dashboard**
- Total pemilih, sudah/belum memilih, persentase partisipasi.
- Grafik batang & donat perolehan suara, peringkat kandidat.
- Partisipasi per kelas.
- Tombol **Buka / Tutup Pemilihan**.
- Auto-refresh setiap 10 detik.

**Keamanan**
- **Suara rahasia**: sheet `Suara` hanya menyimpan kode acak + nomor urut (tanpa NISN), dan disisipkan di baris acak sehingga tidak bisa dicocokkan dengan urutan waktu memilih.
- `LockService` mencegah suara ganda saat banyak siswa memilih bersamaan.
- Sesi berbasis token (siswa 30 menit, admin 6 jam).
- Blokir sementara 5 menit setelah 5 kali login gagal.
- Fungsi `setupSpreadsheet` & `resetPemilihan` hanya bisa dijalankan pemilik dari editor/menu spreadsheet.

## Menu Spreadsheet

Setelah spreadsheet dibuka ulang, muncul menu **🗳️ E-Voting OSIS**:
- **Setup / Buat Sheet** – membuat sheet yang belum ada.
- **Reset Semua Suara** – menghapus seluruh suara & status pemilih (untuk uji coba sebelum hari H).

## Tips

- Format kolom **NISN** dan **Password** sebagai *Plain text* (Format → Number → Plain text) — sudah otomatis jika memakai `setupSpreadsheet`.
- Lakukan uji coba dengan beberapa akun, lalu jalankan **Reset Semua Suara** sebelum pemilihan dimulai.
- Lindungi sheet `Suara` dan `Pemilih` (Data → Protect sheets and ranges) agar tidak diubah manual.
- Apps Script membatasi sekitar 30 eksekusi bersamaan; untuk sekolah besar, atur jadwal memilih per kelas.
