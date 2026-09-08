import type { LearningWindow, LearningJob, LearningToolContract, RuleProposal, LearningRecoveryReceipt } from "@provenloop/contracts";
import { buildLearningWindows, validateLearningResponse, verifyLearningRecovery, learningKnowledgeCandidate, sha256, sanitizeDiagnostic } from "@provenloop/domain";
import type { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import type { ProcessLeaseProvider } from "@provenloop/platform-windows";

export interface LearningInferenceProvider {
  readonly identity: { readonly provider: string; readonly model: string; readonly version: string };
  infer(window: LearningWindow, options: { readonly signal: AbortSignal }): Promise<unknown>;
}
export interface LearningCoordinatorOptions {
  readonly store: CanonicalSqliteStore; readonly provider: LearningInferenceProvider;
  readonly lease: ProcessLeaseProvider; readonly enabled: () => Promise<boolean>;
  readonly contracts?: () => readonly LearningToolContract[]; readonly now?: () => Date;
  readonly dailyLimit?: number; readonly candidateDays?: number; readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}
export interface LearningRunResult {
  readonly status: "disabled" | "busy" | "idle" | "paused" | "evaluated" | "failed" | "cancelled";
  readonly jobId?: string; readonly proposals?: number; readonly qualified?: number; readonly reason?: string;
}

export class LearningCoordinator {
  public constructor(private readonly options: LearningCoordinatorOptions) {
    for (const [name, value, maximum] of [["dailyLimit", options.dailyLimit ?? 200, 10_000], ["candidateDays", options.candidateDays ?? 30, 365], ["deadlineMs", options.deadlineMs ?? 60_000, 60_000]] as const) {
      if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new RangeError(`Invalid learning ${name}.`);
    }
  }

  public async run(): Promise<LearningRunResult> {
    const { store, provider } = this.options;
    const now = this.options.now ?? (() => new Date());
    if (this.options.signal?.aborted || !await this.options.enabled()) return { status: "disabled" };
    const lease = await this.options.lease.tryAcquire();
    if (!lease) return { status: "busy" };
    try {
      if (this.options.signal?.aborted || !await this.options.enabled() || store.hasActiveDeletion()) return { status: "disabled" };
      const time = now();
      let evidenceResult: LearningRunResult | undefined;
      for (const job of store.learningJobsDue(time, "maintenance")) {
        if (Date.parse(job.expiresAt) <= time.getTime() && !["archived", "cancelled"].includes(job.state)) {
          store.transitionLearningJob({ ...job, state: "archived", updatedAt: time.toISOString() }, job.state);
          for (const proposal of store.learningProposalsForJob(job.jobId)) {
            const candidate = store.knowledgeCandidates([proposal.knowledgeId])[0];
            if (candidate?.state === "candidate") store.upsertKnowledgeCandidates([{ ...candidate, state: "archived" }]);
          }
        } else if (job.state === "running" && job.deadline && Date.parse(job.deadline) <= time.getTime()) {
          store.transitionLearningJob({ ...job, state: job.attempts >= 3 ? "failed" : "pending", updatedAt: time.toISOString(), error: "Inference lease expired." }, "running");
        }
      }
      for (const job of store.learningJobsDue(time, "evidence")) {
        const window = store.learningWindow(job.jobId);
        if (!window || !store.learningSourcesCurrent(window)) {
          store.transitionLearningJob({ ...job, state: window && store.learningSourcesExist(window) ? "superseded" : "cancelled", updatedAt: time.toISOString() }, "waiting_evidence");
          continue;
        }
        const proposals = store.learningProposalsForJob(job.jobId).filter((entry) =>
          store.knowledgeCandidates([entry.knowledgeId])[0]?.state === "candidate");
        if (proposals.length === 0) {
          store.transitionLearningJob({ ...job, state: "evaluated", updatedAt: time.toISOString() }, "waiting_evidence");
          continue;
        }
        const receipts = proposals.flatMap((proposal): LearningRecoveryReceipt[] => {
          const receipt = verifyLearningRecovery(proposal, window.events, this.options.contracts?.() ?? [], time);
          return receipt ? [receipt] : [];
        });
        if (receipts.length === 0) {
          // Round-robin waiting candidates so one unprovable page cannot starve later evidence.
          store.transitionLearningJob({ ...job, updatedAt: time.toISOString() }, "waiting_evidence");
          continue;
        }
        const qualified = proposals.filter((proposal) => receipts.some((receipt) => receipt.proposalId === proposal.proposalId));
        if (this.options.signal?.aborted || !await this.options.enabled()) return { status: "disabled" };
        const updated: LearningJob = { ...job, state: qualified.length === proposals.length ? "evaluated" : "waiting_evidence", updatedAt: time.toISOString(), result: "qualified" };
        try {
          if (store.commitLearningResult({ job: updated, proposals: qualified, receipts, reevaluation: true,
            candidates: qualified.map((proposal) => learningKnowledgeCandidate(window, proposal, receipts.find((receipt) => receipt.proposalId === proposal.proposalId))),
          })) {
            evidenceResult = { status: "evaluated", jobId: job.jobId, proposals: (evidenceResult?.proposals ?? 0) + qualified.length, qualified: (evidenceResult?.qualified ?? 0) + receipts.length };
            continue;
          }
        } catch {
          // Current counterevidence or user controls can refuse promotion without another model attempt.
        }
        store.transitionLearningJob({ ...job, updatedAt: time.toISOString() }, "waiting_evidence");
      }
      for (const work of store.learningPromptWork(time)) {
        const windowId = `learning-window-${sha256(work.eventId).slice(0, 24)}`;
        const window = buildLearningWindows(work.events, time).find((entry) => entry.windowId === windowId);
        if (window) {
          store.scheduleLearningWindow(window, new Date(Date.parse(window.createdAt) + (this.options.candidateDays ?? 30) * 86_400_000).toISOString(), time);
        }
        // Keep a debounced turn durable even when no more events arrive after this pass.
        const unsettled = !window && work.events.some((entry) => Date.parse(entry.event.timestamp) > time.getTime() - 2_000);
        store.completeLearningPromptWork(work, unsettled ? time.getTime() + 2_000 : undefined);
      }
      const pending = store.learningJobsDue(time, "inference", 1)[0];
      if (!pending) return evidenceResult ?? { status: "idle" };
      if (this.options.signal?.aborted) return { status: "disabled" };
      const window = store.learningWindow(pending.jobId);
      if (!window || !store.learningSourcesCurrent(window)) {
        store.transitionLearningJob({ ...pending, state: window && store.learningSourcesExist(window) ? "superseded" : "cancelled", updatedAt: time.toISOString() }, pending.state);
        return { status: "cancelled", jobId: pending.jobId };
      }
      if (!await this.options.enabled()) return { status: "disabled" };
      if (!store.reserveLearningAttempt(time, this.options.dailyLimit ?? 200)) {
        store.transitionLearningJob({ ...pending, state: "paused", updatedAt: time.toISOString(), pauseReason: "daily_budget",
          retryAfter: new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate() + 1)).toISOString() }, pending.state);
        return evidenceResult ?? { status: "paused", jobId: pending.jobId, reason: "daily_budget" };
      }
      const deadlineMs = this.options.deadlineMs ?? 60_000;
      const running: LearningJob = { ...pending, state: "running", attempts: pending.attempts + 1, updatedAt: time.toISOString(),
        deadline: new Date(time.getTime() + deadlineMs).toISOString(), provider: provider.identity.provider, model: provider.identity.model, extractorVersion: `correction-extractor-1/${provider.identity.version}` };
      delete running.pauseReason; delete running.retryAfter; delete running.error; delete running.result;
      if (!store.transitionLearningJob(running, pending.state)) return { status: "busy" };
      const controller = new AbortController();
      const providerSignal = this.options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, this.options.signal]);
      let timer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      let inference: Promise<unknown> | undefined;
      try {
        // Only the separate inference lease is held here; SQLite/projection/ingestion leases are free.
        const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Learning inference deadline exceeded.")); }, deadlineMs); });
        if (providerSignal.aborted) throw new Error("Learning inference cancelled.");
        const aborted = new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(new Error("Learning inference cancelled."));
          if (providerSignal.aborted) abortListener();
          else providerSignal.addEventListener("abort", abortListener, { once: true });
        });
        inference = provider.infer(window, { signal: providerSignal });
        const output = await Promise.race([inference, timeout, aborted]);
        clearTimeout(timer);
        if (providerSignal.aborted || !await this.options.enabled()) throw new Error("Learning inference stopped before submission.");
        if (!store.learningSourcesCurrent(window) || store.hasActiveDeletion()) {
          store.transitionLearningJob({ ...running, state: store.learningSourcesExist(window) && !store.hasActiveDeletion() ? "superseded" : "cancelled", updatedAt: now().toISOString() }, "running");
          return { status: "cancelled", jobId: running.jobId };
        }
        if (Date.parse(running.expiresAt) <= now().getTime()) {
          store.transitionLearningJob({ ...running, state: "archived", updatedAt: now().toISOString() }, "running");
          return evidenceResult ?? { status: "cancelled", jobId: running.jobId, reason: "expired" };
        }
        const parsed = validateLearningResponse(window, output);
        const proposals: RuleProposal[] = parsed.proposals.map((entry) => {
          const identity = sha256([window.repoId, entry.shellPredicate ? [entry.shellPredicate, window.events.find((event) => event.event.eventId === entry.userSource.eventId)?.event.commitSha] : entry.predicate ?? [entry.rule, entry.trigger]]);
          return { ...entry, schemaVersion: 1, proposalId: `learning-proposal-${sha256([running.jobId, entry]).slice(0, 24)}`, jobId: running.jobId,
            knowledgeId: `learning-knowledge-${identity.slice(0, 24)}`, createdAt: window.createdAt, expiresAt: running.expiresAt, sourceDigests: window.sources };
        });
        const receipts = proposals.flatMap((proposal): LearningRecoveryReceipt[] => {
          const receipt = verifyLearningRecovery(proposal, window.events, this.options.contracts?.() ?? [], now());
          return receipt ? [receipt] : [];
        });
        const candidates = proposals.map((proposal) => learningKnowledgeCandidate(window, proposal, receipts.find((entry) => entry.proposalId === proposal.proposalId)));
        const updated: LearningJob = { ...running, state: proposals.length > receipts.length ? "waiting_evidence" : "evaluated", updatedAt: now().toISOString(),
          result: proposals.length === 0 ? "no_rule" : receipts.length > 0 ? "qualified" : "candidate" };
        const committed = store.commitLearningResult({ job: updated, proposals, receipts, candidates });
        return committed ? { status: "evaluated", jobId: running.jobId, proposals: proposals.length + (evidenceResult?.proposals ?? 0), qualified: receipts.length + (evidenceResult?.qualified ?? 0) } : evidenceResult ?? { status: "cancelled", jobId: running.jobId };
      } catch (error) {
        clearTimeout(timer); controller.abort();
        const cancelled = this.options.signal?.aborted === true;
        const disabled = !await this.options.enabled();
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        const unavailable = code === "signed_out" || code === "rate_limited" || code === "unavailable" ? code : undefined;
        const pauseReason = cancelled ? "host_stopped" : disabled ? "learning_disabled" : unavailable;
        const finished = now();
        const state = !store.learningSourcesCurrent(window) ? (store.learningSourcesExist(window) ? "superseded" : "cancelled")
          : Date.parse(running.expiresAt) <= finished.getTime() ? "archived" : pauseReason ? "paused" : "failed";
        store.transitionLearningJob({ ...running, state, attempts: pauseReason ? pending.attempts : running.attempts,
          updatedAt: finished.toISOString(), result: "error", error: sanitizeDiagnostic(error).slice(0, 512),
          ...(pauseReason ? { pauseReason, retryAfter: new Date(finished.getTime() + (unavailable === "signed_out" ? 300_000 : unavailable ? 60_000 : 0)).toISOString() } : {}),
        }, "running");
        return evidenceResult ?? { status: cancelled ? "cancelled" : disabled ? "disabled" : unavailable ? "paused" : "failed", jobId: running.jobId, reason: pauseReason ?? "inference_or_validation_failed" };
      } finally {
        clearTimeout(timer);
        if (abortListener) providerSignal.removeEventListener("abort", abortListener);
        if (providerSignal.aborted && inference) {
          let grace: NodeJS.Timeout | undefined;
          const settled = await Promise.race([
            inference.then(()=>true,()=>true),
            new Promise<boolean>((resolve)=>{grace=setTimeout(()=>resolve(false),8000);}),
          ]).finally(()=>clearTimeout(grace));
          if (!settled) await Promise.reject(new Error("Inference cancellation cleanup is still pending."));
        }
      }
    } finally { await lease.release(); }
  }
}
