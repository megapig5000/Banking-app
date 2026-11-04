# Sequence Diagrams

## 1. Authentication Flow & Login Audit (`POST /api/auth/login`)

```mermaid
sequenceDiagram
    participant Client
    participant MW as RequestContextMiddleware
    participant Controller as AuthController + AuditInterceptor
    participant Service as AuthService
    participant Repo as UserRepository (TypeORM)
    participant Audit as AuditService
    participant DB as PostgreSQL
    participant Bcrypt

    Client->>MW: POST /api/auth/login {email, password}
    MW->>Controller: requestContextStorage.run({ req })
    Controller->>Service: login(dto)
    Service->>Repo: findOne({email})
    Repo->>DB: SELECT * FROM users WHERE email = $1
    DB-->>Repo: User Record
    Repo-->>Service: user entity

    alt Email not found or Wrong Password
        Service->>Bcrypt: compare(password, hash)
        Bcrypt-->>Service: false
        Service-->>Controller: throw UnauthorizedException (401)
        Controller->>Audit: recordAuditLogBestEffort(AUTH_LOGIN_FAILED, actor=null, email)
        Audit->>DB: INSERT INTO audit_logs (action='AUTH_LOGIN_FAILED', ...)
        Controller-->>Client: 401 Unauthorized (error re-thrown)
    else Correct Password
        Service->>Bcrypt: compare(password, hash)
        Bcrypt-->>Service: true

        alt User is Locked
            Service-->>Controller: throw ForbiddenException (403)
            Controller->>Audit: recordAuditLogBestEffort(AUTH_LOGIN_FAILED, actor=null, email)
            Audit->>DB: INSERT INTO audit_logs (action='AUTH_LOGIN_FAILED', ...)
            Controller-->>Client: 403 Forbidden (error re-thrown)
        else User is Active
            Service->>Service: sign JWT(payload: { sub: user.id })
            Service-->>Controller: { accessToken, user }
            Controller->>Audit: recordAuditLogBestEffort(AUTH_LOGIN_SUCCESS, actor=user.id)
            Audit->>DB: INSERT INTO audit_logs (action='AUTH_LOGIN_SUCCESS', ...)
            Controller-->>Client: 200 OK + JWT
        end
    end
```

## 2. Transaction, Idempotency Snapshot & Double-Entry Ledger Flow — 3 Phases (Transfer / Deposit / Withdraw)

> **Ghi chú về Luồng 3 Pha kết hợp Bảng `idempotency_keys` (Module 2 + 3A + 3B):**
> * **Pha A (Transaction ngắn 1):** Kiểm tra đầu vào, chuẩn hóa dữ liệu và băm SHA-256 (`request_hash`), xóa dòng khóa cũ đã hết hạn (`expired_at <= NOW() AND status <> 'IN_PROGRESS'`), rồi chạy `INSERT INTO idempotency_keys (status = 'IN_PROGRESS', ...) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`.
>   * Nếu **không chèn được** (khóa đã tồn tại): đọc dòng khóa cũ ngay trong transaction → nếu khác `request_hash` trả `409`; nếu `COMPLETED` trả `200 OK` kèm bản chụp `response_body`; nếu `FAILED` trả lại đúng lỗi đã lưu; nếu `IN_PROGRESS` trả `202 Accepted`.
>   * Nếu **chèn được** (khóa mới): kiểm tra tài khoản đích (`404`/`400`), tạo phiếu `Transaction` (`INITIATED → PROCESSING`), gắn `transaction_id` vào dòng khóa và `COMMIT`.
> * **Pha B (Transaction chính 2 — có Deadlock Retry):** Khóa tài khoản bằng `SELECT ... FOR UPDATE OF "account"` theo `ORDER BY account.id ASC`, trừ/cộng tiền (`RETURNING balance`), chèn bút toán `ledger_entries`, đóng dấu giao dịch `PROCESSING → COMPLETED`, và gọi `completeInTransaction()` chuyển dòng `idempotency_keys` sang `COMPLETED` kèm bản chụp `response_body` (`201`) trong **cùng một transaction** trước khi `COMMIT`.
> * **Pha C (Transaction ngắn 3 — khi Pha B lỗi):** Sau khi Pha B đã `ROLLBACK` hoàn toàn (số dư và sổ cái không đổi), mở transaction mới đóng dấu giao dịch `PROCESSING → FAILED` (`failure_code`) và đóng dấu dòng `idempotency_keys` sang `FAILED` kèm bản chụp lỗi trước khi `COMMIT`.

```mermaid
sequenceDiagram
    participant Client
    participant Controller as TransactionsController
    participant Service as TransactionsService
    participant Idem as IdempotencyService
    participant Repo as Repository / EntityManager (TypeORM)
    participant DB as PostgreSQL

    Client->>Controller: POST /api/transactions/transfer | deposit | withdraw (Idempotency-Key)
    Controller->>Controller: Validate JWT, UUID Header & DTO
    Controller->>Service: transfer / deposit / withdraw(userId, idempotencyKey, dto)
    Service->>Idem: computeRequestHash(normalizedPayload)

    rect rgb(240, 248, 255)
        Note over Service,DB: PHA A — Chiếm khóa Idempotency & Tạo phiếu giao dịch (Transaction ngắn 1)
        Service->>Repo: startTransaction()
        Service->>Repo: findOne(Account by userId)
        Service->>Idem: beginIdempotency(manager, userId, idempotencyKey, requestHash)
        Idem->>DB: DELETE FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 AND expired_at <= NOW() AND status <> 'IN_PROGRESS'
        Idem->>DB: INSERT INTO idempotency_keys (IN_PROGRESS, request_hash, expired_at) ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *
        DB-->>Idem: insertedRows[]

        alt Key Already Exists (insertedRows.length === 0)
            Idem->>DB: SELECT * FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2
            DB-->>Idem: existingRecord
            Service->>Repo: rollbackTransaction()
            alt existingRecord.request_hash !== requestHash
                Service-->>Controller: throw ConflictException (409)
            else existingRecord.status === COMPLETED
                Service-->>Controller: { statusCode: 200, transaction: existingRecord.response_body }
            else existingRecord.status === FAILED
                Service-->>Controller: throw HttpException(existingRecord.response_body, existingRecord.response_status)
            else existingRecord.status === IN_PROGRESS
                Service-->>Controller: { statusCode: 202, transaction: currentProcessingTx }
            end
        else New Key (insertedRows.length === 1)
            Service->>Repo: Validate destination account (404 / 400 self-transfer -> rollback both tx & key)
            Service->>Repo: save(Transaction status = INITIATED) & transition(INITIATED -> PROCESSING)
            Repo->>DB: INSERT INTO transactions & UPDATE status = 'PROCESSING'
            Service->>Idem: attachTransactionId(manager, record.id, savedTx.id)
            Idem->>DB: UPDATE idempotency_keys SET transaction_id = $1 WHERE id = $2
            Service->>Repo: commitTransaction()
        end
    end

    rect rgb(240, 255, 240)
        Note over Service,DB: PHA B — Xử lý tiền, Sổ cái & Lưu Bản chụp COMPLETED (Transaction chính 2)
        Service->>Repo: startTransaction() & SET LOCAL lock_timeout = '5s'
        Service->>Repo: loadAccountsForTransaction()
        Repo->>DB: SELECT account, user FROM accounts JOIN users ORDER BY account.id ASC FOR UPDATE OF account
        DB-->>Repo: locked accounts[]

        Service->>Service: Check destination status & locked balance

        opt Transfer or Withdraw
            Service->>Repo: debitAccount(actorAccount.id, amount)
            Repo->>DB: UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance
            DB-->>Repo: senderBalanceAfter
        end

        opt Transfer or Deposit
            Service->>Repo: creditAccount(targetAccount.id, amount)
            Repo->>DB: UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance
            DB-->>Repo: receiverBalanceAfter
        end

        Service->>Repo: insertLedgerEntries(entries[])
        Repo->>DB: INSERT INTO ledger_entries (account_id, transaction_id, type, amount, balance_after)

        Service->>Repo: transition(id, PROCESSING -> COMPLETED)
        Repo->>DB: UPDATE transactions SET status = 'COMPLETED', updated_at = now() WHERE id = $1 AND status = 'PROCESSING'

        Service->>Idem: completeInTransaction(manager, idempotencyRecordId, 201, snapshot)
        Idem->>DB: UPDATE idempotency_keys SET status = 'COMPLETED', response_status = 201, response_body = $2 WHERE id = $1 AND status = 'IN_PROGRESS'

        Service->>Repo: commitTransaction()
        Service-->>Controller: { statusCode: 201, transaction: snapshot }
        Controller-->>Client: 201 Created
    end

    rect rgb(255, 240, 240)
        Note over Service,DB: PHA C — Khi Pha B thất bại (Sau khi đã ROLLBACK Pha B)
        alt Any Error in Phase B (Insufficient Balance / Locked Dest / Overflow / Timeout / Crash)
            Service->>Repo: rollbackTransaction() (Revert balance & ledger entries in Phase B)
            Service->>Repo: startTransaction() (New short transaction for Phase C)
            Service->>Repo: transition(id, PROCESSING -> FAILED, { failureCode })
            Repo->>DB: UPDATE transactions SET status = 'FAILED', failure_code = $2, updated_at = now() WHERE id = $1 AND status = 'PROCESSING'
            Service->>Idem: failInTransaction(manager, idempotencyRecordId, errorStatus, errorBody)
            Idem->>DB: UPDATE idempotency_keys SET status = 'FAILED', response_status = $2, response_body = $3 WHERE id = $1 AND status = 'IN_PROGRESS'
            Service->>Repo: commitTransaction()
            Service-->>Controller: throw Mapped HTTP Exception (422 / 503 / 500)
            Controller-->>Client: HTTP Error Response
        end
    end
```

## 3. Transaction Reversal Flow (Admin Only — `POST /api/transactions/:id/reverse`)

```mermaid
sequenceDiagram
    participant Client as Admin Client
    participant Controller as TransactionsController (JwtAuthGuard + RolesGuard + AuditInterceptor)
    participant Service as TransactionsService
    participant Idem as IdempotencyService
    participant Repo as Repository / EntityManager (TypeORM)
    participant DB as PostgreSQL

    Client->>Controller: POST /api/transactions/:id/reverse (Bearer Admin JWT, Idempotency-Key)
    Controller->>Controller: Verify JWT & RolesGuard (req.user.role === 'ADMIN', else 403)
    Controller->>Service: reverseTransaction(adminUserId, originalTxId, idempotencyKey, dto)
    Service->>Idem: computeRequestHash({ operation: 'REVERSE', originalTransactionId, reason })

    rect rgb(240, 248, 255)
        Note over Service,DB: PHA A — Chiếm khóa Idempotency của Admin & Tạo phiếu REVERSAL
        Service->>Repo: startTransaction()
        Service->>Idem: beginIdempotency(manager, adminUserId, idempotencyKey, requestHash)
        Idem->>DB: INSERT INTO idempotency_keys ... ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *

        alt Key Already Exists for Admin
            Service->>Repo: rollbackTransaction()
            Service-->>Controller: Replay saved snapshot (200 / 202 / saved error) or 409 if hash mismatch
        else New Key
            Service->>Repo: findOne(originalTx by id)
            alt Original Tx Not Found (404) or status !== COMPLETED / type === REVERSAL (409)
                Service->>Repo: rollbackTransaction() (Also rolls back IN_PROGRESS idempotency key)
                Service-->>Controller: throw 404 or 409
            else Valid COMPLETED Original Tx
                Service->>Repo: save(Transaction type = REVERSAL, status = INITIATED) & transition(INITIATED -> PROCESSING)
                Service->>Idem: attachTransactionId(manager, record.id, savedReversal.id)
                Service->>Repo: commitTransaction()
            end
        end
    end

    rect rgb(240, 255, 240)
        Note over Service,DB: PHA B — Đảo bút toán, Đóng dấu REVERSAL COMPLETED, Gốc REVERSED & Lưu Snapshot
        Service->>Repo: startTransaction() & SET LOCAL lock_timeout = '5s'
        Service->>Repo: find(LedgerEntry where transaction_id = originalTx.id)
        Service->>Repo: Lock involved accounts ORDER BY account.id ASC FOR UPDATE OF account
        Service->>Service: Check sufficient balance on accounts to be debited (original CREDIT entries)
        Service->>Repo: Debit & Credit inverse amounts (RETURNING balance)
        Service->>Repo: insertLedgerEntries(inverseEntries[])
        Service->>Repo: transition(reversalTx.id, PROCESSING -> COMPLETED)
        Service->>Repo: transition(originalTx.id, COMPLETED -> REVERSED)
        Service->>Idem: completeInTransaction(manager, idempotencyRecordId, 201, snapshot)
        Service->>Repo: commitTransaction()
        Service-->>Controller: { statusCode: 201, transaction: snapshot }
        Controller->>DB: AuditInterceptor records TRANSACTION_REVERSED in audit_logs
        Controller-->>Client: 201 Created
    end

    rect rgb(255, 240, 240)
        Note over Service,DB: PHA C — Khi bên nhận đã tiêu hết tiền (REVERSAL_INSUFFICIENT_BALANCE)
        alt Insufficient Balance on Receiver Account (or Phase B Error)
            Service->>Repo: rollbackTransaction() (Original Tx remains COMPLETED, balances unchanged)
            Service->>Repo: startTransaction()
            Service->>Repo: transition(reversalTx.id, PROCESSING -> FAILED, { failureCode: REVERSAL_INSUFFICIENT_BALANCE })
            Service->>Idem: failInTransaction(manager, idempotencyRecordId, 422, errorBody)
            Service->>Repo: commitTransaction()
            Service-->>Controller: throw UnprocessableEntityException (422)
            Controller->>DB: AuditInterceptor records TRANSACTION_REVERSED (outcome=ERROR)
            Controller-->>Client: 422 Unprocessable Entity (Can retry with new key once receiver tops up)
        end
    end
```

## 4. Admin Lock/Unlock User & Transactional Audit Subscriber Flow (`PATCH /api/admin/users/:id/status`)

```mermaid
sequenceDiagram
    participant Client as Admin Client
    participant MW as RequestContextMiddleware
    participant Guard as JwtAuthGuard + RolesGuard
    participant Controller as AdminController
    participant Service as AdminService
    participant Repo as EntityManager (TypeORM)
    participant Sub as UserAuditSubscriber
    participant DB as PostgreSQL

    Client->>MW: PATCH /api/admin/users/:id/status { status: "locked" }
    MW->>Guard: requestContextStorage.run({ req })
    Guard->>DB: SELECT * FROM users WHERE id = payload.sub
    DB-->>Guard: currentAdminUser (role = 'ADMIN', status = 'active')

    alt Not Authenticated (401) or Role !== 'ADMIN' (403)
        Guard-->>Client: 401 Unauthorized / 403 Forbidden
    else Valid ADMIN
        Guard->>Controller: req.user = currentAdminUser
        Controller->>Service: updateUserStatus(adminUserId, targetUserId, dto)

        alt adminUserId === targetUserId (Self-Lock Prevention)
            Service-->>Controller: throw BadRequestException (400)
            Controller-->>Client: 400 Bad Request
        else Valid Target User ID
            rect rgb(240, 255, 240)
                Note over Service,DB: Single Database Transaction (User Update + Audit Log Insert)
                Service->>Repo: dataSource.transaction(async manager => ...)
                Repo->>DB: BEGIN
                Service->>Repo: manager.findOne(User, { where: { id: targetUserId }, relations: { accounts: true } })
                Repo->>DB: SELECT user, account FROM users LEFT JOIN accounts WHERE user.id = $1
                DB-->>Repo: targetUser (status = 'active')
                Repo->>Sub: afterLoad(targetUser) -> WeakMap captures beforeSnapshot { status: 'active', ... }

                alt targetUser.status === dto.status (No Change)
                    Service->>Repo: COMMIT (No save() called, 0 audit logs created)
                    Service-->>Controller: mappedUser
                    Controller-->>Client: 200 OK
                else Status Changed ('active' -> 'locked')
                    Service->>Service: targetUser.status = 'locked'
                    Service->>Repo: manager.save(User, targetUser)
                    Repo->>DB: UPDATE users SET status = 'locked' WHERE id = $1
                    Repo->>Sub: afterUpdate(event) (inside same transaction)
                    Sub->>Sub: Compare WeakMap beforeSnapshot ('active') vs afterSnapshot ('locked')
                    Sub->>Sub: Read actorId, ipAddress, userAgent from AsyncLocalStorage (lazy read)
                    Sub->>Repo: event.manager.insert(AuditLog, { action: 'USER_STATUS_CHANGED', before_data: {status:'active'}, after_data: {status:'locked'} })
                    Repo->>DB: INSERT INTO audit_logs (...)

                    alt Transaction Succeeds
                        Service->>Repo: COMMIT (Both users.status and audit_logs committed atomically)
                        Service-->>Controller: mappedUser
                        Controller-->>Client: 200 OK
                    else Any Error Before Commit
                        Service->>Repo: ROLLBACK (Both users.status update and audit_logs insert rolled back 100%)
                        Service-->>Controller: throw Error (500)
                        Controller-->>Client: 500 Internal Server Error
                    end
                end
            end
        end
    end
```