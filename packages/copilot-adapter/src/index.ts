export {
  AsyncCaptureWriter,
  InvalidCaptureWriterConfigurationError,
  type AsyncCaptureWriterOptions,
  type CaptureHealthState,
  type CaptureQueueSink,
  type CaptureWriterStatus,
} from "./async-writer.js";
export {
  COPILOT_CAPTURE_CAPABILITIES,
  COPILOT_SUPPORTED_SOURCE_EVENT_TYPES,
  getCopilotCaptureCapability,
} from "./capabilities.js";
export {
  BoundedCaptureBuffer,
  captureGapEvent,
  InvalidCaptureBufferConfigurationError,
  type BoundedCaptureBufferOptions,
  type CaptureBufferOfferResult,
  type CaptureBufferOfferStatus,
  type CaptureGap,
} from "./capture-buffer.js";
export {
  CaptureReconciler,
  type CanonicalCaptureWatermark,
  type CaptureReconcilerOptions,
  type CaptureReconciliationResult,
  type ReconcileSessionFileOptions,
  type ReconciliationQueue,
} from "./capture-reconciler.js";
export {
  CopilotEventMapper,
  InvalidCopilotEventMapperConfigurationError,
  type CopilotCallbackCopyLimits,
  type CopilotEventMapperOptions,
  type CopilotEventMappingResult,
  type CopilotSessionEvent,
  type CopilotWorkspaceSnapshot,
} from "./event-mapper.js";
export {
  CopilotExtensionCapture,
  InvalidExtensionCaptureConfigurationError,
  type CopilotExtensionCaptureOptions,
  type CopilotExtensionCaptureStatus,
  type CopilotSessionLike,
} from "./extension-runtime.js";
export {
  startCopilotExtensionCapture,
  type CaptureTerminationSignalSource,
  type StartCopilotExtensionCaptureOptions,
} from "./start-extension.js";
export {
  InvalidSessionFileParserConfigurationError,
  parseCopilotSessionFile,
  type CopilotSessionFileHeader,
  type CopilotSessionFileIssue,
  type CopilotSessionFileParserOptions,
  type CopilotSessionFileParseResult,
} from "./session-file-parser.js";
