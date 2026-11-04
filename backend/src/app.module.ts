import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AccountsModule } from './accounts/accounts.module';
import { TransactionsModule } from './transactions/transactions.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { dataSourceOptions } from './database/data-source';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot(dataSourceOptions),
    AuthModule,
    AccountsModule,
    IdempotencyModule,
    TransactionsModule,
  ],
})
export class AppModule {}
