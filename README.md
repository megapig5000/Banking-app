# Simple Banking App — Web Desktop

Ứng dụng ngân hàng trực tuyến cơ bản chạy trên trình duyệt desktop, cho phép người dùng quản lý tài khoản, nạp/rút tiền, chuyển khoản nội bộ an toàn và tra cứu lịch sử giao dịch[cite: 10, 11]. Dự án tuân thủ nguyên tắc K.I.S.S, đảm bảo tính toàn vẹn dữ liệu bằng Database Transaction, cập nhật số dư nguyên tử và chống gửi trùng bằng Idempotency Key[cite: 11].

## 1. Overview & Tech Stack
- **Backend:** NestJS, TypeScript, TypeORM (Migrations), PostgreSQL, Passport JWT, Bcrypt, Class-Validator, Swagger[cite: 11].
- **Frontend:** Next.js (App Router — Client Components), ReactJS, Zustand, Tailwind CSS, Axios[cite: 10, 11].
- **Infrastructure & Testing:** Docker, Docker Compose, Jest & Supertest (E2E Smoke Test với DB test tách biệt)[cite: 9, 11].

## 2. Architecture
Hệ thống phân tầng rõ ràng theo kiến trúc module của NestJS: `Controller -> Service -> TypeORM Repository / EntityManager -> PostgreSQL`[cite: 11].
- Sơ đồ tuần tự (Auth & Transaction Flow): xem tại [`docs/sequence_diagrams.md`](docs/sequence_diagrams.md)[cite: 11].
- Ghi chép quyết định kiến trúc (ADR-001 → ADR-008): xem tại [`docs/ADR.md`](docs/ADR.md).

## 3. Environment Variables
Sao chép file môi trường mẫu trước khi chạy[cite: 11]:
```bash
# Cho Docker Compose ở thư mục gốc
cp .env.example .env

# Cho phát triển local & chạy test trong thư mục backend (tùy chọn)
cp backend/.env.example backend/.env
cp backend/.env.test.example backend/.env.test
```

## 4. Chạy dự án bằng Docker (Khuyên dùng)
Chỉ cần một lệnh duy nhất từ thư mục gốc[cite: 9]:
```bash
docker compose up --build
```
Khi khởi động, container `backend` sẽ tự động thực hiện tuần tự:
1. Chạy TypeORM Migrations (`npm run migration:run:prod`).
2. Chạy Seed dữ liệu mẫu nếu `SEED_ON_START=true`.
3. Khởi động NestJS API server ở cổng `3000`.

Các địa chỉ truy cập:
- **Frontend UI:** http://localhost:3001
- **Backend API:** http://localhost:3000/api[cite: 9]
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

## 6. Chạy Kiểm thử (Smoke E2E Test trên Database riêng)
Dự án bố trí container `postgres-test` chạy riêng ở cổng `5433` (sử dụng `tmpfs` trên RAM) để việc chạy test **không bao giờ chạm vào dữ liệu dev**[cite: 9, 10]:
```bash
# 1. Bật container database test (cổng 5433)
docker compose --profile test up -d postgres-test

# 2. Tạo file .env.test từ file mẫu và chạy Smoke E2E Test
cd backend
cp .env.test.example .env.test
npm run test:e2e
```

## 7. Seed Data & Tài khoản Demo
Script seed (`npm run seed`) là **idempotent** và đảm bảo bất biến số dư (`balance == tổng tiền vào − tổng tiền ra`) thông qua các giao dịch nạp khởi tạo cộng với 25 giao dịch chuyển khoản lịch sử[cite: 9]:
- **Customer A (Active):** `user1@bank.local` / `Password@123` — STK: `1000000001` — Số dư cuối: `5,000,000.00 VND`
- **Customer B (Active):** `user2@bank.local` / `Password@123` — STK: `1000000002` — Số dư cuối: `2,000,000.00 VND`
- **Customer C (Locked):** `user3@bank.local` / `Password@123` — STK: `1000000003` — Số dư cuối: `1,000,000.00 VND` (Tài khoản bị khóa để kiểm thử lỗi 403/422)

## 8. API Endpoints & Transaction Filtering
| Method | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Đăng ký người dùng mới + tạo 1 tài khoản VND (`balance = 0.00`) trong cùng 1 DB transaction[cite: 11] |
| `POST` | `/api/auth/login` | Đăng nhập và nhận JWT Access Token[cite: 11] |
| `GET` | `/api/accounts/me` | Xem thông tin và số dư tài khoản của bản thân[cite: 11] |
| `POST` | `/api/transactions/deposit` | Nạp tiền vào tài khoản của bản thân (yêu cầu header `Idempotency-Key`)[cite: 9] |
| `POST` | `/api/transactions/withdraw` | Rút tiền từ tài khoản của bản thân (yêu cầu header `Idempotency-Key`)[cite: 9] |
| `POST` | `/api/transactions/transfer` | Chuyển khoản nội bộ tới số tài khoản khác (yêu cầu header `Idempotency-Key`)[cite: 9, 11] |
| `GET` | `/api/transactions` | Lịch sử giao dịch có phân trang (`page`, `limit`), lọc (`direction`, `fromDate`, `toDate` theo UTC+7) và sắp xếp (`order = desc \| asc`)[cite: 11] |

## 9. Demo Scenario
1. Chạy `docker compose up --build`, mở `http://localhost:3001`[cite: 9].
2. Đăng nhập `user1@bank.local` / `Password@123` → Dashboard hiển thị STK `1000000001` và số dư `5.000.000 VND`.
3. Mở **Nạp / Rút tiền** (`/cash`):
   - Nạp `200.000 VND` → Thành công, số dư tăng lên `5.200.000 VND`, giao dịch `+ Nạp tiền (Tiền mặt)` xuất hiện đầu danh sách.
   - Chuyển sang tab Rút tiền, rút `100.000 VND` → Thành công, số dư còn `5.100.000 VND`. Thử rút `99.000.000 VND` → Báo lỗi `422 Không đủ số dư khả dụng`.
4. Mở **Chuyển khoản** (`/transfer`):
   - Chuyển `50.000 VND` tới `1000000002` → Thành công, số dư giảm còn `5.050.000 VND`.
   - Thử chuyển tới chính mình (`1000000001`) → `400 Bad Request`; chuyển tới tài khoản bị khóa (`1000000003`) → `422 Unprocessable Entity`[cite: 11].
5. Mở **Lịch sử** (`/transactions`): kiểm tra phân trang (3 trang), lọc theo Tiền vào / Tiền ra, lọc theo khoảng ngày và đổi thứ tự Mới nhất / Cũ nhất trước[cite: 11].
6. Kiểm tra Double-submit / Idempotency trên Swagger (`http://localhost:3000/api/docs`): gửi lặp lại cùng `Idempotency-Key` và cùng nội dung trả về `200 OK` (không trừ/cộng tiền lần 2); cùng key nhưng đổi số tiền hoặc đổi loại giao dịch trả về `409 Conflict`[cite: 9, 10].
7. Đăng xuất và thử đăng nhập vào `user3@bank.local` → Bị từ chối với lỗi `403 Tài khoản của bạn đã bị khóa`.

## 10. Troubleshooting & Known Limitations
- **Chưa triển khai Locking & Xử lý Deadlock:** Số dư không bao giờ âm nhờ cập nhật nguyên tử có điều kiện (`UPDATE ... WHERE balance >= :amount`)[cite: 9, 11], nhưng Pessimistic Locking (`SELECT ... FOR UPDATE`), Optimistic Locking (`version`) và cơ chế retry khi Deadlock được để dành cho Module 1 của bài tập bổ sung[cite: 9, 10].
- **Chưa triển khai Admin API & Refresh Token:** Hệ thống hiện chỉ sử dụng JWT Access Token (`1h`) và vai trò khách hàng theo đúng phạm vi Core[cite: 11].

## 11. Kế hoạch mở rộng (Điểm gắn cho Bài tập bổ sung)

Bảng dưới đây ánh xạ từng bài trong bộ bài tập bổ sung vào đúng file và hàm thực tế đã được chuẩn bị ở Phase 0:

| Bài tập bổ sung | Điểm gắn trong mã nguồn thực tế | Những gì Phase 0 đã chuẩn bị sẵn |
| :--- | :--- | :--- |
| **1.2, 1.4** Pessimistic Locking & Thứ tự khóa chống Deadlock[cite: 9, 10] | `backend/src/transactions/transactions.service.ts` → hàm `loadAccountsForTransaction()` | Đã gom việc tải `actorAccount` và `destAccount` vào **1 câu truy vấn duy nhất** trên `EntityManager` của transaction và sắp xếp cố định `ORDER BY account.id ASC`[cite: 9]. Chỉ cần gắn thêm `.setLock('pessimistic_write')`[cite: 10]. |
| **1.3** Optimistic Locking (`version`)[cite: 9, 10] | `backend/src/database/entities/account.entity.ts` & hàm `debitAccount()` / `creditAccount()` trong `transactions.service.ts` | Toàn bộ thao tác cộng/trừ số dư đã tập trung vào 2 hàm `debitAccount()` và `creditAccount()`. Cột `version` sẽ được thêm qua migration mới[cite: 9, 10]. |
| **2.1, 2.2** Bảng `idempotency_keys` & Frontend Retry[cite: 10] | `transactions.service.ts` → `findExistingByIdempotencyKey()`, `resolveIdempotencyReplay()`, `handleTransactionError()`; Frontend `/cash` & `/transfer` | Logic kiểm tra và đối chiếu payload Idempotency đã tách thành hàm dùng chung cho cả 3 loại giao dịch (`transfer`, `deposit`, `withdraw`)[cite: 9]. |
| **3.1** Sổ cái kép (`ledger_entries`)[cite: 10] | `transactions.service.ts` → ngay sau `debitAccount()` / `creditAccount()` trong cùng `queryRunner` transaction; `seed.ts` | Dữ liệu seed đã có giao dịch `deposit` khởi tạo đảm bảo bất biến `balance == Σ vào − Σ ra` (0 dòng lệch) để backfill sổ cái khớp 100%[cite: 9, 10]. |
| **3.2, 5.3** Transaction State Machine & Ghi log `FAILED`[cite: 10] | `transactions.service.ts` → hàm `insertTransactionRecord()` và `handleTransactionError()` | Bước tạo bản ghi giao dịch đã tách riêng thành `insertTransactionRecord()`, sẵn sàng tách trạng thái `PENDING -> COMPLETED / FAILED / REVERSED`[cite: 10]. |
| **3.3** Audit Log (`audit_logs`)[cite: 10] | NestJS Interceptor / TypeORM Subscriber mới gắn vào các Controller/Entity[cite: 10] | Hạ tầng TypeORM Migration đã sẵn sàng để tạo bảng `audit_logs`[cite: 9, 10]. |
| **3.4** Soft Delete & Account History[cite: 10] | `user.entity.ts`, `account.entity.ts` & Migration mới | Đã có quy trình TypeORM Migration (`migration:generate`, `migration:run`). |
| **4.1** Phân quyền RBAC (`CUSTOMER`, `TELLER`, `ADMIN`)[cite: 10] | `user.entity.ts` (`UserRole`), `backend/src/auth/jwt.strategy.ts` (`validate()`) | `JwtStrategy.validate()` đã nạp thực thể `User` (kèm `role`, `status`) từ DB ở mỗi request và gắn vào `req.user`. |
| **4.2** Refresh Token & Revoke[cite: 10] | `backend/src/auth/auth.service.ts`, `frontend/src/services/api.ts` | Interceptor 401 trong `api.ts` đã tách riêng các route `/auth/*`, sẵn sàng gắn thêm cơ chế refresh rotation. |
| **4.3** Xác thực OTP cho giao dịch lớn[cite: 10] | `transactions.service.ts` → chèn trước bước `debitAccount()` / `creditAccount()` | Các bước kiểm tra hợp lệ và bước áp dụng biến động số dư đã được tách rời rõ ràng[cite: 9]. |
| **4.4** Rate Limiting (`@nestjs/throttler`)[cite: 10] | `backend/src/auth/auth.controller.ts` & `transactions.controller.ts` | Các endpoint đăng nhập và tạo giao dịch đã gom gọn trong 2 controller[cite: 10]. |
| **5.1** Hạn mức giao dịch theo ngày/lần[cite: 10] | `backend/src/common/utils/date.util.ts` (`getCurrentVietnamDayRange()`) & `transactions.service.ts` | Đã có sẵn hàm `getCurrentVietnamDayRange()`, `getVietnamDayStart()`, `getVietnamNextDayStart()` tính theo múi giờ `Asia/Ho_Chi_Minh` (UTC+7)[cite: 10]. |
| **5.2** Trạng thái tài khoản (`ACTIVE`, `FROZEN`, `CLOSED`)[cite: 10] | `transactions.service.ts` → hàm `validateActorAccount()` và `validateDestinationAccount()` | Mọi kiểm tra trạng thái tài khoản nguồn và đích đều đi qua 2 hàm validation tập trung này. |
| **6.1** Job đối soát cuối ngày (Reconciliation)[cite: 10] | `backend/src/database/seed.ts` & Cron Service mới[cite: 10] | Seed đã tuân thủ tuyệt đối bất biến đối soát số dư ngay từ đầu[cite: 9, 10]. |
| **6.2, 6.3** Fraud Detection, Structured Logging & `/health`[cite: 10] | `transactions.service.ts` (sau `insertTransactionRecord`) & Middleware / HealthController[cite: 10] | Cấu trúc module độc lập, không ảnh hưởng luồng Core. |
| **7.1, 7.2, 7.3** Unit Test, Concurrency Integration & Rollback Test[cite: 10] | `backend/test/app.e2e-spec.ts`, service `postgres-test` (`docker-compose.yml`), `TransactionsService` | Đã có container DB test riêng ở cổng `5433` (`tmpfs`), file `.env.test.example` và `DataSource` được inject qua constructor của `TransactionsService`[cite: 9, 10]. |