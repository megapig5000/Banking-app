# Simple Banking App - Web Desktop

Một ứng dụng ngân hàng cơ bản chạy trên trình duyệt, cho phép người dùng quản lý tài khoản, chuyển tiền nội bộ an toàn và xem lịch sử giao dịch. Đồ án tuân thủ nghiêm ngặt nguyên tắc K.I.S.S và đảm bảo tính toàn vẹn dữ liệu.

## 1. Overview & Tech Stack
- **Backend:** NestJS, TypeORM, PostgreSQL, Passport JWT, Bcrypt.
- **Frontend:** Next.js (ReactJS), Zustand, Tailwind CSS, Axios.
- **Infrastructure:** Docker, Docker Compose.

## 2. Architecture
Hệ thống áp dụng kiến trúc module với các tầng rõ ràng: `Controller -> Service -> TypeORM Repository -> PostgreSQL`. 

Vui lòng xem các file sơ đồ tuần tự tại: `docs/sequence_diagrams.md`.
Các quyết định kỹ thuật: `docs/ADR.md`.

## 3. Environment Variables
Dự án sử dụng file `.env` duy nhất đặt ở thư mục gốc. Bạn có thể copy từ `.env.example`:
```bash
cp .env.example .env
```

## 4. Chạy dự án bằng Docker (Khuyên dùng)
Yêu cầu: Máy tính đã cài đặt Docker Desktop.

```bash
docker compose up --build
```

- **Frontend:** http://localhost:3001
- **Backend API:** http://localhost:3000/api
- **Swagger Docs:** http://localhost:3000/api/docs

## 5. Local Development (Không dùng Docker Frontend/Backend)
Nếu muốn chạy môi trường dev:
- **Chạy DB:** `docker compose up -d postgres`
- **Backend:** `cd backend && npm install && npm run start:dev`
- **Frontend:** `cd frontend && npm install && npm run dev`

## 6. Seed & Tài khoản Demo
Khi chạy Docker với `SEED_ON_START=true`, hệ thống tự động sinh 3 user và 25 giao dịch mồi:
- **Customer A:** `user1@bank.local` / `Password@123` (STK: `1000000001` - Balance: 5M)
- **Customer B:** `user2@bank.local` / `Password@123` (STK: `1000000002` - Balance: 2M)
- **Locked Customer:** `user3@bank.local` / `Password@123` (Bị khóa)

## 7. Demo Scenario
1. **Khởi động:** `docker compose up --build`. Mở http://localhost:3001.
2. **Đăng nhập:** với `user1@bank.local` / `Password@123`. Dashboard sẽ hiện số dư 5.000.000 VND.
3. **Chuyển khoản:** Vào tab Chuyển khoản, chuyển 50.000 VND tới STK `1000000002`. Tiền bị trừ tức thì, màn hình báo thành công.
4. **Lịch sử:** Vào tab Lịch sử, sử dụng bộ lọc để xem các giao dịch Tiền vào / Tiền ra, phân trang qua lại.
5. **Thử nghiệm lỗi:**
   - Chuyển 99.000.000 VND -> Báo lỗi không đủ số dư.
   - Chuyển vào `1000000003` -> Báo tài khoản đích bị khóa.
   - Thử đăng xuất và đăng nhập vào `user3@bank.local` -> Báo lỗi tài khoản bị khóa (403).