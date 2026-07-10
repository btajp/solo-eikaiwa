/** 非同期操作のうち、最後に始めた要求だけを画面状態へ反映するための世代管理。 */
export function makeLatestGeneration(): { begin: () => number; isCurrent: (generation: number) => boolean } {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isCurrent(generation) {
      return latest === generation;
    },
  };
}
