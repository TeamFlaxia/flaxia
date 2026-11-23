<script lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Svelte markup reads these
// biome-ignore-all lint/correctness/noUnusedImports: Svelte markup reads these
import { onMount, tick } from 'svelte';
import { startTutorialDemo } from '../../arcade/tutorial-demo.ts';
import { t } from '../../i18n.ts';
import { iconHtml } from '../../post/icon-html.ts';

interface Props {
  onClose: () => void;
}

let { onClose }: Props = $props();

interface Step {
  kind: 'card' | 'demo' | 'spotlight';
  title: string;
  desc: string;
  target?: string;
}

const steps: Step[] = $derived([
  { kind: 'card', title: t('arcade.tutorial_welcome_title'), desc: t('arcade.tutorial_welcome_desc') },
  { kind: 'demo', title: t('arcade.tutorial_step1_title'), desc: t('arcade.tutorial_step1_desc') },
  {
    kind: 'spotlight',
    target: '.arcade-game-container',
    title: t('arcade.tutorial_step2_title'),
    desc: t('arcade.tutorial_step2_desc'),
  },
  {
    kind: 'spotlight',
    target: '[data-tutorial="fullscreen"]',
    title: t('arcade.tutorial_step3_title'),
    desc: t('arcade.tutorial_step3_desc'),
  },
  {
    kind: 'spotlight',
    target: '[data-tutorial="fresh"]',
    title: t('arcade.tutorial_step4_title'),
    desc: t('arcade.tutorial_step4_desc'),
  },
  {
    kind: 'spotlight',
    target: '[data-tutorial="comments"]',
    title: t('arcade.tutorial_step5_title'),
    desc: t('arcade.tutorial_step5_desc'),
  },
  {
    kind: 'spotlight',
    target: '[data-nav-id="home"]',
    title: t('arcade.tutorial_step6_title'),
    desc: t('arcade.tutorial_step6_desc'),
  },
]);

let stepIndex = $state(0);
let targetRect = $state<{ top: number; left: number; width: number; height: number } | null>(null);
let tooltipLeft = $state(0);
let tooltipTop = $state(0);
let overlayEl: HTMLDivElement | undefined = $state();
let tooltipEl: HTMLDivElement | undefined = $state();
let canvasEl: HTMLCanvasElement | undefined = $state();

const step = $derived(steps[stepIndex] ?? steps[0]);
const isLast = $derived(stepIndex === steps.length - 1);
const showSpotlight = $derived(step.kind === 'spotlight' && targetRect !== null);

function measure(): void {
  const current = steps[stepIndex];
  targetRect = null;
  if (!current || current.kind !== 'spotlight' || !current.target) return;
  if (isLast && current.target === '[data-nav-id="home"]' && window.innerWidth <= 768) {
    document.dispatchEvent(new CustomEvent('openLeftNav'));
  }
  const target = document.querySelector(current.target);
  if (!(target instanceof HTMLElement)) return;
  const rect = target.getBoundingClientRect();
  targetRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function goTo(index: number): void {
  if (index < 0 || index >= steps.length) return;
  stepIndex = index;
  targetRect = null;
  void tick().then(measure);
}

async function positionTooltip(): Promise<void> {
  await tick();
  if (!tooltipEl || !targetRect) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 12;
  const tooltipW = Math.min(280, vw - margin * 2);
  const tooltipH = tooltipEl.offsetHeight || 160;
  const centerX = targetRect.left + targetRect.width / 2;
  const centerY = targetRect.top + targetRect.height / 2;
  const inLeftNav = Boolean(document.querySelector('.left-nav')?.contains(document.elementFromPoint(centerX, centerY)));

  let tx: number;
  let ty: number;
  if (inLeftNav && vw <= 768) {
    tx = Math.max(margin, centerX - tooltipW / 2);
    ty = targetRect.top + targetRect.height + margin;
  } else if (centerX < vw * 0.4) {
    tx = targetRect.left + targetRect.width + margin;
    ty = Math.min(centerY - tooltipH / 2, vh - tooltipH - margin);
  } else if (centerX > vw * 0.6) {
    tx = targetRect.left - tooltipW - margin;
    ty = Math.min(centerY - tooltipH / 2, vh - tooltipH - margin);
  } else if (centerY < vh * 0.4) {
    tx = Math.max(margin, centerX - tooltipW / 2);
    ty = targetRect.top + targetRect.height + margin;
  } else {
    tx = Math.max(margin, centerX - tooltipW / 2);
    ty = targetRect.top - tooltipH - margin;
  }

  tooltipLeft = Math.max(margin, Math.min(vw - tooltipW - margin, tx));
  tooltipTop = Math.max(margin, Math.min(vh - tooltipH - margin, ty));
}

$effect(() => {
  if (targetRect) void positionTooltip();
});

$effect(() => {
  const canvas = canvasEl;
  if (!canvas) return;
  const stop = startTutorialDemo(canvas);
  return () => stop();
});

onMount(() => {
  const blockOutside = (event: Event) => {
    if (overlayEl?.contains(event.target as Node)) return;
    const consent = document.getElementById('flaxia-consent-container');
    if (consent && event.composedPath().includes(consent)) return;
    event.stopPropagation();
    event.preventDefault();
  };
  const onResize = () => {
    targetRect = null;
    void tick().then(measure);
  };

  document.addEventListener('click', blockOutside, true);
  document.addEventListener('touchstart', blockOutside, true);
  window.addEventListener('resize', onResize);
  void tick().then(measure);

  return () => {
    document.removeEventListener('click', blockOutside, true);
    document.removeEventListener('touchstart', blockOutside, true);
    window.removeEventListener('resize', onResize);
  };
});

function handleOverlayClick(event: MouseEvent): void {
  // Cards and tooltips stop propagation; the transparent overlay ignores taps.
  if (event.target === event.currentTarget) event.stopPropagation();
}
</script>

{#snippet controls(small: boolean)}
  <div class="arcade-tutorial-buttons" class:is-small={small}>
    {#if stepIndex > 1}
      <button type="button" class="arcade-tutorial-btn is-ghost" onclick={() => goTo(stepIndex - 1)}>
        {t('arcade.tutorial_prev')}
      </button>
    {/if}
    {#if isLast}
      <button type="button" class="arcade-tutorial-btn is-primary" onclick={onClose}>
        {t('arcade.tutorial_done')}
      </button>
    {:else}
      <button type="button" class="arcade-tutorial-btn is-primary" onclick={() => goTo(stepIndex + 1)}>
        {t('arcade.tutorial_next')}
      </button>
    {/if}
  </div>
{/snippet}

<div class="arcade-tutorial-overlay" bind:this={overlayEl} role="presentation" onclick={handleOverlayClick}>
  {#if !showSpotlight}
    <div class="arcade-tutorial-card" role="dialog" aria-modal="true">
      <button type="button" class="arcade-tutorial-close" aria-label={t('common.close')} onclick={onClose}>
        {@html iconHtml('close', 18)}
      </button>
      {#if step.kind === 'demo'}
        <canvas bind:this={canvasEl} class="arcade-tutorial-canvas" width="320" height="200"></canvas>
      {/if}
      <h2>{step.title}</h2>
      <p>{step.desc}</p>
      {#if stepIndex === 0}
        <div class="arcade-tutorial-buttons">
          <button type="button" class="arcade-tutorial-btn is-primary" onclick={() => goTo(1)}>
            {t('arcade.tutorial_start')}
          </button>
          <button type="button" class="arcade-tutorial-btn is-ghost" onclick={onClose}>
            {t('arcade.tutorial_skip')}
          </button>
        </div>
      {:else}
        {@render controls(false)}
      {/if}
    </div>
  {:else}
    <div
      class="arcade-tutorial-spotlight"
      style:top="{targetRect?.top ?? 0}px"
      style:left="{targetRect?.left ?? 0}px"
      style:width="{targetRect?.width ?? 0}px"
      style:height="{targetRect?.height ?? 0}px"
    ></div>
    <div
      class="arcade-tutorial-tooltip"
      bind:this={tooltipEl}
      style:left="{tooltipLeft}px"
      style:top="{tooltipTop}px"
    >
      <div class="arcade-tutorial-step-label">{stepIndex}/{steps.length - 1}</div>
      <div class="arcade-tutorial-tooltip-title">{step.title}</div>
      <div class="arcade-tutorial-tooltip-desc">{step.desc}</div>
      {@render controls(true)}
    </div>
  {/if}
</div>

<style>
  .arcade-tutorial-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    pointer-events: none;
  }

  .arcade-tutorial-card {
    position: fixed;
    top: 50%;
    left: 50%;
    box-sizing: border-box;
    width: calc(100% - 3rem);
    max-width: 420px;
    padding: 2rem 1.5rem;
    border-radius: 16px;
    background: var(--bg-primary, #fff);
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.3);
    text-align: center;
    transform: translate(-50%, -50%);
    pointer-events: auto;
  }

  .arcade-tutorial-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    display: inline-flex;
    align-items: center;
    padding: 0.25rem;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-muted, #888);
    cursor: pointer;
  }

  .arcade-tutorial-card h2 {
    margin: 0 0 0.75rem;
    color: var(--text-primary);
    font-size: 1.2rem;
    font-weight: 700;
    line-height: 1.4;
  }

  .arcade-tutorial-card p {
    margin: 0 0 1.25rem;
    color: var(--text-secondary, #555);
    font-size: 0.95rem;
    line-height: 1.6;
  }

  .arcade-tutorial-canvas {
    display: block;
    width: 100%;
    max-width: 320px;
    aspect-ratio: 320 / 200;
    margin: 0 auto 1rem;
    border-radius: 10px;
    cursor: pointer;
    touch-action: manipulation;
  }

  .arcade-tutorial-buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }

  .arcade-tutorial-buttons.is-small {
    gap: 0.5rem;
  }

  .arcade-tutorial-btn {
    padding: 0.5rem 1.2rem;
    border: 0;
    border-radius: var(--radius-button);
    font-family: var(--font-sans);
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.3;
    box-shadow: var(--shadow-xs);
    cursor: pointer;
    transition: opacity var(--duration-fast) var(--ease-standard);
  }

  .arcade-tutorial-btn:hover {
    opacity: 0.85;
  }

  .arcade-tutorial-btn.is-primary {
    background: var(--primary);
    color: var(--primary-fg);
  }

  .arcade-tutorial-btn.is-ghost {
    border: 1px solid var(--border, #ddd);
    background: transparent;
    color: var(--text-muted, #888);
  }

  .arcade-tutorial-buttons.is-small .arcade-tutorial-btn {
    padding: 0.4rem 0.8rem;
    font-size: 0.8rem;
  }

  .arcade-tutorial-spotlight {
    position: fixed;
    z-index: 2000;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-card);
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.65);
    pointer-events: none;
  }

  .arcade-tutorial-tooltip {
    position: fixed;
    z-index: 2001;
    max-width: 280px;
    padding: 1rem 1.25rem;
    border-radius: 12px;
    background: var(--bg-primary, #fff);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
    text-align: center;
    pointer-events: auto;
  }

  .arcade-tutorial-step-label {
    margin-bottom: 0.5rem;
    color: var(--text-muted, #888);
    font-size: 0.7rem;
  }

  .arcade-tutorial-tooltip-title {
    margin-bottom: 0.4rem;
    color: var(--text-primary);
    font-size: 1rem;
    font-weight: 700;
  }

  .arcade-tutorial-tooltip-desc {
    margin-bottom: 0.75rem;
    color: var(--text-secondary, #555);
    font-size: 0.85rem;
    line-height: 1.5;
  }
</style>
