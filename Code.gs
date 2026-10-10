/**
 * ============================================================
 *  E-VOTING PEMILIHAN KETUA OSIS — Google Apps Script
 * ============================================================
 *  Struktur Spreadsheet (dibuat otomatis oleh setupSpreadsheet()):
 *   - Pemilih    : NISN | Password | Nama | Kelas | Status | Waktu Memilih
 *   - Kandidat   : No Urut | Nama Ketua | Nama Wakil | Visi | Misi | Foto (URL)
 *   - Suara      : Kode Suara | No Urut   (TIDAK menyimpan NISN → suara rahasia)
 *   - Admin      : Username | Password
 *   - Pengaturan : Kunci | Nilai
 *
 *  Halaman:
 *   - <URL Web App>                 → Halaman login & pemilihan siswa
 *   - <URL Web App>?page=dashboard  → Dashboard admin (hasil pemilihan)
 * ============================================================
 */

// Kosongkan jika script dibuat dari menu Extensions > Apps Script di dalam spreadsheet.
// Isi dengan ID spreadsheet jika script dibuat terpisah (standalone).
const SPREADSHEET_ID = '';

const SHEETS = {
  PEMILIH: 'Pemilih',
  KANDIDAT: 'Kandidat',
  SUARA: 'Suara',
  ADMIN: 'Admin',
  PENGATURAN: 'Pengaturan'
};

const VOTER_SESSION_TTL = 30 * 60;     // 30 menit
const ADMIN_SESSION_TTL = 6 * 60 * 60; // 6 jam (maksimum CacheService)
const MAX_LOGIN_ATTEMPTS = 5;          // batas percobaan login gagal
const LOCKOUT_SECONDS = 5 * 60;        // durasi blokir setelah gagal berulang

/* ============================================================
 *  WEB APP
 * ============================================================ */

function doGet(e) {
  const isDashboard = e && e.parameter && e.parameter.page === 'dashboard';
  const tpl = HtmlService.createTemplateFromFile(isDashboard ? 'Dashboard' : 'Index');
  const settings = getSettings_();

  tpl.judul = settings['Judul'] || 'Pemilihan Ketua OSIS';
  tpl.sekolah = settings['Nama Sekolah'] || '';
  tpl.appUrl = ScriptApp.getService().getUrl();

  return tpl.evaluate()
    .setTitle((isDashboard ? 'Dashboard — ' : '') + tpl.judul)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🗳️ E-Voting OSIS')
    .addItem('Setup / Buat Sheet', 'setupSpreadsheet')
    .addSeparator()
    .addItem('Reset Semua Suara (HATI-HATI)', 'resetPemilihan')
    .addToUi();
}

/* ============================================================
 *  API PEMILIH (dipanggil dari Index.html)
 * ============================================================ */

function loginPemilih(nisn, password) {
  try {
    nisn = normNisn_(nisn);
    password = String(password == null ? '' : password).trim();

    if (!nisn || !password) return fail_('NISN dan password wajib diisi.');
    if (!isVotingOpen_()) return fail_('Pemilihan sedang DITUTUP. Silakan hubungi panitia.');
    if (isLockedOut_('voter', nisn)) {
      return fail_('Terlalu banyak percobaan gagal. Silakan coba lagi dalam 5 menit.');
    }

    const voter = findVoter_(nisn);
    if (!voter || String(voter.password).trim() !== password) {
      registerFailedAttempt_('voter', nisn);
      return fail_('NISN atau password salah.');
    }
    clearFailedAttempts_('voter', nisn);

    if (voter.sudah) {
      return fail_('Anda sudah menggunakan hak pilih' +
        (voter.waktu ? ' pada ' + voter.waktu : '') + '. Terima kasih!');
    }

    const token = createSession_('voter', { nisn: nisn }, VOTER_SESSION_TTL);
    return {
      ok: true,
      token: token,
      nama: voter.nama,
      kelas: voter.kelas,
      kandidat: getKandidat_()
    };
  } catch (err) {
    return fail_('Terjadi kesalahan: ' + err.message);
  }
}

function submitVote(token, noUrut) {
  try {
    const session = getSession_('voter', token);
    if (!session) return fail_('Sesi Anda telah berakhir. Silakan login kembali.', { expired: true });
    if (!isVotingOpen_()) return fail_('Pemilihan sudah ditutup.');

    const kandidat = getKandidat_().filter(function (k) { return k.no === String(noUrut); })[0];
    if (!kandidat) return fail_('Kandidat tidak valid.');

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return fail_('Server sedang sibuk, silakan coba lagi.');

    try {
      const voter = findVoter_(session.nisn);
      if (!voter) return fail_('Data pemilih tidak ditemukan.');
      if (voter.sudah) {
        destroySession_('voter', token);
        return fail_('Anda sudah menggunakan hak pilih.', { expired: true });
      }

      // Tandai pemilih dulu (mencegah pemilihan ganda), lalu simpan suara.
      getSheet_(SHEETS.PEMILIH).getRange(voter.row, 5, 1, 2).setValues([['SUDAH', new Date()]]);
      insertVoteRandomly_(kandidat.no);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }

    destroySession_('voter', token);
    return { ok: true, message: 'Terima kasih! Suara Anda telah tersimpan.' };
  } catch (err) {
    return fail_('Terjadi kesalahan: ' + err.message);
  }
}

function logoutPemilih(token) {
  destroySession_('voter', token);
  return { ok: true };
}

/* ============================================================
 *  API ADMIN (dipanggil dari Dashboard.html)
 * ============================================================ */

function loginAdmin(username, password) {
  try {
    username = String(username == null ? '' : username).trim();
    password = String(password == null ? '' : password).trim();
    if (!username || !password) return fail_('Username dan password wajib diisi.');
    if (isLockedOut_('admin', username)) {
      return fail_('Terlalu banyak percobaan gagal. Silakan coba lagi dalam 5 menit.');
    }

    const sh = getSheet_(SHEETS.ADMIN);
    const last = sh.getLastRow();
    const rows = last >= 2 ? sh.getRange(2, 1, last - 1, 2).getValues() : [];
    const match = rows.some(function (r) {
      return String(r[0]).trim() === username && String(r[1]).trim() === password;
    });

    if (!match) {
      registerFailedAttempt_('admin', username);
      return fail_('Username atau password salah.');
    }
    clearFailedAttempts_('admin', username);

    const token = createSession_('admin', { username: username }, ADMIN_SESSION_TTL);
    return { ok: true, token: token, username: username };
  } catch (err) {
    return fail_('Terjadi kesalahan: ' + err.message);
  }
}

function getHasil(token) {
  try {
    const session = getSession_('admin', token, ADMIN_SESSION_TTL);
    if (!session) return fail_('Sesi admin berakhir. Silakan login kembali.', { expired: true });
    const data = computeResults_();
    data.username = session.username;
    return { ok: true, data: data };
  } catch (err) {
    return fail_('Terjadi kesalahan: ' + err.message);
  }
}

function setStatusPemilihan(token, status) {
  try {
    const session = getSession_('admin', token, ADMIN_SESSION_TTL);
    if (!session) return fail_('Sesi admin berakhir. Silakan login kembali.', { expired: true });
    status = String(status).toUpperCase() === 'BUKA' ? 'BUKA' : 'TUTUP';
    setSetting_('Status Pemilihan', status);
    return { ok: true, status: status };
  } catch (err) {
    return fail_('Terjadi kesalahan: ' + err.message);
  }
}

function logoutAdmin(token) {
  destroySession_('admin', token);
  return { ok: true };
}

/* ============================================================
 *  PERHITUNGAN HASIL
 * ============================================================ */

function computeResults_() {
  const settings = getSettings_();
  const kandidat = getKandidat_();

  // Hitung suara per kandidat
  const counts = {};
  kandidat.forEach(function (k) { counts[k.no] = 0; });
  let totalSuara = 0;
  const sSh = getSheet_(SHEETS.SUARA);
  const sLast = sSh.getLastRow();
  if (sLast >= 2) {
    sSh.getRange(2, 2, sLast - 1, 1).getValues().forEach(function (r) {
      const no = String(r[0]).trim();
      if (counts.hasOwnProperty(no)) { counts[no]++; totalSuara++; }
    });
  }

  // Statistik pemilih & per kelas
  const pSh = getSheet_(SHEETS.PEMILIH);
  const pLast = pSh.getLastRow();
  const pRows = pLast >= 2 ? pSh.getRange(2, 1, pLast - 1, 5).getValues() : [];
  let totalPemilih = 0, sudahMemilih = 0;
  const kelasMap = {};
  pRows.forEach(function (r) {
    if (!normNisn_(r[0])) return;
    totalPemilih++;
    const kelas = String(r[3]).trim() || '(Tanpa Kelas)';
    if (!kelasMap[kelas]) kelasMap[kelas] = { kelas: kelas, total: 0, sudah: 0 };
    kelasMap[kelas].total++;
    if (isSudah_(r[4])) { sudahMemilih++; kelasMap[kelas].sudah++; }
  });

  const perKelas = Object.keys(kelasMap)
    .sort(function (a, b) { return a.localeCompare(b, 'id', { numeric: true }); })
    .map(function (k) {
      const o = kelasMap[k];
      o.persen = o.total ? round1_(o.sudah / o.total * 100) : 0;
      return o;
    });

  const hasilKandidat = kandidat.map(function (k) {
    return {
      no: k.no, ketua: k.ketua, wakil: k.wakil, foto: k.foto,
      suara: counts[k.no],
      persen: totalSuara ? round1_(counts[k.no] / totalSuara * 100) : 0
    };
  });

  return {
    judul: settings['Judul'] || 'Pemilihan Ketua OSIS',
    sekolah: settings['Nama Sekolah'] || '',
    status: isVotingOpen_() ? 'BUKA' : 'TUTUP',
    totalPemilih: totalPemilih,
    sudahMemilih: sudahMemilih,
    belumMemilih: totalPemilih - sudahMemilih,
    partisipasi: totalPemilih ? round1_(sudahMemilih / totalPemilih * 100) : 0,
    totalSuara: totalSuara,
    kandidat: hasilKandidat,
    perKelas: perKelas,
    updatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss')
  };
}

/* ============================================================
 *  DATA HELPERS
 * ============================================================ */

function getSS_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  const sh = getSS_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" tidak ditemukan. Jalankan setupSpreadsheet() terlebih dahulu.');
  return sh;
}

function findVoter_(nisn) {
  const sh = getSheet_(SHEETS.PEMILIH);
  const last = sh.getLastRow();
  if (last < 2) return null;
  const values = sh.getRange(2, 1, last - 1, 6).getValues();
  for (let i = 0; i < values.length; i++) {
    if (normNisn_(values[i][0]) === nisn) {
      const r = values[i];
      return {
        row: i + 2,
        password: r[1],
        nama: String(r[2]).trim(),
        kelas: String(r[3]).trim(),
        sudah: isSudah_(r[4]),
        waktu: fmtDate_(r[5])
      };
    }
  }
  return null;
}

function getKandidat_() {
  const sh = getSheet_(SHEETS.KANDIDAT);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 6).getValues()
    .filter(function (r) { return String(r[0]).trim() !== '' && String(r[1]).trim() !== ''; })
    .map(function (r) {
      return {
        no: String(r[0]).trim(),
        ketua: String(r[1]).trim(),
        wakil: String(r[2]).trim(),
        visi: String(r[3]).trim(),
        misi: String(r[4]).trim(),
        foto: driveImageUrl_(r[5])
      };
    });
}

/** Menyimpan suara di posisi baris acak agar urutan baris tidak bisa dicocokkan dengan waktu memilih. */
function insertVoteRandomly_(noUrut) {
  const sh = getSheet_(SHEETS.SUARA);
  const row = [Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase(), noUrut];
  const last = sh.getLastRow();
  const pos = 2 + Math.floor(Math.random() * Math.max(last, 1)); // 2 .. last+1
  if (pos > last) {
    sh.appendRow(row);
  } else {
    sh.insertRowBefore(pos);
    sh.getRange(pos, 1, 1, 2).clearFormat().setValues([row]);
  }
}

function getSettings_() {
  const sh = getSS_().getSheetByName(SHEETS.PENGATURAN);
  if (!sh || sh.getLastRow() < 2) return {};
  const out = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    if (String(r[0]).trim()) out[String(r[0]).trim()] = r[1];
  });
  return out;
}

function setSetting_(key, value) {
  const sh = getSheet_(SHEETS.PENGATURAN);
  const last = sh.getLastRow();
  if (last >= 2) {
    const keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === key) {
        sh.getRange(i + 2, 2).setValue(value);
        return;
      }
    }
  }
  sh.appendRow([key, value]);
}

function isVotingOpen_() {
  return String(getSettings_()['Status Pemilihan'] || '').trim().toUpperCase() === 'BUKA';
}

/* ============================================================
 *  SESSION & KEAMANAN
 * ============================================================ */

function createSession_(type, data, ttl) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('sess_' + type + '_' + token, JSON.stringify(data), ttl);
  return token;
}

function getSession_(type, token, refreshTtl) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const key = 'sess_' + type + '_' + token;
  const raw = cache.get(key);
  if (!raw) return null;
  if (refreshTtl) cache.put(key, raw, refreshTtl);
  return JSON.parse(raw);
}

function destroySession_(type, token) {
  if (token) CacheService.getScriptCache().remove('sess_' + type + '_' + token);
}

function isLockedOut_(type, id) {
  return Number(CacheService.getScriptCache().get('fail_' + type + '_' + id) || 0) >= MAX_LOGIN_ATTEMPTS;
}

function registerFailedAttempt_(type, id) {
  const cache = CacheService.getScriptCache();
  const key = 'fail_' + type + '_' + id;
  cache.put(key, String(Number(cache.get(key) || 0) + 1), LOCKOUT_SECONDS);
}

function clearFailedAttempts_(type, id) {
  CacheService.getScriptCache().remove('fail_' + type + '_' + id);
}

/** Mencegah fungsi berbahaya dipanggil dari web app (google.script.run). */
function assertOwner_() {
  const active = Session.getActiveUser().getEmail();
  const owner = Session.getEffectiveUser().getEmail();
  if (!active || active !== owner) {
    throw new Error('Fungsi ini hanya boleh dijalankan oleh pemilik script dari editor / spreadsheet.');
  }
}

/* ============================================================
 *  UTILITAS
 * ============================================================ */

/** Normalisasi NISN: hapus spasi & nol di depan (Sheets sering menghapus nol di depan angka). */
function normNisn_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, '').replace(/^0+/, '');
}

function isSudah_(v) {
  return v === true || String(v).trim().toUpperCase() === 'SUDAH';
}

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  return String(v || '');
}

function round1_(n) {
  return Math.round(n * 10) / 10;
}

function fail_(message, extra) {
  const o = { ok: false, message: message };
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return o;
}

/** Ubah link Google Drive menjadi link gambar langsung. */
function driveImageUrl_(url) {
  url = String(url || '').trim();
  if (!url) return '';
  if (/drive\.google\.com|docs\.google\.com/.test(url)) {
    const m = url.match(/\/d\/([\w-]{20,})/) || url.match(/[?&]id=([\w-]{20,})/);
    if (m) return 'https://lh3.googleusercontent.com/d/' + m[1];
  }
  return url;
}

/* ============================================================
 *  SETUP & RESET (jalankan dari editor / menu spreadsheet)
 * ============================================================ */

function setupSpreadsheet() {
  assertOwner_();
  const ss = getSS_();

  ensureSheet_(ss, SHEETS.PEMILIH,
    ['NISN', 'Password', 'Nama', 'Kelas', 'Status', 'Waktu Memilih'],
    [
      ['0012345671', 'siswa123', 'Ahmad Fauzi', 'X-1', '', ''],
      ['0012345672', 'siswa123', 'Budi Santoso', 'X-1', '', ''],
      ['0012345673', 'siswa123', 'Citra Lestari', 'X-2', '', ''],
      ['0012345674', 'siswa123', 'Dewi Anggraini', 'XI-1', '', ''],
      ['0012345675', 'siswa123', 'Eko Prasetyo', 'XII-1', '', '']
    ],
    function (sh) { sh.getRange('A:B').setNumberFormat('@'); }
  );

  ensureSheet_(ss, SHEETS.KANDIDAT,
    ['No Urut', 'Nama Ketua', 'Nama Wakil', 'Visi', 'Misi', 'Foto (URL)'],
    [
      [1, 'Rizky Ramadhan', 'Salsa Nabila', 'Mewujudkan OSIS yang aktif, kreatif, dan berprestasi.',
        'Mengadakan lomba antar kelas setiap semester\nMembuat program literasi pagi\nMeningkatkan kegiatan ekstrakurikuler', ''],
      [2, 'Nadia Putri', 'Fajar Hidayat', 'OSIS sebagai wadah aspirasi seluruh siswa.',
        'Membuka kotak aspirasi digital\nMengadakan bakti sosial rutin\nMenjaga kebersihan dan kenyamanan sekolah', ''],
      [3, 'Dimas Saputra', 'Aulia Rahma', 'Sekolah hijau, siswa berkarakter.',
        'Program Go Green sekolah\nPelatihan kepemimpinan siswa\nPentas seni tahunan', '']
    ]
  );

  ensureSheet_(ss, SHEETS.SUARA, ['Kode Suara', 'No Urut'], []);

  ensureSheet_(ss, SHEETS.ADMIN, ['Username', 'Password'], [['admin', 'admin123']],
    function (sh) { sh.getRange('A:B').setNumberFormat('@'); });

  ensureSheet_(ss, SHEETS.PENGATURAN, ['Kunci', 'Nilai'], [
    ['Judul', 'Pemilihan Ketua OSIS 2026/2027'],
    ['Nama Sekolah', 'SMA Negeri 1 Contoh'],
    ['Status Pemilihan', 'BUKA']
  ]);

  // Hapus sheet default kosong
  ['Sheet1', 'Lembar1', 'Lembar 1'].forEach(function (n) {
    const sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });

  notify_('Setup selesai! Silakan isi data Pemilih, Kandidat, dan Admin, lalu deploy sebagai Web App.');
}

function resetPemilihan() {
  assertOwner_();
  try {
    const ui = SpreadsheetApp.getUi();
    const res = ui.alert('Reset Pemilihan',
      'Semua suara dan status pemilih akan DIHAPUS. Lanjutkan?', ui.ButtonSet.YES_NO);
    if (res !== ui.Button.YES) return;
  } catch (e) { /* dijalankan dari editor: tanpa konfirmasi */ }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const suara = getSheet_(SHEETS.SUARA);
    if (suara.getLastRow() >= 2) suara.deleteRows(2, suara.getLastRow() - 1);
    const pemilih = getSheet_(SHEETS.PEMILIH);
    if (pemilih.getLastRow() >= 2) pemilih.getRange(2, 5, pemilih.getLastRow() - 1, 2).clearContent();
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  notify_('Data pemilihan berhasil direset.');
}

function ensureSheet_(ss, name, headers, samples, formatFn) {
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  if (formatFn) formatFn(sh); // format diterapkan sebelum data ditulis (mis. NISN sebagai teks)
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1e40af').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  if (samples && samples.length) sh.getRange(2, 1, samples.length, headers.length).setValues(samples);
  sh.autoResizeColumns(1, headers.length);
  return sh;
}

function notify_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}
