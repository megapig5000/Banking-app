# Cẩm nang Hỏi – Đáp Bảo vệ Đồ án Tổng hợp (Defense Q&A — 40 Câu hỏi)

Tài liệu này tổng hợp **30 câu hỏi bảo vệ cốt lõi** (chia theo 5 chủ đề kỹ thuật) và **10 câu hỏi "Tình huống khó" (What-if Scenarios)** kèm câu trả lời ngắn gọn, chính xác, có ví dụ số cụ thể và bám sát mã nguồn thực tế của dự án **Simple Banking App**.

---

## Phần I — 30 Câu hỏi Bảo vệ theo 5 Chủ đề Kỹ thuật

### Chủ đề 1: Toàn vẹn Dữ liệu, Sổ cái kép (`ledger_entries`) & Hoàn tiền (`REVERSAL`)

**Câu 1: Tại sao dự án dùng kiểu `numeric(18,2)` và chuỗi `string` / `BigInt` cho số tiền thay vì dùng `number` (float) của JavaScript?**
- **Trả lời:** Số thực dấu chấm động IEEE 754 (`number`) trong JavaScript bị sai số biểu diễn nhị phân (ví dụ `0.1 + 0.2 = 0.30000000000000004`). Trong dự án, mọi cột tiền tệ (`accounts.balance`, `accounts.hold_amount`, `transactions.amount`, `ledger_entries.amount`, `ledger_entries.balance_after`) đều lưu kiểu `numeric(18,2)` trong PostgreSQL; truyền qua API dạng `string`; khi so sánh số dư hay hạn mức ở tầng Service (`date.util.ts`), hàm `parseDecimalToCents()` quy đổi chuỗi thập phân ra đơn vị xu kiểu `BigInt` (ví dụ `"30000000.01"` → `3000000001n`), còn khi cộng/trừ số dư trong DB thì dùng biểu thức SQL `balance = balance - :amount RETURNING balance`. Nhờ vậy sai số làm tròn bằng `0` tuyệt đối.

**Câu 2: Sổ cái kép (Double-entry Ledger) là gì? Khi A chuyển `100.000đ` cho B thì bảng `ledger_entries` ghi những gì?**
- **Trả lời:** Sổ cái kép là mô hình kế toán trong đó mọi biến động số dư đều được ghi lại thành các bút toán bất biến thay vì chỉ sửa đè con số cuối cùng. Khi A (có `5.000.000đ`) chuyển `100.000đ` cho B (có `2.000.000đ`), trong cùng một Database Transaction ở Pha B, hàm `insertLedgerEntries()` chèn **2 dòng** vào `ledger_entries`:
  1. Dòng 1 cho A: `type = 'DEBIT'`, `amount = '100000.00'`, `balance_after = '4900000.00'`.
  2. Dòng 2 cho B: `type = 'CREDIT'`, `amount = '100000.00'`, `balance_after = '2100000.00'`.
  Tổng `DEBIT` luôn bằng tổng `CREDIT` (`100.000đ`).

**Câu 3: Giá trị `balance_after` trong `ledger_entries` được lấy từ đâu? Vì sao không tự tính bằng phép trừ trong code NodeJS?**
- **Trả lời:** `balance_after` được lấy trực tiếp từ kết quả trả về của câu lệnh SQL nguyên tử `UPDATE accounts SET balance = balance - :amount WHERE ... RETURNING balance` (trong `debitAccount()` và `creditAccount()`). Không tự tính bằng JS vì trong môi trường đồng thời hoặc khi biểu thức SQL thực thi tại PostgreSQL, giá trị từ `RETURNING balance` mới là số dư chính xác tuyệt đối của dòng tài khoản ngay tại thời điểm câu lệnh `UPDATE` hoàn tất.

**Câu 4: Giữa cột `accounts.balance` và bảng `ledger_entries`, cái nào là "nguồn sự thật" (Source of Truth)? Làm sao kiểm chứng hai bên luôn khớp nhau?**
- **Trả lời:** Bảng `ledger_entries` là **nguồn sự thật (Source of Truth)**, còn `accounts.balance` là **bản sao đọc nhanh (Cached Balance)** được cập nhật trong cùng một Database Transaction với các bút toán sổ cái. Ta kiểm chứng hai bên khớp nhau tuyệt đối bằng truy vấn bất biến **Q2** (`SUM(CASE WHEN type='CREDIT' THEN amount ELSE -amount END) = accounts.balance`) và **Q3** (số dư cộng dồn theo `ORDER BY id` khớp `balance_after` từng dòng) trong `assertLedgerInvariants()`.

**Câu 5: Làm thế nào hệ thống ngăn chặn việc sửa hoặc xóa bút toán trong `ledger_entries` (kể cả khi ai đó chạy lệnh SQL trực tiếp)?**
- **Trả lời:** Hệ thống bảo vệ bằng **2 lớp**:
  1. *Tầng ứng dụng:* Chỉ có hàm `insertLedgerEntries()`, không viết bất kỳ hàm `update`/`delete` nào và không export repository của `LedgerEntry`.
  2. *Tầng Database (Migration `1710000002000`):* Gắn Trigger `trg_ledger_entries_immutable` (`BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW`) gọi hàm `prevent_ledger_entries_modification()` ném lỗi `ledger_entries is append-only` ngay tại PostgreSQL (đã kiểm chứng ở Test `L1`).

**Câu 6: Vì sao khi hoàn tiền (`POST /api/transactions/:id/reverse`), hệ thống không xóa giao dịch cũ mà lại tạo giao dịch `REVERSAL` mới? Ba lớp chống hoàn tiền 2 lần là gì?**
- **Trả lời:** Trong nghiệp vụ ngân hàng, lịch sử giao dịch và sổ cái là chỉ-ghi-thêm (không tẩy xóa). Khi hoàn tiền giao dịch A chuyển `100.000đ` cho B, hệ thống tạo một giao dịch mới có `type = 'REVERSAL'`, `original_transaction_id` trỏ về giao dịch gốc, sinh 2 bút toán đảo ngược (`DEBIT` B `100.000đ`, `CREDIT` A `100.000đ`), và đóng dấu giao dịch gốc từ `COMPLETED` sang `REVERSED`.
  **Ba lớp chống hoàn tiền 2 lần:**
  1. Kiểm tra `originalTx.status === 'COMPLETED'` ở Pha A.
  2. Partial Unique Index `IDX_transactions_active_reversal_original` trên `(original_transaction_id)` với điều kiện `type = 'REVERSAL' AND status IN ('INITIATED', 'PENDING_OTP', 'PROCESSING', 'COMPLETED')` (loại trừ `FAILED` để nếu hoàn tiền thất bại do B thiếu tiền thì sau này thử lại được).
  3. Câu lệnh đóng dấu có điều kiện `transition(originalTx.id, COMPLETED -> REVERSED)` (`WHERE id = :id AND status = 'COMPLETED'`) ở cuối Pha B.

---

### Chủ đề 2: Xử lý Đồng thời (Concurrency), Khóa dòng (`FOR UPDATE`) & Chống Deadlock

**Câu 7: Race Condition (Lost Update) là gì? Vì sao chỉ bọc trong một Database Transaction mặc định vẫn bị Race Condition khi rút tiền?**
- **Trả lời:** Nếu 2 request cùng đọc số dư `1.000.000đ` bằng `SELECT` thường, mỗi request trừ `100.000đ` trong bộ nhớ rồi ghi đè `UPDATE accounts SET balance = 900000`, thì 1 lần rút bị mất (số dư còn `900.000đ` thay vì `800.000đ` — đã tái hiện ở Báo cáo 1.1). Mức cô lập mặc định của PostgreSQL là `READ COMMITTED` không ngăn 2 transaction cùng đọc một dòng dữ liệu cũ tại cùng một thời điểm nếu không có khóa dòng (`FOR UPDATE`) hoặc điều kiện nguyên tử.

**Câu 8: `SELECT ... FOR UPDATE` hoạt động như thế nào trong `TransactionsService`? Tại sao bạn vẫn giữ điều kiện `WHERE (balance - hold_amount) >= :amount` trong câu `UPDATE` dù đã khóa dòng?**
- **Trả lời:** Trong `loadAccountsForTransaction()`, câu lệnh `SELECT ... FOR UPDATE OF "account"` khóa độc quyền các dòng tài khoản liên quan ngay khi bắt đầu Pha B. Các request khác chạm vào cùng tài khoản đó phải xếp hàng chờ cho tới khi transaction hiện tại `COMMIT` hoặc `ROLLBACK`. Mình vẫn giữ điều kiện `WHERE (balance - hold_amount) >= :amount` trong câu `UPDATE` (và `CHECK` constraint ở DB) theo nguyên tắc **"thắt dây an toàn kép" (Defense in Depth)**: khóa dòng bảo vệ thứ tự thực thi, còn điều kiện `WHERE` nguyên tử đảm bảo ngay tại khoảnh khắc ghi xuống đĩa, số dư khả dụng không bao giờ âm.

**Câu 9: Pessimistic Locking và Optimistic Locking (`version`) khác nhau ở đâu? Vì sao dự án chọn giữ Pessimistic Locking cho luồng chính?**
- **Trả lời:** Pessimistic Locking khóa dòng trước khi sửa (các request xếp hàng tuần tự), còn Optimistic Locking không khóa khi đọc mà kiểm tra `WHERE version = :readVersion` lúc ghi (nếu lệch `version` thì rollback và retry). Trong thực nghiệm Benchmark ở Báo cáo 1.3 (Kịch bản S2: 100 request đồng thời rút tiền trên 1 tài khoản), **Pessimistic Locking đạt 100/100 thành công trong ~242ms (0 lỗi 503)**, trong khi **Optimistic Locking chỉ thành công 28/100 và thất bại 503 tới 72 request** do bão xung đột `version` (retry storm). Vì tài khoản ngân hàng thường xuyên có nhiều giao dịch dồn vào cùng một tài khoản, Pessimistic Locking ổn định và hiệu quả hơn hẳn.

**Câu 10: Deadlock là gì? Làm thế nào `loadAccountsForTransaction()` phòng ngừa được Deadlock khi A chuyển cho B cùng lúc B chuyển cho A?**
- **Trả lời:** Deadlock xảy ra khi Transaction 1 khóa tài khoản A rồi chờ khóa tài khoản B, cùng lúc Transaction 2 khóa tài khoản B rồi chờ khóa tài khoản A — cả hai chờ nhau vô tận (PostgreSQL cắt bằng lỗi `40P01`). Trong `loadAccountsForTransaction()`, hệ thống tải và khóa cả tài khoản nguồn lẫn đích trong **một câu truy vấn duy nhất có `ORDER BY account.id ASC`**. Nhờ vậy, dù là A chuyển cho B hay B chuyển cho A, cả hai transaction đều luôn yêu cầu khóa tài khoản có `id` nhỏ hơn trước rồi mới đến `id` lớn hơn — phá vỡ hoàn toàn vòng chờ đợi tuần hoàn (0 deadlock qua 5 vòng × 50 cặp ở Báo cáo 1.4). Ngoài ra, Pha B còn được bọc bởi `executeWithDeadlockRetry` (tối đa 3 lần) làm lưới an toàn thứ hai.

**Câu 11: Hằng số `LOCK_TIMEOUT = '5s'` dùng để làm gì? Điều gì xảy ra khi chờ khóa quá 5 giây?**
- **Trả lời:** Ngay khi mở transaction Pha B, `startTransactionWithLockTimeout()` chạy `SET LOCAL lock_timeout = '5s'`. Nếu một dòng tài khoản bị giữ khóa quá 5 giây, PostgreSQL chủ động hủy việc đứng chờ và ném mã lỗi `55P03` (`lock_not_available`). `classifyPhaseBFailure()` bắt mã `55P03`, ghi nhận phiếu `FAILED` với `failure_code = 'SERVER_BUSY'` ở Pha C và trả về HTTP **`503 Service Unavailable`** (*"Hệ thống đang bận, vui lòng thử lại"*) thay vì để kết nối bị treo vô thời hạn.

**Câu 12: Khi khóa tài khoản trong `loadAccountsForTransaction()`, vì sao phải viết `.setLock('pessimistic_write', undefined, ['account'])` mà không khóa cả bảng `users` được JOIN kèm?**
- **Trả lời:** Vì chỉ có bảng `accounts` mới chứa số dư và cần khóa tuần tự theo thứ tự `account.id ASC`. Chỉ định rõ `['account']` sinh ra `FOR UPDATE OF "account"`, tránh khóa không cần thiết lên bảng `users` và tránh lỗi của PostgreSQL khi câu truy vấn có chứa `JOIN`.

---

### Chủ đề 3: Vòng đời Giao dịch (State Machine 3 Pha) & Chống trùng lặp (`idempotency_keys`)

**Câu 13: Tại sao luồng giao dịch được chia thành 3 Pha (Pha A, Pha B, Pha C) thay vì gộp chung trong 1 transaction duy nhất?**
- **Trả lời:** Nếu chỉ dùng 1 transaction duy nhất, khi giao dịch gặp lỗi nghiệp vụ (như thiếu số dư khả dụng hoặc vượt hạn mức ngày) và gọi `ROLLBACK`, mọi câu lệnh `INSERT` trong transaction đó đều biến mất — ta không thể lưu lại tờ phiếu `FAILED` kèm `failure_code` vào bảng `transactions` và bản chụp lỗi vào `idempotency_keys`! Nhờ chia 3 Pha:
  - **Pha A** commit trước tờ phiếu `PROCESSING` và dòng khóa `IN_PROGRESS`.
  - **Pha B** xử lý tiền, sổ cái và đóng dấu `COMPLETED` trong một transaction nguyên tử.
  - Nếu **Pha B** lỗi và `ROLLBACK` (tiền và sổ cái không nhích một xu), **Pha C** mở một transaction ngắn mới để đóng dấu tờ phiếu đã tạo ở Pha A sang `FAILED` kèm `failure_code` và lưu bản chụp lỗi vào `idempotency_keys`.

**Câu 14: Vì sao mọi thay đổi trạng thái giao dịch đều phải đi qua hàm `transition()` với điều kiện `WHERE id = :id AND status = :from`?**
- **Trả lời:** Hàm `transition()` đóng vai trò là cổng kiểm soát duy nhất của State Machine: (1) Gọi `canTransition(from, to)` kiểm tra cạnh chuyển có nằm trong 7 cạnh hợp lệ của `ALLOWED_STATUS_TRANSITIONS` hay không; (2) Thực thi `UPDATE transactions SET status = :to, updated_at = now() WHERE id = :id AND status = :from`. Nếu có một tiến trình khác (như job quét giao dịch treo hoặc một request hoàn tiền đồng thời) đã đổi trạng thái trước đó, `result.affected` sẽ bằng `0` và `transition()` ném ngay `ConflictException` (`409`) để rollback toàn bộ Pha B, ngăn chặn tuyệt đối việc ghi đè trạng thái.

**Câu 15: Job quét giao dịch treo `sweepStuckTransactions()` hoạt động ra sao? Vì sao nó không cần "hoàn tiền" cho phiếu `PROCESSING` bị treo?**
- **Trả lời:** Chạy định kỳ mỗi phút qua `@Cron`, `sweepStuckTransactions()` tìm các giao dịch đang ở `status = 'PROCESSING'` có `updated_at` cũ hơn `120 giây` (`STUCK_AFTER_SECONDS`). Nó không cần hoàn tiền vì trong thiết kế 3 Pha, việc trừ tiền, cộng tiền, ghi bút toán `ledger_entries` và đóng dấu `PROCESSING -> COMPLETED` nằm chung trong **cùng một transaction ở Pha B** — một phiếu còn dừng ở `PROCESSING` nghĩa là Pha B chưa commit nên tiền chắc chắn chưa từng bị trừ. Nếu phát hiện phiếu `PROCESSING` quá hạn có `0` bút toán, job chuyển cả phiếu lẫn dòng khóa `idempotency_keys` sang `FAILED` (`TIMEOUT` / `503`); nếu có `> 0` bút toán (dị thường trái thiết kế), job giữ nguyên và ghi log `ERROR`.

**Câu 16: Bảng `idempotency_keys` lưu những gì và `request_hash` được tính như thế nào?**
- **Trả lời:** Bảng `idempotency_keys` lưu `user_id`, `idempotency_key`, `request_hash` (`char(64)`), `status` (`IN_PROGRESS | COMPLETED | FAILED`), `response_status`, `response_body` (`jsonb`), `transaction_id`, `created_at` và `expired_at` (`+24h`). Hàm `computeRequestHash()` chuẩn hóa `amount` về đúng 2 chữ số thập phân bằng xử lý chuỗi (`"50000"` → `"50000.00"`), sanitize `description`/`reason`, tạo JSON có thứ tự trường cố định kèm tên `operation` (`TRANSFER | DEPOSIT | WITHDRAW | REVERSE`) rồi băm SHA-256. Nhờ vậy, gửi lại cùng khóa nhưng đổi số tiền hay đổi người nhận sẽ có `request_hash` khác và bị chặn `409 Conflict` ngay lập tức.

**Câu 17: Tại sao `beginIdempotency()` dùng câu lệnh `INSERT ... ON CONFLICT ("user_id", "idempotency_key") DO NOTHING RETURNING *` thay vì bắt lỗi `try/catch` Unique Constraint?**
- **Trả lời:** Trong PostgreSQL, nếu một câu lệnh `INSERT` bên trong transaction ném lỗi Unique Violation (`23505`), toàn bộ transaction hiện tại sẽ bị đánh dấu `aborted` (không thể chạy thêm câu lệnh `SELECT` nào nữa nếu không `ROLLBACK` trước). Dùng `INSERT ... ON CONFLICT DO NOTHING RETURNING *` giúp transaction không bị lỗi: nếu mảng trả về có 1 dòng thì đây là khóa mới (`isNew: true`); nếu mảng trả về rỗng (`0` dòng) thì khóa đã tồn tại và ta có thể `SELECT` ngay dòng khóa cũ trong cùng kết nối để kiểm tra `request_hash`.

**Câu 18: Tại sao khi Replay một khóa Idempotency ở trạng thái `COMPLETED`, hệ thống lại trả về bản chụp `response_body` lúc đó thay vì truy vấn trạng thái hiện tại của giao dịch?**
- **Trả lời:** Bản chất của Idempotency là trả về **"kết quả của chính yêu cầu đó tại thời điểm nó được xử lý xong"**. Ví dụ (Test `I9`): Khách A chuyển `150.000đ` cho B (nhận `201 Created`, `status: 'COMPLETED'`). Vài tiếng sau, Admin hoàn tiền giao dịch đó khiến bản ghi trong bảng `transactions` đổi sang `REVERSED`. Nếu thiết bị của A gửi phát lại (Replay) đúng `Idempotency-Key` của lần chuyển tiền ban đầu, nó vẫn phải nhận về `200 OK` kèm bản chụp `COMPLETED` ban đầu, còn trạng thái hiện tại (`REVERSED`) được xem ở API Lịch sử giao dịch.

**Câu 19: Frontend tự động retry (`submitIdempotentTransaction`) trong những trường hợp nào và dừng ngay trong trường hợp nào? Vì sao cần thêm `useRef` ngoài thuộc tính `disabled` của nút bấm?**
- **Trả lời:** Hàm `submitIdempotentTransaction()` đặt timeout `10s` và chỉ tự động retry (tối đa 3 lần, chờ `1s -> 2s -> 4s` với **cùng `Idempotency-Key`**) khi **không nhận được phản hồi từ server** (lỗi mạng / timeout) hoặc khi nhận mã **`202 Accepted`** (giao dịch đang `PROCESSING`). Nó **dừng ngay lập tức** khi nhận bất kỳ phản hồi cuối cùng nào (`201`, `200`, hoặc lỗi `4xx`/`5xx`), rồi sinh `Idempotency-Key` mới cho lần bấm sau. Cần thêm cờ đồng bộ `inFlightRef = useRef(false)` vì cập nhật state `setLoading(true)` của React là bất đồng bộ — nếu người dùng nhấp đúp chuột cực nhanh trong cùng một mili-giây trước khi React kịp re-render thuộc tính `disabled`, `inFlightRef.current` sẽ chặn đứng lần bấm thứ hai ngay lập tức.

---

### Chủ đề 4: Bảo mật, Phân quyền RBAC, Nhật ký Kiểm toán (`audit_logs`), Hạn mức, Trạng thái TK & Xóa mềm

**Câu 20: Tại sao `RolesGuard` và `JwtStrategy` luôn đọc `role` và `status` của người dùng từ Database ở mỗi request thay vì lưu `role` vào bên trong JWT payload?**
- **Trả lời:** Nếu nhét `role` và `status` vào JWT payload và chỉ tin vào chữ ký của token, thì khi Admin khóa một người dùng (`status = 'locked'`), xóa mềm người dùng (`deleted_at != null`), hoặc hạ quyền từ `ADMIN` xuống `CUSTOMER`, chiếc JWT cũ của người đó vẫn còn hạn tối đa 1 giờ và vẫn tiếp tục gọi được API! Nhờ `JwtStrategy.validate()` tải thực thể `User` từ PostgreSQL theo `payload.sub` ở mỗi request, mọi thay đổi về khóa tài khoản (`403` — Test `AD2`), xóa mềm (`401` — Test `S1`) hay đổi vai trò (`Test RB3`) đều **có hiệu lực tức thì ở ngay request kế tiếp**.

**Câu 21: Mã lỗi `401 Unauthorized` và `403 Forbidden` khác nhau như thế nào? Vì sao khi đổi email ở `PATCH /api/users/me` mà nhập sai `currentPassword` lại trả về `400 Bad Request` thay vì `401`?**
- **Trả lời:**
  - `401 Unauthorized`: Chưa đăng nhập, token không hợp lệ, hoặc người dùng sở hữu token đã bị xóa mềm.
  - `403 Forbidden`: Đã xác thực danh tính hợp lệ nhưng tài khoản đang bị khóa (`locked`) hoặc không đủ quyền hạn (`CUSTOMER` gọi `/api/admin/*` hoặc xem tài khoản người khác).
  - Khi người dùng đang đăng nhập ở trang `/profile` và nhập sai `currentPassword` lúc đổi email, hệ thống trả về **`400 Bad Request`** (dữ liệu đầu vào của biểu mẫu không đúng) để Axios ở Frontend hiển thị thông báo lỗi trên form chứ không hiểu nhầm là hết hạn phiên đăng nhập (`401`) làm văng người dùng ra trang Login (Test `H2`).

**Câu 22: Hệ thống kết hợp `UserAuditSubscriber` / `AccountAuditSubscriber` và `AuditInterceptor` như thế nào? Vì sao Subscriber phải ghi bằng `event.manager` và dùng `WeakMap`?**
- **Trả lời:**
  - **Subscribers (`UserAuditSubscriber`, `AccountAuditSubscriber`):** Dùng cho các thay đổi dữ liệu trên bảng `users` và `accounts` (`USER_STATUS_CHANGED`, `USER_UPDATED`, `USER_SOFT_DELETED`, `ACCOUNT_UPDATED`). Ghi bằng `event.manager.insert(AuditLog, ...)` để bản ghi audit nằm trong **cùng một Database Transaction** với thao tác sửa dữ liệu (nếu transaction rollback thì bản ghi audit cũng rollback sạch sẽ — Test `AU6`, `S5`). Dùng `WeakMap` chụp ảnh trước ngay tại `afterLoad(entity)` để khi Service gán đè thuộc tính trên cùng biến `user`/`account` rồi gọi `save()`, Subscriber vẫn giữ được nguyên vẹn `before_data` cũ.
  - **`AuditInterceptor` + `@Audit()`:** Dùng cho các sự kiện hành vi cấp HTTP (`AUTH_LOGIN_SUCCESS`, `AUTH_LOGIN_FAILED`, `TRANSACTION_REVERSED`), nơi không nhất thiết có lệnh `save(User)` (như đăng nhập sai mật khẩu).

**Câu 23: `AsyncLocalStorage` trong `request-context.ts` giải quyết bài toán gì? Tại sao mở ngữ cảnh ở Middleware nhưng lại đọc `req.user` lúc ghi log (lazy read)?**
- **Trả lời:** TypeORM Subscriber chạy sâu bên dưới tầng Database và chỉ nhận vào `UpdateEvent<User>`, hoàn toàn không có tham số `req` của Express để biết Admin nào đang bấm nút khóa hay từ IP/User-Agent nào. `RequestContextMiddleware` mở một vùng nhớ `AsyncLocalStorage` lưu tham chiếu tới `req` cho suốt vòng đời bất đồng bộ của request đó. Vì trong NestJS, `Middleware` chạy **trước** `JwtAuthGuard` (lúc Middleware chạy thì `req.user` chưa có), nên `getRequestContextSnapshot()` thực hiện **đọc trễ (`req.user?.id`)** ngay tại thời điểm Subscriber/Interceptor ghi log (lúc này Guard đã chạy xong và đã gán `req.user`).

**Câu 24: Tại sao việc kiểm tra trạng thái tài khoản (`ACTIVE / FROZEN / CLOSED`) và hạn mức giao dịch (`STANDARD / VIP`) lại đặt ở Pha B dưới khóa dòng mà không đặt ở Pha A?**
- **Trả lời:** Vì hai lý do bắt buộc:
  1. *Chống Race Condition vượt hạn mức:* Nếu kiểm tra hạn mức ngày ở Pha A (không có khóa dòng), 10 request `9.900.000đ` bắn đồng thời khi chỉ còn hạn mức cho 2 request sẽ cùng thấy "còn hạn mức" và cùng đi qua. Đặt ở Pha B dưới khóa `SELECT ... FOR UPDATE` bắt 10 request phải xếp hàng kiểm tra tuần tự (đúng 2 request thành công, 8 request bị từ chối `LIMIT_PER_DAY_EXCEEDED` — Test `L5`).
  2. *Lưu vết `FAILED` theo đúng yêu cầu Bài 5.2:* Phiếu giao dịch được tạo ở Pha A, sau đó bị từ chối ở Pha B sẽ được Pha C đóng dấu `FAILED` kèm đúng `failure_code` (`SOURCE_ACCOUNT_FROZEN`, `LIMIT_PER_DAY_EXCEEDED`...) thay vì biến mất.

**Câu 25: Tổng tiền "Đã dùng hôm nay" (`usedToday`) được tính bằng câu SQL như thế nào? Những giao dịch nào được tính và những giao dịch nào KHÔNG được tính?**
- **Trả lời:** Trong `calculateAccountLimits()` (`date.util.ts`), `usedToday` chỉ cộng `SUM(t.amount)` của các giao dịch thỏa mãn đồng thời:
  - `from_account_id = accountId`
  - `type IN ('TRANSFER', 'WITHDRAW')` (tiền đi ra)
  - `status = 'COMPLETED'`
  - `created_at` nằm trong ngày hiện tại theo múi giờ Việt Nam tính bằng đồng hồ của PostgreSQL: `(date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')`.
  **Không tính:** `DEPOSIT` (tiền nạp vào), `REVERSAL` (giao dịch hoàn tiền của Admin), các giao dịch `FAILED` (chưa trừ tiền), và các giao dịch gốc đã chuyển sang `REVERSED` (tiền đã được hoàn lại — Test `L6`).

**Câu 26: Số dư khả dụng (`availableBalance`) khác Số dư sổ sách (`balance`) thế nào? Ba lớp bảo vệ không cho rút lẹm vào tiền phong tỏa (`hold_amount`) là gì?**
- **Trả lời:** `availableBalance = balance − hold_amount`. Ví dụ tài khoản có `balance = 1.000.000đ`, Admin phong tỏa `hold_amount = 400.000đ` thì khách chỉ rút/chuyển được tối đa `600.000đ` (Test `A3`). Ba lớp bảo vệ gồm:
  1. Hàm `ensureSufficientAvailableBalance()` kiểm tra bằng `BigInt` dưới khóa dòng ở Pha B.
  2. Câu lệnh SQL trong `debitAccount()` kiểm tra nguyên tử `WHERE id = :id AND status = 'ACTIVE' AND deleted_at IS NULL AND (balance - hold_amount) >= :amount`.
  3. Ràng buộc `CHECK ("hold_amount" <= "balance")` (`CHK_accounts_hold_lte_balance`) ngay trên bảng `accounts` của PostgreSQL (Test `A4`).

**Câu 27: Khi Admin xóa mềm một khách hàng (`DELETE /api/admin/users/:id`), những điều kiện nào phải thỏa mãn và làm sao lịch sử giao dịch của những người từng giao dịch với người đó không bị mất số tài khoản?**
- **Trả lời:** Chỉ xóa được `CUSTOMER` (không xóa được `ADMIN` → `403`, không tự xóa mình → `400`) khi dưới khóa dòng `FOR UPDATE`, tài khoản thỏa mãn cả 3 điều kiện: `balance = 0`, `hold_amount = 0` và `0` giao dịch đang xử lý dở (`INITIATED / PENDING_OTP / PROCESSING`). Khi xóa, hệ thống đổi `account.status = 'CLOSED'`, gọi `softRemove` cho cả `Account` và `User`, và ghi Audit `USER_SOFT_DELETED` trong cùng 1 transaction. Để lịch sử của đối tác không bị mất số tài khoản khi `LEFT JOIN` với bảng `accounts` (vốn có `@DeleteDateColumn`), `TransactionsService.getTransactions()` và `AdminService.getTransactions()` chủ động gọi `.withDeleted()` trên QueryBuilder (Test `S1`).

---

### Chủ đề 5: Chiến lược Kiểm thử (Unit Test vs. E2E Test), Độ phủ mã & CI

**Câu 28: Unit Test (`src/**/*.spec.ts`) và E2E Test (`test/*.e2e-spec.ts`) khác nhau thế nào? Cái gì Unit Test với Mock không kiểm chứng được?**
- **Trả lời:**
  - **Unit Test (9 suites / >145 tests):** Chạy hoàn toàn trong bộ nhớ với Mock (`jest.fn()`), không cần Docker/DB, hoàn tất trong ~2 giây, dùng để kiểm chứng vét cạn mọi nhánh quyết định nghiệp vụ, 36 cặp State Machine, 13 mã lỗi, các giá trị biên `0,01đ` và validation DTO.
  - **E2E Test (8 suites / 66 tests):** Chạy với PostgreSQL thật (`postgres-test`), kiểm chứng những thứ mà Mock **không thể kiểm chứng được**: cú pháp câu lệnh SQL `UPDATE ... RETURNING`, hiệu lực chặn thật của khóa dòng `SELECT ... FOR UPDATE`, phát hiện Deadlock `40P01`, Trigger bất biến (`ledger_entries`, `audit_logs`, `account_history`), ràng buộc `CHECK`, `Partial Unique Index` và hành vi tự lọc của `@DeleteDateColumn`.

**Câu 29: Độ phủ mã (Code Coverage) ≥ 80% nghĩa là gì và KHÔNG có nghĩa là gì? Bạn đã làm gì để tránh "phủ giả"?**
- **Trả lời:** Độ phủ ≥ 80% nghĩa là ít nhất 80% câu lệnh, nhánh rẽ (`if/else`), hàm và dòng code trong các service nghiệp vụ đã được thực thi khi chạy bộ Unit Test (thực tế dự án đạt `100%` cho `accounts` và `~96.1%` cho `transactions`, bị ép cứng bằng `coverageThreshold` trong `jest.config.ts`). Tuy nhiên, độ phủ cao **không** tự động đồng nghĩa với test tốt nếu chỉ gọi hàm cho chạy qua dòng code mà không kiểm tra kết quả. Để tránh "phủ giả", mọi bài test trong dự án đều tuân thủ cấu trúc AAA và có `expect(...)` kiểm tra cụ thể mã lỗi (`failure_code`), thông báo lỗi động, giá trị số dư/hạn mức biên (`0,01đ`) và kiểm tra cả lời gọi `rollbackTransaction()`.

**Câu 30: Quy trình GitHub Actions CI (`.github/workflows/ci.yml`) của dự án thực hiện những bước nào?**
- **Trả lời:** Workflow CI gồm 2 jobs chạy song song:
  1. `backend-ci`: Khởi tạo container dịch vụ `postgres:15-alpine` (có `pg_isready` healthcheck), chạy `npm ci` → `npm run lint` → `npm run build` → `npm run test:cov` (ép ngưỡng độ phủ ≥ 80% cho `transactions` & `accounts`, ≥ 75% cho `global`) → chạy `npm run test:e2e` (66 bài kiểm thử tích hợp) **2 lần liên tiếp** để đảm bảo không flaky → lưu báo cáo coverage làm artifact.
  2. `frontend-ci`: Chạy `npm ci` → `npm run lint` → `npm run build` cho ứng dụng Next.js.

---

## Phần II — 10 Câu hỏi "Tình huống khó" (What-if Scenarios)

**Tình huống 1: Điều gì xảy ra nếu ở Pha B, hệ thống vừa chạy xong lệnh `debitAccount()` trừ `500.000đ` của A nhưng ngay trước khi chạy `creditAccount()` cộng cho B thì tiến trình NodeJS bị sập nguồn hoặc mất kết nối tới PostgreSQL?**
- **Trả lời:** Tiền của A **không mất một xu nào** và sổ cái **không có bút toán mồ côi** (đã kiểm chứng bằng thực nghiệm ở Test `R1` và `R2`). Vì `debitAccount()`, `creditAccount()`, `insertLedgerEntries()` và `transition(PROCESSING -> COMPLETED)` đều nằm trong **cùng một Database Transaction của Pha B**. Khi kết nối bị đứt hoặc ném lỗi trước khi `COMMIT`, PostgreSQL tự động `ROLLBACK` toàn bộ transaction của Pha B, khôi phục số dư của A về nguyên trạng. Còn tờ phiếu `PROCESSING` đã tạo ở Pha A sẽ được cron job `sweepStuckTransactions()` phát hiện sau 120 giây (do có `0` bút toán sổ cái) và tự động đóng dấu `FAILED` (`failure_code = 'TIMEOUT'`), đồng thời đóng luôn dòng khóa `idempotency_keys` sang `FAILED (503)`.

**Tình huống 2: Nếu 5 Quản trị viên (`ADMIN`) cùng bấm nút Hoàn tiền (`POST /api/transactions/:id/reverse`) cho cùng một giao dịch `COMPLETED` vào đúng một mili-giây với 5 `Idempotency-Key` khác nhau thì chuyện gì xảy ra?**
- **Trả lời:** Chỉ có **đúng 1 request thành công (`201 Created`)**, còn **4 request kia nhận `409 Conflict`** và tiền chỉ được hoàn lại đúng 1 lần duy nhất (đã kiểm chứng ở Test `V2`). Ngay ở Pha A, khi cả 5 request cùng cố gắng `INSERT` một bản ghi có `type = 'REVERSAL'` và `status = 'INITIATED'` cho cùng một `original_transaction_id`, Partial Unique Index **`IDX_transactions_active_reversal_original`** của PostgreSQL chỉ cho phép đúng 1 dòng lọt qua; 4 dòng còn lại bị chặn ngay bởi lỗi Unique Violation (`23505`) và được chuyển thành `409 ConflictException`. Thêm vào đó, ở cuối Pha B còn có lớp khóa `FOR UPDATE` và câu lệnh `transition(originalTx.id, COMPLETED -> REVERSED)` có điều kiện `WHERE status = 'COMPLETED'`.

**Tình huống 3: Tài khoản `STANDARD` (hạn mức `50.000.000đ/ngày`) hôm nay đã dùng `30.000.000đ` (còn lại `20.000.000đ`). Nếu khách hàng mở 10 tab trình duyệt và bắn đồng thời 10 lệnh rút `9.900.000đ` (mỗi lệnh một `Idempotency-Key` riêng) thì có bị lọt quá 2 lệnh không?**
- **Trả lời:** Tuyệt đối không — luôn có **đúng 2 lệnh `201 COMPLETED`** (`2 × 9.900.000đ = 19.800.000đ`, nâng tổng đã dùng lên `49.800.000đ`) và **8 lệnh bị từ chối `422 LIMIT_PER_DAY_EXCEEDED`** (đã kiểm chứng ở Test `L5`). Lý do là bước tính `usedToday` và kiểm tra hạn mức (`enforceOutgoingLimitsInPhaseB`) nằm ở **Pha B, ngay bên dưới khóa dòng `SELECT ... FOR UPDATE` của tài khoản nguồn**. Do đó, Lệnh #2 phải chờ Lệnh #1 `COMMIT` trạng thái `COMPLETED` xong mới được vào đọc `usedToday` (lúc này đã là `39.900.000đ`), và Lệnh #3 vào sau sẽ thấy `usedToday = 49.800.000đ` (chỉ còn `200.000đ` < `9.900.000đ`) nên bị từ chối ngay.

**Tình huống 4: Điều gì xảy ra nếu Khách hàng A đang rút `800.000đ` trên tài khoản có `balance = 1.000.000đ` (`hold_amount = 0`) cùng lúc Admin gọi API `PATCH /api/admin/accounts/:accountNumber` để phong tỏa `holdAmount = 800.000đ`?**
- **Trả lời:** Cả hai thao tác (`withdraw` ở Pha B và `AdminService.updateAccount`) đều bắt đầu bằng việc xin khóa độc quyền `SELECT ... FOR UPDATE` trên dòng `Account` đó (đã kiểm chứng ở Test `A3`):
  - Nếu **Admin vào khóa trước**: `hold_amount` được cập nhật lên `800.000đ` và commit. Ngay sau đó lệnh `withdraw` của khách vào khóa sẽ thấy `availableBalance = 1.000.000 − 800.000 = 200.000đ < 800.000đ` và bị từ chối `422 INSUFFICIENT_BALANCE`.
  - Nếu **Khách vào khóa trước**: `balance` giảm xuống còn `200.000đ` và commit. Ngay sau đó lệnh của Admin vào khóa sẽ thấy `holdAmount (800.000đ) > balance (200.000đ)` và bị từ chối `422 Unprocessable Entity`.
  Trong mọi trường hợp, bất biến `hold_amount <= balance` (**Q8**) luôn được bảo toàn tuyệt đối.

**Tình huống 5: Nếu Admin gọi `DELETE /api/admin/users/:id` để xóa mềm một người dùng đúng lúc người đó đang có một giao dịch chuyển khoản đang chạy dở ở trạng thái `PROCESSING` (vừa qua Pha A, chuẩn bị vào Pha B) thì sao?**
- **Trả lời:** Trong `AdminService.softDeleteUser()`, sau khi khóa dòng `Account` bằng `FOR UPDATE`, hệ thống đếm số giao dịch liên quan có `status IN ('INITIATED', 'PENDING_OTP', 'PROCESSING')`. Vì giao dịch kia đã commit Pha A ở trạng thái `PROCESSING`, `pendingTxCount` sẽ `> 0` và lệnh xóa mềm của Admin bị từ chối ngay với mã **`409 Conflict`** (*"Không thể xóa người dùng khi tài khoản đang có giao dịch xử lý dở dang"* — đã kiểm chứng ở Test `S2`). Ngược lại, nếu tài khoản đã được xóa mềm và đóng (`CLOSED`) trước đó, mọi giao dịch chạm vào tài khoản đó ở Pha B đều bị `ensureAccountActiveInPhaseB` chặn lại với mã `SOURCE_ACCOUNT_CLOSED` / `DESTINATION_ACCOUNT_CLOSED`.

**Tình huống 6: Khi mạng chậm, người dùng bấm nút "Xác nhận chuyển khoản", request mất 12 giây mới xử lý xong trên Server nhưng Axios ở Frontend đã timeout ở giây thứ 10. Chuyện gì xảy ra tiếp theo?**
- **Trả lời:** Khi Axios timeout ở giây thứ 10, việc xử lý trên Server **không bị hủy** mà vẫn tiếp tục chạy tới giây thứ 12 và hoàn tất (`COMPLETED`, lưu bản chụp vào `idempotency_keys`). Ở giây thứ 10, hàm `submitIdempotentTransaction()` của Frontend bắt lỗi timeout, chờ `1 giây` rồi tự động gửi lại **Lần thử lại 1/3 với CÙNG `Idempotency-Key` cũ**:
  - Nếu lúc gửi lại (giây 11) Server vẫn đang chạy Pha B (`IN_PROGRESS`), Server trả về `202 Accepted`, Frontend chờ tiếp `2 giây` rồi hỏi lại lần 2.
  - Ở giây thứ 13, khi Server đã hoàn tất Pha B, lần hỏi lại của Frontend nhận về `200 OK` kèm đúng bản chụp kết quả thành công ban đầu — giao diện báo thành công và tiền chỉ bị trừ đúng **1 lần duy nhất**!

**Tình huống 7: Khách hàng A chuyển `20.000.000đ` lúc `23:59:30` đêm (giờ Việt Nam) và chuyển tiếp `35.000.000đ` lúc `00:00:30` sáng hôm sau (giờ Việt Nam) trên tài khoản `STANDARD` (`50.000.000đ/ngày`). Giao dịch thứ hai có bị chặn không, kể cả khi container Backend đang chạy trên máy chủ đặt múi giờ `UTC`?**
- **Trả lời:** Giao dịch thứ hai (`35.000.000đ` vượt trần 1 lần `30M` nên nếu là 2 khoản `20.000.000đ` thì hoàn toàn thành công!) — cụ thể nếu khách chuyển `25.000.000đ` lúc `23:59:30` đêm hôm qua và `30.000.000đ` lúc `00:00:30` sáng hôm nay (tổng `55M > 50M`), giao dịch lúc `00:00:30` sáng hôm nay **vẫn thành công 100%** (Test `L4`). Lý do là câu truy vấn tính `usedToday` không dùng giờ hệ thống của máy chủ NodeJS (vốn ở UTC mới là `17:00` chiều cùng ngày), mà dùng biểu thức múi giờ trực tiếp trong PostgreSQL: `now() AT TIME ZONE 'Asia/Ho_Chi_Minh'`. Qua mốc `00:00:00+07:00`, hạn mức ngày mới tự động bắt đầu lại từ `0.00`.

**Tình huống 8: Nếu một người dùng gửi đồng thời 2 request `PATCH /api/users/me` để đổi số điện thoại cùng một lúc khi `profile_version` đang là `1`, liệu có bị lỗi trùng khóa `UNIQUE (user_id, version)` trong bảng `account_history` không?**
- **Trả lời:** Không. Trong `UsersService.updateMyProfile()`, ngay khi mở Database Transaction, hệ thống thực hiện khóa dòng `User` bằng `manager.createQueryBuilder(User, 'user').setLock('pessimistic_write').where('user.id = :userId', { userId }).getOne()`. Nhờ khóa `FOR UPDATE` trên dòng `User`, Request #2 phải đứng chờ Request #1 chèn xong `version = 1` vào `account_history` và nâng `user.profile_version` lên `2` rồi `COMMIT`. Khi Request #2 vào khóa, nó đọc được `profile_version = 2` mới nhất và chèn `version = 2` vào `account_history` một cách tuần tự, an toàn.

**Tình huống 9: Tại sao khi một giao dịch rút tiền bị từ chối `422` (do tài khoản đang chỉ có `100.000đ` mà đòi rút `500.000đ`), sau đó khách nạp thêm `1.000.000đ` vào tài khoản rồi gửi lại request rút `500.000đ` với CÙNG `Idempotency-Key` cũ thì vẫn nhận lại lỗi `422` cũ mà không rút được tiền?**
- **Trả lời:** Vì trong mô hình State Machine & Idempotency chuẩn (Test `I4`), `FAILED` là **trạng thái kết thúc (Terminal State)** của yêu cầu mang `Idempotency-Key` đó, và bản chụp lỗi `422` đã được đóng dấu vĩnh viễn vào `idempotency_keys` (trong vòng 24 giờ). Khi gửi lại cùng một khóa đã `FAILED`, hệ thống phải trả về đúng kết quả đã lưu của khóa đó chứ không được thực thi lại. Ở phía Frontend, ngay khi nhận phản hồi lỗi cuối cùng (`422`), form tự động sinh một `Idempotency-Key` (UUID) mới, nên khi khách nạp tiền xong và bấm nút rút lại trên giao diện, yêu cầu mới mang khóa mới và thành công ngay lập tức.

**Tình huống 10: Điều gì xảy ra nếu trong một thao tác quản trị (như khóa người dùng `PATCH /api/admin/users/:id/status` hoặc xóa mềm `DELETE /api/admin/users/:id`), dữ liệu trên bảng `users` vừa được cập nhật xong nhưng việc ghi vào bảng `audit_logs` bị lỗi (hoặc ngược lại)?**
- **Trả lời:** Cả hai sẽ **cùng thành công hoặc cùng được `ROLLBACK` 100%** (đã kiểm chứng ở Test `AU6` và `S5`). Bởi vì `UserAuditSubscriber` và `AccountAuditSubscriber` chèn bản ghi kiểm toán thông qua `event.manager.insert(AuditLog, ...)` — tức dùng chung đúng `EntityManager` và Database Transaction với lệnh `manager.save(User)` / `manager.softRemove(User)`. Nhờ vậy, hệ thống đảm bảo bất biến: *"Không bao giờ có thay đổi trạng thái người dùng/tài khoản nào xảy ra mà thiếu dấu vết trong `audit_logs`, và không bao giờ có dòng `audit_logs` nào ghi nhận một thay đổi đã bị rollback"*.