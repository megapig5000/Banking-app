import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class UpgradeUserRoleEnumAndCreateAuditLogs1710000005000 implements MigrationInterface {
  name = 'UpgradeUserRoleEnumAndCreateAuditLogs1710000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Đổi enum users_role_enum từ ('customer', 'admin') sang ('CUSTOMER', 'ADMIN') có ánh xạ dữ liệu cũ
    await queryRunner.query(
      `ALTER TYPE "public"."users_role_enum" RENAME TO "users_role_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('CUSTOMER', 'ADMIN')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT`,
    );
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "role" TYPE "public"."users_role_enum"
      USING (
        CASE "role"::text
          WHEN 'admin'    THEN 'ADMIN'::"public"."users_role_enum"
          WHEN 'customer' THEN 'CUSTOMER'::"public"."users_role_enum"
          ELSE "role"::text::"public"."users_role_enum"
        END
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'CUSTOMER'`,
    );
    await queryRunner.query(`DROP TYPE "public"."users_role_enum_old"`);

    // 2. Tạo bảng audit_logs (cột id kiểu BIGSERIAL đồng bộ với @PrimaryGeneratedColumn({ type: 'bigint' }))
    await queryRunner.createTable(
      new Table({
        name: 'audit_logs',
        columns: [
          {
            name: 'id',
            type: 'bigint',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'actor_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'action',
            type: 'varchar',
            length: '60',
            isNullable: false,
          },
          {
            name: 'entity',
            type: 'varchar',
            length: '60',
            isNullable: false,
          },
          {
            name: 'entity_id',
            type: 'varchar',
            length: '64',
            isNullable: true,
          },
          {
            name: 'ip_address',
            type: 'varchar',
            length: '64',
            isNullable: true,
          },
          {
            name: 'user_agent',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'before_data',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'after_data',
            type: 'jsonb',
            isNullable: true,
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

    // 3. Tạo các Index và Foreign Key cho bảng audit_logs
    await queryRunner.createIndex(
      'audit_logs',
      new TableIndex({
        columnNames: ['created_at'],
      }),
    );

    await queryRunner.createIndex(
      'audit_logs',
      new TableIndex({
        columnNames: ['actor_id', 'id'],
      }),
    );

    await queryRunner.createIndex(
      'audit_logs',
      new TableIndex({
        columnNames: ['entity', 'entity_id'],
      }),
    );

    await queryRunner.createForeignKey(
      'audit_logs',
      new TableForeignKey({
        columnNames: ['actor_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'RESTRICT',
      }),
    );

    // 4. Tạo Function và Trigger chặn UPDATE / DELETE trên bảng audit_logs (append-only)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_audit_logs_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only: % operation is not allowed', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_immutable
      BEFORE UPDATE OR DELETE ON "audit_logs"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_logs_modification();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Xóa Trigger, Function và bảng audit_logs
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON "audit_logs"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS prevent_audit_logs_modification()`,
    );
    await queryRunner.dropTable('audit_logs', true, true, true);

    // 2. Khôi phục enum users_role_enum về chữ thường ('customer', 'admin')
    await queryRunner.query(
      `ALTER TYPE "public"."users_role_enum" RENAME TO "users_role_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('customer', 'admin')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT`,
    );
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "role" TYPE "public"."users_role_enum"
      USING (
        CASE "role"::text
          WHEN 'ADMIN'    THEN 'admin'::"public"."users_role_enum"
          WHEN 'CUSTOMER' THEN 'customer'::"public"."users_role_enum"
          ELSE 'customer'::"public"."users_role_enum"
        END
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'customer'`,
    );
    await queryRunner.query(`DROP TYPE "public"."users_role_enum_old"`);
  }
}
