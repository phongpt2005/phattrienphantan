import { IsString, IsOptional, IsEnum, IsInt, MinLength, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export enum AccessLevel {
  PUBLIC = 'PUBLIC',
  DEPARTMENT = 'DEPARTMENT',
  PRIVATE = 'PRIVATE',
}

export class CreateDocumentDto {
  @IsString()
  @MinLength(3, { message: 'Tiêu đề tài liệu phải có ít nhất 3 ký tự' })
  @MaxLength(255, { message: 'Tiêu đề không được vượt quá 255 ký tự' })
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;

  @IsOptional()
  tags?: string; // Chuỗi thẻ ngăn cách bởi dấu phẩy, vd: "hợp đồng, 2024, nhân sự"

  @IsOptional()
  @IsEnum(AccessLevel)
  accessLevel?: AccessLevel = AccessLevel.DEPARTMENT;

  @IsOptional()
  @Type(() => Number)
  userId?: number = 1; // Default admin user ID (sẽ lấy từ JWT trong Phase 5)
}
