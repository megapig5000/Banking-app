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

## ADR-003: Why Database Transaction + Pessimistic Lock + Atomic Conditional Update (Defense in Depth)
* **Context**: Các thao tác biến động số dư (chuyển khoản, nạp tiền, rút tiền) cần đảm bảo không để lại dữ liệu dở dang khi lỗi và không xảy ra Lost Update hay âm quỹ khi có nhiều request chạy đồng thời.
* **Decision**: Áp dụng cơ chế bảo vệ kép ("Thắt dây an toàn kép") bên trong một Database Transaction (`QueryRunner`):
  1. **Lớp 1 (Pessimistic Locking):** Tải và khóa các dòng tài khoản liên quan bằng `SELECT ... FOR UPDATE OF "account"` (`.setLock('pessimistic_write', undefined, ['account'])`), sắp xếp theo `ORDER BY account.id ASC`, và kiểm tra số dư ngay sau khi khóa.
  2. **Lớp 2 (Atomic Conditional Update):** Trừ tiền bằng câu lệnh nguyên tử có điều kiện `UPDATE accounts SET balance = balance - :amount WHERE id = :id AND balance >= :amount`.
* **Reason**: Thực nghiệm ở Bài 1.1 chứng minh chỉ có Database Transaction (`READ COMMITTED`) với `SELECT` thường sẽ bị lỗi Lost Update (20 request rút 100.000đ trên số dư 1.000.000đ đều báo thành công). Kết hợp `SELECT ... FOR UPDATE` với `UPDATE ... WHERE balance >= :amount` đảm bảo dữ liệu đọc ra luôn mới nhất, không một transaction nào xen ngang trong lúc kiểm tra nghiệp vụ, và tầng SQL luôn có chốt chặn chống âm quỹ cuối cùng.
* **Trade-offs**: Các giao dịch chạm vào cùng một tài khoản tại cùng một thời điểm phải xếp hàng tuần tự, được kiểm soát bởi `SET LOCAL lock_timeout = '5s'` (quá hạn trả `503 Service Unavailable`).

## ADR-004: Why Idempotency
* **Context**: Khi mạng chậm hoặc timeout, người dùng hoặc trình duyệt có thể gửi lặp lại cùng một yêu cầu giao dịch, dẫn đến nguy cơ trừ/cộng tiền hai lần.
* **Decision**: Bắt buộc client gửi header `Idempotency-Key` (định dạng UUID) cho mọi API tạo giao dịch (`transfer`, `deposit`, `withdraw`). Giao dịch tạo mới trả `201 Created`; gửi lặp lại cùng key và cùng payload trả `200 OK` kèm kết quả cũ; cùng key nhưng khác payload hoặc khác loại giao dịch trả `409 Conflict`.
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
* **Context**: Ở phiên bản khởi đầu, `synchronize: true` được dùng để tạo bảng nhanh từ Entity. Tuy nhiên khi mở rộng sang các bài tập nâng cao (thêm `CHECK` constraint, thay đổi enum, thêm bảng sổ cái kép và trigger bất biến), `synchronize: true` không thể kiểm soát thứ tự chuyển đổi dữ liệu và có nguy cơ tự động xóa cột ngoài ý muốn.
* **Decision**: Tắt hoàn toàn `synchronize: true` (`synchronize: false` trong `data-source.ts`), thiết lập Baseline Migration và quản lý mọi thay đổi schema thông qua TypeORM Migrations. Khi khởi động container Docker, `start.sh` chạy `migration:run:prod` trước khi chạy `seed` và khởi động ứng dụng.
* **Reason**: Đảm bảo mọi thay đổi cấu trúc DB đều tường minh, có thể kiểm soát phiên bản trên Git, hỗ trợ rollback (`down`) và cho phép định nghĩa các ràng buộc SQL nâng cao.
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
  1. **Chọn Pessimistic Locking làm cơ chế chính trên nhánh sản phẩm (`feat/module1`):** Khóa riêng bảng `account` bằng `.setLock('pessimistic_write', undefined, ['account'])` kèm `SET LOCAL lock_timeout = '5s'` (quá hạn trả `503`).
  2. **Khóa theo thứ tự cố định (`ORDER BY account.id ASC`):** Tải và khóa cả tài khoản nguồn lẫn tài khoản đích trong một câu truy vấn duy nhất sắp xếp theo `account.id` tăng dần.
  3. **Bọc vòng lặp Deadlock Retry (`executeWithDeadlockRetry`) bên ngoài Transaction:** Nếu PostgreSQL trả về mã lỗi `40P01`, tự động rollback, ghi log kèm bộ đếm (`deadlockDetected`, `retrySucceeded`, `retryExhausted`), chờ ngẫu nhiên `10–50ms` và thử lại tối đa `3 lần` (`MAX_DEADLOCK_RETRIES = 3`).
* **Reason (Dẫn chứng bằng số liệu thực nghiệm từ Bài 1.3 & 1.4)**:
  * Trong benchmark Bài 1.3 ở kịch bản tranh chấp cao **S2** (100 request đồng thời vào 1 tài khoản), **Pessimistic Locking** hoàn thành `100/100` giao dịch (`201`), đạt thông lượng **~275 req/s** và **`0` lỗi `503`**. Ngược lại, **Optimistic Locking** gặp bão thử lại (retry storm), thông lượng giảm còn **~80 req/s** và có **~35–55 request bị trả lỗi `503`** sau khi cạn 5 lần retry.
  * Trong thực nghiệm Bài 1.4 với 500 giao dịch chuyển khoản chéo A↔B (50 cặp × 5 vòng), khi khóa sai thứ tự (người gửi trước → người nhận sau ở nhánh `exp/1.4-deadlock-demo`), deadlock `40P01` xảy ra liên tục và mất ~15–35 giây để hoàn tất. Khi áp dụng **`ORDER BY account.id ASC`**, số lần deadlock giảm về **`0`** và toàn bộ 500 giao dịch hoàn tất trong **~2.2–4.0 giây**, bảo toàn tuyệt đối tổng số dư `20,000,000.00 VND`.
* **Trade-offs**:
  * Pessimistic Locking giữ khóa dòng trong suốt transaction nên nếu một transaction xử lý chậm sẽ làm các request sau trên cùng tài khoản đó phải xếp hàng chờ (đã được bảo vệ bởi `lock_timeout = '5s'`).
  * Bộ đếm Deadlock hiện lưu trong RAM của tiến trình NodeJS (sẽ reset khi khởi động lại container; việc đẩy metrics ra hệ thống giám sát tập trung thuộc phạm vi Module 6).