import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';

export class RepsAnswerDto {
  @Matches(/^\d{1,19}$/, { message: 'questionId must be a question id' })
  questionId!: string;

  @IsString()
  @MaxLength(8_000)
  answer!: string;
}

export class ResumeRepsJobDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepsAnswerDto)
  answers!: RepsAnswerDto[];
}
