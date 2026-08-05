import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { type ApiResponseOptions } from '@nestjs/swagger';
import { z } from 'zod';

import { AppError } from './app-error';

/**
 * Schema shape accepted by the Swagger decorators.
 *
 * `@nestjs/swagger` exposes `SchemaObject` only through a deep path that is not
 * resolvable under NodeNext module resolution, so the type is derived from the
 * public decorator option type instead.
 */
export type OpenApiSchemaObject = Extract<ApiResponseOptions, { schema: unknown }>['schema'];

/**
 * Runtime validation for every request payload.
 *
 * The contracts in `@exocortex/contracts` are the single source of truth, so the
 * pipe takes a zod schema directly instead of duplicating DTO classes.
 */
@Injectable()
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.infer<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw AppError.validation(
        `Invalid ${metadata.type} payload`,
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      );
    }
    return result.data;
  }
}

/** Convenience factory so controllers stay readable. */
export function zodPipe<TSchema extends z.ZodType>(schema: TSchema): ZodValidationPipe<TSchema> {
  return new ZodValidationPipe(schema);
}

/**
 * Converts a zod schema into an OpenAPI schema object.
 *
 * zod 4 ships native JSON Schema conversion, so the OpenAPI document is always
 * generated from the same schemas the runtime validates against; the two cannot
 * drift apart.
 */
export function openApiSchema(schema: z.ZodType): OpenApiSchemaObject {
  // `z.toJSONSchema` returns a JSON Schema draft-2020-12 object; OpenAPI 3.1
  // accepts it directly. The cast is the boundary between the two type systems.
  // `unrepresentable: 'any'` keeps schemas that contain transforms (for example
  // coerced booleans) documentable instead of aborting the OpenAPI build.
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as OpenApiSchemaObject;
}

/** Same as `openApiSchema` but for response bodies (output types). */
export function openApiResponseSchema(schema: z.ZodType): OpenApiSchemaObject {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
  }) as OpenApiSchemaObject;
}
