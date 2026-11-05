import { TransientError } from './http.js';

const MAX_TRIES = 3;

// A cover must never cost someone their post. Whatever goes wrong here ends in a note on the Schedule page.
export async function settleCover(stage, platform, attempt) {
  try {
    await attempt();
    return { ...stage, coverDone: true };
  } catch (err) {
    const tries = (stage.coverTries ?? 0) + 1;
    if (err instanceof TransientError && tries < MAX_TRIES) return { ...stage, coverTries: tries };
    return { ...stage, coverDone: true, coverNote: `${platform} didn't accept the cover, so it picked its own. ${err.message}` };
  }
}
