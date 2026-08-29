import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

import { isoTimestampSchema } from "@provenloop/contracts";

import {
  getCopilotCaptureCapability,
} from "./capabilities.js";
import type {
  CopilotSessionEvent,
  CopilotWorkspaceSnapshot,
} from "./event-mapper.js";

export interface CopilotSessionFileHeader {
  readonly adapterVersion: string;
  readonly fileVersion: number;
  readonly producer?: string;
  readonly sessionId: string;
  readonly workspace: CopilotWorkspaceSnapshot;
}

export interface CopilotSessionFileIssue {
  readonly kind:
    | "malformed_json"
    | "malformed_event"
    | "oversized_line";
  readonly lineNumber: number;
  readonly message: string;
}

export interface CopilotSessionFileParserOptions {
  readonly expectedSessionId?: string;
  readonly maxLineChars: number;
  readonly onEvent: (
    event: CopilotSessionEvent,
    lineNumber: number,
  ) => Promise<void> | void;
  readonly onHeader?: (
    header: CopilotSessionFileHeader,
  ) => Promise<boolean | undefined> | boolean | undefined;
  readonly onIssue?: (
    issue: CopilotSessionFileIssue,
  ) => Promise<void> | void;
}

export type CopilotSessionFileParseResult =
  | {
      readonly eventCount: number;
      readonly header: CopilotSessionFileHeader;
      readonly issueCount: number;
      readonly partialTail: boolean;
      readonly status: "supported";
      readonly stoppedAfterHeader: boolean;
    }
  | {
      readonly adapterVersion?: string;
      readonly fileVersion?: number;
      readonly reason:
        | "unsupported_adapter_version"
        | "unsupported_session_file_version";
      readonly status: "incompatible";
    }
  | {
      readonly lineNumber: number;
      readonly reason: string;
      readonly status: "malformed";
    };

type CopilotSessionFileHeaderResult =
  | CopilotSessionFileHeader
  | Exclude<
      CopilotSessionFileParseResult,
      { readonly status: "supported" }
    >;

export class InvalidSessionFileParserConfigurationError extends Error {
  public override readonly name =
    "InvalidSessionFileParserConfigurationError";

  public constructor() {
    super("Session file maxLineChars must be a positive integer.");
  }
}

interface FirstSessionRecord {
  readonly line: string;
  readonly lineNumber: number;
  readonly nextOffset: number;
}

const asRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const optionalString = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const workspaceFromContext = (
  value: unknown,
): CopilotWorkspaceSnapshot => {
  const context = asRecord(value);
  if (context === undefined) {
    return {};
  }
  const branch = optionalString(context, "branch");
  const commitSha = optionalString(context, "headCommit");
  const repoId = optionalString(context, "repository");
  const worktree =
    optionalString(context, "gitRoot") ??
    optionalString(context, "cwd");
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(commitSha === undefined ? {} : { commitSha }),
    ...(repoId === undefined ? {} : { repoId }),
    ...(worktree === undefined ? {} : { worktree }),
  };
};

const inspectHeader = (
  input: unknown,
  expectedSessionId: string | undefined,
  lineNumber: number,
): CopilotSessionFileHeaderResult => {
  const event = asRecord(input);
  if (event === undefined || event.type !== "session.start") {
    return {
      status: "malformed",
      lineNumber,
      reason: "The first Session record must be session.start.",
    };
  }
  if (
    typeof event.id !== "string" ||
    event.id.trim().length === 0 ||
    !Object.prototype.hasOwnProperty.call(event, "parentId") ||
    (
      event.parentId !== null &&
      (
        typeof event.parentId !== "string" ||
        event.parentId.trim().length === 0
      )
    ) ||
    !isoTimestampSchema.safeParse(event.timestamp).success
  ) {
    return {
      status: "malformed",
      lineNumber,
      reason:
        "session.start requires a valid id, parentId, and ISO timestamp.",
    };
  }
  const data = asRecord(event.data);
  if (data === undefined) {
    return {
      status: "malformed",
      lineNumber,
      reason: "session.start data must be an object.",
    };
  }
  const adapterVersion = optionalString(data, "copilotVersion");
  const sessionId = optionalString(data, "sessionId");
  const fileVersion = data.version;
  if (
    adapterVersion === undefined ||
    sessionId === undefined ||
    !Number.isInteger(fileVersion) ||
    (fileVersion as number) < 0
  ) {
    return {
      status: "malformed",
      lineNumber,
      reason:
        "session.start requires copilotVersion, sessionId, and a non-negative integer version.",
    };
  }
  if (
    expectedSessionId !== undefined &&
    expectedSessionId !== sessionId
  ) {
    return {
      status: "malformed",
      lineNumber,
      reason: "Session directory identity does not match session.start.",
    };
  }
  const capability = getCopilotCaptureCapability(adapterVersion);
  if (capability === undefined || capability.status !== "supported") {
    return {
      status: "incompatible",
      adapterVersion,
      fileVersion: fileVersion as number,
      reason: "unsupported_adapter_version",
    };
  }
  if (!capability.sessionFileVersions.includes(fileVersion as number)) {
    return {
      status: "incompatible",
      adapterVersion,
      fileVersion: fileVersion as number,
      reason: "unsupported_session_file_version",
    };
  }
  const producer = optionalString(data, "producer");
  return {
    adapterVersion,
    fileVersion: fileVersion as number,
    ...(producer === undefined ? {} : { producer }),
    sessionId,
    workspace: workspaceFromContext(data.context),
  };
};

const readFirstSessionRecord = async (
  path: string,
  maxLineChars: number,
): Promise<
  | FirstSessionRecord
  | {
      readonly lineNumber: number;
      readonly status: "empty" | "oversized";
    }
> => {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    const maximumBytes = maxLineChars * 4 + 1;
    const lineBuffer = Buffer.allocUnsafe(maximumBytes);
    const byte = Buffer.allocUnsafe(1);
    let lineBytes = 0;
    let lineNumber = 1;
    let position = 0;
    while (position < metadata.size) {
      const read = await handle.read(byte, 0, 1, position);
      if (read.bytesRead === 0) {
        break;
      }
      position += 1;
      if (byte[0] === 0x0a) {
        const line = lineBuffer
          .subarray(0, lineBytes)
          .toString("utf8")
          .replace(/\r$/u, "");
        if (line.length > maxLineChars) {
          return {
            status: "oversized",
            lineNumber,
          };
        }
        if (line.trim().length > 0) {
          return {
            line,
            lineNumber,
            nextOffset: position,
          };
        }
        lineBytes = 0;
        lineNumber += 1;
        continue;
      }
      if (lineBytes >= maximumBytes) {
        return {
          status: "oversized",
          lineNumber,
        };
      }
      lineBuffer[lineBytes] = byte[0] ?? 0;
      lineBytes += 1;
    }

    if (lineBytes === 0) {
      return {
        status: "empty",
        lineNumber,
      };
    }
    const line = lineBuffer
      .subarray(0, lineBytes)
      .toString("utf8")
      .replace(/\r$/u, "");
    if (line.length > maxLineChars) {
      return {
        status: "oversized",
        lineNumber,
      };
    }
    return line.trim().length === 0
      ? {
          status: "empty",
          lineNumber,
        }
      : {
          line,
          lineNumber,
          nextOffset: position,
        };
  } finally {
    await handle.close();
  }
};

export const parseCopilotSessionFile = async (
  path: string,
  options: CopilotSessionFileParserOptions,
): Promise<CopilotSessionFileParseResult> => {
  if (
    !Number.isInteger(options.maxLineChars) ||
    options.maxLineChars <= 0
  ) {
    throw new InvalidSessionFileParserConfigurationError();
  }

  const firstRecord = await readFirstSessionRecord(
    path,
    options.maxLineChars,
  );
  if ("status" in firstRecord) {
    return {
      status: "malformed",
      lineNumber: firstRecord.lineNumber,
      reason:
        firstRecord.status === "oversized"
          ? "session.start exceeds the line-size limit."
          : "Session file is empty.",
    };
  }
  let headerInput: unknown;
  try {
    headerInput = JSON.parse(
      firstRecord.line.replace(/^\uFEFF/u, ""),
    ) as unknown;
  } catch {
    return {
      status: "malformed",
      lineNumber: firstRecord.lineNumber,
      reason: "session.start is not valid JSON.",
    };
  }
  const inspected = inspectHeader(
    headerInput,
    options.expectedSessionId,
    firstRecord.lineNumber,
  );
  if ("status" in inspected) {
    return inspected;
  }
  const header = inspected;
  const continueParsing = await options.onHeader?.(header);
  if (continueParsing === false) {
    return {
      status: "supported",
      eventCount: 0,
      header,
      issueCount: 0,
      partialTail: false,
      stoppedAfterHeader: true,
    };
  }

  let eventCount = 1;
  let issueCount = 0;
  let lineNumber = firstRecord.lineNumber;
  let partialTail = false;
  let pending = "";
  let discardingOversizedLine = false;
  await options.onEvent(
    headerInput as CopilotSessionEvent,
    firstRecord.lineNumber,
  );

  const reportIssue = async (
    issue: CopilotSessionFileIssue,
  ): Promise<void> => {
    issueCount += 1;
    await options.onIssue?.(issue);
  };

  const reportOversizedLine = (
    oversizedLineNumber: number,
  ): Promise<void> =>
    reportIssue({
      kind: "oversized_line",
      lineNumber: oversizedLineNumber,
      message: "Session event exceeds the line-size limit.",
    });

  const processLine = async (
    rawLine: string,
    finalLine: boolean,
  ): Promise<void> => {
    if (rawLine.trim().length === 0) {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(rawLine) as unknown;
    } catch {
      if (finalLine) {
        partialTail = true;
        return;
      }
      await reportIssue({
        kind: "malformed_json",
        lineNumber,
        message: "Session event is not valid JSON.",
      });
      return;
    }
    if (asRecord(event) === undefined) {
      await reportIssue({
        kind: "malformed_event",
        lineNumber,
        message: "Session event must be a JSON object.",
      });
      return;
    }

    eventCount += 1;
    await options.onEvent(
      event as CopilotSessionEvent,
      lineNumber,
    );
  };

  for await (const chunk of createReadStream(path, {
    encoding: "utf8",
    start: firstRecord.nextOffset,
  })) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      if (newline === -1) {
        if (!discardingOversizedLine) {
          pending += chunk.slice(start);
          if (pending.length > options.maxLineChars + 1) {
            pending = "";
            discardingOversizedLine = true;
            await reportOversizedLine(lineNumber + 1);
          }
        }
        break;
      }

      lineNumber += 1;
      const segment = chunk.slice(start, newline);
      start = newline + 1;
      if (discardingOversizedLine) {
        discardingOversizedLine = false;
        continue;
      }

      pending += segment;
      const completeLine = pending.endsWith("\r")
        ? pending.slice(0, -1)
        : pending;
      if (completeLine.length > options.maxLineChars) {
        pending = "";
        await reportOversizedLine(lineNumber);
        continue;
      }
      pending = "";
      await processLine(completeLine, false);
    }
  }

  if (discardingOversizedLine) {
    partialTail = true;
  } else if (pending.length > 0) {
    lineNumber += 1;
    if (pending.length > options.maxLineChars) {
      await reportOversizedLine(lineNumber);
      partialTail = true;
    } else {
      await processLine(pending, true);
    }
  }
  return {
    status: "supported",
    eventCount,
    header,
    issueCount,
    partialTail,
    stoppedAfterHeader: false,
  };
};
