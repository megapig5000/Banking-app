import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User, UserStatus } from '../database/entities/user.entity';
import { Account } from '../database/entities/account.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { sanitizeHtml } from '../common/utils/sanitize.util';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { fullName, email, password } = registerDto;

    const existingUser = await this.userRepository.findOne({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException('Email đã tồn tại');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const sanitizedFullName = sanitizeHtml(fullName);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Tạo user
      const user = queryRunner.manager.create(User, {
        full_name: sanitizedFullName,
        email,
        password_hash: hashedPassword,
      });
      const savedUser = await queryRunner.manager.save(user);

      // 2. Tạo bank account ngẫu nhiên 10 số (logic tránh trùng lặp)
      let accountNumber = '';
      let isUnique = false;
      let attempts = 0;

      while (!isUnique && attempts < 5) {
        accountNumber = Math.floor(
          1000000000 + Math.random() * 9000000000,
        ).toString();
        const existingAcc = await queryRunner.manager.findOne(Account, {
          where: { account_number: accountNumber },
        });
        if (!existingAcc) isUnique = true;
        attempts++;
      }

      if (!isUnique) {
        throw new InternalServerErrorException(
          'Không thể tạo số tài khoản, vui lòng thử lại',
        );
      }

      const account = queryRunner.manager.create(Account, {
        user_id: savedUser.id,
        account_number: accountNumber,
        balance: '0.00',
        currency: 'VND',
      });
      await queryRunner.manager.save(account);

      await queryRunner.commitTransaction();

      // Mapping để không trả password_hash
      return {
        id: savedUser.id,
        fullName: savedUser.full_name,
        email: savedUser.email,
        role: savedUser.role,
        status: savedUser.status,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    if (user.status === UserStatus.LOCKED) {
      throw new ForbiddenException('Tài khoản của bạn đã bị khóa');
    }

    const payload = { sub: user.id };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        status: user.status,
      },
    };
  }
}
