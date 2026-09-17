import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  /**
   * Length is the only rule. Composition requirements push people towards
   * shorter, more predictable passwords, so twelve characters is the floor and
   * nothing else is demanded.
   */
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  newPassword!: string;
}
