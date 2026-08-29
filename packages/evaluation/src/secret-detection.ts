import type { EvidenceLedgerEntry } from "@provenloop/contracts";

const knownSecretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/u,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
];

const knownSecretReplacementPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/gu,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu,
];

const tokenCandidates = (value: string): readonly string[] =>
  value.match(/[A-Za-z0-9+/=_]{24,}|[A-Fa-f0-9]{32,}/gu) ?? [];

const bitsPerSymbol = (value: string): number => {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  return [...frequencies.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
};

export const containsKnownSecret = (value: string): boolean =>
  knownSecretPatterns.some((pattern) => pattern.test(value));

export const containsPotentialSecret = (value: string): boolean =>
  containsKnownSecret(value) ||
  tokenCandidates(value).some(
    (candidate) => bitsPerSymbol(candidate) >= 3.5,
  );

export const redactKnownSecrets = (value: string): string =>
  knownSecretReplacementPatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );

export const redactPotentialSecrets = (value: string): string => {
  const knownRedacted = redactKnownSecrets(value);
  return tokenCandidates(knownRedacted).reduce(
    (redacted, candidate) =>
      bitsPerSymbol(candidate) >= 3.5
        ? redacted.replaceAll(candidate, "[REDACTED]")
        : redacted,
    knownRedacted,
  );
};

const allLedgerStrings = (
  entry: EvidenceLedgerEntry,
): readonly string[] =>
  [
    entry.actorId,
    entry.claimId,
    entry.episodeId,
    entry.eventId,
    entry.invocationId,
    entry.ledgerEntryId,
    entry.participantId,
    entry.requestedModel,
    entry.requestedProvider,
    entry.resolvedModel,
    entry.resolvedProvider,
    entry.runId,
    entry.status,
  ].filter((value): value is string => value !== undefined);

const entropyEligibleLedgerStrings = (
  entry: EvidenceLedgerEntry,
): readonly string[] =>
  [
    entry.actorId,
    entry.participantId,
    entry.requestedModel,
    entry.requestedProvider,
    entry.resolvedModel,
    entry.resolvedProvider,
  ].filter(
    (value): value is string =>
      value !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        value,
      ),
  );

export const immutableLedgerIdentifierContainsSecret = (
  entry: EvidenceLedgerEntry,
): boolean =>
  containsKnownSecret(entry.ledgerEntryId) ||
  containsKnownSecret(entry.runId);

export const ledgerEntryContainsSecret = (
  entry: EvidenceLedgerEntry,
): boolean =>
  allLedgerStrings(entry).some(containsKnownSecret) ||
  entropyEligibleLedgerStrings(entry).some(containsPotentialSecret);
