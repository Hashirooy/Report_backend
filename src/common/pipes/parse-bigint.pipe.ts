import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/**
 * Route ids arrive as decimal strings because primary keys are 64-bit and JSON
 * has no integer wide enough to carry them.
 */
@Injectable()
export class ParseBigIntPipe implements PipeTransform<string, bigint> {
  transform(value: string): bigint {
    if (!/^\d{1,19}$/.test(value)) {
      throw new BadRequestException(`"${value}" is not a valid id`);
    }
    try {
      return BigInt(value);
    } catch {
      throw new BadRequestException(`"${value}" is not a valid id`);
    }
  }
}
