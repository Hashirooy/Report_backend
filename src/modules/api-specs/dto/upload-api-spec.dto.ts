import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Non-file parts of a spec upload. The document supplies defaults for both. */
export class UploadApiSpecDto {
  /**
   * Stable identity of one API inside the project. Defaults to `info.title`.
   * Send this explicitly when titles can change between versions.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  serviceKey?: string;

  /**
   * Overrides `info.version`. For a service whose spec never bumps its own
   * version, this is the only way to tell two snapshots apart in a list.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  version?: string;
}
