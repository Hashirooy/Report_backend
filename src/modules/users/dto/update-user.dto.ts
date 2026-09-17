import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** A patch: only the fields present are written. */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsIn(['admin', 'member'])
  role?: 'admin' | 'member';

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Administrative reset. Ends the user's sessions, like any other change. */
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password?: string;
}
