# Architecture Decision Records (ADR)

## ADR-001: Why NestJS + PostgreSQL + TypeORM
* **Context**: Cần chọn stack backend cho ứng dụng ngân hàng đáp ứng yêu cầu kiến trúc phân tầng rõ ràng và đảm bảo tính toàn vẹn dữ liệu giao dịch.
* **Decision**: Sử dụng NestJS (TypeScript) làm backend framework, TypeORM làm ORM và PostgreSQL làm hệ quản trị cơ sở dữ liệu.
* **Reason**: NestJS cung cấp sẵn kiến trúc module hóa (`Controller -> Service -> Repository`) và tích hợp sẵn `ValidationPipe`, Guard, Swagger. TypeORM hỗ trợ tốt quản lý Database Transaction (`QueryRunner`) và Migration. PostgreSQL tuân thủ chuẩn ACID và hỗ trợ tốt kiểu số thập phân chính xác (`numeric`).
* **Trade-offs**: Cấu hình khởi đầu của NestJS và TypeORM Migration nhiều bước hơn so với ExpressJS thuần, nhưng giúp mã nguồn nhất quán và dễ mở rộng.

## ADR-002: Why numeric(18,2)
* **Context**: Cần chọn kiểu dữ liệu lưu trữ và tính toán số tiền (`balance`, `amount`) cho tiền tệ VND.
* **Decision**: Sử dụng `numeric(18,2)` trong PostgreSQL, truyền và trả dữ liệu qua JSON dưới dạng `string` (ví dụ `"50000.00"`), so sánh ở ứng dụng bằng số nguyên `BigInt` (đơn vị xu) và thực hiện cộng/trừ trực tiếp bằng biểu thức SQL trong PostgreSQL.
* **Reason**: Kiểu `float` hoặc `double` (IEEE 754) bị sai số làm tròn dấu phẩy động, không được phép dùng trong ứng dụng tài chính. `numeric(18,2)` lưu trữ chính xác tuyệt đối tới từng xu và chịu được giá trị lên tới hàng triệu tỷ đồng.
* **Trade-offs**: TypeORM ánh xạ cột `numeric` thành `string` trong TypeScript nên cần validate định dạng bằng regex `^\d{1,16}(\.\d{1,2})?$` ở DTO và bắt lỗi tràn số (`22003`) ở tầng database.

## ADR-003: Why 3-Phase Transaction Flow + Pessimistic Lock + Atomic Conditional Update + In-Transaction Ledger Posting
* **Context**: Các thao tác biến động số dư (`TRANSFER`, `DEPOSIT`, `WITHDRAW`, `REVERSAL`) cần vừa lưu lại dấu vết phiếu giao dịch khi thất bại (`FAILED`), vừa đảm bảo tuyệt đối không để lại dữ liệu tiền hay bút toán dở dang khi lỗi giữa chừng hoặc khi có nhiều request chạy đồng thời.
* **Decision**: Thực hiện giao dịch theo **Luồng 3 Pha** kết hợp bảo vệ đa lớp:
  1. **Pha A (Khởi tạo phiếu — Transaction ngắn 1):** Kiểm tra đầu vào và Idempotency, tạo bản ghi giao dịch ở trạng thái `INITIATED`, chuyển sang `PROCESSING` bằng `transition()` và `COMMIT` ngay.
  2. **Pha B (Xử lý tiền & Sổ cái — Transaction chính 2):**
     * Khóa các dòng tài khoản liên quan bằng `SELECT ... FOR UPDATE OF "account"` theo `ORDER BY account.id ASC`.
     * Trừ/cộng tiền bằng câu lệnh nguyên tử có điều kiện (`UPDATE accounts SET balance = balance ∓ :amount WHERE id = :id [AND balance >= :amount] RETURNING balance`) để lấy ngay `balance_after`.
     * Ghi các bút toán vào `ledger_entries` và đóng dấu `PROCESSING → COMPLETED` (kèm `COMPLETED → REVERSED` cho giao dịch gốc nếu là hoàn tiền) trong **cùng một Database Transaction** trước khi `COMMIT`.
  3. **Pha C (Ghi nhận thất bại — Transaction ngắn 3):** Nếu Pha B gặp lỗi và đã `ROLLBACK` hoàn toàn (số dư và sổ cái không đổi), mở transaction mới đóng dấu `PROCESSING → FAILED` kèm `failure_code` rồi `COMMIT`.
* **Reason**: Đảm bảo cả hai mục tiêu: (1) Mọi biến động số dư, bút toán sổ cái và con dấu `COMPLETED` luôn thành công hoặc hủy bỏ cùng nhau 100%; (2) Các giao dịch thất bại ở bước kiểm tra nghiệp vụ vẫn được lưu lại lịch sử `FAILED` kèm mã lý do rõ ràng.
* **Trade-offs**: Mỗi giao dịch đi qua 2 transaction ngắn (Pha A và Pha B, hoặc Pha A và Pha C), đổi lại trạng thái vòng đời giao dịch luôn tường minh và không bao giờ lệch tiền.

## ADR-004: Why Status-Aware Idempotency
* **Context**: Khi mạng chậm hoặc timeout, người dùng hoặc trình duyệt có thể gửi lặp lại cùng một yêu cầu giao dịch, dẫn đến nguy cơ trừ/cộng tiền hai lần.
* **Decision**: Bắt buộc client gửi header `Idempotency-Key` (UUID) cho mọi API tạo giao dịch (`transfer`, `deposit`, `withdraw`, `reverse`). Khi gửi lại cùng key (cùng `actor_account_id`):
  * Khác payload (hoặc khác loại giao dịch): trả `409 Conflict`.
  * Giao dịch đang ở `COMPLETED` hoặc `REVERSED`: trả `200 OK` kèm kết quả cũ.
  * Giao dịch đang ở `INITIATED`, `PENDING_OTP`, `PROCESSING`: trả `202 Accepted` kèm trạng thái hiện tại.
  * Giao dịch đã ở `FAILED`: trả lại đúng HTTP status và message lỗi cũ từ `FAILURE_CODE_MAP` mà không chạy lại.
* **Reason**: Phản ánh chính xác trạng thái của giao dịch trong State Machine mà không cần hệ thống cache ngoài.
* **Trade-offs**: Frontend cần phân biệt phản hồi chưa kết thúc (`202` hoặc lỗi mạng → giữ nguyên key) với phản hồi đã kết thúc (`201/200` hoặc `4xx/5xx` → sinh key mới).

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
* **Context**: Khi mở rộng sang các bài tập nâng cao (thêm `CHECK` constraint, đổi tên/thêm giá trị enum, thêm bảng sổ cái kép kèm backfill, trigger và partial unique index), `synchronize: true` không thể kiểm soát thứ tự chuyển đổi dữ liệu.
* **Decision**: Tắt hoàn toàn `synchronize: true` (`synchronize: false` trong `data-source.ts`) và quản lý mọi thay đổi schema qua TypeORM Migrations.
* **Reason**: Mọi thay đổi cấu trúc DB đều tường minh, có phiên bản trên Git, hỗ trợ rollback (`down`) và ánh xạ dữ liệu cũ an toàn.
* **Trade-offs**: Mỗi khi sửa Entity phải tạo và chạy file migration tương ứng.

## ADR-008: Why Single-Sided Cash Transactions & `actor_account_id` Idempotency Scope
* **Context**: Cần quyết định cách lưu `from_account_id` / `to_account_id` cho `DEPOSIT`, `WITHDRAW` và phạm vi Unique constraint cho `idempotency_key`.
* **Decision**: Chọn **mô hình giao dịch một phía** (`DEPOSIT`: `from = NULL, to = NOT NULL`; `WITHDRAW`: `from = NOT NULL, to = NULL`) kèm `CHECK` constraint `CHK_transactions_type_accounts`, và đặt Unique constraint trên `(idempotency_key, actor_account_id)`.
* **Reason**: Không cần tạo tài khoản hệ thống ảo bị âm quỹ, đồng thời bảo vệ cả `TRANSFER`, `DEPOSIT`, `WITHDRAW`, `REVERSAL` dưới cùng một cơ chế khóa Idempotency.
* **Trade-offs**: Bảng `transactions` có thêm cột `actor_account_id`, đổi lại kiểm tra Idempotency đồng nhất.

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
  1. Ở các phiên bản trước, khi giao dịch thất bại (ví dụ không đủ số dư `422` hoặc hết thời gian chờ khóa `503`), toàn bộ transaction bị rollback nên không để lại bản ghi nào trong bảng `transactions` để tra cứu hay đối soát lỗi.
  2. Nếu ứng dụng bị sập nguồn đột ngột giữa lúc đang xử lý giao dịch, cần cơ chế phát hiện và xử lý các giao dịch bị "treo" (`PROCESSING` quá lâu).
* **Decision**:
  1. **Máy trạng thái hữu hạn (`ALLOWED_STATUS_TRANSITIONS` & `transition()`):** Định nghĩa 6 trạng thái viết HOA (`INITIATED`, `PENDING_OTP`, `PROCESSING`, `COMPLETED`, `FAILED`, `REVERSED`) và chỉ cho phép đổi trạng thái qua hàm `transition()` duy nhất bằng câu lệnh nguyên tử có điều kiện `UPDATE transactions SET status = :to, updated_at = now() WHERE id = :id AND status = :from`.
  2. **Tách Luồng 3 Pha (Pha A → Pha B → Pha C):** Pha A tạo phiếu `INITIATED → PROCESSING` và `COMMIT` trước; Pha B khóa tài khoản, cập nhật số dư, ghi sổ cái và đóng dấu `PROCESSING → COMPLETED` trong cùng một transaction; nếu Pha B lỗi và rollback, Pha C mở transaction mới đóng dấu `PROCESSING → FAILED` kèm `failure_code` chuẩn hóa từ `FAILURE_CODE_MAP`.
  3. **Quét giao dịch treo định kỳ (`sweepStuckTransactions` với `@nestjs/schedule`):** Cron job chạy mỗi phút tìm các giao dịch `PROCESSING` có `updated_at` cũ hơn `STUCK_AFTER_SECONDS = 120s` (nhờ Partial Index `IDX_transactions_processing_updated_at`). Nếu giao dịch chưa có bút toán nào trong `ledger_entries`, đóng dấu `PROCESSING → FAILED` (`failure_code = TIMEOUT`); nếu phát hiện đã có bút toán (dị thường trái thiết kế), ghi log `ERROR` và giữ nguyên để kiểm tra thủ công.
* **Reason**:
  * Commit Pha A trước giúp mọi giao dịch bước vào giai đoạn xử lý tiền đều có định danh và dấu vết rõ ràng trong DB.
  * Việc đóng dấu `PROCESSING → COMPLETED` nằm chung transaction với bước trừ/cộng tiền và ghi sổ cái ở Pha B đảm bảo **một phiếu đang ở `PROCESSING` chắc chắn chưa từng làm thay đổi tiền hay sổ cái**, do đó job quét giao dịch treo có thể đóng dấu `FAILED/TIMEOUT` an toàn mà không cần thực hiện hoàn tiền.
  * Dùng câu lệnh `UPDATE ... WHERE id = :id AND status = :from` ngăn chặn tuyệt đối race condition giữa Pha B và job quét (hoặc giữa hai yêu cầu đồng thời).
* **Trade-offs**:
  * Thêm 1 dependency duy nhất là `@nestjs/schedule` (sẽ được tái sử dụng cho job đối soát ở Module 6.1). Trong môi trường test (`NODE_ENV === 'test'`), lịch tự chạy được tắt để test gọi trực tiếp `sweepStuckTransactions()` một cách tất định.
  * Các lỗi yêu cầu đầu vào không hợp lệ trước khi lập phiếu (`400 DTO sai`, `404 tài khoản đích không tồn tại`, `400 tự chuyển cho chính mình`) được từ chối ngay trước Pha A nên không lưu vào DB.

## ADR-012: Why Reversal Transactions with Inverse Ledger Entries, 3-Layer Double-Reversal Prevention, and Uppercase Enum Migration
* **Context**:
  1. Khi cần hủy hoặc hoàn tiền một giao dịch đã `COMPLETED`, hệ thống tài chính không được phép `UPDATE` số tiền hay `DELETE` giao dịch/bút toán cũ.
  2. Cần ngăn chặn tuyệt đối việc một giao dịch gốc bị hoàn tiền hai lần (kể cả khi nhiều Admin bấm hoàn tiền đồng thời), nhưng vẫn phải cho phép thử lại nếu lần hoàn tiền trước thất bại do bên nhận tạm thời thiếu số dư.
* **Decision**:
  1. **Hoàn tiền bằng giao dịch `REVERSAL` mới và đảo từng bút toán gốc (`DEBIT ↔ CREDIT`):** Endpoint `POST /api/transactions/:id/reverse` (bảo vệ bởi `RolesGuard` tối thiểu kiểm tra `user.role === 'admin'` từ DB) tạo một giao dịch mới có `type = 'REVERSAL'`, `original_transaction_id = gốc`, đảo chiều `from_account_id ↔ to_account_id`, và đảo ngược từng dòng `ledger_entries` của giao dịch gốc (`CREDIT` gốc thành `DEBIT` trừ tiền, `DEBIT` gốc thành `CREDIT` cộng tiền). Trong cùng transaction Pha B, đóng dấu `REVERSAL: PROCESSING → COMPLETED` và đóng dấu giao dịch gốc `COMPLETED → REVERSED`.
  2. **Ba lớp chống hoàn tiền hai lần:**
     * *Lớp 1 (Kiểm tra ở Pha A):* Chỉ cho phép hoàn tiền khi giao dịch gốc có `status = 'COMPLETED'` và `type <> 'REVERSAL'`.
     * *Lớp 2 (Partial Unique Index ở PostgreSQL):* Ràng buộc `IDX_transactions_active_reversal_original` (`UNIQUE (original_transaction_id) WHERE type = 'REVERSAL' AND status IN ('INITIATED', 'PENDING_OTP', 'PROCESSING', 'COMPLETED')`) chặn ngay từ Pha A mọi yêu cầu hoàn tiền trùng lặp, nhưng **loại trừ `FAILED`** để nếu hoàn tiền thất bại vì thiếu số dư (`422 REVERSAL_INSUFFICIENT_BALANCE`) thì Admin vẫn có thể thử lại sau.
     * *Lớp 3 (Đóng dấu có điều kiện ở Pha B):* `transition(originalTx.id, COMPLETED, REVERSED)` kiểm tra `WHERE id = :origId AND status = 'COMPLETED'` ngay trước khi commit Pha B.
  3. **Đồng bộ Enum chữ HOA qua Migration (`1710000003000`):** Đổi toàn bộ giá trị `TransactionType` và `TransactionStatus` sang chữ HOA bằng kỹ thuật tạo kiểu enum mới + `ALTER COLUMN ... TYPE ... USING (CASE ...)` trong một migration duy nhất có hỗ trợ `down()`.
* **Reason**:
  * Đảo từng bút toán của giao dịch gốc giúp cùng một thuật toán hoàn tiền chạy đúng cho cả `TRANSFER` (2 bút toán đảo), `DEPOSIT` (1 bút toán `DEBIT`) và `WITHDRAW` (1 bút toán `CREDIT`), giữ nguyên tính bất biến của bảng `ledger_entries` và thỏa mãn các bất biến Q4 (tổng ròng gốc + hoàn tiền = 0), Q5 (nhất quán 1-1 giữa `REVERSED` và `REVERSAL COMPLETED`).
  * Ba lớp bảo vệ đảm bảo ngay cả khi 5 Admin gửi 5 request hoàn tiền đồng thời với 5 `Idempotency-Key` khác nhau (Test `V2`), chỉ có đúng 1 request thành công (`201`) và 4 request nhận `409 Conflict`.
* **Trade-offs**:
  * Việc đổi enum sang chữ HOA là thay đổi phá vỡ (breaking change) đối với API contract cũ, đòi hỏi cập nhật đồng bộ từ Migration, Entity, Service, Seed, Frontend đến E2E Tests trong cùng một đợt phát hành.