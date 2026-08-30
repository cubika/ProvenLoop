export {
  CaptureQueueItemNotFoundError,
  CaptureQueueNotInitializedError,
  CaptureQueueDeletionInProgressError,
  ConflictingCaptureQueueDeletionError,
  CorruptCaptureQueueItemError,
  DuplicateQueueItemIdError,
  DeletedCaptureSourceError,
  InvalidCaptureQueueConfigurationError,
  InvalidCaptureQueueTransitionError,
  InvalidQueueItemIdError,
  StaleCaptureQueueClaimError,
  WindowsCaptureQueue,
  type EnqueueCaptureIfAbsentResult,
  type CaptureQueueClaim,
  type CaptureQueueIdentity,
  type DeleteCaptureQueueResult,
  type DeleteCaptureQueueOptions,
  type EnqueueCaptureOptions,
  type WindowsCaptureQueueOptions,
} from "./capture-queue.js";
export {
  discoverCopilotSessionFiles,
  InvalidSessionDiscoveryConfigurationError,
  resolveCopilotSessionStateRoot,
  type CopilotSessionFileDescriptor,
  type DiscoverCopilotSessionFilesOptions,
} from "./copilot-session-files.js";
export {
  WindowsNamedPipeLeaseProvider,
  windowsNamedPipePath,
  type ProcessLease,
  type ProcessLeaseProvider,
} from "./process-lease.js";
export {
  LocalAppDataUnavailableError,
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopDataRoot,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  type WindowsProvenLoopPaths,
} from "./operational-paths.js";
