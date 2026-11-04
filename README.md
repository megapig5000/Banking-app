# Simple Banking App — Web Desktop

Ứng dụng ngân hàng trực tuyến chạy trên trình duyệt desktop, cho phép người dùng quản lý tài khoản, nạp/rút tiền, chuyển khoản nội bộ an toàn, tra cứu lịch sử giao dịch và hỗ trợ quản trị viên thực hiện hoàn tiền (`REVERSAL`). Dự án tuân thủ nguyên tắc K.I.S.S, đảm bảo tính toàn vẹn dữ liệu bằng Database Transaction, Pessimistic Locking (`SELECT ... FOR UPDATE`), chống Deadlock, chống gửi trùng bằng bảng **`idempotency_keys`** (lưu mã băm SHA-256, bản chụp kết quả và hạn dùng 24h) kết hợp **Auto-Retry an toàn phía Frontend**, ghi nhận biến động qua **Sổ cái kép chỉ-ghi-thêm (`ledger_entries`)** và quản lý **Vòng đời giao dịch (State Machine 3 Pha)**.

## 1. Overview & Tech Stack
- **Backend:** NestJS, TypeScript, TypeORM (Migrations), PostgreSQL, `@nestjs/schedule` (Cron quét giao dịch treo & dọn khóa Idempotency hết hạn), Passport JWT, Bcrypt, Class-Validator, Swagger.
- **Frontend:** Next.js (App Router — Client Components), ReactJS, Zustand, Tailwind CSS, Axios (kèm cơ chế Idempotent Auto-Retry & `useRef` In-Flight Guard).
- **Infrastructure & Testing:** Docker, Docker Compose, Jest & Supertest (5 bộ E2E Test Suites với 29 bài kiểm thử tích hợp trên DB test tách biệt).

## 2. Architecture
Hệ thống phân tầng rõ ràng theo kiến trúc module của NestJS: `Controller -> Service -> TypeORM Repository / EntityManager -> PostgreSQL`.
- Sơ đồ tuần tự (Auth, Luồng giao dịch 3 Pha kèm Idempotency Snapshot & Hoàn tiền `REVERSAL`): xem tại [`docs/sequence_diagrams.md`](docs/sequence_diagrams.md).
- Ghi chép quyết định kiến trúc (ADR-001 → ADR-013): xem tại [`docs/ADR.md`](docs/ADR.md).
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
1. Chạy TypeORM Migrations (`npm run migration:run:prod` — tạo bảng, backfill sổ cái, gắn trigger bất biến, nâng cấp schema State Machine / Reversal và tạo bảng `idempotency_keys`).
2. Chạy Seed dữ liệu mẫu nếu `SEED_ON_START=true` (tạo Admin, 3 Customer, giao dịch mẫu và đồng bộ bút toán sổ cái).
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

## 6. Chạy Kiểm thử Tự động (29 E2E Tests trên DB Test riêng)
Dự án bố trí container `postgres-test` chạy riêng ở cổng `5433` (sử dụng `tmpfs` trên RAM) để việc chạy test **không bao giờ chạm vào dữ liệu dev**:
```bash
# 1. Bật container database test (cổng 5433)
docker compose --profile test up -d postgres-test

# 2. Tạo file .env.test (nếu chưa có) và chạy toàn bộ E2E Test
cd backend
cp .env.test.example .env.test
npm run test:e2e
```
Bộ test bao gồm 5 test suites (29 bài kiểm thử tích hợp):
- `test/app.e2e-spec.ts` (1 test): Smoke test luồng Đăng ký → Đăng nhập → Xem số dư → Nạp tiền (`DEPOSIT` / `COMPLETED`).
- `test/concurrency.e2e-spec.ts` (3 tests — Bài 7.2 + Kiểm tra bất biến Q1′–Q5):
  - **T1:** 20 request rút `100,000đ` đồng thời trên số dư `1,000,000đ` (5 vòng) → luôn đúng `10 × 201 COMPLETED`, `10 × 422 FAILED`, số dư `0.00`.
  - **T2:** Chuyển khoản hai chiều A→B và B→A đồng thời (5 vòng) → không deadlock/500, bảo toàn tổng số dư `A + B`.
  - **T3:** 5 request đồng thời dùng chung 1 `Idempotency-Key` (5 vòng) → tất cả phản hồi trong `{201, 200, 202}`, chỉ tạo đúng 1 giao dịch `COMPLETED` và 2 bút toán trong DB.
- `test/ledger.e2e-spec.ts` (5 tests — Bài 3.1 & Bài 7.3):
  - **L1:** Chặn đứng mọi thao tác `UPDATE` và `DELETE` trên `ledger_entries` qua cả TypeORM Repository lẫn SQL thô nhờ Trigger bất biến.
  - **L2:** Số dư từ `GET /api/accounts/me` khớp tuyệt đối với tổng bút toán `CREDIT − DEBIT`.
  - **L3:** Mỗi loại giao dịch sinh đúng số bút toán (`DEPOSIT = 1 CREDIT`, `WITHDRAW = 1 DEBIT`, `TRANSFER = 1 DEBIT + 1 CREDIT`); replay không sinh thêm bút toán.
  - **R1 & R2:** Giả lập lỗi giữa chừng ở Pha B → Pha B rollback 100% số dư và bút toán (`0` bút toán mồ côi), Pha C ghi nhận phiếu `FAILED` (`INTERNAL_ERROR`) và đóng khóa `idempotency_keys` sang `FAILED (500)`.
- `test/state-machine-reversal.e2e-spec.ts` (10 tests — Bài 3.2 & Bài 5.3):
  - **ST & ST2:** Duyệt toàn bộ 36 cặp chuyển trạng thái `(from, to)`; chỉ 7 cạnh hợp lệ được phép, từ chối `FAILED → COMPLETED`.
  - **F1 & F2:** Ghi nhận `FAILED` kèm `failure_code` (`INSUFFICIENT_BALANCE`, `INTERNAL_ERROR`), có `0` bút toán, replay cùng key trả lại đúng bản chụp lỗi cũ.
  - **P1 & P2:** Replay giao dịch đang `PROCESSING` (khóa `IN_PROGRESS`) trả về `202 Accepted`; `sweepStuckTransactions()` đánh dấu `FAILED/TIMEOUT` cho phiếu `PROCESSING` cũ không có bút toán (và đóng luôn dòng khóa `idempotency_keys` sang `FAILED/503`), giữ nguyên phiếu mới và log `ERROR` nếu phiếu cũ đã có bút toán.
  - **V1 – V4:** Hoàn tiền thành công cho cả `TRANSFER`, `DEPOSIT`, `WITHDRAW`; chống hoàn tiền hai lần khi 5 request bắn đồng thời; xử lý bên nhận thiếu số dư (`422 REVERSAL_INSUFFICIENT_BALANCE`) và thử lại thành công sau khi nạp tiền; kiểm tra `RolesGuard` (`403`) và chặn hoàn tiền sai trạng thái (`409`).
- `test/idempotency.e2e-spec.ts` (10 tests — Bài 2.1):
  - **I1:** Gửi 5 lần tuần tự cùng `Idempotency-Key` và nội dung (kể cả biến thể `"100000"` vs `"100000.00"`) → lần đầu `201`, 4 lần sau `200`, cả 5 body giống hệt nhau, chỉ tạo 1 giao dịch và 2 bút toán.
  - **I2:** Cùng khóa nhưng khác `amount`, khác `toAccountNumber`, hoặc khác loại thao tác (`TRANSFER` vs `DEPOSIT`/`WITHDRAW`) → `409 Conflict`, không tạo giao dịch mới.
  - **I3:** 5 request đồng thời cùng khóa → chỉ 1 lần `201`, gửi lại sau đó nhận `200` cùng body.
  - **I4:** Replay giao dịch `FAILED` trả lại đúng lỗi `422` đã lưu kể cả sau khi đã nạp thêm tiền; dùng khóa mới thì thành công.
  - **I5 & I7:** Khóa hết hạn (`expired_at` trong quá khứ) được xử lý như yêu cầu mới (`201`); `deleteExpiredKeys()` xóa khóa hết hạn đã `COMPLETED`/`FAILED`, giữ nguyên khóa còn hạn và khóa `IN_PROGRESS`.
  - **I6:** Thiếu hoặc sai định dạng UUID ở header `Idempotency-Key` → `400 Bad Request`.
  - **I8:** Cô lập khóa theo `user_id`: 2 người dùng gửi cùng 1 UUID tạo 2 giao dịch độc lập, không lộ kết quả của nhau.
  - **I9:** Replay trả về bản chụp `COMPLETED` ban đầu ngay cả sau khi giao dịch gốc đã bị Admin hoàn tiền (`REVERSED`).
  - **I10:** `sweepStuckTransactions()` đóng cả giao dịch treo và dòng khóa `IN_PROGRESS` sang `FAILED (503)`, gửi lại khóa nhận đúng lỗi `503` đã lưu.

## 7. Concurrency, Locking & Deadlock (Module 1)
1. **Chống Lost Update / Âm quỹ (Bài 1.1 & 1.2):** Khóa dòng tài khoản bằng `SELECT ... FOR UPDATE OF "account"` kết hợp `UPDATE ... WHERE balance >= :amount RETURNING balance` và `SET LOCAL lock_timeout = '5s'`.
2. **Phòng ngừa & Xử lý Deadlock (Bài 1.4):** Tải và khóa các tài khoản theo thứ tự cố định `ORDER BY account.id ASC`, kết hợp vòng lặp `executeWithDeadlockRetry` (tối đa 3 lần khi gặp mã `40P01`).
3. **Chạy Script bắn tải:**
   ```bash
   node scripts/concurrency/withdraw-load.mjs
   node scripts/concurrency/transfer-ab-ba.mjs
   ```

## 8. Sổ cái kép — Double-entry Ledger (Module 3A)
Mọi biến động số dư ở Pha B đều được ghi thành các bút toán bất biến trong bảng `ledger_entries` (`id BIGSERIAL`, `account_id`, `transaction_id`, `type DEBIT | CREDIT`, `amount > 0`, `balance_after >= 0` lấy từ `UPDATE ... RETURNING balance`) trong cùng một Database Transaction và được bảo vệ bởi Trigger `trg_ledger_entries_immutable`.

## 9. Vòng đời giao dịch (State Machine) & Hoàn tiền (`REVERSAL` — Module 3B)

### 9.1. Sơ đồ trạng thái & Bảng cạnh hợp lệ
Mọi thay đổi cột `status` trên bảng `transactions` bắt buộc phải đi qua hàm `transition()` với câu lệnh đóng dấu có điều kiện `UPDATE transactions SET status = :to, updated_at = now() WHERE id = :id AND status = :from`:

```mermaid
stateDiagram-v2
    [*] --> INITIATED
    INITIATED --> PENDING_OTP
    INITIATED --> PROCESSING
    PENDING_OTP --> PROCESSING
    PENDING_OTP --> FAILED
    PROCESSING --> COMPLETED
    PROCESSING --> FAILED
    COMPLETED --> REVERSED
```

| Trạng thái hiện tại (`from`) | Các trạng thái kế tiếp hợp lệ (`to`) | Ghi chú |
| :--- | :--- | :--- |
| `INITIATED` | `PENDING_OTP`, `PROCESSING` | Trạng thái khởi tạo ngay khi lập phiếu ở Pha A |
| `PENDING_OTP` | `PROCESSING`, `FAILED` | Dành sẵn cho luồng xác thực OTP giao dịch lớn (Module 4.3) |
| `PROCESSING` | `COMPLETED`, `FAILED` | Đang xử lý ở Pha B (hoặc bị đánh dấu `FAILED` ở Pha C / Job quét treo) |
| `COMPLETED` | `REVERSED` | Giao dịch đã hoàn tất; chỉ đổi sang `REVERSED` khi hoàn tiền thành công |
| `FAILED` | *(Không đi đâu nữa)* | Trạng thái kết thúc (Terminal state) |
| `REVERSED` | *(Không đi đâu nữa)* | Trạng thái kết thúc (Terminal state) |

### 9.2. Luồng thực thi 3 Pha & Bảng mã lỗi (`FAILURE_CODE_MAP`)
- **Pha A (Tạo phiếu & Khóa):** Kiểm tra đầu vào (400/404), đăng ký khóa `idempotency_keys` (`IN_PROGRESS`) bằng `INSERT ... ON CONFLICT DO NOTHING` → `INSERT` phiếu `INITIATED` → `transition(INITIATED → PROCESSING)` → gắn `transaction_id` vào dòng khóa → `COMMIT`.
- **Pha B (Xử lý tiền, Sổ cái & Lưu Snapshot):** Khóa tài khoản `FOR UPDATE` → Kiểm tra nghiệp vụ & số dư → Trừ/cộng tiền (`RETURNING balance`) → Ghi bút toán `ledger_entries` → `transition(PROCESSING → COMPLETED)` → cập nhật `idempotency_keys` sang `COMPLETED` kèm bản chụp `response_body` (`201`) → `COMMIT`.
- **Pha C (Ghi nhận `FAILED`):** Khi Pha B lỗi và đã `ROLLBACK` hoàn toàn (số dư và sổ cái không đổi), mở transaction ngắn mới gọi `transition(PROCESSING → FAILED, { failureCode })` và cập nhật `idempotency_keys` sang `FAILED` kèm bản chụp lỗi → `COMMIT`.

| `failure_code` | HTTP Status | Thông báo lỗi trả về Client |
| :--- | :---: | :--- |
| `INSUFFICIENT_BALANCE` | `422` | Không đủ số dư khả dụng |
| `DESTINATION_UNAVAILABLE` | `422` | Tài khoản đích đang bị khóa, không thể nhận tiền |
| `AMOUNT_OVERFLOW` | `422` | Số dư tài khoản vượt quá giới hạn cho phép |
| `REVERSAL_INSUFFICIENT_BALANCE` | `422` | Tài khoản nhận không đủ số dư để thực hiện hoàn tiền |
| `SERVER_BUSY` | `503` | Hệ thống đang bận, vui lòng thử lại |
| `TIMEOUT` | `503` | Giao dịch bị quá thời gian xử lý, vui lòng thử lại |
| `INTERNAL_ERROR` | `500` | Lỗi hệ thống khi thực hiện giao dịch |

### 9.3. Hướng dẫn Hoàn tiền (`REVERSAL`) bằng `curl` / Node với quyền Admin
Chỉ tài khoản có `role = 'admin'` (`admin@bank.local` / `Password@123`) mới được gọi `POST /api/transactions/:id/reverse`:
```bash
# 1. Đăng nhập tài khoản Admin để lấy JWT Token
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bank.local","password":"Password@123"}' | node -pe 'JSON.parse(fs.readFileSync(0,"utf8")).accessToken')

# 2. Lấy ID của 1 giao dịch COMPLETED gần nhất trong DB
TX_ID=$(docker compose exec -T postgres psql -U root -d simple_bank -t -A -c \
  "SELECT id FROM transactions WHERE status = 'COMPLETED' AND type = 'TRANSFER' ORDER BY created_at DESC LIMIT 1;")

# 3. Gọi API Hoàn tiền với Idempotency-Key mới
curl -i -X POST "http://localhost:3000/api/transactions/${TX_ID}/reverse" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Idempotency-Key: $(node -pe 'require(\"crypto\").randomUUID()')" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Hoan tien theo yeu cau tra soat"}'
```

### 9.4. Cách mô phỏng Giao dịch "Treo" (`PROCESSING`) bằng SQL để Demo Job Quét
Cron job `sweepStuckTransactions()` chạy tự động mỗi phút để đánh dấu `FAILED` (`TIMEOUT`) cho các giao dịch `PROCESSING` có `updated_at` cũ hơn 120 giây (chưa có bút toán sổ cái) và đóng luôn dòng khóa `idempotency_keys` tương ứng sang `FAILED (503)`:
```bash
# 1. Chèn 1 giao dịch giả lập bị treo ở PROCESSING từ 5 phút trước kèm dòng khóa IN_PROGRESS
docker compose exec postgres psql -U root -d simple_bank -c "
WITH inserted_tx AS (
  INSERT INTO transactions (
    id, actor_account_id, from_account_id, to_account_id,
    amount, type, status, description, created_at, updated_at
  )
  SELECT
    uuid_generate_v4(), id, id, NULL,
    50000.00, 'WITHDRAW', 'PROCESSING', 'Demo stuck transaction (5m ago)',
    NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '5 minutes'
  FROM accounts WHERE account_number = '1000000001'
  RETURNING id, actor_account_id
)
INSERT INTO idempotency_keys (
  user_id, idempotency_key, request_hash, status, transaction_id, created_at, expired_at
)
SELECT
  a.user_id, uuid_generate_v4(), repeat('f', 64), 'IN_PROGRESS', it.id,
  NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '19 hours'
FROM inserted_tx it
JOIN accounts a ON a.id = it.actor_account_id;
"

# 2. Đợi đến mốc phút tiếp theo (tối đa 60s), xem log quét của backend và kiểm tra trạng thái
docker compose logs --tail=15 backend
docker compose exec postgres psql -U root -d simple_bank -c "
SELECT t.id, t.type, t.status AS tx_status, t.failure_code, ik.status AS key_status, ik.response_status
FROM transactions t
LEFT JOIN idempotency_keys ik ON ik.transaction_id = t.id
WHERE t.description = 'Demo stuck transaction (5m ago)';
"
```

### 9.5. Bộ 5 Truy vấn Bất biến Kiểm toán (Q1′, Q2, Q3, Q4, Q5)
Tất cả 5 truy vấn dưới đây đều phải trả về **`(0 rows)`** (0 dòng sai lệch):

**Q1′ — Giao dịch chưa/không hoàn tất (`FAILED`, `PROCESSING`...) có 0 bút toán; giao dịch `COMPLETED`/`REVERSED` có đủ bút toán cân bằng; `REVERSAL` khớp số bút toán với giao dịch gốc:**
```bash
docker compose exec postgres psql -U root -d simple_bank -c "
SELECT t.id, t.type, t.status
FROM transactions t
LEFT JOIN ledger_entries le ON le.transaction_id = t.id
GROUP BY t.id, t.type, t.status, t.amount, t.original_transaction_id
HAVING CASE
  WHEN t.status NOT IN ('COMPLETED', 'REVERSED') THEN COUNT(le.id) <> 0
  WHEN t.type = 'TRANSFER' THEN
       COUNT(le.id) <> 2
    OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'DEBIT'), 0)  <> t.amount
    OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'CREDIT'), 0) <> t.amount
  WHEN t.type = 'DEPOSIT' THEN
       COUNT(le.id) <> 1
    OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'CREDIT'), 0) <> t.amount
  WHEN t.type = 'WITHDRAW' THEN
       COUNT(le.id) <> 1
    OR COALESCE(SUM(le.amount) FILTER (WHERE le.type = 'DEBIT'), 0) <> t.amount
  WHEN t.type = 'REVERSAL' THEN
       COUNT(le.id) <> (SELECT COUNT(*) FROM ledger_entries o WHERE o.transaction_id = t.original_transaction_id)
END;
"
```

**Q2 — Số dư hiển thị (`accounts.balance`) khớp tuyệt đối với tổng bút toán của từng tài khoản:**
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

**Q3 — Cột `balance_after` của từng dòng khớp với số dư cộng dồn theo thứ tự `id`:**
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

**Q4 — Mỗi cặp (giao dịch gốc, giao dịch hoàn tiền `COMPLETED`) triệt tiêu nhau (`net = 0`) trên từng tài khoản:**
```bash
docker compose exec postgres psql -U root -d simple_bank -c "
SELECT o.id AS original_id, le.account_id,
       SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END) AS net
FROM transactions o
JOIN transactions r ON r.original_transaction_id = o.id AND r.type = 'REVERSAL' AND r.status = 'COMPLETED'
JOIN ledger_entries le ON le.transaction_id IN (o.id, r.id)
GROUP BY o.id, le.account_id
HAVING SUM(CASE le.type WHEN 'CREDIT' THEN le.amount ELSE -le.amount END) <> 0;
"
```

**Q5 — Trạng thái `REVERSED` của giao dịch gốc và giao dịch `REVERSAL COMPLETED` nhất quán 1-1:**
```bash
docker compose exec postgres psql -U root -d simple_bank -c "
SELECT o.id FROM transactions o
WHERE o.status = 'REVERSED'
  AND (SELECT COUNT(*) FROM transactions r
       WHERE r.original_transaction_id = o.id AND r.type = 'REVERSAL' AND r.status = 'COMPLETED') <> 1
UNION ALL
SELECT r.id FROM transactions r
WHERE r.type = 'REVERSAL' AND r.status = 'COMPLETED'
  AND NOT EXISTS (SELECT 1 FROM transactions o WHERE o.id = r.original_transaction_id AND o.status = 'REVERSED');
"
```

## 10. Cơ chế Chống Trùng Lặp Giao Dịch (`idempotency_keys`) & Frontend Auto-Retry (Module 2)

### 10.1. Cấu trúc bảng `idempotency_keys` & Cách tính `request_hash` (Bài 2.1)
Thay vì lưu cột `idempotency_key` trực tiếp trên bảng `transactions`, hệ thống tách riêng bảng **`idempotency_keys`** (`UNIQUE (user_id, idempotency_key)`):
- **`request_hash` (`char(64)`):** Mã băm SHA-256 tính từ object JSON có **thứ tự trường cố định** sau khi đã chuẩn hóa `amount` về đúng 2 chữ số thập phân bằng xử lý chuỗi (`"50000"` → `"50000.00"`) và sanitize `description` / `reason`:
  - `TRANSFER`: `{ operation: "TRANSFER", toAccountNumber, amount, description }`
  - `DEPOSIT`: `{ operation: "DEPOSIT", amount, description }`
  - `WITHDRAW`: `{ operation: "WITHDRAW", amount, description }`
  - `REVERSE`: `{ operation: "REVERSE", originalTransactionId, reason }`
- **Bản chụp kết quả (`response_status` & `response_body`):** Lưu ngay trong cùng transaction Pha B (khi `COMPLETED`) hoặc Pha C (khi `FAILED`).
- **Hạn dùng (`expired_at` = `created_at + 24 giờ`):** Tự động dọn dẹp mỗi giờ qua `@Cron(CronExpression.EVERY_HOUR)` (`deleteExpiredKeys()`) đối với các khóa đã kết thúc (`status <> 'IN_PROGRESS'`).

### 10.2. Bảng quy tắc Replay thống nhất
| Tình huống khi gửi lại cùng `Idempotency-Key` (cùng `user_id`) | HTTP Status | Hành vi của Hệ thống |
| :--- | :---: | :--- |
| Thiếu hoặc sai định dạng UUID ở header `Idempotency-Key` | `400 Bad Request` | Từ chối ngay tại Controller |
| Khác `request_hash` (khác số tiền, người nhận, mô tả, hoặc khác loại giao dịch) | `409 Conflict` | Từ chối ngay, không tạo giao dịch |
| Khóa ở trạng thái `COMPLETED` (còn hạn) | `200 OK` | Trả về nguyên bản chụp `response_body` đã lưu lúc hoàn tất (kể cả nếu về sau giao dịch bị `REVERSED`) |
| Khóa ở trạng thái `FAILED` (còn hạn) | `422 / 503 / 500` | Trả lại đúng `response_status` & `response_body` lỗi đã lưu (không chạy lại) |
| Khóa ở trạng thái `IN_PROGRESS` | `202 Accepted` | Trả về trạng thái hiện tại của giao dịch tương ứng (`PROCESSING`) |
| Khóa đã hết hạn (`expired_at <= NOW()` và `<> 'IN_PROGRESS'`) | `201 Created` | Xóa dòng khóa cũ đã hết hạn và xử lý như một yêu cầu giao dịch mới |

### 10.3. Thực hành kiểm tra nhanh bằng Node / `curl` (5 lần cùng khóa & khác nội dung)
```bash
node -e '
const { randomUUID } = require("node:crypto");
const API = "http://localhost:3000/api";
(async () => {
  const login = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user1@bank.local", password: "Password@123" }),
  }).then(r => r.json());
  const headers = (key) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${login.accessToken}`,
    "Idempotency-Key": key,
  });
  const key = randomUUID();
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API}/transactions/transfer`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ toAccountNumber: "1000000002", amount: i === 1 ? "20000" : "20000.00", description: "Demo 5x" }),
    });
    statuses.push(res.status);
  }
  console.log("5 sequential requests with same key (Expect [201, 200, 200, 200, 200]):", statuses);

  const conflictRes = await fetch(`${API}/transactions/transfer`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({ toAccountNumber: "1000000002", amount: "99999.00", description: "Demo 5x" }),
  });
  console.log("Same key with different amount (Expect 409):", conflictRes.status);
})();
'
```

### 10.4. Danh sách Kiểm thử Thủ công cho Frontend Auto-Retry (Bài 2.2)
Hàm dùng chung `submitIdempotentTransaction()` (`frontend/src/services/api.ts`) đặt `timeout = 10s`, tự động retry tối đa `MAX_RETRIES = 3` lần (`1s → 2s → 4s`) với **cùng `Idempotency-Key`** khi mất mạng/timeout hoặc nhận `202 Accepted`, kết hợp cờ `inFlightRef = useRef(false)` trên cả `/transfer` và `/cash`:

1. **Bấm liên tục 5 lần khi mạng chậm:** Bật Chrome DevTools → Network → Throttling → **Slow 3G**. Nhập chuyển khoản `20.000 VND` tới `1000000002` và bấm liên tục 5 lần thật nhanh vào nút Submit → Chỉ có **1 request** được gửi đi, lịch sử chỉ có **1 giao dịch mới**, số dư giảm đúng 1 lần.
2. **Mất mạng giữa chừng:** Nhập chuyển khoản, bật **Offline** trong DevTools khoảng 2 giây sau khi bấm Submit rồi tắt **Offline** → Giao diện hiển thị *"Đang thử lại (lần 1/3)..."*, tự động gửi lại bằng đúng key cũ và hoàn tất với **1 giao dịch duy nhất**.
3. **Server chậm hơn timeout 10s:** Chạy `docker compose pause backend`, bấm chuyển khoản, đợi ~10s cho tới khi giao diện hiện *"Đang thử lại (lần 1/3)..."*, chạy `docker compose unpause backend` → Giao diện báo thành công, chỉ có **1 giao dịch**.
4. **Hết số lần thử lại (`indeterminate`):** Giữ `docker compose pause backend` suốt ~45s (hết cả 3 lần retry) → Giao diện hiện hộp cảnh báo màu vàng *"Chưa xác nhận được giao dịch..."* (không báo thất bại, giữ nguyên key); chạy `docker compose unpause backend` và bấm xác nhận lại → Nhận kết quả thành công, vẫn chỉ có **1 giao dịch**.
5. **Lỗi nghiệp vụ dừng ngay, không retry:** Rút `99.000.000 VND` (vượt số dư) tại `/cash` → Báo lỗi `422` ngay lập tức, không chạy retry; lần bấm tiếp theo tự động dùng key mới.
6. **Lặp lại bước 1–3 trên form Nạp tiền & Rút tiền (`/cash`):** Cả hai tab đều dùng chung `submitIdempotentTransaction()` và `inFlightRef`, đảm bảo chỉ tạo **1 giao dịch** mỗi lần.

## 11. Seed Data & Tài khoản Demo
Script seed (`npm run seed`) là **idempotent**, tạo sẵn 1 Admin và 3 Customer kèm lịch sử giao dịch và bút toán sổ cái khớp tuyệt đối Q1′–Q5:
- **System Admin (Active):** `admin@bank.local` / `Password@123` — STK: `1000000000` — Số dư: `0.00 VND` (Dùng để gọi API hoàn tiền `POST /api/transactions/:id/reverse`).
- **Customer A (Active):** `user1@bank.local` / `Password@123` — STK: `1000000001` — Số dư cuối: `5,000,000.00 VND`.
- **Customer B (Active):** `user2@bank.local` / `Password@123` — STK: `1000000002` — Số dư cuối: `2,000,000.00 VND`.
- **Customer C (Locked):** `user3@bank.local` / `Password@123` — STK: `1000000003` — Số dư cuối: `1,000,000.00 VND`.

## 12. API Endpoints
| Method | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Đăng ký người dùng mới + tạo 1 tài khoản VND (`balance = 0.00`) |
| `POST` | `/api/auth/login` | Đăng nhập và nhận JWT Access Token |
| `GET` | `/api/accounts/me` | Xem thông tin và số dư tài khoản của bản thân |
| `POST` | `/api/transactions/deposit` | Nạp tiền vào tài khoản của bản thân (Header `Idempotency-Key`; trả `201/200/202`) |
| `POST` | `/api/transactions/withdraw` | Rút tiền từ tài khoản của bản thân (Header `Idempotency-Key`; trả `201/200/202`) |
| `POST` | `/api/transactions/transfer` | Chuyển khoản nội bộ tới số tài khoản khác (Header `Idempotency-Key`; trả `201/200/202`) |
| `POST` | `/api/transactions/:id/reverse` | Hoàn tiền giao dịch `COMPLETED` bằng giao dịch `REVERSAL` mới (**Chỉ Admin**, Header `Idempotency-Key`) |
| `GET` | `/api/transactions` | Lịch sử giao dịch (mọi trạng thái, kèm `originalTransactionId` & `reversalTransactionId`) |

## 13. Demo Scenario
1. Chạy `docker compose up --build`, mở `http://localhost:3001`.
2. Đăng nhập `user1@bank.local` / `Password@123` → Dashboard hiển thị STK `1000000001` và số dư `5.000.000 VND`.
3. Mở **Nạp / Rút tiền** (`/cash`): nạp `200.000 VND`, rút `100.000 VND`; thử rút `99.000.000 VND` → báo lỗi `422` ngay lập tức (không retry) và xuất hiện dòng `FAILED` ("Thất bại") trong lịch sử; sửa lại số tiền rút hợp lệ → thành công ngay nhờ quy tắc tự động sinh mới `Idempotency-Key`.
4. Mở **Chuyển khoản** (`/transfer`): chuyển `50.000 VND` tới `1000000002`; thử nghiệm throttle mạng Slow 3G / Offline theo Mục 10.4.
5. Thực hiện hoàn tiền giao dịch vừa chuyển bằng lệnh `curl` với token của `admin@bank.local` (Mục 9.3) → Mở lại trang **Lịch sử** (`/transactions`) của `user1` sẽ thấy giao dịch gốc đổi nhãn sang **`Đã được hoàn tiền` (`REVERSED`)** kèm mã `Hoàn bởi: ...` và xuất hiện thêm dòng **`+ Hoàn tiền (Nhận)` (`REVERSAL`)** trả lại `50.000 VND`.
6. Chạy 5 truy vấn bất biến Q1′–Q5 ở Mục 9.5 và chạy `npm run test:e2e` (29 bài test) ở Mục 6.

## 14. Troubleshooting & Known Limitations
- **Giới hạn thời gian chờ khóa & Retry:** Các giao dịch chạm vào cùng một tài khoản xếp hàng chờ tối đa `LOCK_TIMEOUT = '5s'`, và tự động retry tối đa `MAX_DEADLOCK_RETRIES = 3` lần nếu gặp deadlock `40P01`.
- **Giới hạn của Bảng `idempotency_keys` & Frontend Retry (Module 2):**
  - Ngay sau lần chạy migration nâng cấp xóa cột `transactions.idempotency_key`, các khóa cũ trước thời điểm nâng cấp không được ghi nhớ lại (không backfill).
  - Mỗi `Idempotency-Key` có hạn dùng **24 giờ (`TTL = 24h`)**; sau 24 giờ, khóa cũ hết hiệu lực và nếu gửi lại sẽ được xử lý như một yêu cầu giao dịch mới.
  - Phản hồi Replay trả về **bản chụp kết quả (`response_body` snapshot)** tại thời điểm yêu cầu đó hoàn tất, không phản ánh các thay đổi trạng thái về sau của giao dịch (ví dụ giao dịch sau đó bị Admin hoàn tiền sang `REVERSED`; trạng thái mới nhất được xem ở màn hình Lịch sử giao dịch).
  - Mã `202 Accepted` yêu cầu client chủ động hỏi lại bằng cùng `Idempotency-Key`; nếu sau `MAX_RETRIES = 3` lần thử lại ở Frontend mà vẫn mất mạng/timeout hoặc nhận `202`, kết quả ở trạng thái **"chưa xác định" (`indeterminate`)** và người dùng cần kiểm tra Lịch sử hoặc bấm gửi lại với cùng khóa.
- **Giới hạn của Trigger bất biến trên `ledger_entries`:** Trigger mức dòng chặn `UPDATE`/`DELETE`, nhưng `superuser` vẫn có thể tắt trigger và `TRUNCATE` mức bảng không kích hoạt trigger mức dòng (dùng để dọn dữ liệu trên DB test). Ở môi trường production thực tế, cần `REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries` khỏi role DB của ứng dụng.
- **Các lỗi đầu vào trước khi có phiếu không được lưu:** Ba lỗi yêu cầu sai trước Pha A (`400 DTO sai`, `404 tài khoản đích không tồn tại`, `400 tự chuyển cho chính mình`) bị từ chối và rollback ngay ở Pha A nên không lưu bản ghi `FAILED` hay khóa vào DB.
- **Trạng thái `PENDING_OTP` & `RolesGuard` tối thiểu:** Giá trị `PENDING_OTP` đã có trong enum và bảng chuyển trạng thái nhưng luồng sinh/kiểm tra OTP thuộc phạm vi **Module 4.3**. `RolesGuard` hiện tại là bản tối thiểu phục vụ API hoàn tiền của Admin; hệ thống RBAC đầy đủ (`TELLER`, duyệt giao dịch lớn, giao diện Admin) thuộc phạm vi **Module 4.1**.
- **Giới hạn của các Job định kỳ (`@Cron`):** Các job `sweepStuckTransactions()` (mỗi phút) và `deleteExpiredKeys()` (mỗi giờ) chạy trong tiến trình backend và được thiết kế cho cấu hình **một instance backend**.

## 15. Kế hoạch mở rộng (Trạng thái các Module Bổ sung)

| Bài tập bổ sung | Điểm gắn trong mã nguồn thực tế | Trạng thái |
| :--- | :--- | :--- |
| **1.1, 1.2, 1.3, 1.4** Race Condition, Locking & Deadlock | `transactions.service.ts` (`loadAccountsForTransaction`, `executeWithDeadlockRetry`), `scripts/concurrency/`, `docs/concurrency/` | ✅ **ĐÃ HOÀN THÀNH (Module 1)** |
| **7.2** Concurrency Integration Tests | `backend/test/concurrency.e2e-spec.ts`, `backend/test/helpers/e2e-test.helper.ts` | ✅ **ĐÃ HOÀN THÀNH (Module 1)** |
| **3.1** Sổ cái kép (`ledger_entries`) | `ledger-entry.entity.ts`, Migration `1710000002000`, `transactions.service.ts` (`insertLedgerEntries`), `seed.ts` | ✅ **ĐÃ HOÀN THÀNH (Module 3A)** |
| **7.3** Test Rollback khi lỗi giữa chừng | `backend/test/ledger.e2e-spec.ts` (`L1–L3`, `R1–R2`), `assertLedgerInvariants()` | ✅ **ĐÃ HOÀN THÀNH (Module 3A)** |
| **3.2, 5.3** Transaction State Machine, `REVERSAL`, Ghi log `FAILED` & Quét treo | Migration `1710000003000`, `transactions.constants.ts`, `transactions.service.ts` (`transition`, 3 Pha, `reverseTransaction`, `sweepStuckTransactions`), `state-machine-reversal.e2e-spec.ts` | ✅ **ĐÃ HOÀN THÀNH (Module 3B)** |
| **2.1, 2.2** Bảng `idempotency_keys`, Snapshot Replay, TTL 24h & Frontend Auto-Retry | Migration `1710000004000`, `idempotency-key.entity.ts`, `idempotency.service.ts`, `frontend/src/services/api.ts` (`submitIdempotentTransaction`), `idempotency.e2e-spec.ts` (`I1–I10`) | ✅ **ĐÃ HOÀN THÀNH (Module 2)** |
| **3.3, 3.4** Audit Log & Soft Delete | NestJS Interceptor / Migration mới | Sẵn sàng |
| **4.1, 4.2, 4.3, 4.4** RBAC đầy đủ, Refresh Token, OTP, Rate Limit | `roles.guard.ts`, `jwt.strategy.ts`, `auth.service.ts`, `transactions.controller.ts` | Sẵn sàng |
| **5.1, 5.2** Hạn mức ngày & Trạng thái tài khoản | `common/utils/date.util.ts`, `validateActorAccount()`, `validateDestinationAccountInPhaseB()` | Sẵn sàng |
| **6.1, 6.2, 6.3** Đối soát tự động, Fraud Detection, Logging & Health | `@nestjs/schedule`, `ledger_entries`, `transactions.service.ts` | Sẵn sàng |
| **7.1** Unit Test & Coverage | `TransactionsService`, `IdempotencyService`, `backend/test/` | Sẵn sàng |