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

## 2. Transaction & Double-Entry Ledger Flow (Transfer / Deposit / Withdraw)

> **Ghi chú cho Nạp tiền (`deposit`), Rút tiền (`withdraw`) và Sổ cái kép (`ledger_entries`):**
> * Cả 3 nghiệp vụ (`transfer`, `deposit`, `withdraw`) đều chạy trong `executeWithDeadlockRetry()` và mở transaction có `SET LOCAL lock_timeout = '5s'`.
> * Với `transfer`: thực hiện cả `debitAccount` và `creditAccount` (lấy số dư mới qua `RETURNING balance`), lưu bản ghi `transactions`, sau đó ghi **2 bút toán cân bằng** (`1 DEBIT` cho tài khoản nguồn + `1 CREDIT` cho tài khoản đích) vào `ledger_entries`.
> * Với `deposit`: chỉ khóa `actorAccount`, thực hiện `creditAccount (... RETURNING balance)`, lưu bản ghi `transactions`, và ghi **1 bút toán `CREDIT`** vào `ledger_entries`.
> * Với `withdraw`: chỉ khóa `actorAccount`, kiểm tra số dư đã khóa, thực hiện `debitAccount (... RETURNING balance)`, lưu bản ghi `transactions`, và ghi **1 bút toán `DEBIT`** vào `ledger_entries`.
> * Nếu xảy ra bất kỳ lỗi nào ở giữa các bước (kể cả lỗi khi đang ghi bút toán), `queryRunner.rollbackTransaction()` hủy toàn bộ thay đổi số dư, giao dịch và bút toán trong transaction đó.

```mermaid
sequenceDiagram
    participant Client
    participant Controller as TransactionsController
    participant Service as TransactionsService
    participant Manager as Repository / EntityManager (TypeORM)
    participant DB as PostgreSQL

    Client->>Controller: POST /api/transactions/transfer | deposit | withdraw (Idempotency-Key)
    Controller->>Controller: Validate JWT, UUID Header & DTO
    Controller->>Service: transfer / deposit / withdraw(userId, idempotencyKey, dto)

    Service->>Manager: connect(), startTransaction() & SET LOCAL lock_timeout = '5s'

    Service->>Manager: loadAccountsForTransaction(userId, toAccountNumber?)
    Manager->>DB: SELECT account, user FROM accounts JOIN users ORDER BY account.id ASC FOR UPDATE OF account
    DB-->>Manager: locked accounts[]
    Manager-->>Service: { actorAccount, destAccount }

    Service->>Manager: findExistingByIdempotencyKey(actorAccount.id, idempotencyKey)
    Manager->>DB: SELECT * FROM transactions WHERE idempotency_key = $1 AND actor_account_id = $2
    DB-->>Manager: existingTx | null

    alt Idempotency Key Already Exists
        Manager-->>Service: existingTx
        Service->>Manager: rollbackTransaction() (No new ledger entries created)
        alt Same Payload (type, amount, description, toAccountNumber)
            Service-->>Controller: { isReplay: true, transaction }
            Controller-->>Client: 200 OK (Replay)
        else Different Payload or Different Type
            Service-->>Controller: throw ConflictException
            Controller-->>Client: 409 Conflict
        end
    else New Idempotency Key
        Manager-->>Service: null
        Service->>Service: Validate actorAccount, destAccount & locked balance

        alt Validation Failed or Insufficient Locked Balance
            Service->>Manager: rollbackTransaction()
            Service-->>Controller: throw 400 / 403 / 404 / 422
            Controller-->>Client: HTTP Error Response
        else Validation Passed
            opt Transfer or Withdraw
                Service->>Manager: debitAccount(actorAccount.id, amount)
                Manager->>DB: UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance
                DB-->>Manager: senderBalanceAfter
            end

            opt Transfer or Deposit
                Service->>Manager: creditAccount(targetAccount.id, amount)
                Manager->>DB: UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance
                DB-->>Manager: receiverBalanceAfter (or 22003 overflow)
            end

            Service->>Manager: insertTransactionRecord(...)
            Manager->>DB: INSERT INTO transactions (actor_account_id, idempotency_key, ...) RETURNING id
            DB-->>Manager: savedTx

            Service->>Manager: insertLedgerEntries(entries[])
            Manager->>DB: INSERT INTO ledger_entries (account_id, transaction_id, type, amount, balance_after)

            alt Mid-Transaction Error (DB Error / Overflow 22003 / Lock Timeout 55P03 / Crash)
                DB-->>Manager: Error
                Service->>Manager: rollbackTransaction() (Revert balance updates, transaction & any partial ledger entries)
                Service-->>Controller: throw 422 / 503 / 500 Exception
                Controller-->>Client: Error Response (No orphaned ledger entries)
            else All Steps Succeeded
                DB-->>Manager: ledger entries inserted
                Service->>Manager: commitTransaction()
                Service-->>Controller: { isReplay: false, transaction }
                Controller-->>Client: 201 Created
            end
        end
    end
```