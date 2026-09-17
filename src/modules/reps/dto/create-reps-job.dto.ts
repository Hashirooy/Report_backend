import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max } from 'class-validator';

import type { RepsJobKind } from '../../../contracts/index.js';

export class CreateRepsJobDto {
  @IsIn(['analyze_run', 'analyze_test', 'custom'])
  kind!: RepsJobKind;

  /**
   * Numeric id, not a run number: a Reps job is created from a screen that
   * already resolved the run, and accepting both would make the reference
   * ambiguous the moment a project has more than one.
   */
  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'runId must be a numeric id' })
  runId?: string;

  /**
   * One row of `test_results` — a single execution, not a test case. The list
   * screen already knows it, and it is what pins the answer to one trace.
   */
  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'resultId must be a numeric id' })
  resultId?: string;

  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'projectId must be a numeric id' })
  projectId?: string;

  @IsString()
  @MaxLength(8_000)
  userRequest!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxAttemptsPerStage?: number;
}
