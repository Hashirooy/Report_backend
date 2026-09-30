import { IsBoolean } from 'class-validator';

/** Mutable controls of an otherwise immutable OpenAPI snapshot. */
export class UpdateApiSpecDto {
  @IsBoolean()
  active!: boolean;
}
