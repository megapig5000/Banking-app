# Sequence Diagrams

## 1. Authentication Flow (Login)

```mermaid
sequenceDiagram
    participant Client
    participant Controller as AuthController
    participant Service as AuthService
    participant Repo as UserRepository (TypeORM)
    participant DB as PostgreSQL
    participant Bcrypt

    Client->>Controller: POST /api/auth/login {email, password}
    Controller->>Service: login(dto)
    Service->>Repo: findOne({email})
    Repo->>DB: SELECT * FROM users WHERE email = $1
    DB-->>Repo: User Record
    Repo-->>Service: user entity

    alt Email not found or Wrong Password
        Service->>Bcrypt: compare(password, hash)
        Bcrypt-->>Service: false
        Service-->>Controller: throw UnauthorizedException
        Controller-->>Client: 401 Unauthorized
    else Correct Password
        Service->>Bcrypt: compare(password, hash)
        Bcrypt-->>Service: true

        alt User is Locked
            Service-->>Controller: throw ForbiddenException
            Controller-->>Client: 403 Forbidden
        else User is Active
            Service->>Service: sign JWT(payload: { sub: user.id })
            Service-->>Controller: { accessToken, user }
            Controller-->>Client: 200 OK + JWT
        end
    end
```

## 2. Transaction & Double-Entry Ledger Flow — 3 Phases (Transfer / Deposit / Withdraw)

> **Ghi chú về Luồng 3 Pha (Pha A → Pha B → Pha C):**
> * **Pha A (Transaction ngắn 1):** Kiểm tra đầu vào (400/404), tra `Idempotency-Key` (nếu đã tồn tại: `COMPLETED/REVERSED -> 200`, `PROCESSING -> 202`, `FAILED -> lỗi cũ`, khác payload -> `409`), sau đó `INSERT` giao dịch ở trạng thái `INITIATED`, gọi `transition(INITIATED -> PROCESSING)` và `COMMIT` ngay.
> * **Pha B (Transaction chính 2 — có Deadlock Retry):** Khóa tài khoản bằng `SELECT ... FOR UPDATE OF "account"` theo `ORDER BY account.id ASC`, kiểm tra nghiệp vụ/số dư, trừ/cộng tiền (`RETURNING balance`), chèn bút toán `ledger_entries` và gọi `transition(PROCESSING -> COMPLETED)` trong **cùng một transaction** trước khi `COMMIT`.
> * **Pha C (Transaction ngắn 3 — khi Pha B lỗi):** Sau khi Pha B đã `ROLLBACK` hoàn toàn (số dư và sổ cái không đổi), mở transaction mới gọi `transition(PROCESSING -> FAILED, { failureCode })` rồi `COMMIT` và trả lỗi HTTP tương ứng cho client.

```mermaid
sequenceDiagram
    participant Client
    participant Controller as TransactionsController
    participant Service as TransactionsService
    participant Repo as Repository / EntityManager (TypeORM)
    participant DB as PostgreSQL

    Client->>Controller: POST /api/transactions/transfer | deposit | withdraw (Idempotency-Key)
    Controller->>Controller: Validate JWT, UUID Header & DTO
    Controller->>Service: transfer / deposit / withdraw(userId, idempotencyKey, dto)

    rect rgb(240, 248, 255)
        Note over Service,DB: PHA A — Tạo phiếu giao dịch (Transaction ngắn 1)
        Service->>Repo: startTransaction()
        Service->>Repo: findOne(Account by userId) & findExistingByIdempotencyKey()
        Repo->>DB: SELECT * FROM transactions WHERE idempotency_key = $1 AND actor_account_id = $2
        DB-->>Repo: existingTx | null

        alt Idempotency Key Already Exists (or 23505 on INSERT)
            Service->>Repo: rollbackTransaction()
            alt Payload Mismatch
                Service-->>Controller: throw ConflictException (409)
            else Status is COMPLETED or REVERSED
                Service-->>Controller: { statusCode: 200, transaction }
            else Status is INITIATED / PENDING_OTP / PROCESSING
                Service-->>Controller: { statusCode: 202, transaction }
            else Status is FAILED
                Service-->>Controller: throw Original Failure Exception (422 / 503 / 500)
            end
        else New Request (Valid Destination & Not Self-Transfer)
            Service->>Repo: save(Transaction status = INITIATED)
            Repo->>DB: INSERT INTO transactions (status = 'INITIATED', ...)
            Service->>Repo: transition(id, INITIATED -> PROCESSING)
            Repo->>DB: UPDATE transactions SET status = 'PROCESSING', updated_at = now() WHERE id = $1 AND status = 'INITIATED'
            Service->>Repo: commitTransaction()
        end
    end

    rect rgb(240, 255, 240)
        Note over Service,DB: PHA B — Xử lý tiền, Sổ cái & Đóng dấu COMPLETED (Transaction chính 2)
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
        Service->>Repo: commitTransaction()
        Service-->>Controller: { statusCode: 201, transaction }
        Controller-->>Client: 201 Created
    end

    rect rgb(255, 240, 240)
        Note over Service,DB: PHA C — Khi Pha B thất bại (Sau khi đã ROLLBACK Pha B)
        alt Any Error in Phase B (Insufficient Balance / Locked Dest / Overflow / Timeout / Crash)
            Service->>Repo: rollbackTransaction() (Revert balance & ledger entries in Phase B)
            Service->>Repo: startTransaction() (New short transaction for Phase C)
            Service->>Repo: transition(id, PROCESSING -> FAILED, { failureCode })
            Repo->>DB: UPDATE transactions SET status = 'FAILED', failure_code = $2, updated_at = now() WHERE id = $1 AND status = 'PROCESSING'
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
    participant Controller as TransactionsController (JwtAuthGuard + RolesGuard)
    participant Service as TransactionsService
    participant Repo as Repository / EntityManager (TypeORM)
    participant DB as PostgreSQL

    Client->>Controller: POST /api/transactions/:id/reverse (Bearer Admin JWT, Idempotency-Key)
    Controller->>Controller: Verify JWT & RolesGuard (req.user.role === 'admin', else 403)
    Controller->>Service: reverseTransaction(adminUserId, originalTxId, idempotencyKey, dto)

    rect rgb(240, 248, 255)
        Note over Service,DB: PHA A — Kiểm tra giao dịch gốc & Tạo phiếu REVERSAL
        Service->>Repo: startTransaction()
        Service->>Repo: findOne(originalTx by id) & findExistingByIdempotencyKey()
        Repo->>DB: SELECT * FROM transactions WHERE id = $1
        DB-->>Repo: originalTx

        alt Original Tx Not Found
            Service->>Repo: rollbackTransaction()
            Service-->>Controller: throw NotFoundException (404)
        else Original Tx is REVERSAL or status !== COMPLETED (and not Replay)
            Service->>Repo: rollbackTransaction()
            Service-->>Controller: throw ConflictException (409)
        else Valid COMPLETED Original Tx
            Service->>Repo: save(Transaction type = REVERSAL, status = INITIATED, original_transaction_id = originalTx.id)
            Repo->>DB: INSERT INTO transactions (checked by Partial Unique Index IDX_transactions_active_reversal_original)
            alt Concurrent Active Reversal Exists (Error 23505 on original_transaction_id)
                DB-->>Repo: Unique Violation 23505
                Service->>Repo: rollbackTransaction()
                Service-->>Controller: throw ConflictException (409)
            else Insert OK
                Service->>Repo: transition(reversalTx.id, INITIATED -> PROCESSING)
                Service->>Repo: commitTransaction()
            end
        end
    end

    rect rgb(240, 255, 240)
        Note over Service,DB: PHA B — Đảo bút toán, Đóng dấu REVERSAL COMPLETED & Gốc REVERSED
        Service->>Repo: startTransaction() & SET LOCAL lock_timeout = '5s'
        Service->>Repo: find(LedgerEntry where transaction_id = originalTx.id)
        Repo->>DB: SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY id ASC
        DB-->>Repo: originalEntries[]

        Service->>Repo: Lock involved accounts ORDER BY account.id ASC FOR UPDATE OF account
        Repo->>DB: SELECT * FROM accounts WHERE id IN (...) ORDER BY id ASC FOR UPDATE
        DB-->>Repo: lockedAccounts[]

        Service->>Service: Check sufficient balance on accounts to be debited (original CREDIT entries)

        loop For each originalEntry in originalEntries
            alt originalEntry.type === CREDIT
                Service->>Repo: debitAccount(account_id, amount) -> RETURNING balance
                Repo->>DB: UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance
            else originalEntry.type === DEBIT
                Service->>Repo: creditAccount(account_id, amount) -> RETURNING balance
                Repo->>DB: UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance
            end
        end

        Service->>Repo: insertLedgerEntries(inverseEntries[])
        Repo->>DB: INSERT INTO ledger_entries (DEBIT <-> CREDIT)

        Service->>Repo: transition(reversalTx.id, PROCESSING -> COMPLETED)
        Repo->>DB: UPDATE transactions SET status = 'COMPLETED', updated_at = now() WHERE id = $1 AND status = 'PROCESSING'

        Service->>Repo: transition(originalTx.id, COMPLETED -> REVERSED)
        Repo->>DB: UPDATE transactions SET status = 'REVERSED', updated_at = now() WHERE id = $1 AND status = 'COMPLETED'

        Service->>Repo: commitTransaction()
        Service-->>Controller: { statusCode: 201, transaction: completedReversal }
        Controller-->>Client: 201 Created
    end

    rect rgb(255, 240, 240)
        Note over Service,DB: PHA C — Khi bên nhận đã tiêu hết tiền (REVERSAL_INSUFFICIENT_BALANCE)
        alt Insufficient Balance on Receiver Account (or Phase B Error)
            Service->>Repo: rollbackTransaction() (Original Tx remains COMPLETED, balances unchanged)
            Service->>Repo: startTransaction()
            Service->>Repo: transition(reversalTx.id, PROCESSING -> FAILED, { failureCode: REVERSAL_INSUFFICIENT_BALANCE })
            Repo->>DB: UPDATE transactions SET status = 'FAILED', failure_code = 'REVERSAL_INSUFFICIENT_BALANCE' WHERE id = $1
            Service->>Repo: commitTransaction()
            Service-->>Controller: throw UnprocessableEntityException (422)
            Controller-->>Client: 422 Unprocessable Entity (Can retry with new key once receiver tops up)
        end
    end
```