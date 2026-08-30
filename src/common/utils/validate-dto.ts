import { BadRequestException, ValidationPipe, type Type } from '@nestjs/common';

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: false,
  transformOptions: { enableImplicitConversion: true },
});

/**
 * Runs a DTO through the same validation the global pipe applies to bodies.
 *
 * Multipart fields are collected by hand — parts must be consumed in arrival
 * order, so they never reach the pipe as a body — and this keeps them held to
 * the same rules instead of growing a second validation style.
 */
export async function validateDto<T>(
  metatype: Type<T>,
  value: Record<string, unknown>,
): Promise<T> {
  try {
    return (await pipe.transform(value, { type: 'body', metatype })) as T;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException((error as Error).message);
  }
}
