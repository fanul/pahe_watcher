# Panduan Konfigurasi Remote Browser via CDP (Chrome DevTools Protocol)

Dokumentasi ini menjelaskan cara mengonfigurasi dan menggunakan fitur **Remote Browser via CDP** di Pahe Watcher. Fitur ini sangat berguna jika Anda menjalankan Pahe Watcher di dalam **Docker** (atau server headless), namun ingin menyelesaikan captcha manual langsung dari Google Chrome fisik yang berjalan di PC lokal (client) Anda.

---

## 🛠️ Langkah 1: Jalankan Chrome di PC Client dengan Debugging CDP Aktif

CDP (Chrome DevTools Protocol) memungkinkan program luar (seperti Playwright) mengontrol browser yang berjalan di PC lokal Anda melalui koneksi WebSocket.

1. **Tutup semua jendela Google Chrome** yang saat ini sedang aktif di PC Anda.
2. Buka **Command Prompt (CMD)** atau **PowerShell** di PC Anda.
3. Jalankan perintah berikut untuk membuka Google Chrome dengan port debugging aktif:

   ### Windows:
   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir="C:\pahe_chrome_profile"
   ```

   ### macOS:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir="$HOME/pahe_chrome_profile"
   ```

   ### Linux:
   ```bash
   google-chrome --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir="$HOME/pahe_chrome_profile"
   ```

*Jendela browser Google Chrome baru dengan profil kosong akan terbuka secara otomatis.*

---

## 🔍 Langkah 2: Cari Tahu IP Address PC Lokal (Client) Anda

Jika Pahe Watcher berjalan di dalam kontainer Docker, ia membutuhkan alamat IP dari PC lokal Anda untuk melakukan koneksi keluar.

1. Di PC lokal Anda, buka terminal/CMD.
2. Jalankan perintah:
   * **Windows**: `ipconfig`
   * **macOS / Linux**: `ifconfig` atau `ip a`
3. Temukan alamat IPv4 pada adapter jaringan Anda yang aktif (contoh: `192.168.1.50`).

---

## ⚙️ Langkah 3: Konfigurasi di Web GUI Pahe Watcher

1. Buka dashboard web Pahe Watcher Anda.
2. Buka dialog **⚙ Settings**.
3. Berikan centang pada opsi **Connect to Remote Browser via CDP** untuk mengaktifkan fitur remote browser.
4. Masukkan alamat URL CDP pada bidang **Chrome DevTools (CDP) URL (for remote browser)** sesuai dengan kondisi jaringan Anda:

   * **Jika Docker dan browser Chrome berjalan di PC yang sama**:
     Masukkan: `http://host.docker.internal:9222`
   * **Jika Docker berjalan di server lain / cloud**:
     Masukkan IP PC Client Anda dari Langkah 2: `http://192.168.1.50:9222`
   * **Jika Anda tidak menggunakan Docker (menjalankan `npm start` secara lokal)**:
     Masukkan: `http://localhost:9222`

5. Klik tombol **Save** untuk menyimpan setelan tersebut.
   > [!NOTE]
   > Anda dapat mematikan (*ON/OFF*) remote browser kapan saja secara instan dengan mencentang atau menghilangkan centang dari opsi **Connect to Remote Browser via CDP** tanpa perlu menghapus isi kotak URL.

---

## 🎮 Cara Kerja & Penyelesaian Captcha Manual

1. Ketika Pahe Watcher memulai tugas bypass/sync, Playwright di dalam Docker akan secara otomatis mendeteksi konfigurasi `cdpUrl` Anda dan terhubung ke Chrome fisik di PC Anda.
2. **Tab baru** akan otomatis terbuka di browser Chrome PC Anda.
3. Anda akan melihat halaman pahe.plus / ouo.io dimuat di depan mata Anda.
4. Ketika halaman menampilkan captcha (misalnya Turnstile atau Google reCAPTCHA), **selesaikan captcha tersebut secara manual menggunakan mouse dan keyboard Anda langsung di layar monitor Anda**.
5. Setelah captcha selesai diselesaikan, skrip otomatisasi di dalam Docker akan mendeteksi penyelesaian tersebut, mengambil tautan unduhan akhir (GDrive/GDFlix), menyimpan hasilnya ke database, dan **menutup tab tersebut secara otomatis**.
6. Koneksi remote dilepaskan dengan aman tanpa menutup aplikasi Chrome Anda.
