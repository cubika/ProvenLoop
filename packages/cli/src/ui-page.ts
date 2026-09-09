import type { InspectionCollection, InspectionReader } from "@provenloop/storage-sqlite";
import type { ContextUseRecord } from "@provenloop/contracts";
import { redactKnownSecrets, redactPotentialSecrets } from "@provenloop/domain";
import { releaseMetadata } from "./release-metadata.js";

export const uiCss = `
:root{color-scheme:light;--bg:#f5f5f0;--paper:#fff;--ink:#182b29;--muted:#65716e;--line:#dce2dc;--accent:#136950;--soft:#e9f2eb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #2385ae;outline-offset:3px}
.shell{max-width:1440px;margin:auto;display:grid;grid-template-columns:225px minmax(0,1fr);min-height:100vh}.sidebar{padding:34px 24px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:32px}.brand{font-size:23px;font-weight:750;letter-spacing:-1px;color:var(--ink)}.brand-mark{color:var(--accent);margin-right:7px}.kicker{font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--muted)}nav{display:grid;gap:6px}nav a{padding:10px 13px;color:var(--muted);border-radius:7px}nav a[aria-current=page]{background:var(--soft);color:var(--accent);font-weight:650}.side-note{margin-top:auto;font-size:12px;color:var(--muted)}main{min-width:0;padding:32px 42px 60px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:30px}.topbar span{font-size:12px;color:var(--muted)}h1{font-size:34px;letter-spacing:-1.2px;line-height:1.2;margin:8px 0 12px}h2{font-size:18px;line-height:1.4;margin:0 0 16px}h3{font-size:14px;margin:20px 0 8px}.intro{color:var(--muted);max-width:750px;margin-bottom:26px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:25px 0}.metric,.panel{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:22px}.metric strong{display:block;font-size:32px;line-height:1.4;letter-spacing:-1px}.metric span{font-size:12px;color:var(--muted)}.panel{margin:18px 0}.panel p:first-child{margin-top:0}.panel p:last-child{margin-bottom:0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.grid .panel{margin:0}.badge{display:inline-block;font-size:11px;line-height:1.5;padding:4px 9px;border:1px solid var(--line);border-radius:20px;background:#f5f6f3;color:var(--muted);white-space:nowrap}.badge.active,.badge.qualified,.badge.provided,.badge.succeeded{background:#e9f5ed;color:#176443;border-color:#c8e5d1}.badge.candidate,.badge.pending,.badge.waiting_evidence{background:#fbf3df;color:#8e6607;border-color:#eee0b9}.badge.failed,.badge.disputed,.badge.error{background:#fbeceb;color:#a54439;border-color:#eccfcb}
.toolbar{display:flex;flex-wrap:wrap;align-items:end;gap:12px;background:#fff;padding:16px;border:1px solid var(--line);border-radius:9px;margin:22px 0}label{display:grid;gap:5px;font-size:12px;color:var(--muted)}input,select,button{font:inherit;padding:9px 12px;border:1px solid #cbd5cf;border-radius:6px;background:white;color:var(--ink)}input[type=search]{width:min(330px,70vw)}button{background:var(--accent);border-color:var(--accent);color:white;cursor:pointer}.table-wrap{overflow-x:auto;background:var(--paper);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;padding:13px 17px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);background:#fafbf8}td{padding:16px 17px;border-top:1px solid var(--line);vertical-align:top}td:first-child{min-width:210px;max-width:560px}.title-link{font-weight:600;display:block;margin-bottom:4px;color:var(--ink)}small,.muted{color:var(--muted);font-size:12px}.mono,code,pre{font-family:Consolas,ui-monospace,monospace}.mono{font-size:11px;overflow-wrap:anywhere}.empty{padding:45px 28px;text-align:center;color:var(--muted)}.empty strong{display:block;color:var(--ink);font-size:18px;margin-bottom:8px}.pagination{display:flex;justify-content:space-between;align-items:center;margin-top:18px;font-size:13px}.pagination div{display:flex;gap:20px}.rule{font-size:22px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.back{font-size:13px}dl{display:grid;grid-template-columns:150px minmax(0,1fr);gap:10px 18px;margin:0;font-size:13px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}blockquote{white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid #8bbba4;padding:10px 18px;margin:12px 0;background:#f6faf6}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;background:#f6f7f3;padding:16px;border-radius:6px;max-height:480px;overflow:auto}details{margin-top:16px}summary{cursor:pointer;font-size:13px;color:var(--accent)}.links{display:grid;gap:7px;margin:12px 0}.notice{background:#f8f3e6;border:1px solid #e6d9b5;border-radius:8px;padding:15px 18px;font-size:13px}.chips{display:flex;gap:8px;flex-wrap:wrap}.error-panel{border-color:#e4b9b1}footer{margin-top:30px;font-size:11px;color:var(--muted)}
@media(max-width:1000px){main{padding:28px 24px}.shell{grid-template-columns:185px minmax(0,1fr)}.sidebar{padding:28px 16px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}}@media(max-width:680px){.shell{display:block}.sidebar{border-right:0;border-bottom:1px solid var(--line);padding:18px;gap:12px}.side-note{display:none}nav{display:flex;overflow-x:auto;gap:3px}nav a{font-size:12px;padding:7px 10px}.brand{font-size:21px}main{padding:22px 16px}h1{font-size:29px}.topbar{margin-bottom:22px}dl{grid-template-columns:100px minmax(0,1fr)}.metric{padding:16px}}
`;

export const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/gu, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const text = (value: unknown): string => escapeHtml(redactKnownSecrets(String(value ?? "")));
const prose = (value: unknown): string => escapeHtml(redactPotentialSecrets(String(value ?? "")));
const safeRecord = (value: unknown, key = ""): unknown => {
  if (/^(?:password|passwd|token|secret|authorization|cookie|credential|api[_-]?key|client[_-]?secret)$/iu.test(key)) return "[REDACTED]";
  if (typeof value === "string") return /(?:Ids?|Digests?|Sha|Timestamp|At)$/u.test(key) || /^(?:deduplicationKey|revision|contractDigest)$/u.test(key)
    ? redactKnownSecrets(value) : redactPotentialSecrets(value);
  if (Array.isArray(value)) return value.map((item: unknown) => safeRecord(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [redactKnownSecrets(name), safeRecord(item, name)]));
  return value;
};
const badge = (value: unknown): string => `<span class="badge ${text(String(value).replace(/[^a-z_]/gu, ""))}">${text(value ?? "unknown")}</span>`;
const date = (value: unknown): string => value ? `${text(String(value).replace("T", " ").replace(/\.\d{3}Z$/u, ""))} UTC` : "Unknown";
const json = (value: unknown): string => `<pre>${text(JSON.stringify(safeRecord(value), null, 2))}</pre>`;
const raw = (value: unknown): string => `<details><summary>Stored record</summary>${json(value)}</details>`;
const fields = (entries: [string, unknown][]): string => `<dl>${entries.map(([key, value]) => `<dt>${text(key)}</dt><dd>${text(value ?? "Unknown")}</dd>`).join("")}</dl>`;
const list = (items: readonly string[]): string => items.length ? `<ul>${items.map((item) => `<li>${prose(item)}</li>`).join("")}</ul>` : `<p class="muted">None recorded.</p>`;
const panel = (heading: string, body: string): string => `<section class="panel"><h2>${text(heading)}</h2>${body}</section>`;
const empty = (message: string): string => `<div class="empty"><strong>No records to show</strong>${text(message)}</div>`;
const navigation = [["", "Overview"], ["knowledge", "Knowledge"], ["events", "Activity"], ["episodes", "Work episodes"], ["jobs", "Learning"], ["usage", "Usage"]] as const;

export interface UiPageContext { readonly base: string; readonly dataRoot: string; readonly url: URL }

const link = (context: UiPageContext, route: string, id: string, label = id): string =>
  `<a href="${context.base}${route}/${encodeURIComponent(id)}">${text(label)}</a>`;
const eventLinks = (context: UiPageContext, ids: readonly string[]): string => `<div class="links mono">${ids.slice(0, 100).map((id) => /^(?:event-)?[a-f0-9]{64}$/u.test(id) ? link(context, "events", id) : `<span>${text(id)} <small>(recorded reference)</small></span>`).join("")}</div>${ids.length > 100 ? "<p>Showing the first 100 references.</p>" : ""}`;

export const uiLayout = (context: UiPageContext, title: string, body: string): string => {
  const active = context.url.pathname.slice(context.base.length).split("/")[0] ?? "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(title)} · ProvenLoop</title><link rel="stylesheet" href="${context.base}style.css"></head><body><div class="shell"><aside class="sidebar"><a class="brand" href="${context.base}"><span class="brand-mark">↳</span>ProvenLoop</a><div><div class="kicker">Local workspace</div><nav aria-label="Main navigation">${navigation.map(([route, label]) => `<a href="${context.base}${route}" ${route === active ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav></div><div class="side-note">Evidence stays on this computer.<br>Stop the viewer with Ctrl+C in its terminal.</div></aside><main><header class="topbar"><span>LEARNING EXPLORER</span><div class="chips">${badge("Read only")}<span>v${text(releaseMetadata.version)}</span></div></header>${body}<footer>Local snapshot · ${date(new Date().toISOString())} · <a href="${text(context.url.pathname + context.url.search)}">Refresh</a></footer></main></div></body></html>`;
};

const table = (headers: string[], rows: string[]): string => rows.length
  ? `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th scope="col">${text(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
  : empty("Try another filter, or return after more activity has been collected.");
const row = (cells: string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
const select = (name: string, label: string, options: string[], current: string): string => `<label>${text(label)}<select name="${name}"><option value="">All</option>${options.map((value) => `<option ${value === current ? "selected" : ""}>${text(value)}</option>`).join("")}</select></label>`;

const usageTable = (context: UiPageContext, records: readonly ContextUseRecord[]): string => table(
  ["Time / session", "Provided", "Explicitly adopted", "Feedback"],
  records.slice(0, 100).map((record) => row([`${date(record.createdAt)}<br><small class="mono">${text(record.sessionId)}</small>`,
    record.returnedKnowledgeIds.length ? `<div class="links">${record.returnedKnowledgeIds.slice(0, 10).map((id) => id.startsWith("knowledge:")
      ? link(context, "knowledge", id.slice(10), id) : text(id)).join("")}</div>` : badge(record.retrievalStatus ?? "unknown"),
    text(record.appliedKnowledgeIds.length), text(record.feedback ?? "None recorded")])));

const proposalsView = (context: UiPageContext, proposals: ReturnType<InspectionReader["proposals"]>): string => {
  if (!proposals.length) return `<p class="muted">No automatic learning proposal recorded for this item.</p>`;
  return proposals.slice(0, 100).map(({ proposal, receipt }) => {
    const source = proposal.userSource ?? proposal.agentSource;
    return panel("Learning proposal", `<p>${prose(proposal.rule)}</p><div class="chips">${badge(proposal.agentSource ? `agent_${proposal.agentSource.kind}` : "user_correction")}${badge(receipt ? "qualified" : "candidate")}</div>
      <h3>Source quotation</h3><blockquote>${prose(source?.quote)}</blockquote>${source ? eventLinks(context, [source.eventId]) : ""}
      ${(proposal.agentSource?.evidenceSources ?? []).map((evidence) => `<blockquote>${prose(evidence.quote)}</blockquote>${eventLinks(context, [evidence.eventId])}`).join("")}
      <h3>Verification</h3>${receipt ? `<p>Recorded proof: ${text(receipt.proves)} · ${date(receipt.verifiedAt)}</p>${eventLinks(context, [receipt.failedOperationEventId, receipt.retryOperationEventId, receipt.completionEventId])}${raw(receipt)}` : `<p class="muted">No supported recovery receipt recorded. This proposal alone does not establish a verified rule.</p>`}
      <p>${link(context, "knowledge", proposal.knowledgeId, "Open knowledge")} · ${link(context, "jobs", proposal.jobId, "Open learning job")}</p>${raw(proposal)}`);
  }).join("") + (proposals.length > 100 ? "<p>Showing the latest 100 proposals.</p>" : "");
};

export const renderUiPage = (reader: InspectionReader, context: UiPageContext, installation: string): { status: number; html: string } => {
  const route = context.url.pathname.slice(context.base.length).split("/");
  const section = route[0] ?? "";
  const id = route[1] ? decodeURIComponent(route[1]) : undefined;
  const finish = (title: string, body: string, status = 200) => ({ status, html: uiLayout(context, title, body) });
  const missing = () => finish("Record unavailable", `<h1>Record unavailable</h1><p>This record may have been deleted, or its source was not retained.</p><a href="${context.base}">Return to overview</a>`, 404);
  if (route.length > 2) return missing();
  if (!section) {
    const summary = reader.summary();
    const metrics = [["knowledge", "Knowledge cards"], ["events", "Captured events"], ["jobs", "Learning jobs"], ["episodes", "Work episodes"]];
    return finish("Overview", `<div class="kicker">Your local learning record</div><h1>Follow the evidence.</h1><p class="intro">Browse what was captured, what became knowledge, and where guidance was provided. Open a card to inspect its sources.</p>
      <div class="metrics">${metrics.map(([key, label]) => `<a class="metric" href="${context.base}${key}"><span>${label}</span><strong>${summary.counts[key ?? ""] ?? 0}</strong></a>`).join("")}</div>
      <div class="grid">${panel("Knowledge states", summary.states.length ? `<div class="links">${summary.states.map((item) => `<div>${badge(item.state)} <strong>${text(item.count)}</strong></div>`).join("")}</div>` : `<p class="muted">No knowledge has been stored yet. Captured events may still be awaiting learning or verification.</p>`)}
      ${panel("Guidance use", fields([["Requests recorded", summary.usage?.requests ?? 0], ["With guidance provided", summary.usage?.provided ?? 0], ["With explicit adoption", summary.usage?.adopted ?? 0]]) + `<p class="muted">These counts describe recorded use. Task outcomes and productivity benefit remain unknown.</p>`)}</div>
      ${panel("Local runtime", fields([["Viewer version", releaseMetadata.version], ["Code version", releaseMetadata.codeVersion], ["Data location", context.dataRoot], ["Last captured event", summary.latest], ["Capabilities", installation]]))}`);
  }
  if (id) {
    const back = `<a class="back" href="${context.base}${section}">← Back to ${text(section)}</a>`;
    if (section === "knowledge") {
      const detail = reader.knowledge(id); if (!detail) return missing();
      const item = detail.candidate;
      return finish("Knowledge detail", `${back}<h1>Knowledge detail</h1><div class="chips">${badge(item.state)}${badge(item.evidenceTier)}${badge(item.scope)}</div>
        ${panel("Recorded rule", `<p class="rule">${prose(item.content)}</p>${fields([["Created", item.createdAt], ["Validated", item.validatedAt], ["Expires", item.expiresAt], ["Scope identity", item.scopeId ?? "Personal"]])}<p class="muted">Stored state is shown here. Delivery also depends on task scope, expiry, conflicts, and current evidence checks.</p>`)}
        <div class="grid">${panel("Applies when", list(item.appliesWhen))}${panel("Does not apply when", list(item.nonApplicability))}</div>
        ${panel("Evidence references", item.sourceEvidenceIds.length ? eventLinks(context, item.sourceEvidenceIds) : `<p>No captured event references recorded.</p>`)}
        ${item.sourceEpisodeIds.length ? panel("Source work episodes", `<div class="links mono">${item.sourceEpisodeIds.slice(0, 100).map((episode) => link(context, "episodes", episode)).join("")}</div>`) : ""}
        ${proposalsView(context, detail.proposals)}
        ${panel("Conflicts and feedback", `<div class="links mono">${item.conflictsWith.slice(0, 100).map((conflict) => link(context, "knowledge", conflict)).join("")}</div>` + (detail.feedback.length ? detail.feedback.slice(0, 100).map((feedback) => `<p>${badge(feedback.kind)} ${prose(feedback.reason ?? "No reason recorded")}<br><small>${date(feedback.timestamp)} · ${text(feedback.source)}</small></p>${eventLinks(context, [feedback.evidenceRef])}`).join("") : `<p class="muted">No feedback recorded.</p>`))}
        ${panel("Recent use", usageTable(context, detail.usage) + (detail.usage.length > 100 ? "<p>Showing the latest 100 uses. Browse Usage for more.</p>" : ""))}${raw(item)}`);
    }
    if (section === "events") {
      const detail = reader.event(id); if (!detail) return missing();
      const { event, content, redaction } = detail.envelope;
      return finish("Captured event", `${back}<h1>${text(event.eventType)}</h1><div class="chips">${badge(event.trust)}${badge(detail.parseStatus)}${event.completionStatus ? badge(event.completionStatus) : ""}</div>
        ${panel("Event details", fields([["Time", event.timestamp], ["Session", event.sessionId], ["Repository", event.repoId], ["Worktree", event.worktree], ["Tool", event.toolName], ["Exit code", event.exitCode], ["Content enriched", detail.enriched ? "Yes" : "No"]]))}
        ${content?.message ? panel("Captured message", `<blockquote>${prose(content.message)}</blockquote>`) : ""}
        ${content?.safeError ? panel("Captured error", `<blockquote>${prose(content.safeError)}</blockquote>`) : ""}
        ${event.redactedArguments !== undefined ? panel("Captured arguments", json(event.redactedArguments)) : ""}
        ${content?.toolResult !== undefined ? panel("Captured result", typeof content.toolResult === "string" ? `<pre>${prose(content.toolResult)}</pre>` : json(content.toolResult)) : ""}
        ${!content ? `<div class="notice">No message or result content was retained for this event.</div>` : ""}
        ${redaction.truncatedPaths.length || redaction.droppedPaths.length || redaction.redactedPaths.length ? panel("Capture limits", `<p>Some fields were redacted, omitted, or truncated during capture.</p>${json(redaction)}`) : ""}
        ${event.parentEventId ? panel("Parent event", eventLinks(context, [event.parentEventId])) : ""}${raw(detail.envelope)}`);
    }
    if (section === "jobs") {
      const detail = reader.job(id); if (!detail) return missing();
      return finish("Learning job", `${back}<h1>Learning job</h1><div class="chips">${badge(detail.job.state)}${badge(detail.job.result)}</div>
        ${panel("Processing status", fields([["Created", detail.job.createdAt], ["Updated", detail.job.updatedAt], ["Attempts", detail.job.attempts], ["Pause reason", detail.job.pauseReason], ["Retry after", detail.job.retryAfter], ["Expires", detail.job.expiresAt], ["Error", detail.job.error]]))}${proposalsView(context, detail.proposals)}${raw(detail.job)}`);
    }
    if (section === "episodes") {
      const episode = reader.episode(id); if (!episode) return missing();
      return finish("Work episode", `${back}<h1>Work episode</h1>${panel("Goal", `<p class="rule">${prose(episode.goal)}</p>${fields([["Started", episode.startedAt], ["Finished", episode.finishedAt], ["Outcome", episode.outcome], ["Qualification", episode.outcomeQualification], ["Repository", episode.repoId]])}`)}${panel("Source events", eventLinks(context, episode.sourceEventIds))}${panel("Outcome evidence", eventLinks(context, episode.outcomeEvidenceIds))}${raw(episode)}`);
    }
    return missing();
  }
  if (!["knowledge", "events", "jobs", "usage", "episodes"].includes(section)) return missing();
  const collection = section as InspectionCollection;
  const params = context.url.searchParams;
  const query = params.get("q") ?? "";
  const state = params.get("state") ?? "";
  const scope = params.get("scope") ?? "";
  const session = params.get("session") ?? "";
  const page = reader.list(collection, { page: Number(params.get("page") ?? 1), query, state, scope, session });
  const title = navigation.find(([route]) => route === section)?.[1] ?? section;
  const descriptions = { knowledge: "Stored rules, including candidates and archived knowledge. Search the rule text or filter by state and scope.", events: "Captured event metadata across local sessions. Open an event to read its retained, redacted content. Search by type, session, or worktree.", jobs: "Background learning attempts and their outcomes. Open a job to inspect its proposals and verification.", usage: "Recorded context requests. Guidance provided and explicit adoption are counted separately. Search by session or repository.", episodes: "Related work grouped into episodes. Search by goal, then follow the source events." };
  const controls = `<form class="toolbar" method="get" action="${context.base}${section}"><label>Search<input type="search" name="q" value="${text(query)}" maxlength="256" placeholder="Search ${text(title.toLowerCase())}"></label>
    ${section === "knowledge" ? select("state", "State", ["candidate", "active", "disputed", "superseded", "archived"], state) + select("scope", "Scope", ["personal", "repository", "branch", "workflow"], scope) : ""}
    ${section === "jobs" ? select("state", "State", ["pending", "running", "evaluated", "waiting_evidence", "paused", "failed", "cancelled", "archived", "superseded"], state) : ""}
    ${section === "events" || section === "usage" ? `<label>Exact session<input name="session" value="${text(session)}" maxlength="256" placeholder="All sessions"></label>` : ""}<button type="submit">Apply</button><a href="${context.base}${section}">Clear</a></form>`;
  // The reader validates each collection against its persisted contract.
  const items = page.rows as unknown as Record<string, unknown>[];
  let results: string;
  if (collection === "knowledge") results = table(["Rule / scope identity", "State", "Evidence", "Scope"], items.map((item) => row([`<a class="title-link" href="${context.base}knowledge/${encodeURIComponent(String(item.knowledgeId))}">${prose(item.content)}</a><small class="mono">${text(item.scopeId ?? "Personal")}</small>`, badge(item.state), badge(item.evidenceTier), text(item.scope)])));
  else if (collection === "events") results = table(["Event / worktree", "Time", "Source", "Session"], items.map((item) => row([`${link(context, "events", String(item.deduplication_key), String(item.event_type))}<br><small>${text(item.worktree ?? item.repo_id ?? "Repository unknown")}</small>`, date(item.event_timestamp), badge(item.trust), `<span class="mono">${text(item.session_id ?? "Unknown")}</span>`])));
  else if (collection === "jobs") results = table(["Learning job", "State / result", "Attempts", "Updated"], items.map((item) => row([`${link(context, "jobs", String(item.jobId))}<br><small>${text(item.pauseReason ?? item.error ?? "")}</small>`, `${badge(item.state)} ${badge(item.result)}`, text(item.attempts), date(item.updatedAt)])));
  else if (collection === "episodes") results = table(["Goal", "Outcome", "Qualification", "Started"], items.map((item) => row([link(context, "episodes", String(item.episodeId), String(item.goal)), badge(item.outcome), text(item.outcomeQualification), date(item.startedAt)])));
  else results = usageTable(context, page.rows as unknown as Parameters<typeof usageTable>[1]);
  const pageLink = (number: number, label: string): string => { const next = new URLSearchParams(params); next.set("page", String(number)); return `<a href="${context.base}${section}?${text(next.toString())}">${label}</a>`; };
  return finish(title, `<div class="kicker">Browse local records</div><h1>${title}</h1><p class="intro">${descriptions[collection]}</p>${controls}${results}<div class="pagination"><span>${page.total} records · Page ${page.page} of ${Math.max(1, Math.ceil(page.total / page.pageSize))}</span><div>${page.page > 1 ? pageLink(page.page - 1, "← Previous") : ""}${page.page * page.pageSize < page.total ? pageLink(page.page + 1, "Next →") : ""}</div></div>`);
};
