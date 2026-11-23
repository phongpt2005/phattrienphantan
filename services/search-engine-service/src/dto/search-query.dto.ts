import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Tham số tìm kiếm. Người xem (phòng ban, vai trò, Ban Giám đốc) được lấy từ JWT,
 * KHÔNG nhận từ query (trước đây viewerDeptCode/isExecutive do client tự khai).
 */
export class SearchQueryDto {
  @IsOptional()
  @IsString()
  q?: string = ''; // Từ khóa; rỗng = liệt kê tài liệu mới nhất

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  departmentId?: number; // Lọc theo phòng ban (department_id trong Registry)

  @IsOptional()
  @IsString()
  categoryName?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}
