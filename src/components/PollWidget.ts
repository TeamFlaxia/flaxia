// Legacy-compatible bridge: Svelte owns the poll DOM, this keeps the factory API.
import { type Component, mount, unmount } from 'svelte';
import PollWidgetView from '../lib/svelte/PollWidget.svelte';

export interface PollData {
  id: string;
  question: string;
  userVote: string | null;
  expired?: boolean;
  multipleChoice: boolean;
  endsAt?: string | null;
  options: Array<{ id: string; label: string; votes_count: number }>;
}

export function createPollElement(poll: PollData): HTMLElement {
  const target = document.createElement('div');
  const instance = mount(PollWidgetView as Component, { target, props: poll });
  const element = target.firstElementChild as HTMLElement;
  element.remove();
  (element as HTMLElement & { destroy?: () => void }).destroy = () => unmount(instance as never);
  return element;
}
