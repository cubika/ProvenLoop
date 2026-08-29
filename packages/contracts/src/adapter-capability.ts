import { z } from "zod";

import {
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  versionedSchemaShape,
} from "./common.js";

export const adapterCapabilityStatusSchema = z.enum([
  "supported",
  "incompatible",
]);

export const captureTransportSchema = z.enum([
  "extension-session-events",
]);

export const adapterCapabilitySchema = z
  .object({
    ...versionedSchemaShape,
    adapter: nonEmptyStringSchema,
    adapterVersion: nonEmptyStringSchema,
    captureTransport: captureTransportSchema,
    sessionFileParser: nonEmptyStringSchema,
    sessionFileVersions: z
      .array(nonNegativeIntegerSchema)
      .min(1),
    sourceEventTypes: z.array(nonEmptyStringSchema),
    status: adapterCapabilityStatusSchema,
  })
  .strict();

export type AdapterCapability = z.infer<
  typeof adapterCapabilitySchema
>;
