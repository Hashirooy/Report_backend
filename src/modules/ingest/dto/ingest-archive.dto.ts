import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Multipart form fields sent by CI alongside the `file` part.
 *
 * (project, ciBuildId) is the idempotency key: a retried GitLab job updates its
 * run instead of creating a second one.
 */
export class IngestArchiveDto {
  /** Project slug. Created on first upload unless autoCreateProject is false. */
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9\-_.]*$/, {
    message: 'project must be a slug: lowercase letters, digits, - _ .',
  })
  project!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  projectName?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  branch!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  commitSha?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  environment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ciBuildId?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  ciBuildUrl?: string;

  /** Multipart carries strings only, so "false"/"0" have to be decoded here. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? !/^(false|0|no)$/i.test(value) : value))
  @IsBoolean()
  autoCreateProject: boolean = true;
}
