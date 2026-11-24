<script lang="ts">
import { type PostRow, renderPostArticle } from '../../../functions/lib/render-html.ts';
import type { Post } from '../../../shared/types/post.ts';

// Server-rendered post summary for no-JS / crawler clients. Reuses the shared
// escaping renderer so text, hashtags, colours and media match the API.
let { post, isReply = false }: { post: Post; isReply?: boolean } = $props();

const html = $derived(renderPostArticle(post as unknown as PostRow, '', isReply));
</script>

{@html html}
