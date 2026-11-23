// Adapter for the shared ShareModal plus the score-card capture flow. Svelte
// entrypoints must not call legacy DOM factories directly
// (tests/legacy-adapters.test.ts); the modal itself is owned by the post
// surface and stays out of the Arcade migration.
import { createShareModal, type ShareModalProps } from '../../components/ShareModal.ts';
import type { Game } from '../../types/game.js';
import { t } from '../i18n.ts';
import { showToast } from '../toast.ts';
import type { ArcadeCaptureApi } from './player.ts';

let captureBusy = false;

export function openArcadeShare(options: ShareModalProps): void {
  createShareModal(options);
}

function shareProps(game: Game): ShareModalProps {
  return {
    post: {
      id: game.postId,
      text: game.title,
      username: game.username,
      display_name: game.displayName,
    },
    url: `${window.location.origin}/arcade/${game.id}`,
    onClose: () => {},
  };
}

function openScoreCard(game: Game, blob: Blob, filename: string, type = 'image/png'): void {
  openArcadeShare({
    ...shareProps(game),
    media: { blob: new Blob([blob], { type }), filename },
  });
}

/** Find a live frame and return a game-titled score card. */
async function composeCard(
  game: Game,
  capture: ArcadeCaptureApi,
  options: { score?: number; footer?: string; timeoutMs?: number },
): Promise<Blob> {
  const frame = await capture.requestFrame(options.timeoutMs);
  return capture.composeScoreCard(frame, {
    title: game.title,
    username: game.username,
    score: options.score,
    footer: options.footer,
  });
}

/** Share a game, falling back to text when the sandbox cannot be captured. */
export async function shareArcadeGame(game: Game, capture: ArcadeCaptureApi | null): Promise<void> {
  if (captureBusy) return;
  if (!capture) {
    openArcadeShare(shareProps(game));
    return;
  }

  captureBusy = true;
  showToast(t('arcade.share_capturing'));
  try {
    // A short cap keeps a slow sandbox from making Share feel stuck.
    const card = await composeCard(game, capture, { footer: t('arcade.share_capture_footer'), timeoutMs: 1000 });
    openScoreCard(game, card, `flaxia-${game.id}-share.png`);
  } catch (error) {
    console.warn('Share capture failed:', error);
    openArcadeShare(shareProps(game));
  } finally {
    captureBusy = false;
  }
}

/** The sandbox posted a score: capture the frame and open the share dialog. */
export async function shareArcadeScore(
  game: Game,
  score: number,
  label: string,
  capture: ArcadeCaptureApi | null,
): Promise<void> {
  if (!capture || captureBusy) return;
  captureBusy = true;
  try {
    const card = await composeCard(game, capture, { score, footer: label });
    openScoreCard(game, card, `flaxia-${game.id}-score.png`);
  } catch (error) {
    console.warn('Score card capture failed:', error);
  } finally {
    captureBusy = false;
  }
}
