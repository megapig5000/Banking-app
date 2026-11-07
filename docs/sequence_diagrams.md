# Sequence Diagrams

Tài liệu này mô tả chi tiết luồng tương tác tuần tự giữa các tầng kiến trúc (`Client -> Middleware -> Guard -> Interceptor -> Controller -> Service -> TypeORM EntityManager / Subscriber -> PostgreSQL`) cho 5 nghiệp vụ cốt lõi của hệ thống.

---

## 1. Authentication Flow (Login + Automated Audit Interceptor)

```mermaid
sequenceDiagram
    participant Client
    participant MW as RequestContextMiddleware
    participant Interceptor as AuditInterceptor
    participant Controller as AuthController
    participant Service as AuthService
    participant AuditSvc as AuditService
    participant Repo as UserRepository (TypeORM)
    participant DB as PostgreSQL
    participant Bcrypt

    Client->>MW: POST /api/auth/login {email, password}
    MW->>Interceptor: requestContextStorage.run({ req })
    Interceptor->>Controller: login(dto)
    Controller->>Service: login(dto)
    Service->>Repo: findOne({ where: { email } }) (auto-filters deleted_at IS NULL)
    Repo->>DB: SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL
    DB-->>Repo: User Record (or null)
    Repo-->>Service: user entity
    
    alt User not found (or soft-deleted) or Wrong Password
        Service->>Bcrypt: compare(password, hash)
        Bcrypt-->>Service: false
        Service-->>Interceptor: throw UnauthorizedException (401)
        Interceptor->>AuditSvc: recordAuditLogBestEffort(AUTH_LOGIN_FAILED)
        AuditSvc->>DB: INSERT INTO audit_logs (actor_id=NULL, action='AUTH_LOGIN_FAILED', after_data={email, reason, httpStatus: 401})
        Interceptor-->>Client: 401 Unauthorized (error re-thrown intact)
    else Correct Password
        Service->>Bcrypt: compare(password, hash)
        Bcrypt-->>Service: true
        
        alt User is Locked (status = 'locked')
            Service-->>Interceptor: throw ForbiddenException (403)
            Interceptor->>AuditSvc: recordAuditLogBestEffort(AUTH_LOGIN_FAILED)
            AuditSvc->>DB: INSERT INTO audit_logs (actor_id=NULL, action='AUTH_LOGIN_FAILED', after_data={email, reason, httpStatus: 403})
            Interceptor-->>Client: 403 Forbidden (error re-thrown intact)
        else User is Active
            Service->>Service: sign JWT(payload: { sub: user.id })
            Service-->>Controller: { accessToken, user }
            Controller-->>Interceptor: { accessToken, user }
            Interceptor->>AuditSvc: recordAuditLogBestEffort(AUTH_LOGIN_SUCCESS)
            AuditSvc->>DB: INSERT INTO audit_logs (actor_id=user.id, action='AUTH_LOGIN_SUCCESS', after_data={email, role, httpStatus: 200})
            Interceptor-->>Client: 200 OK + { accessToken, user }
        end
    end
```

---

## 2. 3-Phase Transaction Flow with Account Status, Daily Limits, Available Balance & Idempotency Snapshot (`TRANSFER` / `DEPOSIT` / `WITHDRAW`)

```mermaid
sequenceDiagram
    participant Client
    participant Controller as TransactionsController
    participant Service as TransactionsService
    participant IdemSvc as IdempotencyService
    participant EM as EntityManager (TypeORM)
    participant DB as PostgreSQL

    Client->>Controller: POST /api/transactions/transfer (Header: Idempotency-Key)
    Controller->>Service: transfer(userId, idempotencyKey, dto)
    Service->>IdemSvc: computeRequestHash(payload)

    rect rgb(235, 245, 255)
        Note over Service,DB: PHA A — Đăng ký Khóa Idempotency & Tạo phiếu giao dịch (Transaction ngắn)
        Service->>EM: startTransaction()
        Service->>EM: findOne(Account, { user_id: userId, relations: ['user'] })
        Service->>IdemSvc: beginIdempotency(EM, userId, idempotencyKey, requestHash)
        IdemSvc->>DB: DELETE FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 AND expired_at <= NOW() AND status <> 'IN_PROGRESS'
        IdemSvc->>DB: INSERT INTO idempotency_keys (..., status='IN_PROGRESS') ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *
        
        alt Khóa đã tồn tại (ON CONFLICT trả về 0 dòng)
            IdemSvc->>DB: SELECT * FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2
            alt Khác request_hash (Đổi số tiền / người nhận / loại giao dịch)
                IdemSvc-->>Service: throw ConflictException (409)
                Service->>EM: rollbackTransaction()
                Service-->>Controller: 409 Conflict
                Controller-->>Client: 409 Conflict
            else Cùng request_hash (Replay từ Bản chụp)
                Service->>EM: rollbackTransaction()
                Service->>Service: resolveIdempotencyKeyReplay(record)
                Service-->>Controller: 200 OK (COMPLETED snapshot) | 202 Accepted (IN_PROGRESS) | 422/500/503 (FAILED snapshot)
                Controller-->>Client: Phản hồi Replay tương ứng
            end
        else Khóa mới (Chèn thành công dòng IN_PROGRESS)
            Service->>EM: Kiểm tra tài khoản đích tồn tại (404 nếu không có hoặc đã xóa mềm) & không tự chuyển (400)
            Service->>DB: INSERT INTO transactions (status = 'INITIATED', type = 'TRANSFER', ...)
            Service->>DB: UPDATE transactions SET status = 'PROCESSING', updated_at = now() WHERE id = $1 AND status = 'INITIATED'
            Service->>IdemSvc: attachTransactionId(EM, keyRecord.id, initiatedTx.id)
            IdemSvc->>DB: UPDATE idempotency_keys SET transaction_id = $1 WHERE id = $2 AND status = 'IN_PROGRESS'
            Service->>EM: commitTransaction()
        end
    end

    rect rgb(235, 255, 240)
        Note over Service,DB: PHA B — Khóa dòng, Kiểm tra Trạng thái/Hạn mức/Khả dụng, Chuyển tiền & Ghi Sổ cái (Có bọc Deadlock Retry)
        Service->>EM: startTransaction() + SET LOCAL lock_timeout = '5s'
        Service->>EM: loadAccountsForTransaction()
        EM->>DB: SELECT ... FROM accounts WHERE ... ORDER BY account.id ASC FOR UPDATE OF "account"
        DB-->>EM: Locked Accounts (actorAccount, destAccount)

        Service->>Service: 1) Kiểm tra user.status ('active' vs 'locked')
        Service->>Service: 2) ensureAccountActiveInPhaseB(actorAccount, 'source') & ensureAccountActiveInPhaseB(destAccount, 'destination')
        Service->>EM: 3) enforceOutgoingLimitsInPhaseB() -> calculateAccountLimits(EM, actorAccount.id, actorAccount.tier)
        EM->>DB: SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE from_account_id=$1 AND type IN ('TRANSFER','WITHDRAW') AND status='COMPLETED' AND created_at >= vnTodayStart
        DB-->>EM: usedToday
        Service->>Service: Kiểm tra amount <= perTransaction & (usedToday + amount) <= perDay
        Service->>Service: 4) ensureSufficientAvailableBalance() -> kiểm tra (balance - hold_amount) >= amount

        alt Hợp lệ (Tài khoản ACTIVE, trong hạn mức & đủ số dư khả dụng)
            Service->>DB: UPDATE accounts SET balance = balance - :amount WHERE id = :fromId AND status = 'ACTIVE' AND deleted_at IS NULL AND (balance - hold_amount) >= :amount RETURNING balance
            DB-->>Service: senderBalanceAfter
            Service->>DB: UPDATE accounts SET balance = balance + :amount WHERE id = :toId AND status = 'ACTIVE' AND deleted_at IS NULL RETURNING balance
            DB-->>Service: receiverBalanceAfter
            Service->>DB: INSERT INTO ledger_entries (DEBIT fromAccount, balance_after = senderBalanceAfter)
            Service->>DB: INSERT INTO ledger_entries (CREDIT toAccount, balance_after = receiverBalanceAfter)
            Service->>DB: UPDATE transactions SET status = 'COMPLETED', updated_at = now() WHERE id = :txId AND status = 'PROCESSING'
            Service->>IdemSvc: completeInTransaction(EM, keyRecord.id, 201, responseSnapshot)
            IdemSvc->>DB: UPDATE idempotency_keys SET status = 'COMPLETED', response_status = 201, response_body = $1 WHERE id = $2 AND status = 'IN_PROGRESS'
            Service->>EM: commitTransaction()
            Service-->>Controller: 201 Created + responseSnapshot
            Controller-->>Client: 201 Created
        else Lỗi ở Pha B (Tài khoản FROZEN/CLOSED, Vượt hạn mức lần/ngày, Thiếu số dư khả dụng, Đích bị khóa, Timeout khóa 55P03...)
            Service->>EM: rollbackTransaction() (Số dư & Sổ cái được khôi phục nguyên vẹn 100%)
            
            rect rgb(255, 240, 240)
                Note over Service,DB: PHA C — Ghi nhận giao dịch FAILED & Đóng khóa Idempotency (Transaction ngắn mới)
                Service->>EM: startTransaction()
                Service->>DB: UPDATE transactions SET status = 'FAILED', failure_code = :code, updated_at = now() WHERE id = :txId AND status = 'PROCESSING'
                Service->>IdemSvc: failInTransaction(EM, keyRecord.id, errorHttpStatus, errorResponseBody)
                IdemSvc->>DB: UPDATE idempotency_keys SET status = 'FAILED', response_status = $1, response_body = $2 WHERE id = $3 AND status = 'IN_PROGRESS'
                Service->>EM: commitTransaction()
            end
            
            Service-->>Controller: Throw HttpException (422 / 503 / 500 kèm message rõ ràng)
            Controller-->>Client: 422 / 503 / 500 Error Response
        end
    end
```

---

## 3. Transaction Reversal Flow (`POST /api/transactions/:id/reverse` — Admin Only + Audit)

```mermaid
sequenceDiagram
    participant Client as Admin Client
    participant Guard as JwtAuthGuard + RolesGuard
    participant Interceptor as AuditInterceptor
    participant Controller as TransactionsController
    participant Service as TransactionsService
    participant IdemSvc as IdempotencyService
    participant EM as EntityManager (TypeORM)
    participant DB as PostgreSQL

    Client->>Guard: POST /api/transactions/:id/reverse (Bearer Admin JWT + Idempotency-Key)
    alt Không phải ADMIN (role != 'ADMIN')
        Guard-->>Client: 403 Forbidden
    else Là ADMIN hợp lệ
        Guard->>Interceptor: Cho phép đi tiếp
        Interceptor->>Controller: reverseTransaction(req, id, dto)
        Controller->>Service: reverseTransaction(adminUserId, originalTxId, idempotencyKey, dto)

        rect rgb(235, 245, 255)
            Note over Service,DB: PHA A — Kiểm tra Idempotency, Kiểm tra Giao dịch gốc & Lập phiếu REVERSAL
            Service->>EM: startTransaction()
            Service->>IdemSvc: beginIdempotency(EM, adminUserId, idempotencyKey, requestHash)
            IdemSvc->>DB: INSERT INTO idempotency_keys (status='IN_PROGRESS', ...) ON CONFLICT DO NOTHING RETURNING *
            Service->>EM: findOne(Transaction, { id: originalTxId, withDeleted: true })
            alt Không tìm thấy (404) hoặc status != 'COMPLETED' / type == 'REVERSAL' (409)
                Service->>EM: rollbackTransaction() (Hủy luôn dòng khóa IN_PROGRESS vừa tạo)
                Service-->>Interceptor: 404 Not Found / 409 Conflict
                Interceptor-->>Client: 404 / 409 (Ghi Audit TRANSACTION_REVERSED outcome=ERROR)
            else Giao dịch gốc hợp lệ (status == 'COMPLETED')
                Service->>DB: INSERT INTO transactions (type='REVERSAL', status='INITIATED', original_transaction_id=originalTxId)
                Note right of DB: Partial Unique Index IDX_transactions_active_reversal_original<br/>chặn hoàn tiền 2 lần đồng thời (23505 -> 409)
                Service->>DB: UPDATE transactions SET status='PROCESSING' WHERE id=reversalTx.id AND status='INITIATED'
                Service->>IdemSvc: attachTransactionId(EM, keyRecord.id, reversalTx.id)
                Service->>EM: commitTransaction()
            end
        end

        rect rgb(235, 255, 240)
            Note over Service,DB: PHA B — Khóa tài khoản, Kiểm tra ACTIVE & Số dư khả dụng, Đảo bút toán & Đóng dấu kép
            Service->>EM: startTransaction() + SET LOCAL lock_timeout = '5s'
            Service->>DB: SELECT * FROM ledger_entries WHERE transaction_id = :originalTxId ORDER BY id ASC
            Service->>DB: SELECT * FROM accounts WHERE id IN (...) ORDER BY id ASC FOR UPDATE OF "account"
            Service->>Service: Kiểm tra mọi tài khoản liên quan đang ACTIVE & bên bị thu hồi đủ (balance - hold_amount) >= amount
            
            alt Tài khoản bị FROZEN/CLOSED hoặc bên nhận thiếu số dư khả dụng
                Service->>EM: rollbackTransaction()
                Note over Service,DB: PHA C — Đánh dấu phiếu REVERSAL là FAILED & đóng khóa Idempotency (Gốc vẫn giữ COMPLETED)
                Service->>DB: UPDATE transactions SET status='FAILED', failure_code=:code WHERE id=reversalTx.id
                Service->>IdemSvc: failInTransaction(EM, keyRecord.id, 422, errorBody)
                Service-->>Interceptor: 422 Unprocessable Entity
                Interceptor-->>Client: 422 Unprocessable Entity
            else Đủ điều kiện hoàn tiền
                Service->>DB: Đảo biến động số dư (debitAccount cho CREDIT gốc, creditAccount cho DEBIT gốc)
                Service->>DB: INSERT INTO ledger_entries (Các bút toán ngược chiều với giao dịch gốc)
                Service->>DB: UPDATE transactions SET status='COMPLETED' WHERE id=reversalTx.id AND status='PROCESSING'
                Service->>DB: UPDATE transactions SET status='REVERSED' WHERE id=originalTxId AND status='COMPLETED'
                Service->>IdemSvc: completeInTransaction(EM, keyRecord.id, 201, reversalSnapshot)
                Service->>EM: commitTransaction()
                Service-->>Controller: 201 Created + reversalSnapshot
                Controller-->>Interceptor: 201 Created + reversalSnapshot
                Interceptor->>DB: INSERT INTO audit_logs (action='TRANSACTION_REVERSED', entity='transactions', entity_id=originalTxId)
                Interceptor-->>Client: 201 Created
            end
        end
    end
```

---

## 4. Admin Lock/Unlock User Flow with Transactional Audit Subscriber (`PATCH /api/admin/users/:id/status`)

```mermaid
sequenceDiagram
    participant Client as Admin Client
    participant MW as RequestContextMiddleware
    participant Guard as JwtAuthGuard + RolesGuard
    participant Controller as AdminController
    participant Service as AdminService
    participant EM as EntityManager (TypeORM)
    participant Sub as UserAuditSubscriber
    participant DB as PostgreSQL

    Client->>MW: PATCH /api/admin/users/:id/status { status: "locked" }
    MW->>Guard: requestContextStorage.run({ req })
    Guard->>DB: SELECT * FROM users WHERE id = :adminId AND deleted_at IS NULL (JwtStrategy.validate)
    DB-->>Guard: adminUser (role = 'ADMIN', status = 'active')
    
    alt Người gọi không phải ADMIN (role != 'ADMIN')
        Guard-->>Client: 403 Forbidden
    else Người gọi là ADMIN hợp lệ
        Guard->>Controller: updateUserStatus(req, id, dto)
        Controller->>Service: updateUserStatus(adminUser.id, targetUserId, dto)
        
        alt Admin tự khóa chính mình (adminUser.id == targetUserId)
            Service-->>Controller: throw BadRequestException (400)
            Controller-->>Client: 400 Bad Request
        else Hợp lệ
            rect rgb(235, 255, 240)
                Note over Service,DB: Cùng một Database Transaction (dataSource.transaction)
                Service->>EM: startTransaction()
                Service->>EM: findOne(User, { where: { id: targetUserId }, relations: ['accounts'] })
                EM->>DB: SELECT ... FROM users WHERE id = $1 AND deleted_at IS NULL
                DB-->>EM: targetUser (status = 'active')
                EM->>Sub: afterLoad(targetUser) -> Lưu bản chụp vào WeakMap { status: 'active', ... }
                
                alt Trạng thái mới trùng trạng thái hiện tại
                    Service->>EM: commitTransaction()
                    Service-->>Controller: 200 OK (Không gọi save, không sinh Audit thừa)
                    Controller-->>Client: 200 OK
                else Trạng thái thay đổi ('active' -> 'locked')
                    Service->>Service: targetUser.status = 'locked'
                    Service->>EM: manager.save(User, targetUser)
                    EM->>DB: UPDATE users SET status = 'locked' WHERE id = $1
                    EM->>Sub: afterUpdate(event)
                    Sub->>Sub: So sánh WeakMap beforeSnapshot ({status:'active'}) vs afterSnapshot ({status:'locked'})
                    Sub->>Sub: getRequestContextSnapshot() -> { actorId: adminUser.id, ipAddress, userAgent }
                    Sub->>DB: event.manager.insert(AuditLog, { action: 'USER_STATUS_CHANGED', before_data: {status:'active'}, after_data: {status:'locked'} })
                    
                    alt Lỗi bất ngờ trước khi Commit
                        Service->>EM: rollbackTransaction() (Cả UPDATE users lẫn INSERT audit_logs đều được Rollback 100%)
                        Service-->>Client: 500 Internal Server Error
                    else Thành công
                        Service->>EM: commitTransaction()
                        Service-->>Controller: 200 OK + mappedAdminUser
                        Controller-->>Client: 200 OK
                    end
                end
            end
        end
    end
```

---

## 5. Admin Soft Delete User & Close Account Flow (`DELETE /api/admin/users/:id`)

```mermaid
sequenceDiagram
    participant Client as Admin Client
    participant MW as RequestContextMiddleware
    participant Guard as JwtAuthGuard + RolesGuard
    participant Controller as AdminController
    participant Service as AdminService
    participant EM as EntityManager (TypeORM)
    participant AccSub as AccountAuditSubscriber
    participant UserSub as UserAuditSubscriber
    participant DB as PostgreSQL

    Client->>MW: DELETE /api/admin/users/:id (Bearer Admin JWT)
    MW->>Guard: requestContextStorage.run({ req })
    Guard->>DB: SELECT * FROM users WHERE id = :adminId AND deleted_at IS NULL
    DB-->>Guard: adminUser (role = 'ADMIN', status = 'active')

    alt Không phải ADMIN (role != 'ADMIN')
        Guard-->>Client: 403 Forbidden
    else Là ADMIN hợp lệ
        Guard->>Controller: softDeleteUser(req, id)
        Controller->>Service: softDeleteUser(adminUser.id, targetUserId)

        alt Admin tự xóa chính mình (adminUser.id == targetUserId)
            Service-->>Controller: throw BadRequestException (400)
            Controller-->>Client: 400 Bad Request
        else Kiểm tra trong Database Transaction
            rect rgb(235, 255, 240)
                Note over Service,DB: Cùng một Database Transaction (Đóng tài khoản, Xóa mềm Account + User & Ghi Audit)
                Service->>EM: startTransaction()
                Service->>EM: findOne(User, { where: { id: targetUserId } }) (tự lọc deleted_at IS NULL)
                EM->>DB: SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL
                DB-->>EM: targetUser (hoặc null)
                EM->>UserSub: afterLoad(targetUser) -> Chụp snapshot vào WeakMap

                alt Không tìm thấy hoặc đã bị xóa mềm trước đó
                    Service->>EM: rollbackTransaction()
                    Service-->>Controller: throw NotFoundException (404)
                    Controller-->>Client: 404 Not Found
                else targetUser.role != 'CUSTOMER' (Cố tình xóa ADMIN khác)
                    Service->>EM: rollbackTransaction()
                    Service-->>Controller: throw ForbiddenException (403)
                    Controller-->>Client: 403 Forbidden
                else Là CUSTOMER đang tồn tại
                    Service->>EM: Khóa dòng Account của user bằng SELECT ... FOR UPDATE
                    EM->>DB: SELECT * FROM accounts WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id ASC FOR UPDATE OF "account"
                    DB-->>EM: lockedAccount
                    EM->>AccSub: afterLoad(lockedAccount) -> Chụp snapshot { status: 'ACTIVE', ... }
                    Service->>DB: SELECT COUNT(*) FROM transactions WHERE (from_account_id=$1 OR to_account_id=$1) AND status IN ('INITIATED','PENDING_OTP','PROCESSING')
                    DB-->>Service: pendingTxCount

                    alt balance > 0 HOẶC hold_amount > 0 HOẶC pendingTxCount > 0
                        Service->>EM: rollbackTransaction() (Không thay đổi bất kỳ dữ liệu nào)
                        Service-->>Controller: throw ConflictException (409)
                        Controller-->>Client: 409 Conflict (Nêu rõ lý do)
                    else Đủ điều kiện xóa mềm (balance = 0, hold = 0, pendingTxCount = 0)
                        Service->>EM: lockedAccount.status = 'CLOSED' -> manager.save(Account, lockedAccount)
                        EM->>DB: UPDATE accounts SET status = 'CLOSED' WHERE id = $1
                        EM->>AccSub: afterUpdate() -> event.manager.insert(AuditLog, action='ACCOUNT_UPDATED', before={status:'ACTIVE'}, after={status:'CLOSED'})
                        
                        Service->>EM: manager.softRemove(Account, lockedAccount)
                        EM->>DB: UPDATE accounts SET deleted_at = now() WHERE id = $1
                        
                        Service->>EM: manager.softRemove(User, targetUser)
                        EM->>DB: UPDATE users SET deleted_at = now() WHERE id = $1
                        EM->>UserSub: afterUpdate/afterSoftRemove() -> event.manager.insert(AuditLog, action='USER_SOFT_DELETED', before=userSnapshot, after={deletedAt})

                        alt Lỗi bất ngờ giữa chừng trước khi Commit
                            Service->>EM: rollbackTransaction() (Hoàn tác cả CLOSED, deleted_at và cả 2 dòng Audit Log!)
                            Service-->>Client: 500 Internal Server Error
                        else Thành công
                            Service->>EM: commitTransaction()
                            Service-->>Controller: Hoàn tất
                            Controller-->>Client: 204 No Content (Token cũ của user lập tức bị từ chối 401 ở request kế tiếp)
                        end
                    end
                end
            end
        end
    end
```