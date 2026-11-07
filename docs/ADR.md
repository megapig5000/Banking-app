# Architecture Decision Records (ADR)

Tài liệu này ghi lại các quyết định kiến trúc cốt lõi của dự án **Simple Banking App** từ phiên bản nền tảng (Core v1.0), giai đoạn chuẩn bị mở rộng (Phase 0), đến các module nâng cao: Concurrency & Locking (Module 1), Sổ cái kép (Module 3A), Vòng đời giao dịch & Hoàn tiền (Module 3B), Chống trùng lặp giao dịch (Module 2), Phân quyền RBAC & Nhật ký kiểm toán (Module 4A), và Hạn mức, Trạng thái tài khoản & Xóa mềm (Module 5).

---

## ADR-001: Lựa chọn Monorepo kết hợp Docker Compose
- **Context:** Dự án bao gồm Backend (NestJS), Frontend (Next.js) và Database (PostgreSQL), cần chạy đồng bộ và dễ dàng kiểm thử chỉ với một lệnh duy nhất.
- **Decision:** Tổ chức mã nguồn theo cấu trúc Monorepo (`/backend`, `/frontend`, `/docs`, `/scripts`) và đóng gói toàn bộ dịch vụ bằng `docker-compose.yml`.
- **Reason:** Giúp đồng bộ phiên bản mã nguồn giữa Backend và Frontend, đơn giản hóa việc thiết lập môi trường phát triển và chạy kiểm thử tích hợp (`postgres-test`).
- **Trade-offs:** Thời gian build image lần đầu lâu hơn so với chạy rời từng dịch vụ trên máy host, nhưng đổi lại tính nhất quán môi trường đạt 100%.

---

## ADR-002: Xác thực Stateless JWT kết hợp Kiểm tra Trạng thái từ Database mỗi Request
- **Context:** Cần cơ chế xác thực đơn giản, chuẩn mực cho REST API nhưng vẫn phải đảm bảo khi tài khoản người dùng bị khóa (`locked`) hoặc bị xóa mềm (`deleted_at IS NOT NULL`), mọi phiên đang mở phải bị chặn ngay lập tức.
- **Decision:** Sử dụng JWT Access Token (thời hạn 1 giờ) chỉ chứa `{ sub: user.id }`. Tại `JwtStrategy.validate()`, hệ thống truy vấn bảng `users` trong PostgreSQL ở mỗi request để kiểm tra sự tồn tại (`deleted_at IS NULL`), trạng thái `user.status !== 'locked'` và nạp `user.role` mới nhất.
- **Reason:** Tuân thủ nguyên tắc K.I.S.S (không cần Redis Blacklist phức tạp) mà vẫn đảm bảo thu hồi quyền truy cập hoặc cập nhật vai trò/trạng thái khóa tức thì.
- **Trade-offs:** Phát sinh 1 câu truy vấn `SELECT` theo khóa chính `users.id` ở mỗi request cần xác thực, nhưng truy vấn theo PK UUID trên PostgreSQL có độ trễ cực thấp (< 1ms).

---

## ADR-003: Luồng Giao dịch 3 Pha, Khóa Bi quan, Kiểm tra Trạng thái/Hạn mức/Khả dụng và Ghi Sổ cái Nguyên tử
- **Context:** Giao dịch chuyển tiền, nạp tiền, rút tiền và hoàn tiền đòi hỏi tính toàn vẹn tuyệt đối (ACID): không mất cập nhật khi nhiều request chạy song song, không âm số dư khả dụng, không vượt hạn mức, mọi biến động số dư đều phải có bút toán sổ cái đối ứng và mọi giao dịch thất bại ở bước xử lý tiền đều phải lưu vết `FAILED`.
- **Decision:** Thực thi các giao dịch tài chính theo **Luồng 3 Pha (3-Phase Transaction Flow)**:
  1. **Pha A (Khởi tạo phiếu & Đăng ký khóa Idempotency — Transaction ngắn):** Kiểm tra điều kiện đầu vào (400/404), xóa khóa Idempotency cũ đã hết hạn (nếu có), thực hiện `INSERT INTO idempotency_keys ... ON CONFLICT DO NOTHING` (`IN_PROGRESS`), tạo bản ghi `transactions` ở trạng thái `INITIATED`, chuyển qua `transition(INITIATED -> PROCESSING)`, gắn `transaction_id` vào dòng khóa và `COMMIT` ngay.
  2. **Pha B (Xử lý tiền, Kiểm tra Trạng thái/Hạn mức/Khả dụng, Ghi Sổ cái & Lưu Snapshot — Transaction chính, có bọc Deadlock Retry):** Đặt `SET LOCAL lock_timeout = '5s'`, khóa dòng các tài khoản liên quan bằng `SELECT ... FOR UPDATE OF "account" ORDER BY account.id ASC`. Dưới khóa dòng, kiểm tra tuần tự: (1) trạng thái người dùng (`user.status`), (2) trạng thái tài khoản (`account.status === 'ACTIVE'`), (3) hạn mức mỗi lần và mỗi ngày theo giờ Việt Nam (đối với `TRANSFER`/`WITHDRAW`), (4) số dư khả dụng (`balance - hold_amount >= amount`). Sau đó cập nhật số dư bằng biểu thức SQL `UPDATE accounts SET balance = balance - :amount WHERE id = :id AND status = 'ACTIVE' AND deleted_at IS NULL AND (balance - hold_amount) >= :amount RETURNING balance`, chèn các bút toán vào `ledger_entries`, đóng dấu `transition(PROCESSING -> COMPLETED)`, và cập nhật `idempotency_keys` sang `COMPLETED` kèm bản chụp `response_body` trong **cùng một Database Transaction**.
  3. **Pha C (Ghi nhận `FAILED` khi Pha B lỗi):** Sau khi Pha B đã `ROLLBACK` hoàn toàn (số dư và sổ cái không đổi), mở một transaction ngắn mới gọi `transition(PROCESSING -> FAILED, { failureCode })` và đóng dấu dòng `idempotency_keys` sang `FAILED` kèm bản chụp lỗi chuẩn rồi trả lỗi tương ứng cho client.
- **Reason:** Tách Pha A giúp phiếu giao dịch và khóa `idempotency_keys` tồn tại bền vững trước khi động vào tiền; gom việc kiểm tra trạng thái tài khoản, hạn mức, số dư khả dụng, trừ/cộng tiền, ghi sổ cái, đóng dấu `COMPLETED` và lưu bản chụp `idempotency_keys` vào cùng một transaction ở Pha B đảm bảo "tiền chỉ nhích khi sổ cái, con dấu `COMPLETED` và sổ ghi nhớ khóa cùng được đóng".
- **Trade-offs:** Mỗi giao dịch thành công đi qua 2 transaction (Pha A và Pha B), nhưng Pha A cực ngắn và không giữ khóa tài khoản nên không làm giảm thông lượng hệ thống.

---

## ADR-004: Chống gửi trùng giao dịch bằng Bảng `idempotency_keys` độc lập
- **Context:** Khi mạng chập chờn, client timeout hoặc người dùng bấm nút nhiều lần, cùng một yêu cầu giao dịch có thể được gửi lặp lại. Ở phiên bản đầu, khóa chống trùng chỉ là một cột trên bảng `transactions` nên không lưu được bản chụp phản hồi (response snapshot), không có thời hạn sống (TTL) và không kiểm tra được mã băm chuẩn hóa của yêu cầu.
- **Decision:** Tách cơ chế chống trùng ra bảng **`idempotency_keys`** độc lập (và xóa cột `transactions.idempotency_key`), bắt buộc client gửi header `Idempotency-Key` (UUID) cho cả 4 endpoint: `/transfer`, `/deposit`, `/withdraw`, `/reverse`.
- **Reason:** Cho phép quản lý vòng đời khóa độc lập (`IN_PROGRESS`, `COMPLETED`, `FAILED`), lưu chính xác mã HTTP (`response_status`) cùng bản chụp JSON (`response_body`), cô lập không gian khóa theo từng người dùng (`UNIQUE (user_id, idempotency_key)`) và tự động dọn dẹp khóa hết hạn sau 24 giờ.
- **Trade-offs:** Cần thêm 1 bảng trong Database và bước cập nhật trạng thái khóa trong Pha A / Pha B / Pha C, nhưng giải quyết triệt để bài toán phát lại kết quả chuẩn mực của hệ thống tài chính.

---

## ADR-005: Lưu trữ và Tính toán Tiền tệ chính xác bằng `numeric(18,2)` và Chuỗi Decimal / `BigInt`
- **Context:** Phép tính số thực dấu chấm động (`Number` / IEEE 754) trong JavaScript bị sai số làm tròn (ví dụ `0.1 + 0.2 !== 0.3`), rất nguy hiểm cho ứng dụng ngân hàng.
- **Decision:** Lưu mọi cột tiền tệ (`accounts.balance`, `accounts.hold_amount`, `transactions.amount`, `ledger_entries.amount`, `ledger_entries.balance_after`) bằng kiểu `numeric(18,2)` trong PostgreSQL; truyền nhận qua API dưới dạng `string`; chuẩn hóa số thập phân bằng xử lý chuỗi thuần túy và so sánh số dư / hạn mức bằng `BigInt` (quy đổi ra xu) hoặc biểu thức SQL.
- **Reason:** Loại bỏ 100% sai số dấu chấm động ở cả tầng ứng dụng lẫn tầng cơ sở dữ liệu.
- **Trade-offs:** Cần bước chuyển đổi chuỗi sang `BigInt` khi so sánh ở tầng Service và định dạng hiển thị ở Frontend.

---

## ADR-006: Quản lý Trạng thái Phía Client bằng Zustand và App Router Client Components
- **Context:** Frontend cần quản lý trạng thái đăng nhập (JWT token, thông tin user) gọn nhẹ, dễ hiểu và đồng bộ nhanh với các trang giao dịch.
- **Decision:** Sử dụng Next.js App Router kết hợp Client Components (`'use client'`), Zustand (`authStore`) lưu trữ phiên vào `localStorage`, và Axios instance dùng chung có gắn Request Interceptor.
- **Reason:** Giữ cấu trúc Frontend tối giản (K.I.S.S), không cần cấu hình phức tạp giữa Server Actions và Client State.
- **Trade-offs:** Không tận dụng SSR cho các trang trong vùng đăng nhập (`(protected)`), nhưng hoàn toàn phù hợp với ứng dụng Web Banking Dashboard.

---

## ADR-007: Quản lý Schema bằng TypeORM Migrations thay cho `synchronize: true`
- **Context:** Tùy chọn `synchronize: true` của TypeORM tự động sửa bảng khi khởi động app, dễ gây mất dữ liệu hoặc không thể kiểm soát thứ tự nâng cấp schema (như backfill sổ cái, đổi kiểu enum, tạo trigger).
- **Decision:** Tắt hoàn toàn `synchronize: false` ở mọi môi trường và quản lý mọi thay đổi schema qua các file Migration trong `backend/src/database/migrations/` (chạy tự động qua `start.sh` trước khi seed và khởi động server).
- **Reason:** Đảm bảo mọi thay đổi cấu trúc bảng, ràng buộc `CHECK`, `Partial Index`, `Trigger` và bước chuyển đổi dữ liệu (data migration) đều có lịch sử phiên bản rõ ràng và có thể hoàn tác (`down`).
- **Trade-offs:** Khi thay đổi Entity cần viết hoặc sinh thêm file Migration tương ứng.

---

## ADR-008: Mô hình Nạp/Rút Một phía và Cột `actor_account_id` trên Giao dịch
- **Context:** Hệ thống cần hỗ trợ cả 3 loại giao dịch cơ bản (`TRANSFER`, `DEPOSIT`, `WITHDRAW`) và giao dịch hoàn tiền (`REVERSAL`). Với `DEPOSIT` thì không có tài khoản nguồn (`from_account_id = NULL`), còn với `WITHDRAW` thì không có tài khoản đích (`to_account_id = NULL`).
- **Decision:** Chọn **mô hình giao dịch một phía** cho Nạp/Rút (kèm `CHECK` constraint `CHK_transactions_type_accounts` kiểm tra chặt các cột `from_account_id`, `to_account_id`, `original_transaction_id` theo từng `type`), và lưu cột `actor_account_id` (`NOT NULL`) để luôn ghi nhận tài khoản của người khởi tạo giao dịch.
- **Reason:** Đơn giản, trực quan, không cần tạo một "tài khoản tiền mặt hệ thống" được phép âm số dư, đồng thời `actor_account_id` giúp truy vết rõ tài khoản nào đã phát sinh yêu cầu giao dịch.
- **Trade-offs:** Giao dịch `DEPOSIT` và `WITHDRAW` chỉ sinh 1 bút toán trong `ledger_entries` (thay vì 2 bút toán như `TRANSFER`), nhưng tổng bút toán của từng tài khoản vẫn khớp tuyệt đối với `accounts.balance`.

---

## ADR-009: Pessimistic Locking (`SELECT ... FOR UPDATE`), Khóa theo Thứ tự `id ASC` và Retry Deadlock
- **Context:** Khi nhiều request rút tiền hoặc chuyển khoản chạy đồng thời trên cùng một tài khoản, hoặc khi A chuyển cho B cùng lúc B chuyển cho A, hệ thống có nguy cơ bị Race Condition (Lost Update) hoặc Deadlock.
- **Decision:**
  1. Sử dụng **Pessimistic Locking** (`SELECT ... FOR UPDATE OF "account"`) kết hợp `SET LOCAL lock_timeout = '5s'`.
  2. Luôn tải và khóa các tài khoản liên quan trong một truy vấn theo thứ tự cố định **`ORDER BY account.id ASC`**.
  3. Bọc Pha B trong vòng lặp `executeWithDeadlockRetry` (tối đa 3 lần khi gặp mã lỗi PostgreSQL `40P01`, chờ ngẫu nhiên 10–50ms) và giữ điều kiện `WHERE (balance - hold_amount) >= :amount` trong câu lệnh `UPDATE` như lớp bảo vệ thứ hai.
- **Reason:** Thực nghiệm ở Module 1 (Báo cáo 1.3) cho thấy dưới tải tranh chấp cao (100 request đồng thời vào 1 tài khoản), Pessimistic Locking đạt 100% thành công trong ~242ms với 0 lỗi 503, trong khi Optimistic Locking (`version`) bị lỗi 503 tới 72% do bão retry. Khóa theo thứ tự `id ASC` triệt tiêu vòng chờ đợi tuần hoàn khi chuyển khoản hai chiều A↔B (0 deadlock qua 5 vòng × 50 cặp).
- **Trade-offs:** Các giao dịch chạm vào cùng một tài khoản phải xếp hàng tuần tự dưới khóa dòng; nếu chờ quá `5s` sẽ nhận `503 Service Unavailable`.

---

## ADR-010: Sổ cái kép Chỉ-Ghi-Thêm (`ledger_entries`), Trigger Bất biến và `id` Kiểu `bigint`
- **Context:** Nếu chỉ cập nhật đè cột `accounts.balance`, hệ thống không thể chứng minh lịch sử biến động số dư hoặc phát hiện sai lệch khi thanh tra.
- **Decision:**
  1. Tạo bảng **`ledger_entries`** lưu mọi bút toán `DEBIT` / `CREDIT` kèm `balance_after` lấy trực tiếp từ `UPDATE accounts ... RETURNING balance` trong cùng một Database Transaction.
  2. Sử dụng khóa chính `id` kiểu `bigint` tự tăng (`BIGSERIAL`, đồng bộ với `@PrimaryGeneratedColumn({ type: 'bigint' })`) để cố định thứ tự ghi sổ.
  3. Bảo vệ tính bất biến (append-only) bằng 2 lớp: không có hàm sửa/xóa ở tầng ứng dụng và gắn Trigger `trg_ledger_entries_immutable` chặn `UPDATE` / `DELETE` ngay tại PostgreSQL.
  4. Giữ `accounts.balance` làm bản sao đọc nhanh (cached balance), còn `ledger_entries` là nguồn sự thật (source of truth).
- **Reason:** Đảm bảo mọi biến động tiền tệ đều có dấu vết bất biến và sao kê (`balance_after`) luôn khớp với số dư cộng dồn theo thứ tự `id`.
- **Trade-offs:** Tốn thêm dung lượng lưu trữ bút toán và thao tác `INSERT` trong mỗi giao dịch; ở môi trường production thực tế cần kết hợp thêm `REVOKE UPDATE, DELETE, TRUNCATE` đối với DB user của ứng dụng.

---

## ADR-011: Máy Trạng thái Giao dịch (State Machine), Ghi nhận `FAILED` và Job Quét Giao dịch Treo
- **Context:** Giao dịch tài chính cần có vòng đời rõ ràng; các giao dịch thất bại do lỗi nghiệp vụ (như thiếu số dư, vượt hạn mức, tài khoản bị đóng băng) cần được lưu vết thay vì biến mất sau khi rollback, và các giao dịch bị kẹt ở `PROCESSING` (do sập nguồn/mất kết nối giữa chừng) cần được tự động phát hiện.
- **Decision:**
  1. Định nghĩa bảng chuyển trạng thái hợp lệ duy nhất `ALLOWED_STATUS_TRANSITIONS` (`INITIATED -> PENDING_OTP | PROCESSING`, `PENDING_OTP -> PROCESSING | FAILED`, `PROCESSING -> COMPLETED | FAILED`, `COMPLETED -> REVERSED`) và hàm `transition()` thực hiện `UPDATE ... WHERE id = :id AND status = :from`.
  2. Ghi nhận mọi lỗi ở Pha B thành trạng thái `FAILED` kèm mã lý do `failure_code` ở Pha C (sau khi Pha B đã rollback tiền và sổ cái).
  3. Thiết lập cron job `sweepStuckTransactions()` (`@nestjs/schedule`, chạy mỗi phút) tìm các giao dịch `PROCESSING` có `updated_at` cũ hơn `120s` và chưa có bút toán sổ cái để chuyển sang `FAILED` (`failure_code = TIMEOUT`) đồng thời đóng luôn dòng khóa `idempotency_keys` tương ứng sang `FAILED` (`503`).
- **Reason:** Đảm bảo không bao giờ có giao dịch rơi vào trạng thái "lửng lơ" vô thời hạn, không thể chuyển trạng thái sai cạnh (như `FAILED -> COMPLETED`), và lưu đầy đủ lịch sử các lần giao dịch thất bại.
- **Trade-offs:** Job `@Cron` chạy trong tiến trình backend phù hợp với kiến trúc 1 instance hiện tại; nếu mở rộng nhiều instance cần thêm cơ chế distributed lock hoặc `FOR UPDATE SKIP LOCKED`.

---

## ADR-012: Hoàn tiền bằng Giao dịch `REVERSAL` Đảo Bút toán và 3 Lớp Chống Hoàn tiền Hai lần
- **Context:** Khi cần hoàn tiền một giao dịch đã `COMPLETED`, hệ thống tài chính không được phép xóa hay sửa số tiền của giao dịch gốc hay bút toán gốc.
- **Decision:**
  1. Tạo endpoint `POST /api/transactions/:id/reverse` (chỉ dành cho `ADMIN` qua `RolesGuard`) sinh ra một giao dịch mới có `type = REVERSAL` và `original_transaction_id` trỏ về giao dịch gốc.
  2. Đảo ngược từng bút toán của giao dịch gốc (`CREDIT -> DEBIT`, `DEBIT -> CREDIT`) và kiểm tra số dư khả dụng của bên bị thu hồi tiền (`REVERSAL_INSUFFICIENT_BALANCE` nếu đã tiêu hết).
  3. Bảo vệ chống hoàn tiền hai lần bằng **3 lớp**: (a) Kiểm tra `originalTx.status === 'COMPLETED'` ở Pha A; (b) Partial Unique Index `IDX_transactions_active_reversal_original` trên `(original_transaction_id)` với điều kiện `type = 'REVERSAL' AND status IN ('INITIATED', 'PENDING_OTP', 'PROCESSING', 'COMPLETED')` (loại trừ `FAILED` để cho phép thử lại khi bên nhận nạp thêm tiền); (c) Đóng dấu có điều kiện `transition(originalTx.id, COMPLETED -> REVERSED)` trong cùng transaction Pha B.
- **Reason:** Giữ nguyên vẹn lịch sử giao dịch gốc và sổ cái chỉ-ghi-thêm, đồng thời ngăn chặn tuyệt đối việc hoàn tiền trùng lặp ngay cả khi nhiều Admin bấm cùng lúc.
- **Trade-offs:** Nếu người nhận đã rút tiêu hết tiền, yêu cầu hoàn tiền sẽ thất bại (`422`) và cần chờ tài khoản đó có đủ số dư mới hoàn tiền lại được.

---

## ADR-013: Kiến trúc Bảng `idempotency_keys` (Request Hash, Response Snapshot, TTL 24h) và Frontend Auto-Retry
- **Context:** Cần nâng cấp cơ chế Idempotency từ mức cột đơn giản lên chuẩn hệ thống thanh toán (Bài 2.1 & 2.2): phát hiện trùng khóa nhưng đổi nội dung, trả lại đúng bản chụp phản hồi ban đầu, có hạn dùng và hỗ trợ Frontend tự động thử lại khi mạng lỗi.
- **Decision:**
  1. **Cấu trúc bảng `idempotency_keys`:** Gồm `user_id`, `idempotency_key`, `request_hash` (`char(64)`), `status` (`IN_PROGRESS | COMPLETED | FAILED`), `response_status`, `response_body` (`jsonb`), `transaction_id`, `created_at`, `expired_at` (`created_at + 24 giờ`), với ràng buộc `UNIQUE (user_id, idempotency_key)` và `CHECK (status = 'IN_PROGRESS' OR response_status IS NOT NULL)`.
  2. **Chuẩn hóa và băm yêu cầu (`request_hash`):** Chuẩn hóa `amount` về đúng 2 chữ số thập phân bằng xử lý chuỗi (`"50000"` → `"50000.00"`), sanitize `description`/`reason`, xếp các trường theo thứ tự cố định kèm tên `operation` (`TRANSFER | DEPOSIT | WITHDRAW | REVERSE`) rồi băm SHA-256.
  3. **Đăng ký khóa nguyên tử bằng `INSERT ... ON CONFLICT DO NOTHING`:** Tại Pha A, xóa dòng khóa cũ đã hết hạn (nếu `expired_at <= NOW()` và `status <> 'IN_PROGRESS'`), sau đó chạy `INSERT ... ON CONFLICT ("user_id", "idempotency_key") DO NOTHING RETURNING *`. Nếu không chèn được (khóa đã tồn tại), đọc ngay dòng khóa hiện có trong cùng kết nối mà không làm hỏng transaction để so khớp `request_hash` (khác → `409 Conflict`; khớp → trả bản chụp `200`, lỗi đã lưu `422/500/503`, hoặc `202 Accepted` nếu đang `IN_PROGRESS`).
  4. **Đồng bộ trạng thái khóa trong cùng Transaction:** Chuyển khóa sang `COMPLETED` ngay trong transaction Pha B (cùng lúc với việc chuyển tiền) và sang `FAILED` trong transaction Pha C (hoặc trong `sweepStuckTransactions()`). Dọn khóa hết hạn mỗi giờ bằng `@Cron(CronExpression.EVERY_HOUR)`.
  5. **Frontend Auto-Retry & In-Flight Guard (`submitIdempotentTransaction`):** Đặt timeout `10s`, tự động retry tối đa `3` lần (chờ `1s -> 2s -> 4s`) với **cùng `Idempotency-Key`** chỉ khi không nhận được phản hồi (mất mạng/timeout) hoặc nhận `202 Accepted`; dừng ngay khi nhận bất kỳ phản hồi cuối cùng nào (`201/200` hoặc `4xx/5xx`); kết hợp cờ đồng bộ `useRef(false)` để chặn bấm đúp trong cùng một tích tắc trước khi React kịp re-render.
- **Reason:** Đảm bảo tính nhất quán tuyệt đối giữa trạng thái khóa và biến động tiền tệ; trả về đúng bản chụp kết quả lúc yêu cầu hoàn tất; và bảo vệ người dùng khỏi bị trừ tiền hai lần khi mạng chập chờn hoặc bấm nhầm nhiều lần.
- **Trade-offs:** Phản hồi Replay trả về **bản chụp tại thời điểm giao dịch đó kết thúc** (ví dụ: giao dịch lúc đầu trả `COMPLETED`, về sau bị Admin hoàn tiền sang `REVERSED`, thì replay lại khóa cũ của lần chuyển vẫn trả bản chụp `COMPLETED` ban đầu; trạng thái mới nhất xem ở API Lịch sử giao dịch). Ngoài ra, khi nâng cấp xóa cột `transactions.idempotency_key`, các khóa cũ trước thời điểm nâng cấp không được backfill (chấp nhận được vì khóa vốn chỉ có TTL 24 giờ).

---

## ADR-014: Phân quyền theo Vai trò (RBAC) Đọc Trực tiếp từ Database và Phạm vi Rút gọn 2 Vai trò (`CUSTOMER` / `ADMIN`)
- **Context:** Hệ thống ngân hàng cần phân tách rõ quyền hạn giữa Khách hàng thông thường (`CUSTOMER`) và Quản trị viên hệ thống (`ADMIN`), đồng thời đảm bảo khi thay đổi vai trò hoặc khóa tài khoản, quyền hạn mới phải có hiệu lực ngay lập tức mà không chờ JWT hết hạn (Bài 4.1).
- **Decision:**
  1. Chuẩn hóa enum `users.role` sang chữ HOA gồm 2 giá trị: **`CUSTOMER`** và **`ADMIN`** (giữ nguyên `users.status` là `'active' | 'locked'` theo đề gốc).
  2. Xây dựng decorator `@Roles(...roles)` và `RolesGuard` sử dụng `Reflector` để đọc danh sách vai trò yêu cầu ở cấp Controller hoặc Method, đối chiếu trực tiếp với `req.user.role` (được `JwtStrategy.validate()` tải tươi từ PostgreSQL ở mỗi request).
  3. Đặt `@Roles(UserRole.ADMIN)` ở cấp class cho toàn bộ `AdminController` (`/api/admin/*`) và ở cấp method cho `POST /api/transactions/:id/reverse`. Bổ sung kiểm tra quyền sở hữu (Ownership Check) tại `GET /api/accounts/:accountNumber`: `CUSTOMER` chỉ xem được tài khoản của chính mình (xem của người khác trả `403 Forbidden`), trong khi `ADMIN` xem được mọi tài khoản (`404` nếu không tồn tại).
  4. Các endpoint giao dịch cá nhân (`/api/accounts/me`, `/api/transactions/transfer|deposit|withdraw`, `GET /api/transactions`) mở cho mọi người dùng đã xác thực nhưng luôn lấy danh tính từ `req.user.id` của JWT, nên mỗi người chỉ thao tác được trên tài khoản của chính mình.
  5. **Phạm vi rút gọn (`HOÃN`):** Tạm hoãn vai trò `TELLER`, các API giao dịch hộ khách tại quầy (`/staff/transactions/*`), hạn mức duyệt giao dịch viên và giao diện Admin UI ở Frontend (sử dụng Swagger / `curl` với token `ADMIN`).
- **Reason:** Đọc `role` và `status` từ DB ở mỗi request giúp loại bỏ hoàn toàn độ trễ thu hồi quyền của JWT tĩnh; đặt `@Roles(UserRole.ADMIN)` ở cấp Controller ngăn ngừa rủi ro quên gắn guard khi thêm route quản trị mới; trả `403` tại `GET /api/accounts/:accountNumber` đáp ứng chính xác kịch bản kiểm thử phân quyền của đề bài.
- **Trade-offs:** Trả `403` khi `CUSTOMER` tra cứu số tài khoản khác có thể gián tiếp cho biết định dạng endpoint tồn tại, nhưng số tài khoản đích vốn đã có thể kiểm tra qua luồng chuyển khoản nên hoàn toàn chấp nhận được. Việc hoãn vai trò `TELLER` và Admin UI giúp giữ dự án gọn gàng, tập trung vào độ tin cậy của tầng Backend.

---

## ADR-015: Nhật ký Kiểm toán Tự động Chỉ-Ghi-Thêm (`audit_logs`) Kết hợp TypeORM Subscriber, Interceptor và `AsyncLocalStorage`
- **Context:** Mọi thao tác nhạy cảm (khóa/mở khóa người dùng, cập nhật hồ sơ, xóa mềm người dùng, cập nhật trạng thái/hạn mức/hold của tài khoản, đăng nhập thành công/thất bại, hoàn tiền giao dịch) phải được ghi lại tự động vào bảng `audit_logs` kèm thông tin người thực hiện (`actor_id`), IP, User-Agent và ảnh dữ liệu trước/sau (`before_data` / `after_data`) mà không làm rò rỉ mật khẩu hay có thể bị tẩy xóa (Bài 3.3).
- **Decision:**
  1. **Bảng `audit_logs` chỉ-ghi-thêm:** Sử dụng khóa chính `id` kiểu `bigint` tự tăng (`BIGSERIAL`, đồng bộ giữa `@PrimaryGeneratedColumn({ type: 'bigint' })` và Migration theo Phụ lục P.1) để cố định thứ tự thời gian tuyệt đối, kèm Trigger `trg_audit_logs_immutable` chặn mọi câu lệnh `UPDATE` và `DELETE` ngay tại tầng PostgreSQL.
  2. **Truyền ngữ cảnh yêu cầu bằng `AsyncLocalStorage` (`RequestContextMiddleware`):** Mở ngữ cảnh ở tầng Middleware lưu tham chiếu tới `req`, và thực hiện **đọc trễ (lazy read)** `req.user?.id`, `req.ip`, `req.headers['user-agent']` tại thời điểm ghi log (vì `JwtAuthGuard` chạy sau Middleware).
  3. **Kết hợp hai cơ chế ghi Audit tự động:**
     - **TypeORM Entity Subscribers (`UserAuditSubscriber` & `AccountAuditSubscriber`):** Lắng nghe thực thể `User` và `Account`, chụp bản sao an toàn vào `WeakMap` ngay tại `afterLoad(entity)` (giải quyết triệt để vấn đề `event.databaseEntity` bị ghi đè khi sửa cùng instance rồi gọi `save()`, theo Phụ lục P.2 & P.3), đối chiếu với `afterUpdate` / `afterSoftRemove` theo danh sách trắng `ALLOWED_USER_AUDIT_FIELDS = ['fullName', 'email', 'phone', 'role', 'status']` và `ALLOWED_ACCOUNT_AUDIT_FIELDS = ['status', 'tier', 'holdAmount']` (tuyệt đối không có `password_hash`), và chèn bản ghi `USER_STATUS_CHANGED` / `USER_UPDATED` / `USER_SOFT_DELETED` / `ACCOUNT_UPDATED` bằng **`event.manager`** (nằm trong **cùng một Database Transaction** với thao tác sửa dữ liệu).
     - **NestJS Interceptor (`AuditInterceptor` + `@Audit()`):** Gắn lên các sự kiện nghiệp vụ cấp HTTP (`POST /api/auth/login` → `AUTH_LOGIN_SUCCESS` / `AUTH_LOGIN_FAILED`; `POST /api/transactions/:id/reverse` → `TRANSACTION_REVERSED`), ghi nhận cả khi thành công lẫn thất bại (sau khi ghi xong phải **ném lại đúng lỗi gốc**, không nuốt lỗi).
- **Reason:** Kết hợp Subscriber và Interceptor giúp tận dụng thế mạnh của cả hai: các thay đổi trạng thái dữ liệu (`User`, `Account`) được bảo vệ nguyên tử cùng transaction (nếu transaction rollback thì bản ghi audit cũng rollback theo), trong khi các sự kiện hành vi như đăng nhập sai mật khẩu (không sửa dòng DB nào) vẫn được Interceptor ghi vết đầy đủ.
- **Trade-offs:** Cơ chế ghi của `AuditInterceptor` là *best-effort* (chạy ngay sau khi handler xử lý xong, không nằm chung transaction với handler); và các câu lệnh cập nhật bằng biểu thức SQL qua `QueryBuilder` (như cộng/trừ `accounts.balance` hay đổi `transactions.status`) không đi qua Subscriber (đã có `ledger_entries` và State Machine lưu vết chuyên biệt).

---

## ADR-016: Kiểm tra Hạn mức Giao dịch ở Pha B dưới Khóa dòng theo Ngày Việt Nam bằng Đồng hồ Database
- **Context:** Ngân hàng cần giới hạn số tiền tối đa cho mỗi lần giao dịch và tổng số tiền lũy kế trong một ngày theo từng hạng tài khoản (`STANDARD`: 30.000.000đ/lần, 50.000.000đ/ngày; `VIP`: 100.000.000đ/lần, 200.000.000đ/ngày — Bài 5.1). Nếu kiểm tra hạn mức không có khóa hoặc tính mốc ngày theo đồng hồ máy chủ NodeJS, nhiều request đồng thời có thể lách qua trần hạn mức ngày hoặc lệch múi giờ.
- **Decision:**
  1. Đặt cấu hình hạn mức tập trung tại một hằng số duy nhất `ACCOUNT_TIER_LIMITS` theo `AccountTier` (`STANDARD` / `VIP`).
  2. Thực hiện kiểm tra hạn mức (`enforceOutgoingLimitsInPhaseB`) ở **Bước 3 của Pha B, ngay bên dưới khóa dòng `SELECT ... FOR UPDATE` của tài khoản nguồn**, chỉ áp dụng cho các giao dịch làm tiền đi ra khỏi tài khoản (`TRANSFER` và `WITHDRAW`; miễn áp dụng cho `DEPOSIT` và `REVERSAL`).
  3. Tính tổng số tiền đã dùng hôm nay (`usedToday`) bằng truy vấn SQL lấy tổng `amount` của các giao dịch `TRANSFER` / `WITHDRAW` đang ở trạng thái **`COMPLETED`** có `created_at` nằm trong ngày hiện tại theo múi giờ Việt Nam (`Asia/Ho_Chi_Minh`) tính trực tiếp bằng đồng hồ của PostgreSQL:
     `t.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')`
  4. So sánh số tiền bằng số học nguyên `BigInt` (quy đổi ra xu, không dùng số thực dấu chấm động). Khi vượt hạn mức, ném `LIMIT_PER_TRANSACTION_EXCEEDED` hoặc `LIMIT_PER_DAY_EXCEEDED` (`422`) kèm thông báo động nêu rõ hạn mức và số tiền còn lại hôm nay (`formatVndCurrency`), đồng thời lưu thông báo này vào bản chụp `idempotency_keys.response_body` ở Pha C.
- **Reason:** Kiểm tra dưới khóa dòng `FOR UPDATE` ở Pha B bắt buộc mọi giao dịch đồng thời của cùng một tài khoản phải xếp hàng kiểm tra tuần tự (giao dịch sau luôn nhìn thấy giao dịch trước đã `COMMIT` trạng thái `COMPLETED`), triệt tiêu 100% lỗi vượt trần hạn mức ngày khi bắn song song. Chỉ tính `status = 'COMPLETED'` đảm bảo giao dịch `FAILED` (chưa trừ tiền) và giao dịch gốc đã `REVERSED` (tiền đã hoàn trả) không chiếm dụng hạn mức của khách hàng.
- **Trade-offs:** Vì hạn mức được kiểm tra chính thức ở Pha B, khách hàng chỉ nhận kết quả từ chối sau khi gửi yêu cầu; để tối ưu trải nghiệm, API `GET /api/accounts/me` trả thêm khối `limits` (`usedToday`, `remainingToday` đọc không khóa) để giao diện hiển thị thanh tiến độ và gợi ý sớm cho người dùng.

---

## ADR-017: Trạng thái Tài khoản (`ACTIVE / FROZEN / CLOSED`), Số dư Khả dụng (`balance − hold_amount`) trong Câu `UPDATE` và Luật Đóng Tài khoản
- **Context:** Cần quản lý vòng đời trạng thái của tài khoản ngân hàng (`ACTIVE`, `FROZEN`, `CLOSED`) và số tiền đang bị phong tỏa/giữ chỗ (`hold_amount`), sao cho tài khoản không hoạt động thì không thể giao dịch (cả chiều đi lẫn chiều đến) và khách hàng không bao giờ rút/chuyển lẹm vào phần tiền đang bị phong tỏa (Bài 5.2).
- **Decision:**
  1. Bổ sung vào bảng `accounts` các cột `status` (`ACTIVE | FROZEN | CLOSED`, mặc định `ACTIVE`), `tier` (`STANDARD | VIP`, mặc định `STANDARD`), `hold_amount` (`numeric(18,2)`, mặc định `0`) cùng **3 ràng buộc `CHECK` mức Database**: `CHK_accounts_balance_non_negative` (`balance >= 0`), `CHK_accounts_hold_non_negative` (`hold_amount >= 0`), và `CHK_accounts_hold_lte_balance` (`hold_amount <= balance`).
  2. Kiểm tra trạng thái tài khoản (`ensureAccountActiveInPhaseB`) ở **Pha B dưới khóa dòng** cho cả 4 nghiệp vụ (`transfer`, `deposit`, `withdraw`, `reverse`). Nếu tài khoản nguồn hoặc đích đang `FROZEN` hay `CLOSED`, từ chối với đúng 1 trong 4 mã lỗi (`SOURCE_ACCOUNT_FROZEN`, `SOURCE_ACCOUNT_CLOSED`, `DESTINATION_ACCOUNT_FROZEN`, `DESTINATION_ACCOUNT_CLOSED` — HTTP `422`) và ghi nhận bản ghi `FAILED` ở Pha C.
  3. Đặt công thức kiểm tra **số dư khả dụng** ở cả 2 lớp: kiểm tra bằng `BigInt` (`balance - hold_amount >= amount`) ở Pha B và khóa chặt điều kiện ngay trong câu lệnh SQL `UPDATE accounts SET balance = balance - :amount WHERE id = :id AND status = 'ACTIVE' AND deleted_at IS NULL AND (balance - hold_amount) >= :amount RETURNING balance`.
  4. Cung cấp API `PATCH /api/admin/accounts/:accountNumber` (chỉ `ADMIN`), khóa dòng `Account` bằng `FOR UPDATE`, áp dụng luật chuyển trạng thái: `ACTIVE <-> FROZEN` tự do; `CLOSED` là trạng thái kết thúc (không thể mở lại → `409`); chỉ cho phép chuyển sang `CLOSED` khi `balance = 0`, `hold_amount = 0` và không có giao dịch `INITIATED / PENDING_OTP / PROCESSING` nào liên quan (`409` nếu vi phạm); `holdAmount` phải thỏa `0 <= holdAmount <= balance` (`422` nếu vượt số dư).
- **Reason:** Kiểm tra trạng thái tài khoản ở Pha B (thay vì chặn ở Pha A) đảm bảo mọi giao dịch chạm vào tài khoản `FROZEN`/`CLOSED` đều được lưu vết `FAILED` đúng yêu cầu đề bài. Kết hợp khóa dòng `FOR UPDATE`, điều kiện `WHERE (balance - hold_amount) >= :amount` trong câu `UPDATE` và `CHECK (hold_amount <= balance)` ở PostgreSQL tạo thành 3 lớp bảo vệ không thể xuyên thủng khi Admin đặt hold đồng thời với lúc khách rút tiền.
- **Trade-offs:** Khi một tài khoản đang bị `FROZEN`, ngay cả giao dịch hoàn tiền (`REVERSAL`) của Admin cũng bị từ chối tạm thời; Admin cần mở băng tài khoản đó sang `ACTIVE` trước khi thực hiện hoàn tiền (nhằm tránh làm thay đổi số dư trên tài khoản đang phong tỏa hoặc đã đóng `CLOSED`).

---

## ADR-018: Xóa mềm bằng `@DeleteDateColumn`, Rà soát `withDeleted` và Lưu vết Phiên bản Hồ sơ Tường minh (`account_history`)
- **Context:** Trong hệ thống tài chính, việc xóa cứng (`DELETE FROM`) người dùng hoặc tài khoản sẽ phá hủy khóa ngoại của sổ cái `ledger_entries` và làm mất dấu vết lịch sử giao dịch. Đồng thời, khi người dùng cập nhật thông tin cá nhân (`fullName`, `email`, `phone`), hệ thống cần lưu lại các phiên bản cũ để tra cứu (Bài 3.4).
- **Decision:**
  1. **Xóa mềm nguyên tử (`DELETE /api/admin/users/:id`):** Sử dụng `@DeleteDateColumn` (`deleted_at`) trên cả `User` và `Account`. Khi Admin xóa một `CUSTOMER` (yêu cầu `balance = 0`, `hold_amount = 0`, không có giao dịch đang dở), hệ thống thực hiện trong **một Database Transaction** dưới khóa dòng `Account`: chuyển `account.status = 'CLOSED'`, gọi `softRemove(Account)` và `softRemove(User)`, đồng thời tự động ghi Audit `ACCOUNT_UPDATED` và `USER_SOFT_DELETED`.
  2. **Rà soát Bản đồ Truy vấn với `@DeleteDateColumn`:**
     - Để mặc định tự lọc (`deleted_at IS NULL`) ở `AuthService.login`, `JwtStrategy.validate` (thu hồi phiên `401` ngay lập tức ở request kế tiếp), `AccountsService`, bước tìm tài khoản đích khi chuyển khoản (`404`) và danh sách `/api/admin/users` mặc định.
     - Chủ động bật **`withDeleted`** tại: (a) `AuthService.register` và `seed.ts` để email và số tài khoản của người dùng đã xóa mềm vẫn được giữ chỗ (`409 Conflict`); (b) `TransactionsService.getTransactions` và `AdminService.getTransactions` khi `LEFT JOIN` `fromAccount` / `toAccount` để lịch sử giao dịch của người còn lại **vẫn hiển thị đầy đủ `counterpartyAccountNumber` của đối tác đã xóa mềm**; (c) `GET /api/admin/users?includeDeleted=true` dành cho Admin.
  3. **Lưu vết phiên bản hồ sơ tường minh trong `account_history` (`PATCH /api/users/me`):** Tạo bảng `account_history` (`id BIGSERIAL`, `UNIQUE (user_id, version)`, kèm Trigger chỉ-ghi-thêm `trg_account_history_immutable`). Khi người dùng sửa `fullName`, `email` (bắt buộc kèm `currentPassword`, sai trả `400 Bad Request`) hoặc `phone` và có ít nhất 1 trường thực sự thay đổi, trong cùng một transaction dưới khóa `FOR UPDATE`: **chèn bản chụp giá trị cũ vào `account_history` với `version = profile_version` hiện tại trước**, sau đó mới ghi đè giá trị mới và tăng `profile_version + 1` trên bảng `users`.
- **Reason:** Dùng `@DeleteDateColumn` giúp hầu hết các truy vấn đọc thông thường tự động loại trừ bản ghi đã xóa mềm mà không sợ quên điều kiện `WHERE`, trong khi việc bật `.withDeleted()` có kiểm soát ở JOIN lịch sử giao dịch bảo toàn trọn vẹn thông tin đối tác. Ghi `account_history` tường minh trong `UsersService` (tách biệt với `audit_logs` của Subscriber) giúp đồng bộ chặt chẽ với việc tăng `profile_version` và phục vụ đúng mục đích "xem lại các phiên bản hồ sơ cũ" của khách hàng và Admin.
- **Trade-offs:** Vì cột `users.email` giữ ràng buộc `UNIQUE` toàn cục để bảo toàn định danh kiểm toán, email của người dùng đã bị xóa mềm không thể dùng để đăng ký tài khoản mới; và phiên bản hiện tại chưa hỗ trợ API khôi phục (`restore`) người dùng đã xóa mềm.