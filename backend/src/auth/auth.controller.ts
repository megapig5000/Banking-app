import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseInterceptors,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { Audit } from '../audit/audit.decorator';
import { AuditAction, AuditEntity } from '../audit/audit.constants';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Đăng ký tài khoản' })
  @ApiResponse({ status: 201, description: 'Đăng ký thành công' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 409, description: 'Email đã tồn tại' })
  async register(@Body() registerDto: RegisterDto) {
    const user = await this.authService.register(registerDto);
    return { user };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(AuditInterceptor)
  @Audit({
    action: AuditAction.AUTH_LOGIN_SUCCESS,
    failureAction: AuditAction.AUTH_LOGIN_FAILED,
    entity: AuditEntity.USERS,
    onSuccess: (_req, result) => ({
      actorId: result?.user?.id ?? null,
      entityId: result?.user?.id ?? null,
      afterData: {
        email: result?.user?.email ?? null,
        role: result?.user?.role ?? null,
      },
    }),
    onError: (req, error) => ({
      actorId: null,
      entityId: null,
      afterData: {
        email:
          typeof req.body?.email === 'string'
            ? req.body.email.trim().toLowerCase()
            : null,
        reason: error?.message ?? 'Login failed',
      },
    }),
  })
  @ApiOperation({ summary: 'Đăng nhập (tự động ghi Audit Log)' })
  @ApiResponse({ status: 200, description: 'Đăng nhập thành công' })
  @ApiResponse({ status: 401, description: 'Email hoặc mật khẩu không đúng' })
  @ApiResponse({ status: 403, description: 'Tài khoản bị khóa' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }
}
