import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Chia sẻ một tài liệu CỦA PHÒNG MÌNH cho phòng ban khác. Phòng chia sẻ lấy từ node/JWT, không nhận từ client. */
export class CreateShareDto {
  /** Mã tài liệu trong chính node này (doc_id) */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  docId: number;

  /** Mã phòng ban nhận (ví dụ 'ACC'), hoặc '*' = toàn công ty (chỉ Ban Giám đốc) */
  @IsString()
  @Matches(/^(\*|[A-Z][A-Z0-9_]{1,19})$/, { message: 'Mã phòng ban nhận không hợp lệ' })
  sharedWithDept: string;

  @IsOptional()
  @IsEnum(['VIEW', 'DOWNLOAD'])
  permission?: 'VIEW' | 'DOWNLOAD';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  /** Số ngày hiệu lực (mặc định 7) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;

  /** Hoặc thời điểm hết hạn cụ thể (ISO 8601) */
  @IsOptional()
  @IsString()
  expiresAt?: string;
}
