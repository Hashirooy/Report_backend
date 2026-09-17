import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateProjectTokenDto {
  /** What the token is for, so a leaked one can be found and revoked. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}
