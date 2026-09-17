import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

import type { RepsJobStatus } from '../../../contracts/index.js';

export class ListRepsJobsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  @IsOptional()
  @IsIn(['pending', 'running', 'waiting_for_user', 'succeeded', 'failed', 'cancelled'])
  status?: RepsJobStatus;

  @IsOptional()
  @Matches(/^\d{1,19}$/)
  projectId?: string;

  @IsOptional()
  @Matches(/^\d{1,19}$/)
  runId?: string;

  @IsOptional()
  @Matches(/^\d{1,19}$/)
  resultId?: string;
}

export class ListRepsEventsQueryDto {
  /** Last event id already drawn; the response continues from just after it. */
  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'after must be an event id' })
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 200;
}
