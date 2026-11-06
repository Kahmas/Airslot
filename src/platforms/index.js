import { createFacebook } from './facebook.js';
import { createInstagram } from './instagram.js';
import { createTikTok } from './tiktok.js';
import { createYouTube } from './youtube.js';

// Limits per rolling 24 hours, from each platform's publishing documentation.
// TikTok's is how many drafts may wait in someone's inbox at once.
export const DAILY_LIMITS = { instagram: 100, facebook: 30, youtube: 100, tiktok: 5 };

// YouTube counts uploads against the whole Google project, so every person on this server shares this.
export const SHARED_YOUTUBE_UPLOADS_PER_DAY = 100;

export function createPlatforms(config) {
  return {
    instagram: createInstagram(config),
    facebook: createFacebook(config),
    youtube: createYouTube(config),
    tiktok: createTikTok(config),
  };
}
