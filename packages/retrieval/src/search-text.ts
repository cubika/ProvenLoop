const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const cjkRuns = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const segmenter = new Intl.Segmenter("zh", {
  granularity: "word",
});

export const retrievalTokens = (input: string): readonly string[] => {
  const normalized = input.normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const result = new Set<string>(tokens);
  if (cjk.test(normalized)) {
    for (const segment of segmenter.segment(normalized)) {
      if (segment.isWordLike) {
        result.add(segment.segment);
      }
    }
    for (const run of normalized.match(cjkRuns) ?? []) {
      const characters = [...run];
      for (let index = 0; index + 1 < characters.length; index += 1) {
        result.add(characters.slice(index, index + 2).join(""));
      }
    }
  }
  return [...result];
};

export const searchableText = (input: string): string =>
  [
    input,
    ...retrievalTokens(input).filter((token) => cjk.test(token)),
  ].join("\n");
