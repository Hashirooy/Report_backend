import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListResultsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  @IsOptional()
  @IsIn(['passed', 'failed', 'broken', 'skipped', 'unknown'])
  status?: 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  suite?: string;

  /** Substring match against the test name. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'errorGroupId must be a numeric id' })
  errorGroupId?: string;

  /** Superseded attempts are hidden unless explicitly asked for. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? /^(true|1|yes)$/i.test(value) : value))
  includeRetries: boolean = false;

  /** "status" puts failures first, which is what the run screen opens on. */
  @IsOptional()
  @IsIn(['status', 'duration', 'name'])
  sort: 'status' | 'duration' | 'name' = 'status';
}
