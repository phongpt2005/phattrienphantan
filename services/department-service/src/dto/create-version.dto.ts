import { IsString, IsOptional, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeNote?: string;

  @IsOptional()
  @Type(() => Number)
  userId?: number = 1;
}
