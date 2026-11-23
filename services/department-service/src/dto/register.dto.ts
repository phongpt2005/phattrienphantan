import { IsString, IsOptional, IsEmail, IsEnum, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  username: string;

  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  password: string;

  @IsString()
  @MaxLength(100)
  fullName: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsEnum(['ADMIN', 'MANAGER', 'STAFF'])
  role?: 'ADMIN' | 'MANAGER' | 'STAFF' = 'STAFF';
}
