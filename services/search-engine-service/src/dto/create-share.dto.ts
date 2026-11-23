import { IsInt, IsString, IsOptional, IsEnum, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateShareDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  centralDocId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sourceDocId?: number;

  @IsOptional()
  @IsString()
  sharedByDept?: string; // Ví dụ: 'HR'

  @IsOptional()
  @IsString()
  sourceDept?: string; // Tương đương sharedByDept

  @IsString()
  sharedWithDept: string; // Ví dụ: 'ACC' hoặc '*'

  @IsOptional()
  @IsEnum(['VIEW', 'DOWNLOAD'])
  permission?: 'VIEW' | 'DOWNLOAD' = 'VIEW';

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expiresInDays?: number = 7;

  @IsOptional()
  @IsString()
  expiresAt?: string;
}
