import { createInterface } from "node:readline";
import type {
  Readable,
  Writable,
} from "node:stream";

interface JsonRpcRequest {
  readonly id?: number | string | null;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface McpServerIo {
  readonly input: Readable;
  readonly output: Writable;
}

const send = (
  output: Writable,
  message: Readonly<Record<string, unknown>>,
): void => {
  output.write(`${JSON.stringify(message)}\n`);
};

const respond = (
  output: Writable,
  id: JsonRpcRequest["id"],
  result: unknown,
): void => {
  send(output, {
    id: id ?? null,
    jsonrpc: "2.0",
    result,
  });
};

const fail = (
  output: Writable,
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): void => {
  send(output, {
    error: {
      code,
      message,
    },
    id: id ?? null,
    jsonrpc: "2.0",
  });
};

const isRecord = (
  input: unknown,
): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

const asRequest = (input: unknown): JsonRpcRequest | undefined => {
  const id = isRecord(input) ? input.id : undefined;
  if (
    !isRecord(input) ||
    input.jsonrpc !== "2.0" ||
    typeof input.method !== "string" ||
    (
      id !== undefined &&
      id !== null &&
      typeof id !== "string" &&
      typeof id !== "number"
    )
  ) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    method: input.method,
    ...(id === undefined
      ? {}
      : {
          id,
        }),
    ...(input.params === undefined
      ? {}
      : {
          params: input.params,
        }),
  };
};

export const runMcpServer = async (
  io: McpServerIo = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<void> => {
  const input = createInterface({
    crlfDelay: Infinity,
    input: io.input,
  });
  await new Promise<void>((resolve) => {
    input.on("line", (line) => {
      if (line.trim().length === 0) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        fail(io.output, null, -32700, "Parse error");
        return;
      }
      const request = asRequest(parsed);
      if (request === undefined) {
        fail(io.output, null, -32600, "Invalid Request");
        return;
      }
      switch (request.method) {
        case "initialize":
          respond(io.output, request.id, {
            capabilities: {
              tools: {},
            },
            protocolVersion:
              isRecord(request.params) &&
              typeof request.params.protocolVersion === "string"
                ? request.params.protocolVersion
                : "2025-06-18",
            serverInfo: {
              name: "provenloop",
              version: "0.0.0",
            },
          });
          break;
        case "ping":
          respond(io.output, request.id, {});
          break;
        case "tools/list":
          respond(io.output, request.id, {
            tools: [],
          });
          break;
        case "tools/call":
          fail(
            io.output,
            request.id,
            -32601,
            "ProvenLoop retrieval tools are not active in this milestone.",
          );
          break;
        default:
          if (request.id !== undefined) {
            fail(io.output, request.id, -32601, "Method not found");
          }
      }
    });
    input.once("close", resolve);
  });
};
