import { IsOptional, IsString, IsUrl, MaxLength, MinLength, ValidateIf } from 'class-validator';

/**
 * Every field is optional; only the ones present change. `description` and
 * `repositoryUrl` accept null to clear them — an absent field and a cleared one
 * are different requests.
 */
export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(2_000)
  description?: string | null;

  /** A reference link for jumping to the code; nothing is fetched from it. */
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsUrl({ require_tld: false })
  repositoryUrl?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  defaultBranch?: string;
}
