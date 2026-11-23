<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import type { MediaCue } from '../../../../shared/post-cues.ts';
import type { MediaSlideModel } from '../../../components/MediaCarousel.js';
import MediaSlide from './MediaSlide.svelte';

interface Props {
  postId: string;
  slides: MediaSlideModel[];
  cues?: MediaCue[];
}

let { postId, slides, cues }: Props = $props();

let track = $state<HTMLDivElement>();
let activeIndex = $state(0);

function onScroll(): void {
  if (!track) return;
  activeIndex = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
}

function goTo(index: number): void {
  track?.scrollTo({ left: index * (track.clientWidth || 0), behavior: 'smooth' });
}

function isBoxed(kind: MediaSlideModel['kind']): boolean {
  return kind === 'image' || kind === 'video';
}
</script>

<div class="media-carousel">
  <div bind:this={track} class="media-carousel-track" onscroll={onScroll}>
    {#each slides as slide}
      <div class="media-carousel-slide" class:fx-box={isBoxed(slide.kind)} style={isBoxed(slide.kind) ? '--fx-ratio: 16 / 9' : undefined}>
        <MediaSlide
          kind={slide.kind}
          {postId}
          src={slide.src}
          gifKey={slide.gifKey}
          ratio="16:9"
          {cues}
          gallery={slide.gallery}
          galleryIndex={slide.galleryIndex}
        />
      </div>
    {/each}
  </div>

  {#if slides.length > 1}
    <div class="media-carousel-dots">
      {#each slides as _, i}
        <button
          type="button"
          class="media-carousel-dot"
          class:media-carousel-dot--active={activeIndex === i}
          aria-label={`${i + 1} / ${slides.length}`}
          aria-current={activeIndex === i ? 'true' : 'false'}
          onclick={(e) => {
            e.stopPropagation();
            goTo(i);
          }}
        ></button>
      {/each}
    </div>
  {/if}
</div>
