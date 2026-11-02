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

## ADR-003: Why Database Transaction + Pessimistic Lock + Atomic Conditional Update + In-Transaction Ledger Posting
* **Context**: Các thao tác biến động số dư (chuyển khoản, nạp tiền, rút tiền) cần đảm bảo không để lại dữ liệu dở dang hay bút toán mồ côi khi lỗi giữa chừng, đồng thời không xảy ra Lost Update hay âm quỹ khi có nhiều request chạy đồng thời.
* **Decision**: Thực hiện toàn bộ chuỗi thao tác bên trong một Database Transaction (`QueryRunner`) duy nhất:
  1. **Lớp 1 (Pessimistic Locking):** Tải và khóa các dòng tài khoản liên quan bằng `SELECT ... FOR UPDATE OF "account"` (`.setLock('pessimistic_write', undefined, ['account'])`), sắp xếp theo `ORDER BY account.id ASC`, và kiểm tra số dư ngay sau khi khóa.
  2. **Lớp 2 (Atomic Conditional Update with `RETURNING`):** Trừ/cộng tiền bằng câu lệnh nguyên tử có điều kiện (`UPDATE accounts SET balance = balance - :amount WHERE id = :id AND balance >= :amount RETURNING balance`) để lấy ngay số dư mới (`balance_after`) từ PostgreSQL.
  3. **Lớp 3 (In-Transaction Transaction & Ledger Recording):** Ghi bản ghi giao dịch (`transactions`) và ghi các bút toán sổ cái (`ledger_entries`) qua cùng `queryRunner.manager` trước khi `COMMIT`. Nếu bất kỳ bước nào lỗi, toàn bộ thay đổi số dư, giao dịch và bút toán đều được `ROLLBACK` nguyên tử.
* **Reason**: Thực nghiệm ở Bài 1.1 và kiểm thử lỗi giữa chừng ở Bài 7.3 (`R1`, `R2`) chứng minh rằng việc gói khóa dòng, cập nhật `RETURNING balance`, ghi `transactions` và ghi `ledger_entries` vào cùng một transaction đảm bảo số dư hiển thị và sổ cái không bao giờ lệch nhau dù có lỗi bất ngờ hay tải đồng thời cao.
* **Trade-offs**: Các giao dịch chạm vào cùng một tài khoản tại cùng một thời điểm phải xếp hàng tuần tự, được kiểm soát bởi `SET LOCAL lock_timeout = '5s'` (quá hạn trả `503 Service Unavailable`).

## ADR-004: Why Idempotency
* **Context**: Khi mạng chậm hoặc timeout, người dùng hoặc trình duyệt có thể gửi lặp lại cùng một yêu cầu giao dịch, dẫn đến nguy cơ trừ/cộng tiền và ghi sổ cái hai lần.
* **Decision**: Bắt buộc client gửi header `Idempotency-Key` (định dạng UUID) cho mọi API tạo giao dịch (`transfer`, `deposit`, `withdraw`). Giao dịch tạo mới trả `201 Created`; gửi lặp lại cùng key và cùng payload trả `200 OK` kèm kết quả cũ (không sinh thêm bút toán); cùng key nhưng khác payload hoặc khác loại giao dịch trả `409 Conflict`.
* **Reason**: Đảm bảo tính idempotent cho mọi thao tác biến động số dư mà không cần thêm hệ thống cache ngoài (như Redis).
* **Trade-offs**: Frontend cần quản lý vòng đời `Idempotency-Key` (giữ nguyên khi lỗi mạng để retry, sinh mới khi người dùng sửa form, đổi tab hoặc sau khi giao dịch thành công).

## ADR-005: Why Next.js + Zustand
* **Context**: Cần xây dựng giao diện ReactJS cho trình duyệt desktop có quản lý trạng thái đăng nhập, bảo vệ route và đóng gói Docker gọn nhẹ.
* **Decision**: Sử dụng Next.js (App Router) ở chế độ Client Component (`'use client'`) kết hợp với Zustand (`persist` middleware) và Axios.
* **Reason**: Next.js cung cấp cơ chế định tuyến theo thư mục rõ ràng (bao gồm Route Group `(protected)`) và chế độ build `output: 'standalone'` giúp chạy container nhẹ mà không cần cấu hình Nginx. Zustand tối giản, không cần nhiều boilerplate như Redux Toolkit.
* **Trade-offs**: Vì trạng thái xác thực nằm ở `localStorage` phía trình duyệt, `AuthGuard` cần chờ cờ `hydrated` của Zustand trước khi kiểm tra redirect để tránh nháy trang khi tải lại.

## ADR-006: Why Input Sanitization / XSS Protection
* **Context**: Dữ liệu văn bản do người dùng nhập (`fullName`, `description`) có thể chứa các thẻ HTML/script độc hại gây lỗi XSS.
* **Decision**:
  1. Validate chặt chẽ bằng `class-validator` với `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`).
  2. Sanitize các ký tự `<`, `>`, `&` bằng hàm `sanitizeHtml` trước khi lưu vào DB.
  3. Ở Frontend, sử dụng cơ chế auto-escaping mặc định của React JSX, không dùng `dangerouslySetInnerHTML`.
* **Reason**: Kết hợp phòng thủ ở cả đầu vào (Backend) và đầu ra (Frontend) mà không phải cài đặt thêm thư viện nặng.
* **Trade-offs**: Access Token lưu trong `localStorage` có bề mặt rủi ro với XSS cao hơn `httpOnly cookie`, do đó việc kiểm soát chặt XSS và giới hạn thời hạn token (`1h`) là bắt buộc.

## ADR-007: Why TypeORM Migrations Instead of Synchronize
* **Context**: Ở phiên bản khởi đầu, `synchronize: true` được dùng để tạo bảng nhanh từ Entity. Tuy nhiên khi mở rộng sang các bài tập nâng cao (thêm `CHECK` constraint, thay đổi enum, thêm bảng sổ cái kép kèm backfill và trigger bất biến), `synchronize: true` không thể kiểm soát thứ tự chuyển đổi dữ liệu và có nguy cơ tự động xóa cột ngoài ý muốn.
* **Decision**: Tắt hoàn toàn `synchronize: true` (`synchronize: false` trong `data-source.ts`), thiết lập Baseline Migration và quản lý mọi thay đổi schema thông qua TypeORM Migrations. Khi khởi động container Docker, `start.sh` chạy `migration:run:prod` trước khi chạy `seed` và khởi động ứng dụng.
* **Reason**: Đảm bảo mọi thay đổi cấu trúc DB đều tường minh, có thể kiểm soát phiên bản trên Git, hỗ trợ rollback (`down`) và cho phép định nghĩa các bước backfill SQL phức tạp cùng trigger bảo vệ dữ liệu.
* **Trade-offs**: Mỗi khi sửa Entity phải tạo và chạy file migration tương ứng thay vì để ORM tự sửa bảng ngầm.

## ADR-008: Why Single-Sided Cash Transactions & `actor_account_id` Idempotency Scope
* **Context**: Khi bổ sung nghiệp vụ Nạp tiền (`deposit`) và Rút tiền (`withdraw`), cần quyết định cách lưu `from_account_id` / `to_account_id` và cách đặt Unique constraint cho `idempotency_key` (vì Unique constraint cũ `(idempotency_key, from_account_id)` không chặn được trùng lặp khi `from_account_id` là `NULL` đối với giao dịch `deposit`).
* **Decision**:
  1. Chọn **mô hình giao dịch một phía** kèm `CHECK` constraint `CHK_transactions_type_accounts`:
     * `transfer`: `from_account_id IS NOT NULL AND to_account_id IS NOT NULL AND from_account_id <> to_account_id`.
     * `deposit`: `from_account_id IS NULL AND to_account_id IS NOT NULL`.
     * `withdraw`: `from_account_id IS NOT NULL AND to_account_id IS NULL`.
  2. Thêm cột `actor_account_id` (`NOT NULL`) đại diện cho tài khoản chủ động thực hiện giao dịch và đặt Unique constraint trên `(idempotency_key, actor_account_id)`.
* **Reason**: Không cần tạo tài khoản hệ thống ảo, đồng thời giúp cả 3 loại giao dịch (`transfer`, `deposit`, `withdraw`) chia sẻ chung một phạm vi khóa Idempotency duy nhất, ngăn chặn việc dùng lại cùng một `Idempotency-Key` cho loại giao dịch khác (trả về `409 Conflict`).
* **Trade-offs**: Bảng `transactions` có thêm cột `actor_account_id`, đổi lại câu truy vấn kiểm tra Idempotency đơn giản, đồng nhất và tương thích 100% với decorator của TypeORM.

## ADR-009: Why Pessimistic Locking, Canonical Lock Ordering by ID, and Deadlock Retry
* **Context**:
  1. Khi một tài khoản nhận nhiều giao dịch đồng thời, cần lựa chọn giữa **Pessimistic Locking** (`SELECT ... FOR UPDATE`) và **Optimistic Locking** (cột `version` + retry) làm cơ chế chính.
  2. Khi hai tài khoản A và B chuyển tiền chéo cho nhau cùng lúc (A→B và B→A), việc khóa dòng có nguy cơ gây ra **Deadlock** (`40P01`).
* **Decision**:
  1. **Chọn Pessimistic Locking làm cơ chế chính:** Khóa riêng bảng `account` bằng `.setLock('pessimistic_write', undefined, ['account'])` kèm `SET LOCAL lock_timeout = '5s'` (quá hạn trả `503`).
  2. **Khóa theo thứ tự cố định (`ORDER BY account.id ASC`):** Tải và khóa cả tài khoản nguồn lẫn tài khoản đích trong một câu truy vấn duy nhất sắp xếp theo `account.id` tăng dần.
  3. **Bọc vòng lặp Deadlock Retry (`executeWithDeadlockRetry`) bên ngoài Transaction:** Nếu PostgreSQL trả về mã lỗi `40P01`, tự động rollback, ghi log kèm bộ đếm (`deadlockDetected`, `retrySucceeded`, `retryExhausted`), chờ ngẫu nhiên `10–50ms` và thử lại tối đa `3 lần` (`MAX_DEADLOCK_RETRIES = 3`).
* **Reason (Dẫn chứng bằng số liệu thực nghiệm từ Bài 1.3 & 1.4)**:
  * Trong benchmark Bài 1.3 ở kịch bản tranh chấp cao **S2** (100 request đồng thời vào 1 tài khoản), **Pessimistic Locking** hoàn thành `100/100` giao dịch (`201`), đạt thông lượng **~275 req/s** và **`0` lỗi `503`**. Ngược lại, **Optimistic Locking** gặp bão thử lại (retry storm), thông lượng giảm còn **~80 req/s** và có **~35–55 request bị trả lỗi `503`** sau khi cạn 5 lần retry.
  * Trong thực nghiệm Bài 1.4 với 500 giao dịch chuyển khoản chéo A↔B (50 cặp × 5 vòng), khi áp dụng **`ORDER BY account.id ASC`**, số lần deadlock giảm về **`0`** và toàn bộ 500 giao dịch hoàn tất trong **~2.2–4.0 giây**, bảo toàn tuyệt đối tổng số dư `20,000,000.00 VND`.
* **Trade-offs**:
  * Pessimistic Locking giữ khóa dòng trong suốt transaction nên nếu một transaction xử lý chậm sẽ làm các request sau trên cùng tài khoản đó phải xếp hàng chờ (đã được bảo vệ bởi `lock_timeout = '5s'`).
  * Bộ đếm Deadlock hiện lưu trong RAM của tiến trình NodeJS (sẽ reset khi khởi động lại container; việc đẩy metrics ra hệ thống giám sát tập trung thuộc phạm vi Module 6).

## ADR-010: Why Append-Only Double-Entry Ledger, Database Immutability Trigger, `BIGSERIAL` Primary Key, and Cached Account Balance
* **Context**:
  1. Nếu chỉ cập nhật trực tiếp cột `accounts.balance`, hệ thống mất dấu vết biến động số dư sau từng bước (`balance_after`) và không có khả năng tự đối soát nếu dữ liệu bị sửa đổi.
  2. Cần bảo vệ bảng sổ cái (`ledger_entries`) không thể bị sửa (`UPDATE`) hoặc xóa (`DELETE`), cần thứ tự ghi sổ tường minh để tính sao kê cộng dồn, và cần đồng bộ kiểu khóa chính tự tăng giữa TypeORM Entity và Migration.
* **Decision**:
  1. **Mô hình Sổ cái kép chỉ-ghi-thêm (`ledger_entries`):** Mọi giao dịch `transfer` sinh đúng **2 bút toán cân bằng** (`1 DEBIT` trên tài khoản gửi + `1 CREDIT` trên tài khoản nhận, `tổng DEBIT = tổng CREDIT = amount`). Theo mô hình tiền mặt một phía của `ADR-008`, `deposit` sinh **1 bút toán `CREDIT`** và `withdraw` sinh **1 bút toán `DEBIT`**. Giá trị `balance_after` được lấy trực tiếp từ câu lệnh `UPDATE ... RETURNING balance` trong cùng một Database Transaction.
  2. **Khóa chính `id` kiểu `bigint` tự tăng (`BIGSERIAL`):** Khai báo đồng nhất `@PrimaryGeneratedColumn({ type: 'bigint' })` trên `LedgerEntry` và `generationStrategy: 'increment'` trong Migration (sinh kiểu `BIGSERIAL` của PostgreSQL). Mọi truy vấn sao kê và cộng dồn sổ cái đều sắp xếp theo `ORDER BY id ASC` (kèm index `(account_id, id)`).
  3. **Bảo vệ bất biến hai lớp (Application + Database Trigger):** Ở tầng ứng dụng, chỉ cung cấp hàm `insertLedgerEntries` (`INSERT`) và không export repository `LedgerEntry`. Ở tầng database, cài đặt Trigger `trg_ledger_entries_immutable` (`BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW`) ném ngoại lệ từ chối mọi thao tác sửa/xóa, kết hợp khóa ngoại `ON DELETE RESTRICT`.
  4. **Số dư hiển thị là bản sao (`accounts.balance`), sổ cái là nguồn sự thật (`ledger_entries`):** Giữ cột `accounts.balance` làm bản sao đọc nhanh (cached balance) cho API `GET /accounts/me`, trong khi tổng cộng dồn của `ledger_entries` là nguồn sự thật chuẩn xác để kiểm toán thông qua bộ truy vấn bất biến Q1–Q3.
* **Reason**:
  * Khác với `uuid` ngẫu nhiên và `created_at` (vốn lấy thời điểm bắt đầu transaction `now()` nên nhiều dòng trong cùng một mili-giây có cùng timestamp), khóa chính `id` kiểu `bigint` tự tăng kết hợp với khóa dòng `SELECT ... FOR UPDATE` (Module 1) đảm bảo các bút toán của cùng một tài khoản luôn có số thứ tự `id` tăng dần khớp tuyệt đối với trình tự biến động `balance_after`.
  * Dùng thống nhất `BIGSERIAL` giữa Entity và Migration giúp lệnh `npm run migration:generate` không bao giờ báo lệch schema giữa `SERIAL` và `IDENTITY`.
  * Trigger ở tầng PostgreSQL chặn được cả những câu lệnh `UPDATE`/`DELETE` gõ trực tiếp bằng SQL, không phụ thuộc hoàn toàn vào code tầng ứng dụng, mà không đòi hỏi phải tách nhiều user/role phức tạp trong Docker Compose.
* **Trade-offs**:
  * Mỗi giao dịch ghi thêm 1–2 dòng vào bảng `ledger_entries`, làm tăng nhẹ dung lượng lưu trữ đổi lấy khả năng kiểm toán và truy vết tuyệt đối.
  * Người dùng có quyền `superuser` của PostgreSQL vẫn có thể vô hiệu hóa trigger (`ALTER TABLE ... DISABLE TRIGGER`), và lệnh `TRUNCATE` mức bảng không kích hoạt trigger `FOR EACH ROW` (được tận dụng có chủ đích để dọn dữ liệu nhanh trên DB test `simple_bank_test`). Trong môi trường production thực tế, cần kết hợp thêm việc `REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries` khỏi role DB của ứng dụng. Việc chạy cron job đối soát tự động cuối ngày giữa `accounts.balance` và `ledger_entries` được để dành cho Module 6.1.