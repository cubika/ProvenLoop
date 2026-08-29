import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_FORMAT_VERSIONS,
  classifyRawEvent,
  CURRENT_SCHEMA_VERSIONS,
  evidenceLedgerEntrySchema,
  gateResultSchema,
  rawEventSchema,
  replaySpecSchema,
  SCHEMA_MIGRATIONS,
  SCHEMA_NAMES,
  UNSUPPORTED_SCHEMA_VERSION_POLICY,
  validateVersionedSchema,
} from "@provenloop/contracts";

interface InvalidFixture {
  readonly expectedStatus: string;
  readonly fixtureId: string;
  readonly fixtureVersion: number;
  readonly input: unknown;
  readonly schemaName: string;
}

const loadFixture = (name: string): InvalidFixture => {
  const path = fileURLToPath(
    new URL(
      `../../packages/contracts/fixtures/invalid/${name}.json`,
      import.meta.url,
    ),
  );
  return JSON.parse(readFileSync(path, "utf8")) as InvalidFixture;
};

describe("schema version compatibility", () => {
  it("rejects an unsupported persisted schema version explicitly", () => {
    const fixture = loadFixture("raw-event-unsupported-version");
    const result = validateVersionedSchema(
      "rawEvent",
      rawEventSchema,
      fixture.input,
    );

    expect(fixture.fixtureVersion).toBe(
      ARTIFACT_FORMAT_VERSIONS.fixture,
    );
    expect(result).toEqual({
      status: "unsupported_version",
      receivedVersion: 2,
      supportedVersion: 1,
    });
  });

  it("reports malformed input without fabricating a valid event", () => {
    const fixture = loadFixture("raw-event-malformed");
    const result = validateVersionedSchema(
      "rawEvent",
      rawEventSchema,
      fixture.input,
    );

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result.status).toBe("invalid");
  });

  it("retains unknown RawEvent types through an explicit path", () => {
    const fixture = loadFixture("raw-event-unknown-type");
    const result = classifyRawEvent(fixture.input);

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result).toMatchObject({
      status: "unsupported_event_type",
      eventType: "future.event",
    });
  });

  it("rejects unsupported adapter source versions explicitly", () => {
    const fixture = loadFixture("raw-event-unsupported-adapter-version");
    const result = classifyRawEvent(fixture.input);

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result).toMatchObject({
      status: "unsupported_adapter_version",
      adapter: "copilot-cli",
      adapterVersion: "999.0.0",
      supportedVersions: [
        "1.0.82-0",
      ],
    });
  });

  it("rejects unknown closed-enum values", () => {
    const fixture = loadFixture("gate-result-unknown-status");
    const result = validateVersionedSchema(
      "gateResult",
      gateResultSchema,
      fixture.input,
    );

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result.status).toBe("invalid");
  });

  it("requires ReplaySpec to choose exactly one input form", () => {
    const fixture = loadFixture("replay-spec-conflicting-inputs");
    const result = validateVersionedSchema(
      "replaySpec",
      replaySpecSchema,
      fixture.input,
    );

    expect(result.status).toBe(fixture.expectedStatus);
    expect(result.status).toBe("invalid");
  });

  it("requires Ledger digest fields to be SHA-256 hex", () => {
    const result = evidenceLedgerEntrySchema.safeParse({
      schemaVersion: 1,
      ledgerEntryId: "ledger-1",
      runId: "run-1",
      status: "event.observed",
      inputDigest: "ghp_1234567890abcdefghijklmnopqrst",
      timestamp: "2026-08-29T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});

describe("migration policy", () => {
  it("registers a current version and migration list for every schema", () => {
    for (const schemaName of SCHEMA_NAMES) {
      expect(CURRENT_SCHEMA_VERSIONS[schemaName]).toBe(1);
      expect(SCHEMA_MIGRATIONS[schemaName]).toEqual([]);
    }
    expect(UNSUPPORTED_SCHEMA_VERSION_POLICY).toBe("reject");
  });
});
