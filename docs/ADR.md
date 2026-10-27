# Architecture Decision Records (ADR)

## ADR-001: Why NestJS + PostgreSQL + TypeORM
* **Context**: Cần chọn stack backend cho ứng dụng ngân hàng đáp ứng yêu cầu kiến trúc phân tầng rõ ràng và đảm bảo tính toàn vẹn dữ liệu giao dịch.
* **Decision**: Sử dụng NestJS (TypeScript) làm backend framework, TypeORM làm ORM và PostgreSQL làm hệ quản trị cơ sở dữ liệu.
* **Reason**: NestJS cung cấp sẵn kiến trúc module hóa (`Controller -> Service -> Repository`) và tích hợp sẵn `ValidationPipe`, Guard, Swagger. TypeORM hỗ trợ tốt quản lý Database Transaction (`QueryRunner`) và Migration. PostgreSQL tuân thủ chuẩn ACID và hỗ trợ tốt kiểu số thập phân chính xác (`numeric`).
* **Trade-offs**: Cấu hình khởi đầu của NestJS và TypeORM Migration nhiều bước hơn so với ExpressJS thuần, nhưng giúp mã nguồn nhất quán và dễ mở rộng.

## ADR-002: Why numeric(18,2)
* **Context**: Cần chọn kiểu dữ liệu lưu trữ và tính toán số tiền (`balance`, `amount`) cho tiền tệ VND.
* **Decision**: Sử dụng `numeric(18,2)` trong PostgreSQL, truyền và trả dữ liệu qua JSON dưới dạng `string` (ví dụ `"50000.00"`), và thực hiện cộng/trừ trực tiếp bằng biểu thức SQL trong PostgreSQL.
* **Reason**: Kiểu `float` hoặc `double` (IEEE 754) bị sai số làm tròn dấu phẩy động, không được phép dùng trong ứng dụng tài chính. `numeric(18,2)` lưu trữ chính xác tuyệt đối tới từng xu và chịu được giá trị lên tới hàng triệu tỷ đồng.
* **Trade-offs**: TypeORM ánh xạ cột `numeric` thành `string` trong TypeScript nên cần validate định dạng bằng regex `^\d{1,16}(\.\d{1,2})?$` ở DTO và bắt lỗi tràn số (`22003`) ở tầng database.

## ADR-003: Why Database Transaction + Atomic Conditional Update
* **Context**: Các thao tác biến động số dư (chuyển khoản, nạp tiền, rút tiền) cần đảm bảo không để lại dữ liệu dở dang khi lỗi và không gây âm quỹ khi có nhiều request rút/chuyển tiền đồng thời.
* **Decision**:
  1. Bọc toàn bộ các bước kiểm tra, cập nhật số dư và tạo bản ghi giao dịch trong một Database Transaction (`QueryRunner`).
  2. Trừ tiền bằng câu lệnh nguyên tử có điều kiện: `UPDATE accounts SET balance = balance - :amount WHERE id = :id AND balance >= :amount`. Nếu `affected === 0`, rollback và trả lỗi `422`.
  3. Tải tất cả các tài khoản liên quan trong một truy vấn duy nhất có `ORDER BY account.id ASC`.
* **Reason**: Ở mức cô lập mặc định `READ COMMITTED` của PostgreSQL, câu lệnh `UPDATE ... WHERE balance >= :amount` tự động khóa dòng đang cập nhật và đánh giá lại điều kiện `WHERE` sau khi transaction trước commit, ngăn chặn âm quỹ. Việc sắp xếp `account.id ASC` chuẩn bị sẵn thứ tự khóa cố định cho các module nâng cao.
* **Trade-offs & Known Limitations**: Phiên bản hiện tại chưa bật Pessimistic Locking (`SELECT ... FOR UPDATE`), Optimistic Locking (`version`) và chưa có cơ chế tự động retry khi xảy ra Deadlock (sẽ được triển khai ở Module 1 của bộ bài tập bổ sung).

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
* **Reason**:
  * Không cần tạo tài khoản hệ thống ảo (tránh phải viết ngoại lệ cho phép âm quỹ hoặc ẩn tài khoản ảo khỏi luồng người dùng).
  * Cột `actor_account_id` giúp cả 3 loại giao dịch (`transfer`, `deposit`, `withdraw`) chia sẻ chung một phạm vi khóa Idempotency duy nhất, ngăn chặn việc dùng lại cùng một `Idempotency-Key` cho loại giao dịch khác (trả về `409 Conflict`) và tương thích 100% với decorator `@Unique` của TypeORM.
* **Trade-offs**: Bảng `transactions` có thêm cột `actor_account_id`, đổi lại câu truy vấn kiểm tra Idempotency đơn giản, đồng nhất và không dùng index biểu thức phức tạp.