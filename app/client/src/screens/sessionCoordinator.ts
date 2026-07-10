export type AttemptPromise = Promise<number | null>;

export type CoordinatedBlock = {
  id: string;
  kind: string;
  minutes: number;
};

export type OpenBlockHandle = CoordinatedBlock & {
  completionId: string;
  attemptId: AttemptPromise;
};

export type PendingCompletion = {
  completionId: string;
  attemptId: number | null;
  blockKind: string;
  amount: number;
};

export function completionRequest(handle: OpenBlockHandle, attemptId: number | null): PendingCompletion {
  return {
    completionId: handle.completionId,
    attemptId,
    blockKind: handle.kind,
    amount: handle.minutes,
  };
}

export function retainFailedCompletion(
  current: PendingCompletion[],
  failed: PendingCompletion,
): PendingCompletion[] {
  return current.some((item) => item.completionId === failed.completionId) ? current : [...current, failed];
}

export type SessionCoordinator = {
  beginGeneration(): number;
  invalidateGeneration(): void;
  isCurrent(generation: number): boolean;
  open(block: CoordinatedBlock, beginAttempt: () => AttemptPromise, generation: number): boolean;
  take(blockId: string): OpenBlockHandle | null;
  takeOpen(): OpenBlockHandle | null;
};

/**
 * SessionRunnerの非同期response世代と「現在開いているblock」をReact外で管理する。
 * block handleへattempt promiseを同梱するため、start responseが逆順でも別blockへ混線しない。
 */
export function makeSessionCoordinator(
  makeId: () => string = () => crypto.randomUUID(),
): SessionCoordinator {
  let generation = 0;
  let openBlock: OpenBlockHandle | null = null;
  return {
    beginGeneration() {
      generation++;
      return generation;
    },
    invalidateGeneration() {
      generation++;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
    open(block, beginAttempt, candidate) {
      if (candidate !== generation || openBlock !== null) return false;
      openBlock = { ...block, completionId: makeId(), attemptId: beginAttempt() };
      return true;
    },
    take(blockId) {
      if (openBlock?.id !== blockId) return null;
      const taken = openBlock;
      openBlock = null;
      return taken;
    },
    takeOpen() {
      const taken = openBlock;
      openBlock = null;
      return taken;
    },
  };
}
