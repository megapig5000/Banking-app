# Simple Banking App — Web Desktop

Ứng dụng ngân hàng trực tuyến cơ bản chạy trên trình duyệt desktop, cho phép người dùng quản lý tài khoản, nạp/rút tiền, chuyển khoản nội bộ an toàn, tra cứu lịch sử giao dịch và đối soát bằng **Sổ cái kép (Double-entry Ledger)**. Dự án tuân thủ nguyên tắc K.I.S.S, đảm bảo tính toàn vẹn dữ liệu bằng Database Transaction, Pessimistic Locking (`SELECT ... FOR UPDATE`), chống Deadlock, chống gửi trùng bằng Idempotency Key và đảm bảo tính bất biến của dữ liệu tài chính.

---

## 1. Overview & Tech Stack
- **Backend:** NestJS, TypeScript, TypeORM (Migrations), PostgreSQL, Passport JWT, Bcrypt, Class-Validator, Swagger.
- **Frontend:** Next.js (App Router — Client Components), ReactJS, Zustand, Tailwind CSS, Axios.
- **Infrastructure & Testing:** Docker, Docker Compose, Jest & Supertest (E2E Smoke, Concurrency, Double-entry Ledger & Rollback Integration Tests trên DB test tách biệt).

---

## 2. Architecture
Hệ thống phân tầng rõ ràng theo kiến trúc module của NestJS: `Controller -> Service -> TypeORM Repository / EntityManager -> PostgreSQL`.
- Sơ đồ tuần tự (Auth, Transaction & Double-Entry Ledger Flow): xem tại [`docs/sequence_diagrams.md`](docs/sequence_diagrams.md).
- Ghi chép quyết định kiến trúc (ADR-001 → ADR-010): xem tại [`docs/ADR.md`](docs/ADR.md).
- Báo cáo thực nghiệm Concurrency & Locking (Module 1):
  - [`docs/concurrency/1.1-race-condition.md`](docs/concurrency/1.1-race-condition.md) — Tái hiện lỗi Race Condition (Lost Update).
  - [`docs/concurrency/1.3-lock-comparison.md`](docs/concurrency/1.3-lock-comparison.md) — Benchmark so sánh Pessimistic Locking và Optimistic Locking.
  - [`docs/concurrency/1.4-deadlock.md`](docs/concurrency/1.4-deadlock.md) — Phòng ngừa & Xử lý Deadlock khi chuyển khoản hai chiều A↔B.

---

## 3. Environment Variables
Sao chép file môi trường mẫu trước khi chạy:

```bash
# Cho Docker Compose ở thư mục gốc
cp .env.example .env

# Cho phát triển local & chạy test trong thư mục backend
cp backend/.env.example backend/.env
cp backend/.env.test.example backend/.env.test
```

---

## 4. Chạy dự án bằng Docker (Khuyên dùng)
Chỉ cần một lệnh duy nhất từ thư mục gốc:

```bash
docker compose up --build
```

Khi khởi động, container `backend` sẽ tự động thực hiện tuần tự:
1. Chạy TypeORM Migrations (`npm run migration:run:prod` — tạo bảng, backfill sổ cái và gắn trigger bất biến).
2. Chạy Seed dữ liệu mẫu nếu `SEED_ON_START=true` (tạo tài khoản, giao dịch mẫu và đồng bộ bút toán sổ cái).
3. Khởi động NestJS API server ở cổng `3000`.

Các địa chỉ truy cập:
- **Frontend UI:** [http://localhost:3001](http://localhost:3001)
- **Backend API:** [http://localhost:3000/api](http://localhost:3000/api)
- **Swagger Docs:** [http://localhost:3000/api/docs](http://localhost:3000/api/docs)

---

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

---

## 6. Chạy Kiểm thử Tự động (Smoke, Concurrency, Ledger & Rollback E2E Tests)
Dự án bố trí container `postgres-test` chạy riêng ở cổng `5433` (sử dụng `tmpfs` trên RAM) để việc chạy test **không bao giờ chạm vào dữ liệu dev**:

```bash
# 1. Bật container database test (cổng 5433)
docker compose --profile test up -d postgres-test

# 2. Tạo file .env.test (nếu chưa có) và chạy toàn bộ E2E Test
cd backend
cp .env.test.example .env.test
npm run test:e2e
```

Bộ test bao gồm 3 test suites (9 bài kiểm thử tích hợp):
- `test/app.e2e-spec.ts`: Smoke test luồng Đăng ký → Đăng nhập → Xem số dư → Nạp tiền.
- `test/concurrency.e2e-spec.ts` (Bài 7.2 + Kiểm tra bất biến Sổ cái Q1–Q3):
  - **T1:** 20 request rút `100,000đ` đồng thời trên số dư `1,000,000đ` (5 vòng) → luôn đúng `10 × 201`, `10 × 422`, số dư `0.00`, thỏa mãn Q1–Q3.
  - **T2:** Chuyển khoản hai chiều A→B và B→A đồng thời (5 vòng) → không deadlock/500, bảo toàn tổng số dư `A + B`, thỏa mãn Q1–Q3.
  - **T3:** 5 request đồng thời dùng chung 1 `Idempotency-Key` (5 vòng) → chỉ tạo đúng 1 giao dịch và 2 bút toán trong DB, thỏa mãn Q1–Q3.
- `test/ledger.e2e-spec.ts` (Bài 3.1 & Bài 7.3):
  - **L1:** Chặn đứng mọi thao tác `UPDATE` và `DELETE` trên `ledger_entries` qua cả TypeORM Repository lẫn SQL thô nhờ Trigger bất biến.
  - **L2:** Số dư từ `GET /api/accounts/me` khớp tuyệt đối với tổng bút toán `CREDIT − DEBIT` sau chuỗi nạp, rút, chuyển khoản hai chiều.
  - **L3:** Mỗi loại giao dịch sinh đúng số bút toán (`deposit = 1 CREDIT`, `withdraw = 1 DEBIT`, `transfer = 1 DEBIT + 1 CREDIT`); replay idempotency không sinh thêm bút toán.
  - **R1:** Giả lập lỗi ngay sau bước trừ tiền A, trước bước cộng tiền B → Rollback 100%, A không bị trừ tiền, không có bút toán nào được lưu.
  - **R2:** Giả lập lỗi ngay sau khi đã ghi bút toán `DEBIT` của A, trước khi ghi bút toán `CREDIT` của B → Rollback 100%, không để lại bút toán `DEBIT` mồ côi.

---

## 7. Concurrency, Locking & Deadlock (Module 1)

### 7.1. Vấn đề & Giải pháp đã triển khai
1. **Chống Lost Update / Âm quỹ (Bài 1.1 & 1.2):**
   - Mọi giao dịch (`transfer`, `deposit`, `withdraw`) đều khóa dòng tài khoản ngay từ bước đọc bằng `SELECT ... FOR UPDATE OF "account"` (`.setLock('pessimistic_write', undefined, ['account'])`), kiểm tra số dư ngay sau khi khóa bằng số học `BigInt`, kết hợp với câu lệnh `UPDATE ... WHERE balance >= :amount RETURNING balance` (thắt dây an toàn kép).
   - Đặt `SET LOCAL lock_timeout = '5s'` ngay khi mở transaction; nếu chờ khóa quá 5 giây (mã `55P03`), API trả về `503 Hệ thống đang bận, vui lòng thử lại`.
2. **Phòng ngừa & Xử lý Deadlock (Bài 1.4):**
   - Cả tài khoản nguồn và đích được tải & khóa trong **một truy vấn duy nhất sắp xếp theo `ORDER BY account.id ASC`**, triệt tiêu vòng tròn chờ đợi khi A→B và B→A chạy cùng lúc.
   - Bọc vòng lặp retry bên ngoài transaction: nếu gặp mã lỗi `40P01` (`deadlock_detected`), tự động rollback, ghi log kèm bộ đếm và thử lại tối đa 3 lần.

### 7.2. Cách chạy các Script bắn tải & Cách đọc kết quả
Đảm bảo hệ thống đang chạy (`docker compose up -d`), mở terminal tại thư mục gốc:

**1. Script bắn tải rút tiền đồng thời (`withdraw-load.mjs`):**
```bash
node scripts/concurrency/withdraw-load.mjs
```
- **Cách đọc kết quả:** Hệ thống chuẩn in ra `HTTP 201: 10`, `HTTP 422: 10`, `HTTP 500: 0`, `Số dư Kỳ vọng: 0.00 | Số dư Thực tế: 0.00 -> ✅ KHỚP` và kết luận `✅ ĐÚNG`.

**2. Script bắn tải chuyển khoản hai chiều A↔B (`transfer-ab-ba.mjs`):**
```bash
node scripts/concurrency/transfer-ab-ba.mjs
```
- **Cách đọc kết quả:** Hệ thống chuẩn in ra `HTTP 500: 0`, `Tổng (A + B): Ban đầu = 20000000.00 | Cuối cùng = 20000000.00 -> ✅ BẢO TOÀN` và kết luận `✅ ĐÚNG`.

---

## 8. Sổ cái kép — Double-entry Ledger (Module 3A)

### 8.1. Thiết kế & Quy tắc Bút toán
Thay vì chỉ sửa trực tiếp cột `accounts.balance`, mọi biến động số dư đều được ghi thành các bút toán bất biến trong bảng `ledger_entries` bên trong **cùng một Database Transaction**:
- **Cấu trúc bảng `ledger_entries`:** `id` (`BIGSERIAL` — số nguyên tự tăng xác định thứ tự ghi sổ), `account_id` (`FK -> accounts`, `ON DELETE RESTRICT`), `transaction_id` (`FK -> transactions`, `ON DELETE RESTRICT`), `type` (`DEBIT | CREDIT`), `amount` (`numeric(18,2)`, `CHECK amount > 0`), `balance_after` (`numeric(18,2)`, `CHECK balance_after >= 0` — lấy trực tiếp từ `UPDATE ... RETURNING balance`), `created_at` (`timestamptz`), kèm `UNIQUE (transaction_id, account_id, type)` và `INDEX (account_id, id)`.
- **Quy tắc sinh bút toán theo loại giao dịch (Mô hình tiền mặt một phía — ADR-008 & ADR-010):**
  - `transfer`: sinh **2 bút toán cân bằng** (`1 DEBIT` trên tài khoản gửi + `1 CREDIT` trên tài khoản nhận; luôn đảm bảo `tổng DEBIT = tổng CREDIT = amount`).
  - `deposit`: sinh **1 bút toán `CREDIT`** trên tài khoản người dùng.
  - `withdraw`: sinh **1 bút toán `DEBIT`** trên tài khoản người dùng.
- **Chống sửa/xóa hai lớp (Immutability):** Tầng ứng dụng chỉ có thao tác `INSERT` (`insertLedgerEntries`); tầng PostgreSQL gắn Trigger `trg_ledger_entries_immutable` (`BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW`) chặn mọi câu lệnh sửa hoặc xóa dòng bút toán.

### 8.2. Bộ truy vấn bất biến kiểm toán Sổ cái (Q1, Q2, Q3)
Bạn có thể chạy trực tiếp 3 câu lệnh dưới đây bất kỳ lúc nào (sau khi seed, sau khi giao dịch trên giao diện hoặc sau khi chạy script bắn tải đồng thời):

**Q1 — Kiểm tra mỗi giao dịch `success` có đúng số lượng bút toán, đủ và cân bằng:**
```bash
docker compose exec postgres psql -U root -d simple_bank -c "
SELECT t.id, t.type
FROM transactions t
LEFT JOIN ledger_entries le ON le.transaction_id = t.id
WHERE t.status = 'success'
GROUP BY t.id, t.type, t.amount
HAVING CASE t.type
  WHEN 'transfer' THEN
       COUNT(le.id) <> 2
    OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'DEBIT'), 0)  <> t.amount
    OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'CREDIT'), 0) <> t.amount
  WHEN 'deposit' THEN
       COUNT(le.id) <> 1
    OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'CREDIT'), 0) <> t.amount
  WHEN 'withdraw' THEN
       COUNT(le.id) <> 1
    OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'DEBIT'), 0) <> t.amount
END;
"
```

**Q2 — Kiểm tra số dư hiển thị (`accounts.balance`) khớp tuyệt đối với tổng bút toán của từng tài khoản:**
```bash
docker compose exec postgres psql -U root -d simple_bank -c "
SELECT a.account_number, a.balance,
       COALESCE(SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END), 0) AS computed
FROM accounts a
LEFT JOIN ledger_entries le ON le.account_id = a.id
GROUP BY a.id, a.account_number, a.balance
HAVING a.balance <> COALESCE(SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END), 0);
"
```

**Q3 — Kiểm tra cột `balance_after` của từng dòng khớp với số dư cộng dồn theo thứ tự `id`:**
```bash
docker compose exec postgres psql -U root -d simple_bank -c "
SELECT x.id, x.account_id, x.balance_after, x.running
FROM (
  SELECT le.id, le.account_id, le.balance_after,
         SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END)
           OVER (PARTITION BY le.account_id ORDER BY le.id) AS running
  FROM ledger_entries le
) x
WHERE x.balance_after <> x.running;
"
```
- **Cách đọc kết quả:** Cả 3 truy vấn **Q1, Q2, Q3 đều phải trả về `(0 rows)`** (0 dòng vi phạm), chứng minh mọi giao dịch đều cân bằng, số dư hiển thị khớp 100% với tổng sổ cái và sao kê `balance_after` không có bất kỳ dòng nào sai lệch.

---

## 9. Seed Data & Tài khoản Demo
Script seed (`npm run seed`) là **idempotent**, tự động tạo giao dịch mẫu và đồng bộ bút toán sổ cái (`ledger_entries`) thỏa mãn tuyệt đối Q1–Q3:
- **Customer A (Active):** `user1@bank.local` / `Password@123` — STK: `1000000001` — Số dư cuối: `5,000,000.00 VND`
- **Customer B (Active):** `user2@bank.local` / `Password@123` — STK: `1000000002` — Số dư cuối: `2,000,000.00 VND`
- **Customer C (Locked):** `user3@bank.local` / `Password@123` — STK: `1000000003` — Số dư cuối: `1,000,000.00 VND`

---

## 10. API Endpoints & Transaction Filtering
| Method | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Đăng ký người dùng mới + tạo 1 tài khoản VND (`balance = 0.00`) trong cùng 1 DB transaction |
| `POST` | `/api/auth/login` | Đăng nhập và nhận JWT Access Token |
| `GET` | `/api/accounts/me` | Xem thông tin và số dư tài khoản của bản thân |
| `POST` | `/api/transactions/deposit` | Nạp tiền vào tài khoản của bản thân (yêu cầu header `Idempotency-Key`) |
| `POST` | `/api/transactions/withdraw` | Rút tiền từ tài khoản của bản thân (yêu cầu header `Idempotency-Key`) |
| `POST` | `/api/transactions/transfer` | Chuyển khoản nội bộ tới số tài khoản khác (yêu cầu header `Idempotency-Key`) |
| `GET` | `/api/transactions` | Lịch sử giao dịch có phân trang (`page`, `limit`), lọc (`direction`, `fromDate`, `toDate` theo UTC+7) và sắp xếp (`order = desc \| asc`) |

---

## 11. Demo Scenario
1. Chạy `docker compose up --build`, mở `http://localhost:3001`.
2. Đăng nhập `user1@bank.local` / `Password@123` → Dashboard hiển thị STK `1000000001` và số dư `5.000.000 VND`.
3. Mở **Nạp / Rút tiền** (`/cash`): nạp `200.000 VND`, rút `100.000 VND`; thử rút `99.000.000 VND` → báo lỗi `422 Không đủ số dư khả dụng`.
4. Mở **Chuyển khoản** (`/transfer`): chuyển `50.000 VND` tới `1000000002`; thử chuyển tới chính mình (`1000000001`) → `400`; chuyển tới tài khoản bị khóa (`1000000003`) → `422`.
5. Mở **Lịch sử** (`/transactions`): kiểm tra phân trang, lọc theo Tiền vào / Tiền ra, khoảng ngày và sắp xếp.
6. Chạy 2 script concurrency ở Mục 7.2, chạy 3 truy vấn bất biến Q1–Q3 ở Mục 8.2 và chạy `npm run test:e2e` ở Mục 6.

---

## 12. Troubleshooting & Known Limitations
- **Giới hạn thời gian chờ khóa & Retry:** Các giao dịch chạm vào cùng một tài khoản sẽ xếp hàng chờ tối đa `LOCK_TIMEOUT = '5s'`, và tự động retry tối đa `MAX_DEADLOCK_RETRIES = 3` lần nếu gặp deadlock `40P01`. Vượt quá ngưỡng này, hệ thống trả về `503 Service Unavailable`; client có thể gửi lại an toàn với cùng `Idempotency-Key`.
- **Giới hạn của Trigger bất biến trên `ledger_entries`:** Trigger `trg_ledger_entries_immutable` là trigger mức dòng (`FOR EACH ROW`) nên chặn hoàn toàn các lệnh `UPDATE` và `DELETE`. Tuy nhiên, người có quyền `superuser` của PostgreSQL vẫn có thể tắt trigger, và lệnh `TRUNCATE` mức bảng không kích hoạt trigger mức dòng (đặc điểm này được dùng có chủ đích để làm sạch dữ liệu giữa các bài test trên DB `simple_bank_test`). Trong môi trường production thực tế, cần tạo DB role riêng cho ứng dụng và `REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries`.
- **Mô hình nạp/rút một phía & Đối soát tự động:** Giao dịch `deposit` và `withdraw` hiện dùng mô hình một phía (1 bút toán trên tài khoản khách hàng), còn `transfer` sinh 2 bút toán cân bằng (`DEBIT = CREDIT`). Cột `accounts.balance` đóng vai trò bản sao đọc nhanh (cached balance) và `ledger_entries` là nguồn sự thật; việc chạy cron job đối soát tự động cuối ngày giữa hai bên thuộc phạm vi **Module 6.1**.
- **Chưa triển khai State Machine, Hoàn tiền (`REVERSAL`) và lưu giao dịch `FAILED`:** Hiện tại giao dịch lỗi được rollback toàn bộ; việc chuyển trạng thái `PENDING -> COMPLETED / FAILED / REVERSED` và tạo bút toán đảo ngược thuộc phạm vi **Module 3B (Bài 3.2 & 5.3)**.

---

## 13. Kế hoạch mở rộng (Trạng thái các Module Bổ sung)

| Bài tập bổ sung | Điểm gắn trong mã nguồn thực tế | Trạng thái |
| :--- | :--- | :--- |
| **1.1, 1.2, 1.3, 1.4** Race Condition, Locking & Deadlock | `transactions.service.ts` (`loadAccountsForTransaction`, `executeWithDeadlockRetry`), `scripts/concurrency/`, `docs/concurrency/` | ✅ **ĐÃ HOÀN THÀNH (Module 1)** |
| **7.2** Concurrency Integration Tests | `backend/test/concurrency.e2e-spec.ts`, `backend/test/helpers/e2e-test.helper.ts` | ✅ **ĐÃ HOÀN THÀNH (Module 1)** |
| **3.1** Sổ cái kép (`ledger_entries`) | `ledger-entry.entity.ts`, Migration `1710000002000`, `transactions.service.ts` (`debitAccount`, `creditAccount`, `insertLedgerEntries`), `seed.ts` | ✅ **ĐÃ HOÀN THÀNH (Module 3A)** |
| **7.3** Test Rollback khi lỗi giữa chừng | `backend/test/ledger.e2e-spec.ts` (`L1–L3`, `R1–R2`), `assertLedgerInvariants()` | ✅ **ĐÃ HOÀN THÀNH (Module 3A)** |
| **3.2, 5.3** Transaction State Machine, `REVERSAL` & Ghi log `FAILED` | `transactions.service.ts` → `insertTransactionRecord()` và `handleTransactionError()` | Sẵn sàng (Module 3B tiếp theo) |
| **3.3, 3.4** Audit Log & Soft Delete | NestJS Interceptor / Migration mới | Sẵn sàng (Phase 0) |
| **2.1, 2.2** Bảng `idempotency_keys` & Frontend Retry | `transactions.service.ts` → `findExistingByIdempotencyKey()`, `resolveIdempotencyReplay()`, `handleTransactionError()` | Sẵn sàng (Phase 0) |
| **4.1, 4.2, 4.3, 4.4** RBAC, Refresh Token, OTP, Rate Limit | `jwt.strategy.ts`, `auth.service.ts`, `transactions.controller.ts` | Sẵn sàng (Phase 0) |
| **5.1, 5.2** Hạn mức ngày & Trạng thái tài khoản | `common/utils/date.util.ts`, `validateActorAccount()`, `validateDestinationAccount()` | Sẵn sàng (Phase 0) |
| **6.1, 6.2, 6.3** Đối soát, Fraud Detection, Logging & Health | `seed.ts`, `ledger_entries`, `transactions.service.ts` | Sẵn sàng (Phase 0) |
| **7.1** Unit Test & Coverage | `TransactionsService` (inject `DataSource`), `backend/test/` | Sẵn sàng (Phase 0) |