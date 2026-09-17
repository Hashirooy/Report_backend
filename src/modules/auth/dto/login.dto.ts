import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /** No length rule here: the stored password is what decides, not the form. */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}
