import { IsIn, IsOptional, Matches } from 'class-validator';

export class SetProjectMemberDto {
  /** Numeric user id as a string, like every id crossing the wire. */
  @Matches(/^\d{1,19}$/, { message: 'userId must be a numeric id' })
  userId!: string;

  @IsOptional()
  @IsIn(['viewer', 'maintainer'])
  role?: 'viewer' | 'maintainer';
}
