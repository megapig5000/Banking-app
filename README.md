# Simple Banking App — Web Desktop

Ứng dụng ngân hàng trực tuyến cơ bản chạy trên trình duyệt desktop, cho phép người dùng quản lý tài khoản, nạp/rút tiền, chuyển khoản nội bộ an toàn và tra cứu lịch sử giao dịch. Dự án tuân thủ nguyên tắc K.I.S.S, đảm bảo tính toàn vẹn dữ liệu bằng Database Transaction, Pessimistic Locking (`SELECT ... FOR UPDATE`), chống Deadlock và chống gửi trùng bằng Idempotency Key.

## 1. Overview & Tech Stack
- **Backend:** NestJS, TypeScript, TypeORM (Migrations), PostgreSQL, Passport JWT, Bcrypt, Class-Validator, Swagger.
- **Frontend:** Next.js (App Router — Client Components), ReactJS, Zustand, Tailwind CSS, Axios.
- **Infrastructure & Testing:** Docker, Docker Compose, Jest & Supertest (E2E Smoke & Concurrency Integration Tests trên DB test tách biệt).

## 2. Architecture
Hệ thống phân tầng rõ ràng theo kiến trúc module của NestJS: `Controller -> Service -> TypeORM Repository / EntityManager -> PostgreSQL`.
- Sơ đồ tuần tự (Auth & Transaction Flow): xem tại [`docs/sequence_diagrams.md`](docs/sequence_diagrams.md).
- Ghi chép quyết định kiến trúc (ADR-001 → ADR-009): xem tại [`docs/ADR.md`](docs/ADR.md).
- Báo cáo thực nghiệm Concurrency & Locking (Module 1):
  - [`docs/concurrency/1.1-race-condition.md`](docs/concurrency/1.1-race-condition.md) — Tái hiện lỗi Race Condition (Lost Update).
  - [`docs/concurrency/1.3-lock-comparison.md`](docs/concurrency/1.3-lock-comparison.md) — Benchmark so sánh Pessimistic Locking và Optimistic Locking.
  - [`docs/concurrency/1.4-deadlock.md`](docs/concurrency/1.4-deadlock.md) — Phòng ngừa & Xử lý Deadlock khi chuyển khoản hai chiều A↔B.

## 3. Environment Variables
Sao chép file môi trường mẫu trước khi chạy:
```bash
# Cho Docker Compose ở thư mục gốc
cp .env.example .env

# Cho phát triển local & chạy test trong thư mục backend
cp backend/.env.example backend/.env
cp backend/.env.test.example backend/.env.test
```

## 4. Chạy dự án bằng Docker (Khuyên dùng)
Chỉ cần một lệnh duy nhất từ thư mục gốc:
```bash
docker compose up --build
```
Khi khởi động, container `backend` sẽ tự động thực hiện tuần tự:
1. Chạy TypeORM Migrations (`npm run migration:run:prod`).
2. Chạy Seed dữ liệu mẫu nếu `SEED_ON_START=true`.
3. Khởi động NestJS API server ở cổng `3000`.

Các địa chỉ truy cập:
- **Frontend UI:** http://localhost:3001
- **Backend API:** http://localhost:3000/api
- **Swagger Docs:** http://localhost:3000/api/docs

## 5. Local Development & Quản lý Migration
Nếu muốn chạy Backend và Frontend trực tiếp trên máy host:
```bash
# 1. Khởi chạy PostgreSQL cho môi trường dev (cổng 5432)
docker compose up -d postgres

# 2. Chạy Migration & Seed tại thư mục backend
cd backend
npm install
npm run migration:run
npm run seed
npm run start:dev

# 3. Khởi chạy Frontend ở một cửa sổ terminal khác
cd frontend
npm install
npm run dev
```

Các lệnh quản lý schema với TypeORM Migration (trong thư mục `backend/`):
- Chạy migration mới nhất: `npm run migration:run`
- Hoàn tác (rollback) 1 migration gần nhất: `npm run migration:revert`
- Sinh migration mới khi sửa Entity: `npm run migration:generate -- src/database/migrations/<TenMigration>`

## 6. Chạy Kiểm thử Tự động (Smoke & Concurrency E2E Tests)
Dự án bố trí container `postgres-test` chạy riêng ở cổng `5433` (sử dụng `tmpfs` trên RAM) để việc chạy test **không bao giờ chạm vào dữ liệu dev**:
```bash
# 1. Bật container database test (cổng 5433)
docker compose --profile test up -d postgres-test

# 2. Tạo file .env.test (nếu chưa có) và chạy toàn bộ E2E Test
cd backend
cp .env.test.example .env.test
npm run test:e2e
```
Bộ test bao gồm:
- `test/app.e2e-spec.ts`: Smoke test luồng Đăng ký → Đăng nhập → Xem số dư → Nạp tiền.
- `test/concurrency.e2e-spec.ts` (Bài 7.2):
  - **T1:** 20 request rút `100,000đ` đồng thời trên số dư `1,000,000đ` (5 vòng) → luôn đúng `10 × 201`, `10 × 422`, số dư `0.00`.
  - **T2:** Chuyển khoản hai chiều A→B và B→A đồng thời (5 vòng) → không deadlock/500, bảo toàn tổng số dư `A + B`.
  - **T3:** 5 request đồng thời dùng chung 1 `Idempotency-Key` (5 vòng) → chỉ tạo đúng 1 giao dịch trong DB.

## 7. Concurrency, Locking & Deadlock (Module 1)

### 7.1. Vấn đề & Giải pháp đã triển khai
1. **Chống Lost Update / Âm quỹ (Bài 1.1 & 1.2):**
   - Mọi giao dịch (`transfer`, `deposit`, `withdraw`) đều khóa dòng tài khoản ngay từ bước đọc bằng `SELECT ... FOR UPDATE OF "account"` (`.setLock('pessimistic_write', undefined, ['account'])`), kiểm tra số dư ngay sau khi khóa bằng số học `BigInt`, kết hợp với câu lệnh `UPDATE ... WHERE balance >= :amount` (thắt dây an toàn kép).
   - Đặt `SET LOCAL lock_timeout = '5s'` ngay khi mở transaction; nếu chờ khóa quá 5 giây (mã `55P03`), API trả về `503 Hệ thống đang bận, vui lòng thử lại`.
2. **Phòng ngừa & Xử lý Deadlock (Bài 1.4):**
   - Cả tài khoản nguồn và đích được tải & khóa trong **một truy vấn duy nhất sắp xếp theo `ORDER BY account.id ASC`**, triệt tiêu vòng tròn chờ đợi khi A→B và B→A chạy cùng lúc.
   - Bọc vòng lặp retry bên ngoài transaction: nếu gặp mã lỗi `40P01` (`deadlock_detected`), tự động rollback, ghi log kèm bộ đếm và thử lại tối đa 3 lần.

### 7.2. Cách chạy các Script bắn tải & Cách đọc kết quả
Đảm bảo hệ thống đang chạy (`docker compose up -d`), mở terminal tại thư mục gốc:

**1. Script bắn tải rút tiền đồng thời (`withdraw-load.mjs`):**
```bash
# Chạy mặc định: 1 tài khoản, số dư 1.000.000đ, bắn 20 request rút 100.000đ cùng lúc
node scripts/concurrency/withdraw-load.mjs

# Tuỳ chỉnh tham số (ví dụ kịch bản S2 và S3 của Bài 1.3):
node scripts/concurrency/withdraw-load.mjs --accounts 1 --requests 100 --initial 10000000 --amount 10000
node scripts/concurrency/withdraw-load.mjs --accounts 20 --requests 100 --initial 10000000 --amount 10000
```
- **Cách đọc kết quả:** Với lệnh mặc định, hệ thống chuẩn sẽ in ra `HTTP 201: 10`, `HTTP 422: 10`, `HTTP 500: 0`, `Số dư Kỳ vọng: 0.00 | Số dư Thực tế: 0.00 -> ✅ KHỚP` và kết luận `✅ ĐÚNG`.

**2. Script bắn tải chuyển khoản hai chiều A↔B (`transfer-ab-ba.mjs`):**
```bash
# Chạy mặc định: 50 cặp A->B và B->A mỗi vòng x 5 vòng = 500 giao dịch đồng thời
node scripts/concurrency/transfer-ab-ba.mjs
```
- **Cách đọc kết quả:** Hệ thống chuẩn sẽ in ra `HTTP 500: 0`, `Tổng (A + B): Ban đầu = 20000000.00 | Cuối cùng = 20000000.00 -> ✅ BẢO TOÀN`, số dư từng bên khớp chính xác với số giao dịch thành công mỗi chiều và kết luận `✅ ĐÚNG`.

## 8. Seed Data & Tài khoản Demo
Script seed (`npm run seed`) là **idempotent** và đảm bảo bất biến số dư (`balance == tổng tiền vào − tổng tiền ra`):
- **Customer A (Active):** `user1@bank.local` / `Password@123` — STK: `1000000001` — Số dư cuối: `5,000,000.00 VND`
- **Customer B (Active):** `user2@bank.local` / `Password@123` — STK: `1000000002` — Số dư cuối: `2,000,000.00 VND`
- **Customer C (Locked):** `user3@bank.local` / `Password@123` — STK: `1000000003` — Số dư cuối: `1,000,000.00 VND`

## 9. API Endpoints & Transaction Filtering
| Method | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Đăng ký người dùng mới + tạo 1 tài khoản VND (`balance = 0.00`) trong cùng 1 DB transaction |
| `POST` | `/api/auth/login` | Đăng nhập và nhận JWT Access Token |
| `GET` | `/api/accounts/me` | Xem thông tin và số dư tài khoản của bản thân |
| `POST` | `/api/transactions/deposit` | Nạp tiền vào tài khoản của bản thân (yêu cầu header `Idempotency-Key`) |
| `POST` | `/api/transactions/withdraw` | Rút tiền từ tài khoản của bản thân (yêu cầu header `Idempotency-Key`) |
| `POST` | `/api/transactions/transfer` | Chuyển khoản nội bộ tới số tài khoản khác (yêu cầu header `Idempotency-Key`) |
| `GET` | `/api/transactions` | Lịch sử giao dịch có phân trang (`page`, `limit`), lọc (`direction`, `fromDate`, `toDate` theo UTC+7) và sắp xếp (`order = desc \| asc`) |

## 10. Demo Scenario
1. Chạy `docker compose up --build`, mở `http://localhost:3001`.
2. Đăng nhập `user1@bank.local` / `Password@123` → Dashboard hiển thị STK `1000000001` và số dư `5.000.000 VND`.
3. Mở **Nạp / Rút tiền** (`/cash`): nạp `200.000 VND`, rút `100.000 VND`; thử rút `99.000.000 VND` → báo lỗi `422 Không đủ số dư khả dụng`.
4. Mở **Chuyển khoản** (`/transfer`): chuyển `50.000 VND` tới `1000000002`; thử chuyển tới chính mình (`1000000001`) → `400`; chuyển tới tài khoản bị khóa (`1000000003`) → `422`.
5. Mở **Lịch sử** (`/transactions`): kiểm tra phân trang, lọc theo Tiền vào / Tiền ra, khoảng ngày và sắp xếp.
6. Chạy 2 script concurrency ở Mục 7.2 và chạy `npm run test:e2e` ở Mục 6 để chứng minh khả năng chịu tải đồng thời.

## 11. Troubleshooting & Known Limitations
- **Giới hạn thời gian chờ khóa & Retry:** Các giao dịch chạm vào cùng một tài khoản sẽ xếp hàng chờ tối đa `LOCK_TIMEOUT = '5s'`, và tự động retry tối đa `MAX_DEADLOCK_RETRIES = 3` lần nếu gặp deadlock `40P01`. Vượt quá ngưỡng này, hệ thống trả về `503 Service Unavailable` để bảo vệ tài nguyên kết nối; client có thể gửi lại an toàn với cùng `Idempotency-Key`.
- **Chưa thiết lập CI tự động:** Bộ test `npm run test:e2e` hiện được chạy trên máy dev/test local thông qua container `postgres-test`.
- **Các module đang chờ mở rộng:** Sổ cái kép (`ledger_entries`), State Machine giao dịch, Audit Log, Admin RBAC & Refresh Token sẽ được triển khai ở các Module 2–6 tiếp theo.

## 12. Kế hoạch mở rộng (Trạng thái các Module Bổ sung)

| Bài tập bổ sung | Điểm gắn trong mã nguồn thực tế | Trạng thái |
| :--- | :--- | :--- |
| **1.1, 1.2, 1.3, 1.4** Race Condition, Locking & Deadlock | `transactions.service.ts` (`loadAccountsForTransaction`, `executeWithDeadlockRetry`), `scripts/concurrency/`, `docs/concurrency/` | ✅ **ĐÃ HOÀN THÀNH (Module 1)** |
| **7.2** Concurrency Integration Tests | `backend/test/concurrency.e2e-spec.ts`, `backend/test/helpers/e2e-test.helper.ts` | ✅ **ĐÃ HOÀN THÀNH (Module 1)** |
| **2.1, 2.2** Bảng `idempotency_keys` & Frontend Retry | `transactions.service.ts` → `findExistingByIdempotencyKey()`, `resolveIdempotencyReplay()`, `handleTransactionError()` | Sẵn sàng (Phase 0) |
| **3.1** Sổ cái kép (`ledger_entries`) | `transactions.service.ts` → ngay sau `debitAccount()` / `creditAccount()`; `seed.ts` | Sẵn sàng (Phase 0) |
| **3.2, 5.3** Transaction State Machine & Ghi log `FAILED` | `transactions.service.ts` → `insertTransactionRecord()` và `handleTransactionError()` | Sẵn sàng (Phase 0) |
| **3.3, 3.4** Audit Log & Soft Delete | NestJS Interceptor / Migration mới | Sẵn sàng (Phase 0) |
| **4.1, 4.2, 4.3, 4.4** RBAC, Refresh Token, OTP, Rate Limit | `jwt.strategy.ts`, `auth.service.ts`, `transactions.controller.ts` | Sẵn sàng (Phase 0) |
| **5.1, 5.2** Hạn mức ngày & Trạng thái tài khoản | `common/utils/date.util.ts`, `validateActorAccount()`, `validateDestinationAccount()` | Sẵn sàng (Phase 0) |
| **6.1, 6.2, 6.3** Đối soát, Fraud Detection, Logging & Health | `seed.ts`, `transactions.service.ts` | Sẵn sàng (Phase 0) |
| **7.1, 7.3** Unit Test & Rollback Test | `TransactionsService` (inject `DataSource`), `backend/test/` | Sẵn sàng (Phase 0) |