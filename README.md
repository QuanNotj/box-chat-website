# Box Chat By QuanNotj

Ứng dụng chat realtime dùng Express, Socket.IO và SQLite. Dự án có đăng ký/đăng nhập tài khoản, lưu lịch sử tin nhắn, gửi ảnh, reaction, profile người dùng và bộ công cụ moderation/admin cơ bản.

## Tính năng

- Chat realtime bằng Socket.IO.
- Đăng ký và đăng nhập tài khoản.
- Mật khẩu được hash phía server bằng PBKDF2.
- Lưu người dùng, tin nhắn, reaction và lịch sử chỉnh sửa bằng SQLite.
- Tải thêm lịch sử chat theo trang.
- Gửi tin nhắn văn bản, ảnh, emoji, reply và link preview.
- Chỉnh sửa, thu hồi, ghim và reaction tin nhắn.
- Gallery ảnh trong phòng chat.
- Profile người dùng với avatar, banner, bio, màu tên và trạng thái.
- Danh sách người online, trạng thái kết nối và typing indicator.
- Tìm kiếm tin nhắn trên giao diện.
- Chế độ sáng/tối.
- Admin tùy chọn: xóa tin nhắn, ghim tin, mute/unmute, kick user và xóa toàn bộ chat.
- Auto moderation theo số lượng link, emoji và danh sách từ khóa.

## Công nghệ

- Node.js >= 18
- Express
- Socket.IO
- SQLite
- HTML, CSS, JavaScript thuần

## Cài đặt

Clone repo và cài dependency:

```bash
git clone https://github.com/<username>/<repo>.git
cd <repo>
npm install
```

Tạo file cấu hình local từ file mẫu:

```bash
cp .env.example .env
```

Trên Windows PowerShell có thể dùng:

```powershell
Copy-Item .env.example .env
```

Chạy ứng dụng:

```bash
npm start
```

Mặc định app chạy tại:

```text
http://localhost:2096
```

SQLite database sẽ được tạo tự động khi app khởi động lần đầu.

## Biến môi trường

| Biến | Mặc định | Mô tả |
| --- | --- | --- |
| `PORT` | `2096` | Port chạy web server. |
| `DB_PATH` | `chat.db` | Đường dẫn file SQLite database. |
| `ADMIN_PASSWORD` | rỗng | Mật khẩu admin. Để rỗng sẽ tắt quyền admin. |
| `AUTO_MOD_LINK_LIMIT` | `3` | Số link tối đa trong một tin nhắn. |
| `AUTO_MOD_EMOJI_LIMIT` | `18` | Số emoji tối đa trong một tin nhắn. |
| `AUTO_MOD_WORDS` | rỗng | Danh sách từ khóa bị chặn, ngăn cách bằng dấu phẩy. |

Ví dụ `.env`:

```env
PORT=2096
DB_PATH=chat.db
ADMIN_PASSWORD=your-strong-password
AUTO_MOD_LINK_LIMIT=3
AUTO_MOD_EMOJI_LIMIT=18
AUTO_MOD_WORDS=word1,word2,word3
```

## Cấu trúc dự án

```text
.
|-- .codesandbox/       # Cấu hình chạy trên CodeSandbox
|-- .env.example        # File mẫu biến môi trường
|-- .gitignore          # Danh sách file không đưa lên Git
|-- index.html          # Giao diện client
|-- index.js            # Server Express, Socket.IO và SQLite migration
|-- package.json        # Script và dependencies
|-- package-lock.json   # Khóa phiên bản dependencies
`-- README.md           # Tài liệu dự án
```

## Dữ liệu local

Dự án dùng SQLite nên khi chạy local sẽ sinh ra các file như:

```text
chat.db
chat.db-shm
chat.db-wal
```

Các file này chỉ là dữ liệu runtime và đã được đưa vào `.gitignore`. Không commit database thật lên GitHub public vì có thể chứa tài khoản, tin nhắn, ảnh hoặc dữ liệu riêng tư.

## Chuẩn bị trước khi public GitHub

Trước khi push repo public, kiểm tra các điểm sau:

- Không có file `.env` trong repo.
- Không có file database SQLite như `.db`, `.db-wal`, `.db-shm`.
- Không có thư mục `node_modules`.
- Không có log hoặc file tạm.
- Nếu mật khẩu admin từng bị lộ, hãy đổi mật khẩu mới.
- Chỉ commit source code, lockfile, README, license và file cấu hình mẫu.

## Script

```bash
npm start
```

Chạy server bằng lệnh:

```bash
node --no-warnings index.js
```

## Ghi chú triển khai

- Khi deploy production, nên cấu hình biến môi trường trực tiếp trên nền tảng deploy thay vì upload file `.env`.
- Nên dùng `ADMIN_PASSWORD` mạnh nếu bật tính năng admin.
- File SQLite phù hợp cho demo, học tập hoặc project nhỏ. Với lượng người dùng lớn, nên cân nhắc chuyển sang database server như PostgreSQL hoặc MySQL.

## License

MIT
