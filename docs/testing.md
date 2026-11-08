# Chiến lược và Quy ước Kiểm thử (Testing Guide)

Tài liệu này mô tả kiến trúc kiểm thử theo mô hình **Kim tự tháp Kiểm thử (Testing Pyramid)**, quy ước viết bài test và cách vận hành bộ kiểm thử của dự án **Simple Banking App**.

---

## 1. Kim tự tháp Kiểm thử trong Dự án

Dự án kết hợp hai tầng kiểm thử bổ trợ chặt chẽ cho nhau:

| Tầng kiểm thử | Vị trí file | Lệnh chạy | Phụ thuộc | Mục đích bảo vệ |
| :--- | :--- | :--- | :--- | :--- |
| **1. Unit Tests** (Đáy tháp — Nhiều, cực nhanh) | `backend/src/**/*.spec.ts` | `npm run test:unit`<br>`npm run test:cov` | **Không cần Docker/DB** (dùng Mock/Stub trong bộ nhớ, chạy xong trong vài giây) | Kiểm chứng 100% logic quyết định nghiệp vụ, chuẩn hóa số tiền, hạn mức, trạng thái tài khoản, số dư khả dụng, State Machine 36 cặp, băm Idempotency, phân quyền RBAC, Validation DTO và mọi nhánh lỗi (`400/401/403/404/409/422/500/503`) cùng các giá trị biên (`0,01đ`). |
| **2. Integration / E2E Tests** (Đỉnh tháp — Chạy với DB thật) | `backend/test/*.e2e-spec.ts` | `npm run test:e2e` | Container `postgres-test` (cổng `5433`, dùng `tmpfs` trên RAM) | Kiểm chứng các cơ chế ở tầng PostgreSQL mà Mock không thể thay thế: câu lệnh SQL `UPDATE ... RETURNING`, khóa dòng `SELECT ... FOR UPDATE`, chống Deadlock `40P01`, Trigger bất biến (`ledger_entries`, `audit_logs`, `account_history`), ràng buộc `CHECK`, `Partial Unique Index` và bộ 10 truy vấn bất biến (`Q1′–Q10`). |

---

## 2. Quy ước Viết Unit Test

1. **Đặt tên theo hành vi bằng tiếng Việt:** Mô tả rõ điều kiện đầu vào và hành vi/kết quả kỳ vọng (ví dụ: `"từ chối với mã LIMIT_PER_TRANSACTION_EXCEEDED khi số tiền vượt hạn mức lần đúng 0.01đ"`).
2. **Cấu trúc 3 bước AAA (`Arrange – Act – Assert` — Sắp xếp – Hành động – Kiểm tra):**
   - **Arrange (Sắp xếp):** Khởi tạo dữ liệu mẫu bằng các hàm builder trong `src/test-utils/mock-helpers.ts` (`buildMockAccount`, `buildMockUser`...) và thiết lập giá trị trả về cho mock.
   - **Act (Hành động):** Gọi phương thức của hàm/service cần kiểm thử.
   - **Assert (Kiểm tra):** Khẳng định kết quả trả về, mã lỗi ném ra, hoặc kiểm tra xem bước quan trọng (như ghi nhận `FAILED` ở Pha C) có được gọi với đúng tham số hay không.
3. **Sử dụng kiểm thử theo bảng (`it.each`):** Khi kiểm tra một quy tắc trên nhiều bộ giá trị đầu vào/đầu ra (như kiểm tra số tiền hợp lệ/không hợp lệ, hoặc 36 cặp chuyển trạng thái), dùng `it.each(...)` thay vì viết vòng lặp `for` hay `if/else` bên trong bài test.
4. **Tính tất định (Deterministic — Không Flaky):**
   - Không dùng DB thật, mạng thật hay `setTimeout` chờ thật trong Unit Test.
   - Khi kiểm thử logic phụ thuộc thời gian (như mốc ngày theo giờ Việt Nam `Asia/Ho_Chi_Minh`), luôn đóng băng đồng hồ bằng `jest.useFakeTimers().setSystemTime(new Date(...))`.
   - Mọi mock được tự động làm sạch sau mỗi bài test nhờ `clearMocks: true` và `restoreMocks: true` trong `backend/jest.config.ts`.
   - Tuyệt đối không để lại `it.skip`, `describe.only`, `fit`, `xit` trong mã nguồn.

---

## 3. Cách chạy Kiểm thử và Đọc Báo cáo Độ phủ (Code Coverage)

### 3.1. Chạy Unit Test và Kiểm tra Ngưỡng Độ phủ (Không cần bật Docker)
```bash
cd backend

# Chạy nhanh toàn bộ Unit Test
npm run test:unit

# Chạy Unit Test kèm báo cáo độ phủ và kiểm tra ngưỡng ép (coverageThreshold)
npm run test:cov
```

### 3.2. Ngưỡng Độ phủ Bắt buộc (`coverageThreshold` trong `backend/jest.config.ts`)
Lệnh `npm run test:cov` sẽ **thất bại (exit code khác 0)** nếu bất kỳ chỉ số nào (`Statements`, `Branches`, `Functions`, `Lines`) tụt xuống dưới ngưỡng sau:
- **Nhóm `./src/transactions/`:** `≥ 80%` cho cả 4 chỉ số (`statements`, `branches`, `functions`, `lines`).
- **Nhóm `./src/accounts/`:** `≥ 80%` cho cả 4 chỉ số (`statements`, `branches`, `functions`, `lines`).
- **Toàn cục (`global`):** `≥ 75%` cho cả 4 chỉ số.

Cách đọc bảng báo cáo trên terminal:
- **`% Stmts` (Statements):** Tỷ lệ câu lệnh đã được thực thi.
- **`% Branch` (Branches):** Tỷ lệ các nhánh rẽ (`if/else`, `switch`, toán tử `?:`, `??`, `&&`, `||`) đã được kiểm tra — đây là chỉ số quan trọng nhất phản ánh các nhánh lỗi nghiệp vụ đã được phủ kín hay chưa.
- **`% Funcs` (Functions):** Tỷ lệ các hàm/phương thức đã được gọi.
- **`% Lines` (Lines):** Tỷ lệ dòng mã nguồn đã được đi qua.
- **`Uncovered Line #s`:** Số thứ tự dòng mã nguồn chưa có bài test nào đi qua.

### 3.3. Chạy Bộ E2E Tests trên Database Test riêng
```bash
# Bật container postgres-test ở cổng 5433 (từ thư mục gốc)
docker compose --profile test up -d postgres-test

# Chạy toàn bộ 8 bộ E2E Test Suites (66 bài kiểm thử tích hợp)
cd backend
npm run test:e2e
```