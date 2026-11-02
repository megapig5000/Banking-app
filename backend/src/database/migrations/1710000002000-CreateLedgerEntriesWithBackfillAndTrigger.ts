import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableCheck,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from 'typeorm';

export class CreateLedgerEntriesWithBackfillAndTrigger1710000002000 implements MigrationInterface {
  name = 'CreateLedgerEntriesWithBackfillAndTrigger1710000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tạo bảng ledger_entries (cùng enum ledger_entries_type_enum và cột id BIGSERIAL)
    await queryRunner.createTable(
      new Table({
        name: 'ledger_entries',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'account_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'transaction_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'type',
            type: 'enum',
            enum: ['DEBIT', 'CREDIT'],
            enumName: 'ledger_entries_type_enum',
            isNullable: false,
          },
          {
            name: 'amount',
            type: 'numeric',
            precision: 18,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'balance_after',
            type: 'numeric',
            precision: 18,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'now()',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // 2. Tạo Unique, Check constraints, Index và Foreign Keys (ON DELETE RESTRICT)
    await queryRunner.createUniqueConstraint(
      'ledger_entries',
      new TableUnique({
        columnNames: ['transaction_id', 'account_id', 'type'],
      }),
    );

    await queryRunner.createCheckConstraint(
      'ledger_entries',
      new TableCheck({
        name: 'CHK_ledger_entries_amount_positive',
        expression: `"amount" > 0`,
      }),
    );

    await queryRunner.createCheckConstraint(
      'ledger_entries',
      new TableCheck({
        name: 'CHK_ledger_entries_balance_non_negative',
        expression: `"balance_after" >= 0`,
      }),
    );

    await queryRunner.createIndex(
      'ledger_entries',
      new TableIndex({
        columnNames: ['account_id', 'id'],
      }),
    );

    await queryRunner.createForeignKey(
      'ledger_entries',
      new TableForeignKey({
        columnNames: ['account_id'],
        referencedTableName: 'accounts',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );

    await queryRunner.createForeignKey(
      'ledger_entries',
      new TableForeignKey({
        columnNames: ['transaction_id'],
        referencedTableName: 'transactions',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );

    // 3. Backfill dữ liệu từ các giao dịch 'success' đã tồn tại trong bảng transactions
    // Thứ tự sắp xếp xác định: created_at ASC, transaction_id ASC, type ASC
    await queryRunner.query(`
      WITH raw_entries AS (
        SELECT
          t.from_account_id AS account_id,
          t.id AS transaction_id,
          'DEBIT'::"public"."ledger_entries_type_enum" AS type,
          t.amount AS amount,
          t.created_at AS created_at
        FROM "transactions" t
        WHERE t.status = 'success'
          AND t.from_account_id IS NOT NULL

        UNION ALL

        SELECT
          t.to_account_id AS account_id,
          t.id AS transaction_id,
          'CREDIT'::"public"."ledger_entries_type_enum" AS type,
          t.amount AS amount,
          t.created_at AS created_at
        FROM "transactions" t
        WHERE t.status = 'success'
          AND t.to_account_id IS NOT NULL
      ),
      ordered_entries AS (
        SELECT
          re.account_id,
          re.transaction_id,
          re.type,
          re.amount,
          SUM(
            CASE
              WHEN re.type = 'CREDIT'::"public"."ledger_entries_type_enum" THEN re.amount
              ELSE -re.amount
            END
          ) OVER (
            PARTITION BY re.account_id
            ORDER BY re.created_at ASC, re.transaction_id ASC, re.type ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS balance_after,
          re.created_at
        FROM raw_entries re
      )
      INSERT INTO "ledger_entries" (
        "account_id",
        "transaction_id",
        "type",
        "amount",
        "balance_after",
        "created_at"
      )
      SELECT
        oe.account_id,
        oe.transaction_id,
        oe.type,
        oe.amount,
        oe.balance_after,
        oe.created_at
      FROM ordered_entries oe
      ORDER BY oe.created_at ASC, oe.transaction_id ASC, oe.type ASC
    `);

    // 4. Tạo Function và Trigger chặn UPDATE / DELETE trên bảng ledger_entries (tạo sau cùng)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_ledger_entries_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'ledger_entries is append-only: % operation is not allowed', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_ledger_entries_immutable
      BEFORE UPDATE OR DELETE ON "ledger_entries"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_entries_modification();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON "ledger_entries"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS prevent_ledger_entries_modification()`,
    );
    await queryRunner.dropTable('ledger_entries', true, true, true);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."ledger_entries_type_enum"`,
    );
  }
}