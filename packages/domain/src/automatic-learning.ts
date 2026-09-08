import { posix, win32 } from "node:path";
import {
  learningInferenceResponseSchema, learningWindowSchema, mcpRecoveryReceiptSchema,
  type CaptureEnvelope, type LearningWindow, type LearningToolContract,
  type RuleProposal, type McpRecoveryReceipt, type LearningRecoveryReceipt, type KnowledgeCandidate,
} from "@provenloop/contracts";
import { sha256 } from "./digest.js";
import { validCapturedParent } from "./parent-bridge.js";
import { verifyShellRecovery } from "./shell-learning.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
export const learningSourceDigest = (event: CaptureEnvelope): string => sha256(event);

export const buildLearningWindows = (events: readonly CaptureEnvelope[], now: Date): LearningWindow[] => {
  const bridgedSources = new Set(events.flatMap((entry) => entry.event.parentBridge?.map((bridge) => bridge.sourceEventId) ?? []));
  const ordered = [...events].filter((entry) => entry.event.actorId !== "provenloop-internal" && !bridgedSources.has(entry.sourceEventId))
    .sort((a, b) => Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp) || a.event.eventId.localeCompare(b.event.eventId));
  const windows: LearningWindow[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const user = ordered[i];
    if (user === undefined || user.event.trust !== "user" || user.event.eventType !== "prompt.submitted" ||
        !user.content?.message || !user.event.sessionId || !user.event.repoId || !user.event.worktree ||
        user.event.repositoryState !== "known_repo") continue;
    const same = (entry: CaptureEnvelope): boolean => entry.event.sessionId === user.event.sessionId &&
      entry.event.repoId === user.event.repoId && entry.event.worktree === user.event.worktree;
    const prior = ordered.slice(0, i).filter(same);
    const latestFailure = prior.findLast((entry) => (entry.event.eventType === "tool.failed" || (entry.event.eventType === "tool.completed" && entry.event.exitCode !== undefined && entry.event.exitCode !== 0)) && entry.event.operationId !== undefined);
    const failedStart = latestFailure === undefined ? -1 : prior.findLastIndex((entry) =>
      entry.event.eventType === "tool.started" && entry.event.operationId === latestFailure.event.operationId &&
      Date.parse(entry.event.timestamp) <= Date.parse(latestFailure.event.timestamp));
    // Keep the actual failed operation and its causal response, not an earlier unrelated prompt.
    const previous = failedStart >= 0 ? prior.slice(failedStart).slice(-12) : prior.slice(-8);
    const following: CaptureEnvelope[] = [];
    for (const entry of ordered.slice(i + 1)) {
      if (!same(entry)) continue;
      if (entry.event.trust === "user" || previous.length + following.length >= 31) break;
      following.push(entry);
      if (["tool.completed", "tool.failed"].includes(entry.event.eventType)) break;
    }
    // An ordinary turn is analyzed after an actual operation changes state, without keyword gates.
    if (!following.some((entry) => ["tool.completed", "tool.failed", "session.idle"].includes(entry.event.eventType))) continue;
    if (now.getTime() - Date.parse(following.at(-1)?.event.timestamp ?? user.event.timestamp) < 2_000) continue;
    const selected = [...previous, user, ...following];
    const completion = following.at(-1);
    if (completion?.event.eventType === "tool.completed") {
      for (const proof of ordered.filter((entry) => same(entry) && entry.event.eventType === "test.completed" && entry.event.operationId === completion.event.operationId && entry.event.evidence?.sourceCompleteEventId === completion.sourceEventId)) {
        if (selected.length < 32 && !selected.includes(proof)) selected.push(proof);
      }
    }
    const sources = selected.map((entry) => ({ eventId: entry.event.eventId, digest: learningSourceDigest(entry) }));
    const window = learningWindowSchema.parse({
      schemaVersion: 1, windowId: `learning-window-${sha256(user.event.eventId).slice(0, 24)}`,
      revision: sha256(sources), sessionId: user.event.sessionId, repoId: user.event.repoId,
      worktree: user.event.worktree, createdAt: user.event.timestamp, sources, events: selected,
    });
    windows.push(window);
  }
  return windows;
};

export const validateLearningResponse = (window: LearningWindow, output: unknown): ReturnType<typeof learningInferenceResponseSchema.parse> => {
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > 16 * 1024) throw new Error("Learning response exceeds byte budget.");
  const parsed = learningInferenceResponseSchema.parse(output);
  const sources = new Map(window.events.map((entry) => [entry.event.eventId, entry]));
  for (const proposal of parsed.proposals) {
    if (proposal.predicate && proposal.shellPredicate) throw new Error("A proposal cannot mix shell and MCP predicates.");
    const user = sources.get(proposal.userSource.eventId);
    if (user?.event.trust !== "user" || user.event.eventType !== "prompt.submitted" ||
        `learning-window-${sha256(user.event.eventId).slice(0, 24)}` !== window.windowId ||
        !user.content?.message?.includes(proposal.userSource.quote)) throw new Error("Invalid user source quotation.");
    for (const id of [proposal.failedOperationEventId, proposal.retryOperationEventId, proposal.completionEventId]) {
      if (!sources.has(id)) throw new Error("Proposal references an unknown source.");
    }
    if (sources.get(proposal.failedOperationEventId)?.event.eventType !== "tool.started" ||
        sources.get(proposal.retryOperationEventId)?.event.eventType !== "tool.started" ||
        sources.get(proposal.completionEventId)?.event.eventType !== "tool.completed") {
      throw new Error("Proposal operation references must identify failed/retry tool.started events and the retry tool.completed event.");
    }
  }
  return parsed;
};

export const renderLearningPredicate = (proposal: RuleProposal): string | undefined => {
  if (proposal.shellPredicate && !proposal.predicate) return `Use ${proposal.shellPredicate.command} instead of ${proposal.shellPredicate.failedCommand} for this repository's tests at the verified revision.`;
  const p = proposal.predicate;
  if (p === undefined) return undefined;
  return p.kind === "required_argument"
    ? `Supply the required ${p.argument} argument when calling ${p.serverName}/${p.toolName}.`
    : `Use an absolute path for ${p.argument} when calling ${p.serverName}/${p.toolName} under the recorded tool contract.`;
};

export const verifyMcpRecovery = (proposal: RuleProposal, events: readonly CaptureEnvelope[], contracts: readonly LearningToolContract[], now: Date): McpRecoveryReceipt | undefined => {
  const predicate = proposal.predicate;
  if (predicate === undefined) return undefined;
  const contract = contracts.find((item) => item.digest === predicate.contractDigest && item.serverName === predicate.serverName && item.toolName === predicate.toolName);
  if (contract === undefined || sha256({ schemaVersion: contract.schemaVersion, serverName: contract.serverName, toolName: contract.toolName, version: contract.version, sourceSchemaDigest: contract.sourceSchemaDigest, requiredArguments: contract.requiredArguments, absolutePathArguments: contract.absolutePathArguments }) !== contract.digest) return undefined;
  if (!(predicate.kind === "required_argument" ? contract.requiredArguments : contract.absolutePathArguments).includes(predicate.argument)) return undefined;
  const byId = new Map(events.map((entry) => [entry.event.eventId, entry]));
  const failed = byId.get(proposal.failedOperationEventId);
  const retry = byId.get(proposal.retryOperationEventId);
  const completion = byId.get(proposal.completionEventId);
  const user = byId.get(proposal.userSource.eventId);
  const failure = events.find((entry) => entry.event.eventType === "tool.failed" && entry.event.operationId === failed?.event.operationId && entry.event.sessionId === failed?.event.sessionId);
  if (!failed || !retry || !completion || !user || !failure || user.event.trust !== "user" ||
      !user.content?.message?.includes(proposal.userSource.quote)) return undefined;
  const chain = [failed, failure, user, retry, completion];
  if (!user.event.sessionId || !user.event.repoId || !user.event.worktree || chain.some((entry) =>
    entry.event.sessionId !== user.event.sessionId || entry.event.repoId !== user.event.repoId ||
    entry.event.worktree !== user.event.worktree || entry.event.repositoryState !== "known_repo" ||
    entry.redaction.truncatedPaths.length > 0 || entry.redaction.droppedPaths.length > 0 ||
    entry.redaction.redactedPaths.length > 0 || (entry.event.captureQuality?.truncatedFields.length ?? 0) > 0 ||
    (entry.event.captureQuality?.omittedFields.length ?? 0) > 0)) return undefined;
  if (chain.some((entry, index) => index > 0 && Date.parse(entry.event.timestamp) <= Date.parse(chain[index - 1]?.event.timestamp ?? ""))) return undefined;
  const native = (entry: CaptureEnvelope): boolean => {
    const metadata = record(record(entry.event).mcp);
    return entry.event.trust === "tool" && metadata.serverName === predicate.serverName && metadata.toolName === predicate.toolName && metadata.contractDigest === contract.digest;
  };
  if (![failed, failure, retry, completion].every(native) || failed.event.eventType !== "tool.started" || retry.event.eventType !== "tool.started" ||
      completion.event.eventType !== "tool.completed" || completion.event.completionStatus !== "succeeded" ||
      completion.event.operationId !== retry.event.operationId || failed.event.operationId === retry.event.operationId ||
      !(completion.event.mcp?.isError === false || completion.event.mcp?.resultType === "success") ||
      !(failure.event.mcp?.isError === true || failure.event.mcp?.resultType === "failure") ||
      failure.event.mcp?.isError === false || failure.event.mcp?.resultType === "success" ||
      completion.event.mcp?.isError === true || completion.event.mcp?.resultType === "failure" ||
      failure.event.mcp?.failureArgument !== predicate.argument) return undefined;
  const before = record(failed.event.redactedArguments);
  const after = record(retry.event.redactedArguments);
  const absolute = (value: unknown): boolean => typeof value === "string" && (win32.isAbsolute(value) || posix.isAbsolute(value));
  const valid = (value: unknown): boolean => predicate.kind === "absolute_path" ? absolute(value) : value !== undefined && value !== null;
  if (valid(before[predicate.argument]) || !valid(after[predicate.argument]) ||
      contract.requiredArguments.some((arg) => after[arg] === undefined || after[arg] === null) ||
      contract.absolutePathArguments.some((arg) => after[arg] !== undefined && !absolute(after[arg]))) return undefined;
  const otherBefore = Object.fromEntries(Object.entries(before).filter(([key]) => key !== predicate.argument));
  const otherAfter = Object.fromEntries(Object.entries(after).filter(([key]) => key !== predicate.argument));
  if (sha256(otherBefore) !== sha256(otherAfter)) return undefined;
  const traces = (entry: CaptureEnvelope, target: string): boolean => {
    const visited = new Set<string>(); let current = entry.event.parentEventId; let childTime = Date.parse(entry.event.timestamp); let child = entry;
    while (current && !visited.has(current)) {
      visited.add(current); const parent = byId.get(current);
      if (!parent || !validCapturedParent(child, parent)) return false;
      if (current === target) return true;
      if (!parent || parent.event.sessionId !== user.event.sessionId || parent.event.repoId !== user.event.repoId ||
          parent.event.worktree !== user.event.worktree || Date.parse(parent.event.timestamp) > childTime ||
          parent.event.trust === "user" || parent.event.trust === "external-content") return false;
      childTime = Date.parse(parent.event.timestamp);
      child = parent;
      current = parent.event.parentEventId;
    }
    return false;
  };
  if (!traces(retry, user.event.eventId) || !traces(user, failure.event.eventId) ||
      !traces(failure, failed.event.eventId) || !traces(completion, retry.event.eventId)) return undefined;
  if (events.filter((entry) => entry.event.eventType === "tool.started" && entry.event.toolName === retry.event.toolName && traces(entry, user.event.eventId)).length !== 1) return undefined;
  if (proposal.sourceDigests.some((source) => { const entry = byId.get(source.eventId); return !entry || learningSourceDigest(entry) !== source.digest; })) return undefined;
  if (chain.some((entry) => !proposal.sourceDigests.some((source) => source.eventId === entry.event.eventId))) return undefined;
  if (events.some((entry) => entry.event.sessionId === user.event.sessionId && entry.event.operationId === retry.event.operationId &&
      (entry.event.eventType === "tool.failed" || entry.event.completionStatus === "failed" || entry.event.mcp?.isError === true))) return undefined;
  return mcpRecoveryReceiptSchema.parse({ schemaVersion: 1, receiptId: `mcp-recovery-${sha256([proposal.proposalId, contract.digest]).slice(0, 24)}`,
    proposalId: proposal.proposalId, predicate, contract, failureEventId: failure.event.eventId, userEventId: user.event.eventId,
    failedOperationEventId: failed.event.eventId, retryOperationEventId: retry.event.eventId, completionEventId: completion.event.eventId,
    sourceDigests: proposal.sourceDigests, verifiedAt: now.toISOString(), proves: "invocation_contract" });
};

export const verifyLearningRecovery = (proposal: RuleProposal, events: readonly CaptureEnvelope[], contracts: readonly LearningToolContract[], now: Date): LearningRecoveryReceipt | undefined =>
  proposal.shellPredicate ? verifyShellRecovery(proposal, events, now) : verifyMcpRecovery(proposal, events, contracts, now);

export const learningKnowledgeCandidate = (window: LearningWindow, proposal: RuleProposal, receipt?: LearningRecoveryReceipt): KnowledgeCandidate => ({
  schemaVersion: 1, knowledgeId: proposal.knowledgeId, topicKey: `learning:${sha256([window.repoId, proposal.shellPredicate ?? proposal.predicate ?? proposal.trigger]).slice(0, 24)}`,
  kind: "semantic", scope: "repository", scopeId: window.repoId,
  content: receipt ? renderLearningPredicate(proposal) ?? proposal.rule : proposal.rule,
  appliesWhen: receipt?.proves === "repository_test_command" ? [`Running ${receipt.predicate.failedCommand} or ${receipt.predicate.command} in the verified repository revision.`] : receipt ? [`Calling ${receipt.predicate.serverName}/${receipt.predicate.toolName} under its verified tool contract.`] : [proposal.trigger],
  nonApplicability: receipt ? ["Other repositories, tools, or contract versions; semantic correctness of returned data."] : proposal.exclusions, conflictsWith: [],
  sourceEpisodeIds: [], sourceEvidenceIds: proposal.sourceDigests.map((item) => item.eventId),
  createdAt: proposal.createdAt, ...(receipt ? { validatedAt: receipt.verifiedAt } : { expiresAt: proposal.expiresAt }),
  evidenceMarks: receipt ? ["externally_verified"] : [], evidenceTier: receipt ? "externally_verified" : "inferred",
  state: receipt ? "active" : "candidate", importance: 0, utility: { applied: 0, harmful: 0, helpful: 0 }, coverage: { applicableOpportunities: 0, observedOutcomes: 0 },
});
