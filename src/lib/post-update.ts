import { Post } from '../types/post.js';

type PostCardLike = { updatePost: (update: Partial<Post>) => void };

export function createPostUpdatedHandler(postCards: Map<string, PostCardLike>): (e: Event) => void {
  return (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (!detail?.postId) return;
    const card = postCards.get(detail.postId);
    if (card) {
      const update: Partial<Post> = {};
      if (detail.isFreshed !== undefined) update.is_freshed = detail.isFreshed;
      if (detail.freshCount !== undefined) update.fresh_count = detail.freshCount;
      if (detail.isBookmarked !== undefined) update.is_bookmarked = detail.isBookmarked;
      if (detail.bookmarkCount !== undefined) update.bookmark_count = detail.bookmarkCount;
      if (detail.replyCount !== undefined) update.reply_count = detail.replyCount;
      card.updatePost(update);
    }
  };
}
