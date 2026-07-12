/** Pure ranking rules — the battlefield's law. */

export interface Rankable {
  id: string;
  addedAt: number;
  score: number;
}

/**
 * Queue order: net score DESC, then oldest-first (respect for the patient),
 * then id for total determinism.
 */
export function rankQueue<T extends Rankable>(songs: T[]): T[] {
  return [...songs].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
    return a.id < b.id ? -1 : 1;
  });
}

/** Skip passes when MORE THAN half of active participants voted skip. */
export function skipPasses(skipVotes: number, activeParticipants: number): boolean {
  if (activeParticipants <= 0) return false;
  return skipVotes > activeParticipants / 2;
}

/** Votes needed for the live percentage bar. */
export function skipNeeded(activeParticipants: number): number {
  return Math.floor(activeParticipants / 2) + 1;
}
