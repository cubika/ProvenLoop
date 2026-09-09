import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import {
  isUpgradeMaintenanceActive, resolveWindowsProvenLoopPaths,
  resolveWindowsProvenLoopLeaseName, WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import { readInspection } from "@provenloop/storage-sqlite";
import { redactPotentialSecrets } from "@provenloop/domain";
import { escapeHtml, renderUiPage, uiCss, uiLayout } from "./ui-page.js";

export interface UiServerOptions { readonly dataRoot: string; readonly port?: number }
export interface UiServer { readonly url: string; readonly close: () => Promise<void> }

const installationSummary = async (path: string): Promise<string> => {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as { capabilities?: Record<string, { enabled?: boolean }>; automaticLearning?: { enabled?: boolean } };
    const capabilities = ["capture", "worker", "retrieval", "correction_learning"].map((name) =>
      `${name.replaceAll("_", " ")}: ${state.capabilities?.[name]?.enabled === true ? "on" : state.capabilities?.[name]?.enabled === false ? "off" : "unknown"}`);
    capabilities.push(`automatic learning: ${state.automaticLearning?.enabled === true ? "on" : "off"}`);
    return capabilities.join(" · ");
  } catch { return "Installation state could not be read. Check provenloop status."; }
};

export const startUiServer = async (options: UiServerOptions): Promise<UiServer> => {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("UI port must be between 0 and 65535.");
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  const base = `/${randomBytes(32).toString("hex")}/`;
  let origin = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status: number, body: string, contentType = "text/html; charset=utf-8"): void => {
      response.statusCode = status; response.setHeader("Content-Type", contentType);
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const handle = async (): Promise<void> => {
      if (request.headers.host !== new URL(origin).host ||
        (request.headers.origin !== undefined && request.headers.origin !== origin) ||
        request.headers["sec-fetch-site"] === "cross-site") { send(403, "Forbidden"); return; }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD"); send(405, "This viewer is read only."); return;
      }
      if (!request.url?.startsWith(base) || request.url.length > 4096) { send(404, "Not found"); return; }
      const url = new URL(request.url, origin);
      if (!url.pathname.startsWith(base)) { send(404, "Not found"); return; }
      const context = { base, dataRoot: paths.root, url };
      if (url.pathname === `${base}style.css`) { send(200, uiCss, "text/css; charset=utf-8"); return; }
      const leases = [];
      try {
        await access(paths.rootMarker);
        if (await isUpgradeMaintenanceActive(paths.root)) throw new Error("An upgrade is in progress. Refresh when it finishes.");
        // Use existing maintenance leases; never keep a database handle between requests.
        for (const [root, purpose] of [[paths.root, "knowledge-projection"], [dirname(paths.database), "canonical-restore"]] as const) {
          const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(root, purpose)).tryAcquire();
          if (!lease) throw new Error("Storage is busy with another operation. Refresh in a moment.");
          leases.push(lease);
        }
        if (await isUpgradeMaintenanceActive(paths.root)) throw new Error("An upgrade is in progress. Refresh when it finishes.");
        const installation = await installationSummary(paths.adapterState);
        const page = readInspection(paths.database, (reader) => renderUiPage(reader, context, installation));
        send(page.status, page.html);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to read local records.";
        const friendly = message.includes("ENOENT") ? "No ProvenLoop installation found at this data location. Check --data-root." : message;
        send(503, uiLayout(context, "Data unavailable", `<h1>Data unavailable</h1><section class="panel error-panel"><p>${escapeHtml(redactPotentialSecrets(friendly))}</p><p class="mono">${escapeHtml(paths.root)}</p><a href="${base}">Retry overview</a></section>`));
      } finally { for (const lease of leases.reverse()) await lease.release(); }
    };
    void handle().catch(() => { if (!response.headersSent) send(500, "Unable to display this page."); else response.destroy(); });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { reject(error); };
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", failed); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve UI address.");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}${base}`, close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
};

const openBrowser = async (url: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("The browser could not be opened.")));
  });
};

export const runUi = async (options: UiServerOptions & { readonly open: boolean }, io: { log(message: string): void; error(message: string): void }): Promise<void> => {
  const viewer = await startUiServer(options);
  io.log(`ProvenLoop local viewer: ${viewer.url}\nRead only. Press Ctrl+C to stop.`);
  const stopped = new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
      void viewer.close().then(resolve, (error: unknown) => { io.error(String(error)); resolve(); });
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
  if (options.open) {
    try { await openBrowser(viewer.url); } catch { io.error("Open the viewer URL above in your browser."); }
  }
  await stopped;
};
