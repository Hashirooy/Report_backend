import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** The non-file parts of a spec upload. Both are optional: the document has a version. */
export class UploadApiSpecDto {
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
