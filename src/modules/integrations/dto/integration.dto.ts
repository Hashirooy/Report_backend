import {
  IsBoolean,
  IsDefined,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/*
 * The template is a free-form JSON document, which class-validator cannot
 * describe. These DTOs only check that it is an object; the service parses it
 * with IntegrationTemplateSchema and the template engine, which report every
 * problem with its location inside the template.
 */

/**
 * PUT body. The first save creates the integration and needs a complete
 * template; later ones replace only the template keys they carry.
 */
export class SaveIntegrationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Only the keys present are replaced — `{ url }` keeps the stored body. */
  @IsOptional()
  @IsObject()
  template?: Record<string, unknown>;

  /** Write-only. Absent keeps the stored one, null removes it. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  secret?: string | null;
}

export class PreviewIntegrationDraftDto {
  @IsDefined()
  @IsObject()
  template!: Record<string, unknown>;
}

export class PreviewIssueExportDto {
  @IsOptional()
  @Matches(/^\d{1,19}$/, { message: 'artifactId must be an id' })
  artifactId?: string;
}

export class CreateIssueExportDto extends PreviewIssueExportDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
