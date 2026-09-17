import { IsOptional, Matches } from 'class-validator';

export class SpecDiffQueryDto {
  /** Snapshot to compare against. Omitted, the preceding snapshot is used. */
  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'against must be a snapshot id' })
  against?: string;
}
