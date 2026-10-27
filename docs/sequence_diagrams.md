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

## 2. Transaction Flow (Transfer / Deposit / Withdraw)

> **Ghi chú cho Nạp tiền (`deposit`) và Rút tiền (`withdraw`):**
> * Cả 3 nghiệp vụ (`transfer`, `deposit`, `withdraw`) đều đi qua cùng một cấu trúc bước xử lý trong `TransactionsService`[cite: 9].
> * Với `deposit`: chỉ tải `actorAccount` (`to_account_id = actorAccount.id`, `from_account_id = NULL`), bỏ qua bước `debitAccount` và chỉ thực hiện `creditAccount` (kèm bắt lỗi tràn số `22003` → `422`).
> * Với `withdraw`: chỉ tải `actorAccount` (`from_account_id = actorAccount.id`, `to_account_id = NULL`), chỉ thực hiện `debitAccount` có điều kiện `balance >= :amount` và bỏ qua `creditAccount`[cite: 9].

```mermaid
sequenceDiagram
    participant Client
    participant Controller as TransactionsController
    participant Service as TransactionsService
    participant Manager as EntityManager (QueryRunner)
    participant DB as PostgreSQL

    Client->>Controller: POST /api/transactions/transfer | deposit | withdraw (Idempotency-Key)
    Controller->>Controller: Validate JWT, UUID Header & DTO
    Controller->>Service: transfer / deposit / withdraw(userId, idempotencyKey, dto)

    Service->>Manager: connect() & startTransaction()

    Service->>Manager: loadAccountsForTransaction(userId, toAccountNumber?)
    Manager->>DB: SELECT account, user FROM accounts JOIN users ORDER BY account.id ASC
    DB-->>Manager: accounts[]
    Manager-->>Service: { actorAccount, destAccount }

    Service->>Manager: findExistingByIdempotencyKey(actorAccount.id, idempotencyKey)
    Manager->>DB: SELECT * FROM transactions WHERE idempotency_key = $1 AND actor_account_id = $2
    DB-->>Manager: existingTx | null

    alt Idempotency Key Already Exists
        Manager-->>Service: existingTx
        Service->>Manager: rollbackTransaction()
        alt Same Payload (type, amount, description, toAccountNumber)
            Service-->>Controller: { isReplay: true, transaction }
            Controller-->>Client: 200 OK (Replay)
        else Different Payload or Different Type
            Service-->>Controller: throw ConflictException
            Controller-->>Client: 409 Conflict
        end
    else New Idempotency Key
        Manager-->>Service: null
        Service->>Service: Validate actorAccount & destAccount (active, not self-transfer)

        alt Validation Failed
            Service->>Manager: rollbackTransaction()
            Service-->>Controller: throw 400 / 403 / 404 / 422
            Controller-->>Client: HTTP Error Response
        else Validation Passed
            opt Transfer or Withdraw
                Service->>Manager: debitAccount(actorAccount.id, amount)
                Manager->>DB: UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1
                DB-->>Manager: affected rows
            end

            alt Debit affected == 0 (Insufficient Balance)
                Service->>Manager: rollbackTransaction()
                Service-->>Controller: throw UnprocessableEntityException
                Controller-->>Client: 422 Không đủ số dư khả dụng
            else Debit OK (or Deposit)
                opt Transfer or Deposit
                    Service->>Manager: creditAccount(targetAccount.id, amount)
                    Manager->>DB: UPDATE accounts SET balance = balance + $1 WHERE id = $2
                    DB-->>Manager: ok (or 22003 overflow -> Rollback & 422)
                end

                Service->>Manager: insertTransactionRecord(...)
                Manager->>DB: INSERT INTO transactions (actor_account_id, idempotency_key, ...)

                alt Concurrent Duplicate Idempotency Key (Error 23505)
                    DB-->>Manager: Unique Violation 23505
                    Service->>Manager: rollbackTransaction()
                    Service->>DB: SELECT existing transaction by (idempotency_key, actor_account_id)
                    alt Same Payload
                        Service-->>Controller: { isReplay: true, transaction }
                        Controller-->>Client: 200 OK (Replay)
                    else Different Payload
                        Service-->>Controller: throw ConflictException
                        Controller-->>Client: 409 Conflict
                    end
                else Insert Success
                    DB-->>Manager: savedTx
                    Service->>Manager: commitTransaction()
                    Service-->>Controller: { isReplay: false, transaction }
                    Controller-->>Client: 201 Created
                end
            end
        end
    end
```