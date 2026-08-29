import { createHash } from "node:crypto";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [
          key,
          canonicalize(child),
        ]),
    );
  }

  return value;
};

export const stableJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

export const sha256 = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");
