import {
  MigrationInterface,
  QueryRunner,
  TableCheck,
  TableColumn,
  TableForeignKey,
} from 'typeorm';

export class UpgradeTransactionsStateMachineAndReversalSchema1710000003000 implements MigrationInterface {
  name = 'UpgradeTransactionsStateMachineAndReversalSchema1710000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Xóa CHECK constraint cũ đang phụ thuộc vào giá trị enum chữ thường
    await queryRunner.dropCheckConstraint(
      'transactions',
      'CHK_transactions_type_accounts',
    );

    // 2. Đổi enum transactions_type_enum sang chữ HOA và thêm 'REVERSAL'
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" RENAME TO "transactions_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('TRANSFER', 'DEPOSIT', 'WITHDRAW', 'REVERSAL')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" DROP DEFAULT`,
    );
    await queryRunner.query(`
      ALTER TABLE "transactions"
      ALTER COLUMN "type" TYPE "public"."transactions_type_enum"
      USING (
        CASE "type"::text
          WHEN 'transfer' THEN 'TRANSFER'::"public"."transactions_type_enum"
          WHEN 'deposit'  THEN 'DEPOSIT'::"public"."transactions_type_enum"
          WHEN 'withdraw' THEN 'WITHDRAW'::"public"."transactions_type_enum"
          ELSE "type"::text::"public"."transactions_type_enum"
        END
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" SET DEFAULT 'TRANSFER'`,
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum_old"`);

    // 3. Đổi enum transactions_status_enum sang chữ HOA (State Machine đầy đủ)
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_status_enum" RENAME TO "transactions_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum" AS ENUM('INITIATED', 'PENDING_OTP', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(`
      ALTER TABLE "transactions"
      ALTER COLUMN "status" TYPE "public"."transactions_status_enum"
      USING (
        CASE "status"::text
          WHEN 'success' THEN 'COMPLETED'::"public"."transactions_status_enum"
          WHEN 'failed'  THEN 'FAILED'::"public"."transactions_status_enum"
          WHEN 'pending' THEN 'INITIATED'::"public"."transactions_status_enum"
          ELSE "status"::text::"public"."transactions_status_enum"
        END
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "status" SET DEFAULT 'INITIATED'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."transactions_status_enum_old"`,
    );

    // 4. Thêm 3 cột mới: original_transaction_id, failure_code, updated_at
    await queryRunner.addColumn(
      'transactions',
      new TableColumn({
        name: 'original_transaction_id',
        type: 'uuid',
        isNullable: true,
      }),
    );

    await queryRunner.addColumn(
      'transactions',
      new TableColumn({
        name: 'failure_code',
        type: 'varchar',
        length: '50',
        isNullable: true,
      }),
    );

    await queryRunner.addColumn(
      'transactions',
      new TableColumn({
        name: 'updated_at',
        type: 'timestamptz',
        default: 'now()',
        isNullable: true,
      }),
    );

    // Backfill updated_at = created_at cho các bản ghi lịch sử đã tồn tại
    await queryRunner.query(
      `UPDATE "transactions" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "updated_at" SET NOT NULL`,
    );

    await queryRunner.createForeignKey(
      'transactions',
      new TableForeignKey({
        columnNames: ['original_transaction_id'],
        referencedTableName: 'transactions',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );

    // 5. Tạo lại CHECK constraint với các giá trị enum HOA và quy tắc REVERSAL
    await queryRunner.createCheckConstraint(
      'transactions',
      new TableCheck({
        name: 'CHK_transactions_type_accounts',
        expression: `("type" = 'TRANSFER' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NOT NULL AND "from_account_id" <> "to_account_id" AND "original_transaction_id" IS NULL) OR ("type" = 'DEPOSIT' AND "from_account_id" IS NULL AND "to_account_id" IS NOT NULL AND "original_transaction_id" IS NULL) OR ("type" = 'WITHDRAW' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL AND "original_transaction_id" IS NULL) OR ("type" = 'REVERSAL' AND ("from_account_id" IS NOT NULL OR "to_account_id" IS NOT NULL) AND ("from_account_id" IS NULL OR "to_account_id" IS NULL OR "from_account_id" <> "to_account_id") AND "original_transaction_id" IS NOT NULL)`,
      }),
    );

    // 6. Tạo Partial Unique Index chống hoàn tiền 2 lần (loại trừ FAILED để cho phép thử lại)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_transactions_active_reversal_original"
      ON "transactions" ("original_transaction_id")
      WHERE "type" = 'REVERSAL' AND "status" IN ('INITIATED', 'PENDING_OTP', 'PROCESSING', 'COMPLETED')
    `);

    // 7. Tạo Partial Index phục vụ job quét giao dịch treo ở trạng thái PROCESSING
    await queryRunner.query(`
      CREATE INDEX "IDX_transactions_processing_updated_at"
      ON "transactions" ("updated_at")
      WHERE "status" = 'PROCESSING'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Xóa các Partial Indexes và CHECK constraint mới
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_transactions_processing_updated_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_transactions_active_reversal_original"`,
    );
    await queryRunner.dropCheckConstraint(
      'transactions',
      'CHK_transactions_type_accounts',
    );

    // 2. Xóa các bản ghi REVERSAL (nếu có) trước khi quay về enum cũ
    // Lưu ý: Tạm tắt trigger trên ledger_entries nếu cần xóa bút toán của REVERSAL khi revert
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" DISABLE TRIGGER trg_ledger_entries_immutable`,
    );
    await queryRunner.query(`
      DELETE FROM "ledger_entries"
      WHERE "transaction_id" IN (SELECT "id" FROM "transactions" WHERE "type" = 'REVERSAL')
    `);
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" ENABLE TRIGGER trg_ledger_entries_immutable`,
    );
    await queryRunner.query(
      `DELETE FROM "transactions" WHERE "type" = 'REVERSAL'`,
    );

    // 3. Xóa FK và 3 cột mới
    const table = await queryRunner.getTable('transactions');
    const origFk = table?.foreignKeys.find((fk) =>
      fk.columnNames.includes('original_transaction_id'),
    );
    if (origFk) {
      await queryRunner.dropForeignKey('transactions', origFk);
    }

    await queryRunner.dropColumn('transactions', 'updated_at');
    await queryRunner.dropColumn('transactions', 'failure_code');
    await queryRunner.dropColumn('transactions', 'original_transaction_id');

    // 4. Khôi phục enum transactions_status_enum về chữ thường ('success', 'failed', 'pending')
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_status_enum" RENAME TO "transactions_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum" AS ENUM('success', 'failed', 'pending')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(`
      ALTER TABLE "transactions"
      ALTER COLUMN "status" TYPE "public"."transactions_status_enum"
      USING (
        CASE "status"::text
          WHEN 'COMPLETED'   THEN 'success'::"public"."transactions_status_enum"
          WHEN 'REVERSED'    THEN 'success'::"public"."transactions_status_enum"
          WHEN 'FAILED'      THEN 'failed'::"public"."transactions_status_enum"
          WHEN 'INITIATED'   THEN 'pending'::"public"."transactions_status_enum"
          WHEN 'PENDING_OTP' THEN 'pending'::"public"."transactions_status_enum"
          WHEN 'PROCESSING'  THEN 'pending'::"public"."transactions_status_enum"
          ELSE 'pending'::"public"."transactions_status_enum"
        END
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "status" SET DEFAULT 'success'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."transactions_status_enum_old"`,
    );

    // 5. Khôi phục enum transactions_type_enum về chữ thường ('transfer', 'deposit', 'withdraw')
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" RENAME TO "transactions_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('transfer', 'deposit', 'withdraw')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" DROP DEFAULT`,
    );
    await queryRunner.query(`
      ALTER TABLE "transactions"
      ALTER COLUMN "type" TYPE "public"."transactions_type_enum"
      USING (
        CASE "type"::text
          WHEN 'TRANSFER' THEN 'transfer'::"public"."transactions_type_enum"
          WHEN 'DEPOSIT'  THEN 'deposit'::"public"."transactions_type_enum"
          WHEN 'WITHDRAW' THEN 'withdraw'::"public"."transactions_type_enum"
          ELSE 'transfer'::"public"."transactions_type_enum"
        END
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" SET DEFAULT 'transfer'`,
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum_old"`);

    // 6. Khôi phục CHECK constraint chữ thường của Phase 0
    await queryRunner.createCheckConstraint(
      'transactions',
      new TableCheck({
        name: 'CHK_transactions_type_accounts',
        expression: `("type" = 'transfer' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NOT NULL AND "from_account_id" <> "to_account_id") OR ("type" = 'deposit' AND "from_account_id" IS NULL AND "to_account_id" IS NOT NULL) OR ("type" = 'withdraw' AND "from_account_id" IS NOT NULL AND "to_account_id" IS NULL)`,
      }),
    );
  }
}
