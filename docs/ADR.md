# Architecture Decision Records (ADR)

## ADR-001: Why NestJS + PostgreSQL + TypeORM
* **Context**: Cần chọn stack backend cho ứng dụng ngân hàng đáp ứng yêu cầu kiến trúc phân tầng rõ ràng và đảm bảo tính toàn vẹn dữ liệu giao dịch.
* **Decision**: Sử dụng NestJS (TypeScript) làm backend framework, TypeORM làm ORM và PostgreSQL làm hệ quản trị cơ sở dữ liệu.
* **Reason**: NestJS cung cấp sẵn kiến trúc module hóa (`Controller -> Service -> Repository`) và tích hợp sẵn `ValidationPipe`, Guard, Swagger. TypeORM hỗ trợ tốt quản lý Database Transaction (`QueryRunner`) và Migration. PostgreSQL tuân thủ chuẩn ACID và hỗ trợ tốt kiểu số thập phân chính xác (`numeric`).
* **Trade-offs**: Cấu hình khởi đầu của NestJS và TypeORM Migration nhiều bước hơn so với ExpressJS thuần, nhưng giúp mã nguồn nhất quán và dễ mở rộng.

## ADR-002: Why numeric(18,2)
* **Context**: Cần chọn kiểu dữ liệu lưu trữ và tính toán số tiền (`balance`, `amount`) cho tiền tệ VND.
* **Decision**: Sử dụng `numeric(18,2)` trong PostgreSQL, truyền và trả dữ liệu qua JSON dưới dạng `string` (ví dụ `"50000.00"`), chuẩn hóa số thập phân bằng xử lý chuỗi, so sánh ở ứng dụng bằng số nguyên `BigInt` (đơn vị xu) và thực hiện cộng/trừ trực tiếp bằng biểu thức SQL trong PostgreSQL.
* **Reason**: Kiểu `float` hoặc `double` (IEEE 754) bị sai số làm tròn dấu phẩy động, không được phép dùng trong ứng dụng tài chính. `numeric(18,2)` lưu trữ chính xác tuyệt đối tới từng xu và chịu được giá trị lên tới hàng triệu tỷ đồng.
* **Trade-offs**: TypeORM ánh xạ cột `numeric` thành `string` trong TypeScript nên cần validate định dạng bằng regex `^\d{1,16}(\.\d{1,2})?$` ở DTO và bắt lỗi tràn số (`22003`) ở tầng database.

## ADR-003: Why 3-Phase Transaction Flow + Pessimistic Lock + Atomic Conditional Update + In-Transaction Ledger & Idempotency Snapshot
* **Context**: Các thao tác biến động số dư (`TRANSFER`, `DEPOSIT`, `WITHDRAW`, `REVERSAL`) cần vừa lưu lại dấu vết phiếu giao dịch khi thất bại (`FAILED`), vừa lưu bản chụp kết quả Idempotency, vừa đảm bảo tuyệt đối không để lại dữ liệu tiền hay bút toán dở dang khi lỗi giữa chừng hoặc khi có nhiều request chạy đồng thời.
* **Decision**: Thực hiện giao dịch theo **Luồng 3 Pha** kết hợp bảo vệ đa lớp:
  1. **Pha A (Khởi tạo phiếu & Khóa — Transaction ngắn 1):** Kiểm tra đầu vào, xóa khóa cũ đã hết hạn, chèn dòng `idempotency_keys` (`status = 'IN_PROGRESS'`) bằng `INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`. Nếu là khóa mới: tạo bản ghi giao dịch ở trạng thái `INITIATED`, chuyển sang `PROCESSING`, gắn `transaction_id` vào dòng khóa và `COMMIT` ngay.
  2. **Pha B (Xử lý tiền, Sổ cái & Chụp biên nhận — Transaction chính 2):**
     * Khóa các dòng tài khoản liên quan bằng `SELECT ... FOR UPDATE OF "account"` theo `ORDER BY account.id ASC`.
     * Trừ/cộng tiền bằng câu lệnh nguyên tử có điều kiện (`UPDATE accounts SET balance = balance ∓ :amount WHERE id = :id [AND balance >= :amount] RETURNING balance`) để lấy ngay `balance_after`.
     * Ghi các bút toán vào `ledger_entries`, đóng dấu giao dịch `PROCESSING → COMPLETED` (kèm `COMPLETED → REVERSED` cho giao dịch gốc nếu là hoàn tiền), và đóng dấu dòng `idempotency_keys` từ `IN_PROGRESS → COMPLETED` (kèm `response_status = 201` và `response_body` snapshot) trong **cùng một Database Transaction** trước khi `COMMIT`.
  3. **Pha C (Ghi nhận thất bại — Transaction ngắn 3):** Nếu Pha B gặp lỗi và đã `ROLLBACK` hoàn toàn (số dư và sổ cái không đổi), mở transaction mới đóng dấu giao dịch `PROCESSING → FAILED` kèm `failure_code` và đóng dấu dòng `idempotency_keys` sang `FAILED` kèm bản chụp lỗi rồi `COMMIT`.
* **Reason**: Đảm bảo mọi biến động số dư, bút toán sổ cái, con dấu `COMPLETED` của giao dịch và bản chụp kết quả của khóa Idempotency luôn thành công hoặc hủy bỏ cùng nhau 100%.
* **Trade-offs**: Mỗi giao dịch mới đi qua 2 transaction ngắn (Pha A và Pha B, hoặc Pha A và Pha C), đổi lại trạng thái vòng đời giao dịch và khóa chống trùng luôn nhất quán tuyệt đối.

## ADR-004: Why Dedicated `idempotency_keys` Table Instead of a Column on `transactions`
* **Context**: Khi mạng chậm, mất kết nối hoặc timeout, trình duyệt hoặc người dùng có thể gửi lặp lại cùng một yêu cầu giao dịch, dẫn đến nguy cơ trừ/cộng tiền hai lần. Ở các phiên bản đầu (v5 → Module 3B), khóa chống trùng được lưu tạm ở cột `transactions.idempotency_key`.
* **Decision**: Nâng cấp từ cột trên bảng `transactions` sang bảng **`idempotency_keys`** chuyên biệt (và xóa cột `transactions.idempotency_key`). Bắt buộc client gửi header `Idempotency-Key` (UUID) cho mọi API tạo giao dịch (`transfer`, `deposit`, `withdraw`, `reverse`). Khi gửi lại cùng key (cùng `user_id`) trong thời hạn 24 giờ:
  * Khác `request_hash` (khác nội dung hoặc khác loại thao tác): trả `409 Conflict`.
  * Khóa ở trạng thái `COMPLETED`: trả `200 OK` kèm đúng **bản chụp kết quả (`response_body` snapshot)** đã lưu lúc hoàn tất.
  * Khóa ở trạng thái `FAILED`: trả lại đúng `response_status` và `response_body` lỗi đã lưu mà không chạy lại.
  * Khóa ở trạng thái `IN_PROGRESS`: trả `202 Accepted` kèm trạng thái hiện tại của giao dịch.
* **Reason**: Tách bảng riêng giúp lưu được mã băm yêu cầu (`request_hash`), bản chụp kết quả (`response_body`), thời hạn sống 24 giờ (`expired_at`) để dọn dẹp định kỳ mà không ảnh hưởng tới bảng lịch sử `transactions` vĩnh viễn.
* **Trade-offs**: Thêm một bảng trong cơ sở dữ liệu và cần job dọn dẹp khóa hết hạn định kỳ.

## ADR-005: Why Next.js + Zustand
* **Context**: Cần xây dựng giao diện ReactJS cho trình duyệt desktop có quản lý trạng thái đăng nhập, bảo vệ route và đóng gói Docker gọn nhẹ.
* **Decision**: Sử dụng Next.js (App Router) ở chế độ Client Component (`'use client'`) kết hợp với Zustand (`persist` middleware) và Axios.
* **Reason**: Next.js cung cấp cơ chế định tuyến theo thư mục rõ ràng và chế độ build `output: 'standalone'` giúp chạy container nhẹ. Zustand tối giản, dễ sử dụng.
* **Trade-offs**: Cần chờ cờ `hydrated` của Zustand trước khi kiểm tra redirect ở `ProtectedLayout` để tránh nháy trang khi tải lại.

## ADR-006: Why Input Sanitization / XSS Protection
* **Context**: Dữ liệu văn bản do người dùng nhập (`fullName`, `description`, `reason`) có thể chứa các thẻ HTML/script độc hại gây lỗi XSS.
* **Decision**: Validate bằng `class-validator` (`whitelist: true`, `forbidNonWhitelisted: true`), sanitize các ký tự `<`, `>`, `&` bằng hàm `sanitizeHtml` trước khi lưu vào DB, và tận dụng auto-escaping của React JSX ở Frontend.
* **Reason**: Phòng thủ ở cả đầu vào và đầu ra mà không cần cài thêm thư viện nặng.
* **Trade-offs**: Access Token lưu trong `localStorage` đòi hỏi kiểm soát chặt XSS và giới hạn thời hạn token (`1h`).

## ADR-007: Why TypeORM Migrations Instead of Synchronize
* **Context**: Khi mở rộng sang các bài tập nâng cao (thêm `CHECK` constraint, đổi tên/thêm giá trị enum, thêm bảng sổ cái kép kèm backfill, trigger, partial unique index và bảng `idempotency_keys`), `synchronize: true` không thể kiểm soát thứ tự chuyển đổi dữ liệu.
* **Decision**: Tắt hoàn toàn `synchronize: true` (`synchronize: false` trong `data-source.ts`) và quản lý mọi thay đổi schema qua TypeORM Migrations.
* **Reason**: Mọi thay đổi cấu trúc DB đều tường minh, có phiên bản trên Git, hỗ trợ rollback (`down`) và ánh xạ dữ liệu cũ an toàn.
* **Trade-offs**: Mỗi khi sửa Entity phải tạo và chạy file migration tương ứng.

## ADR-008: Why Single-Sided Cash Transactions & `actor_account_id` Tracking
* **Context**: Cần quyết định cách lưu `from_account_id` / `to_account_id` cho `DEPOSIT`, `WITHDRAW` và ghi nhận tài khoản khởi tạo giao dịch.
* **Decision**: Chọn **mô hình giao dịch một phía** (`DEPOSIT`: `from = NULL, to = NOT NULL`; `WITHDRAW`: `from = NOT NULL, to = NULL`) kèm `CHECK` constraint `CHK_transactions_type_accounts`, và lưu cột `actor_account_id` để định danh tài khoản chủ động thực hiện giao dịch. (Từ Module 2, phạm vi khóa Idempotency được chuyển sang bảng `idempotency_keys` theo `(user_id, idempotency_key)`).
* **Reason**: Không cần tạo tài khoản hệ thống ảo bị âm quỹ, giữ cho mọi tài khoản trong bảng `accounts` luôn có số dư không âm (`>= 0`).
* **Trade-offs**: Bảng `transactions` có cột `actor_account_id` tách biệt với `from_account_id` / `to_account_id`.

## ADR-009: Why Pessimistic Locking, Canonical Lock Ordering by ID, and Deadlock Retry
* **Context**: Cần chống Lost Update khi nhiều request rút/chuyển tiền cùng lúc và chống Deadlock (`40P01`) khi chuyển khoản hai chiều A↔B.
* **Decision**: Dùng Pessimistic Locking (`.setLock('pessimistic_write', undefined, ['account'])`) kèm `SET LOCAL lock_timeout = '5s'`, khóa các tài khoản theo thứ tự cố định `ORDER BY account.id ASC`, và bọc vòng lặp `executeWithDeadlockRetry` (tối đa 3 lần retry khi gặp `40P01`) quanh Pha B.
* **Reason**: Benchmark Bài 1.3 & 1.4 chứng minh Pessimistic Locking đạt `100/100` request thành công ở kịch bản tranh chấp cao S2 (~275 req/s, `0` lỗi `503`), và `ORDER BY account.id ASC` giảm số lần deadlock khi chuyển khoản chéo A↔B về `0`.
* **Trade-offs**: Các request chạm vào cùng một tài khoản phải xếp hàng tuần tự trong giới hạn `lock_timeout = '5s'`.

## ADR-010: Why Append-Only Double-Entry Ledger, Database Immutability Trigger, `BIGSERIAL` Primary Key, and Cached Account Balance
* **Context**: Cần lưu vết biến động số dư (`balance_after`) không thể sửa/xóa và đảm bảo số dư hiển thị luôn khớp với lịch sử kế toán.
* **Decision**: Tạo bảng `ledger_entries` với khóa chính `id` kiểu `BIGSERIAL` (`@PrimaryGeneratedColumn({ type: 'bigint' })`), lấy `balance_after` trực tiếp từ `UPDATE ... RETURNING balance`, chặn `UPDATE`/`DELETE` bằng Trigger `trg_ledger_entries_immutable`, và giữ `accounts.balance` làm bản sao đọc nhanh (cached balance) đối chiếu với nguồn sự thật là tổng `ledger_entries`.
* **Reason**: `id` tự tăng kết hợp khóa `FOR UPDATE` đảm bảo thứ tự ghi sổ khớp tuyệt đối với trình tự biến động số dư; Trigger bảo vệ dữ liệu ngay cả trước các câu lệnh SQL trực tiếp.
* **Trade-offs**: Superuser vẫn có thể tắt trigger và `TRUNCATE` mức bảng không kích hoạt trigger mức dòng (được dùng để dọn DB test); production nên kết hợp thêm `REVOKE UPDATE, DELETE, TRUNCATE`.

## ADR-011: Why Transaction State Machine, 3-Phase Execution, Recording `FAILED` with Failure Codes, and Stuck Transaction Sweeping
* **Context**:
  1. Khi giao dịch thất bại ở bước kiểm tra số dư (`422`) hoặc hết thời gian chờ khóa (`503`), hệ thống cần lưu lại bản ghi `FAILED` kèm mã lý do để tra cứu và kiểm toán, nhưng tuyệt đối không được làm thay đổi tiền hay sổ cái.
  2. Nếu ứng dụng bị sập nguồn đột ngột giữa lúc đang xử lý giao dịch, cần cơ chế phát hiện và đóng dấu các giao dịch bị "treo" (`PROCESSING` quá lâu).
* **Decision**:
  1. **Máy trạng thái hữu hạn (`ALLOWED_STATUS_TRANSITIONS` & `transition()`):** Định nghĩa 6 trạng thái viết HOA (`INITIATED`, `PENDING_OTP`, `PROCESSING`, `COMPLETED`, `FAILED`, `REVERSED`) và chỉ cho phép đổi trạng thái qua hàm `transition()` duy nhất bằng câu lệnh nguyên tử có điều kiện `UPDATE transactions SET status = :to, updated_at = now() WHERE id = :id AND status = :from`.
  2. **Tách Luồng 3 Pha (Pha A → Pha B → Pha C):** Pha A tạo phiếu `INITIATED → PROCESSING` (cùng dòng khóa `IN_PROGRESS`) và `COMMIT` trước; Pha B khóa tài khoản, cập nhật số dư, ghi sổ cái và đóng dấu `PROCESSING → COMPLETED` trong cùng một transaction; nếu Pha B lỗi và rollback, Pha C mở transaction mới đóng dấu `PROCESSING → FAILED` kèm `failure_code` chuẩn hóa từ `FAILURE_CODE_MAP`.
  3. **Quét giao dịch treo định kỳ (`sweepStuckTransactions` với `@nestjs/schedule`):** Cron job chạy mỗi phút tìm các giao dịch `PROCESSING` có `updated_at` cũ hơn `STUCK_AFTER_SECONDS = 120s`. Nếu giao dịch chưa có bút toán nào trong `ledger_entries`, đóng dấu `PROCESSING → FAILED` (`failure_code = TIMEOUT`) và đóng luôn dòng khóa `idempotency_keys` tương ứng sang `FAILED` (`503`); nếu phát hiện đã có bút toán (dị thường trái thiết kế), ghi log `ERROR` và giữ nguyên để kiểm tra thủ công.
* **Reason**:
  * Commit Pha A trước giúp mọi giao dịch bước vào giai đoạn xử lý tiền đều có định danh và dấu vết rõ ràng trong DB.
  * Việc đóng dấu `PROCESSING → COMPLETED` nằm chung transaction với bước trừ/cộng tiền và ghi sổ cái ở Pha B đảm bảo **một phiếu đang ở `PROCESSING` chắc chắn chưa từng làm thay đổi tiền hay sổ cái**, do đó job quét giao dịch treo có thể đóng dấu `FAILED/TIMEOUT` an toàn mà không cần thực hiện hoàn tiền.
* **Trade-offs**:
  * Các lỗi yêu cầu đầu vào không hợp lệ trước khi lập phiếu (`400 DTO sai`, `404 tài khoản đích không tồn tại`, `400 tự chuyển cho chính mình`) được từ chối và rollback ngay ở Pha A nên không lưu vào DB.

## ADR-012: Why Reversal Transactions with Inverse Ledger Entries, 3-Layer Double-Reversal Prevention, and Uppercase Enum Migration
* **Context**:
  1. Khi cần hủy hoặc hoàn tiền một giao dịch đã `COMPLETED`, hệ thống tài chính không được phép `UPDATE` số tiền hay `DELETE` giao dịch/bút toán cũ.
  2. Cần ngăn chặn tuyệt đối việc một giao dịch gốc bị hoàn tiền hai lần (kể cả khi nhiều Admin bấm hoàn tiền đồng thời), nhưng vẫn phải cho phép thử lại nếu lần hoàn tiền trước thất bại do bên nhận tạm thời thiếu số dư.
* **Decision**:
  1. **Hoàn tiền bằng giao dịch `REVERSAL` mới và đảo từng bút toán gốc (`DEBIT ↔ CREDIT`):** Endpoint `POST /api/transactions/:id/reverse` (bảo vệ bởi `RolesGuard` kiểm tra `user.role === 'admin'` từ DB) tạo một giao dịch mới có `type = 'REVERSAL'`, `original_transaction_id = gốc`, đảo chiều `from_account_id ↔ to_account_id`, và đảo ngược từng dòng `ledger_entries` của giao dịch gốc. Trong cùng transaction Pha B, đóng dấu `REVERSAL: PROCESSING → COMPLETED` và đóng dấu giao dịch gốc `COMPLETED → REVERSED`.
  2. **Ba lớp chống hoàn tiền hai lần:** (1) Kiểm tra trạng thái gốc phải là `COMPLETED` ở Pha A; (2) Partial Unique Index `IDX_transactions_active_reversal_original` (`WHERE type = 'REVERSAL' AND status IN ('INITIATED', 'PENDING_OTP', 'PROCESSING', 'COMPLETED')` — loại trừ `FAILED` để cho phép thử lại); (3) Đóng dấu có điều kiện `transition(originalTx.id, COMPLETED, REVERSED)` ở Pha B.
  3. **Đồng bộ Enum chữ HOA qua Migration (`1710000003000`):** Đổi toàn bộ giá trị `TransactionType` và `TransactionStatus` sang chữ HOA bằng kỹ thuật tạo kiểu enum mới + `ALTER COLUMN ... TYPE ... USING (CASE ...)`.
* **Reason**: Giữ nguyên tính bất biến của bảng `ledger_entries` và thỏa mãn các bất biến Q4 (tổng ròng gốc + hoàn tiền = 0), Q5 (nhất quán 1-1 giữa `REVERSED` và `REVERSAL COMPLETED`).
* **Trade-offs**: Việc đổi enum sang chữ HOA đòi hỏi cập nhật đồng bộ từ Migration, Entity, Service, Seed, Frontend đến E2E Tests.

## ADR-013: Why `idempotency_keys` with SHA-256 Request Hash, Response Snapshot, 24h Per-User TTL, `ON CONFLICT DO NOTHING`, and Frontend Auto-Retry
* **Context**:
  1. Cần nhận diện chính xác khi client gửi lại cùng một `Idempotency-Key` nhưng thay đổi nội dung yêu cầu (số tiền, tài khoản đích, hoặc gửi sang loại giao dịch khác).
  2. Cần đảm bảo kết quả trả về khi phát lại (Replay) đúng bằng biên nhận tại thời điểm yêu cầu đó hoàn tất, không bị biến dạng nếu về sau giao dịch bị hoàn tiền (`REVERSAL`).
  3. Cần giới hạn thời gian lưu trữ khóa (TTL) và trang bị cơ chế tự động thử lại (Auto-Retry) an toàn ở phía Frontend khi mất mạng hoặc timeout.
* **Decision**:
  1. **Bảng `idempotency_keys` phạm vi theo người dùng (`UNIQUE (user_id, idempotency_key)`):** Lưu `request_hash` (`char(64)` SHA-256 của dữ liệu yêu cầu đã chuẩn hóa số tiền thành 2 chữ số thập phân bằng xử lý chuỗi, mô tả đã sanitize và thứ tự trường cố định có kèm `operation`), `status` (`IN_PROGRESS`, `COMPLETED`, `FAILED`), `response_status`, `response_body` (`jsonb`), `transaction_id`, và `expired_at` (`created_at + 24 giờ`).
  2. **Chiếm khóa nguyên tử bằng `INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`:** Thực hiện ngay trong Pha A sau khi đã xóa khóa cũ hết hạn (`expired_at <= NOW() AND status <> 'IN_PROGRESS'`). Nếu chèn được (`RETURNING` có dòng), tạo phiếu giao dịch và gắn `transaction_id` trong cùng transaction Pha A. Nếu không chèn được, đọc dòng khóa hiện có ngay mà không làm hỏng (abort) transaction PostgreSQL: so khớp `request_hash` (nếu lệch ném `409 Conflict`), nếu khớp thì phát lại từ bản chụp `response_body` (`200 OK` cho `COMPLETED`, lỗi cũ cho `FAILED`, hoặc `202 Accepted` cho `IN_PROGRESS`).
  3. **Đồng bộ với Job quét treo & Dọn dẹp định kỳ:** `sweepStuckTransactions()` đóng luôn dòng khóa `IN_PROGRESS` của giao dịch treo sang `FAILED (503)` trong cùng một transaction; Cron job `@Cron(CronExpression.EVERY_HOUR)` gọi `deleteExpiredKeys()` xóa các dòng `expired_at < NOW() AND status <> 'IN_PROGRESS'`.
  4. **Frontend Auto-Retry & In-Flight Guard (`submitIdempotentTransaction` + `useRef`):** Đặt `timeout = 10s`, chỉ tự động thử lại tối đa `3 lần` (`1s → 2s → 4s`) với **cùng `Idempotency-Key`** khi không nhận được phản hồi (mất mạng/timeout) hoặc nhận `202 Accepted`; dừng ngay khi nhận phản hồi cuối cùng (`201`/`200` hoặc `4xx`/`5xx`). Nếu hết 3 lần thử vẫn chưa rõ kết quả, hiển thị trạng thái `"chưa xác định"` (`indeterminate`) và giữ nguyên key. Dùng `useRef(false)` (`inFlightRef`) chặn bấm đúp trong cùng một tích tắc trước khi React kịp re-render nút `disabled`.
* **Reason**:
  * Chuẩn hóa số tiền bằng chuỗi (`"50000"` → `"50000.00"`) trước khi băm SHA-256 tránh sai số dấu phẩy động và tránh báo `409` giả.
  * Lưu bản chụp `response_body` trong cùng transaction Pha B với việc chuyển tiền đảm bảo tính bất biến của biên nhận phát lại (được kiểm chứng bởi bài test `I9`).
  * Phạm vi `user_id` ngăn chặn rò rỉ dữ liệu giao dịch giữa các người dùng khác nhau khi tình cờ trùng UUID (bài test `I8`).
* **Trade-offs**:
  * Khi chạy migration nâng cấp xóa cột `transactions.idempotency_key`, các khóa cũ trước thời điểm nâng cấp không được backfill (vì không có `request_hash` và `response_body` gốc, đồng thời khóa vốn chỉ có hạn dùng 24 giờ).