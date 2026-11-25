<script lang="ts">
import { type PostRow, renderPostArticle } from '../../../functions/lib/render-html.ts';
import type { Post } from '../../../shared/types/post.ts';
import { getLocale } from '../i18n.ts';

// Server-rendered post summary for no-JS / crawler clients. Reuses the shared
// escaping renderer so text, hashtags, colours and media match the API.
// The locale is request-scoped on the server (AsyncLocalStorage), so passing it
// explicitly keeps the card's label and date in the language of the request.
let { post, isReply = false }: { post: Post; isReply?: boolean } = $props();

const html = $derived(renderPostArticle(post as unknown as PostRow, '', isReply, getLocale()));
</script>

{@html html}
