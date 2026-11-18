/**
 * Tagged-template renderer.
 *
 * `html` compiles a template once per call site into a real `<template>`, then
 * clones it for every instantiation. Interpolations become "parts" that mutate
 * only the DOM they own:
 *
 *   html`<p>${() => post.text}</p>`
 *
 * A function in a child position is an accessor; it is subscribed with
 * `effect()` and updates the text node in place. A function in an attribute
 * position is treated the same way. Everything else is rendered once.
 *
 * Supported bindings (the interpolation must occupy the whole value):
 *   ${value}          child / text
 *   attr=${value}     attribute
 *   attr="${value}"   attribute
 *   .prop=${value}    DOM property
 *   ?flag=${value}    boolean attribute
 *   @event=${fn}      event listener
 *   ref=${fn}         element reference
 *
 * Values are never parsed as HTML. A post containing `<img onerror=...>` is
 * rendered as text, which keeps the stored-XSS surface out of this layer.
 */

import { createOwner, disposeOwner, type Owner, onCleanup, runInOwner } from './owner.ts';
import { effect, untrack } from './signal.ts';

export interface TemplateResult {
  readonly __flxTemplate: true;
  readonly template: CompiledTemplate;
  readonly values: readonly unknown[];
}

export interface Directive {
  readonly __flxDirective: true;
  render(part: ChildPart): void;
  dispose?(): void;
}

export type Renderable =
  | string
  | number
  | Node
  | TemplateResult
  | Directive
  | (() => Renderable)
  | null
  | undefined
  | boolean
  | readonly Renderable[];

type AttributeKind = 'attr' | 'prop' | 'bool' | 'event' | 'ref';

interface ChildSpec {
  index: number;
  marker: string;
}

interface AttributeSpec {
  index: number;
  kind: AttributeKind;
  /** Logical name used by the part: `value`, `click`, `disabled`. */
  name: string;
  /** Name as written in the template: `.value`, `@click`, `?disabled`. */
  rawName: string;
  marker: string;
}

interface CompiledTemplate {
  element: HTMLTemplateElement;
  children: ChildSpec[];
  attributes: AttributeSpec[];
}

interface Part {
  set(value: unknown): void;
  dispose(): void;
}

const templateCache = new WeakMap<TemplateStringsArray, CompiledTemplate>();
let templateSequence = 0;
const MARKER_PREFIX = '__flx_';
const MARKER_SUFFIX = '__';

export function html(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult {
  let template = templateCache.get(strings);
  if (!template) {
    template = compile(strings);
    templateCache.set(strings, template);
  }
  return { __flxTemplate: true, template, values };
}

export function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === 'object' && value !== null && (value as TemplateResult).__flxTemplate === true;
}

export function isDirective(value: unknown): value is Directive {
  return typeof value === 'object' && value !== null && (value as Directive).__flxDirective === true;
}

function isAccessor(value: unknown): value is () => Renderable {
  return typeof value === 'function';
}

function markerFor(sequence: number, index: number): string {
  return `${MARKER_PREFIX}${sequence}_${index}${MARKER_SUFFIX}`;
}

interface ScanState {
  inTag: boolean;
  quote: string | null;
  lastMeaningful: string;
}

/** Track whether the accumulated template source is inside a tag or a quoted value. */
function scan(source: string): ScanState {
  let inTag = false;
  let quote: string | null = null;
  let lastMeaningful = '';

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (quote) {
      if (char === quote) quote = null;
      continue;
    }

    if (inTag && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }

    if (char === '<') {
      inTag = true;
      lastMeaningful = '<';
      continue;
    }

    if (char === '>') {
      inTag = false;
      lastMeaningful = '>';
      continue;
    }

    if (!/\s/.test(char)) lastMeaningful = char;
  }

  return { inTag, quote, lastMeaningful };
}

function readAttributeName(source: string, quoted: boolean): { kind: AttributeKind; name: string; rawName: string } {
  let index = source.length - 1;
  if (quoted) index--;
  while (index >= 0 && /\s/.test(source[index])) index--;

  if (source[index] !== '=') {
    throw new Error('[render] interpolation is not an attribute value');
  }
  index--;
  while (index >= 0 && /\s/.test(source[index])) index--;

  const end = index + 1;
  while (index >= 0 && !/[\s<>/]/.test(source[index])) index--;
  const raw = source.slice(index + 1, end);

  if (raw.startsWith('@')) return { kind: 'event', name: raw.slice(1), rawName: raw };
  if (raw.startsWith('.')) return { kind: 'prop', name: raw.slice(1), rawName: raw };
  if (raw.startsWith('?')) return { kind: 'bool', name: raw.slice(1), rawName: raw };
  if (raw === 'ref') return { kind: 'ref', name: 'ref', rawName: raw };
  return { kind: 'attr', name: raw, rawName: raw };
}

const RAW_TEXT_ELEMENT = /<(script|style|textarea|title)\b[^>]*>[^<]*$/i;

function compile(strings: TemplateStringsArray): CompiledTemplate {
  const sequence = ++templateSequence;
  let source = '';
  const children: ChildSpec[] = [];
  const attributes: AttributeSpec[] = [];

  for (let i = 0; i < strings.length; i++) {
    source += strings[i];
    if (i === strings.length - 1) break;

    const marker = markerFor(sequence, i);
    const state = scan(source);

    if (!state.inTag) {
      if (RAW_TEXT_ELEMENT.test(source)) {
        throw new Error('[render] child interpolation inside script/style/textarea/title is not supported');
      }
      source += `<!--${marker}-->`;
      children.push({ index: i, marker });
      continue;
    }

    if (state.quote) {
      if (!source.endsWith(state.quote) || !strings[i + 1].startsWith(state.quote)) {
        throw new Error('[render] an interpolation must occupy the entire attribute value');
      }
      const { kind, name, rawName } = readAttributeName(source, true);
      source += marker;
      attributes.push({ index: i, kind, name, rawName, marker });
      continue;
    }

    if (state.lastMeaningful === '=') {
      if (!/^(\s|>|\/|$)/.test(strings[i + 1])) {
        throw new Error('[render] an interpolation must occupy the entire attribute value');
      }
      const { kind, name, rawName } = readAttributeName(source, false);
      source += marker;
      attributes.push({ index: i, kind, name, rawName, marker });
      continue;
    }

    throw new Error('[render] attribute-name and spread interpolations are not supported');
  }

  const element = document.createElement('template');
  element.innerHTML = source;
  return { element, children, attributes };
}

function findComment(root: Node, marker: string): Comment | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  let node = walker.nextNode();
  while (node) {
    if ((node as Comment).data === marker) return node as Comment;
    node = walker.nextNode();
  }
  return null;
}

function findElementWithAttribute(root: Node, name: string, marker: string): Element | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const element = node as Element;
    if (element.getAttribute(name) === marker) return element;
    node = walker.nextNode();
  }
  return null;
}

export interface Instantiated {
  fragment: DocumentFragment;
  parts: Part[];
}

export function instantiate(result: TemplateResult, owner: Owner): Instantiated {
  return runInOwner(owner, () => {
    const fragment = result.template.element.content.cloneNode(true) as DocumentFragment;
    const parts: Part[] = [];

    for (const spec of result.template.children) {
      const anchor = findComment(fragment, spec.marker);
      if (!anchor) throw new Error(`[render] child marker not found: ${spec.marker}`);
      parts[spec.index] = new ChildPart(anchor, owner);
    }

    for (const spec of result.template.attributes) {
      const element = findElementWithAttribute(fragment, spec.rawName, spec.marker);
      if (!element) {
        throw new Error(`[render] attribute marker not found: ${spec.rawName}="${spec.marker}"`);
      }
      element.removeAttribute(spec.rawName);
      parts[spec.index] = createAttributePart(spec, element);
    }

    for (let i = 0; i < result.values.length; i++) {
      parts[i]?.set(result.values[i]);
    }

    // ChildPart already registers its own lifetime in the constructor. The
    // other parts (events, refs, attributes) must be tied to the same owner or
    // their listeners would outlive the template instance.
    for (const part of parts) {
      if (part && !(part instanceof ChildPart)) {
        onCleanup(() => part.dispose());
      }
    }

    return { fragment, parts };
  });
}

function createAttributePart(spec: AttributeSpec, element: Element): Part {
  switch (spec.kind) {
    case 'event':
      return new EventPart(element, spec.name);
    case 'prop':
      return new PropertyPart(element, spec.name);
    case 'bool':
      return new BooleanPart(element, spec.name);
    case 'ref':
      return new RefPart(element);
    default:
      return new AttributePart(element, spec.name);
  }
}

/** Bind an accessor once and keep the effect alive for the part's lifetime. */
function bindAccessor(value: unknown, apply: (next: unknown) => void): (() => void) | null {
  if (!isAccessor(value)) {
    apply(value);
    return null;
  }

  return effect(() => {
    const next = value();
    untrack(() => apply(next));
  });
}

class AttributePart implements Part {
  private readonly element: Element;
  private readonly name: string;
  private disposeEffect: (() => void) | null = null;

  constructor(element: Element, name: string) {
    this.element = element;
    this.name = name;
  }

  set(value: unknown): void {
    this.disposeEffect?.();
    this.disposeEffect = bindAccessor(value, (next) => this.apply(next));
  }

  private apply(value: unknown): void {
    if (value == null || value === false) {
      this.element.removeAttribute(this.name);
      return;
    }
    if (value === true) {
      this.element.setAttribute(this.name, '');
      return;
    }
    if (this.name === 'style' && typeof value === 'object' && !(value instanceof Node)) {
      const style = this.element as HTMLElement;
      style.style.cssText = '';
      for (const [property, propertyValue] of Object.entries(value as Record<string, unknown>)) {
        if (propertyValue == null || propertyValue === false) continue;
        style.style.setProperty(property, String(propertyValue));
      }
      return;
    }
    if (this.name === 'class' && typeof value === 'object' && !(value instanceof Node)) {
      const classes = Object.entries(value as Record<string, unknown>)
        .filter(([, enabled]) => Boolean(enabled))
        .map(([className]) => className)
        .join(' ');
      if (classes) this.element.setAttribute('class', classes);
      else this.element.removeAttribute('class');
      return;
    }
    this.element.setAttribute(this.name, String(value));
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
  }
}

class PropertyPart implements Part {
  private readonly element: Element;
  private readonly name: string;
  private disposeEffect: (() => void) | null = null;

  constructor(element: Element, name: string) {
    this.element = element;
    this.name = name;
  }

  set(value: unknown): void {
    this.disposeEffect?.();
    this.disposeEffect = bindAccessor(value, (next) => this.apply(next));
  }

  private apply(value: unknown): void {
    const target = this.element as unknown as Record<string, unknown>;
    target[this.name] = this.name === 'value' && value == null ? '' : value;
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
  }
}

class BooleanPart implements Part {
  private readonly element: Element;
  private readonly name: string;
  private disposeEffect: (() => void) | null = null;

  constructor(element: Element, name: string) {
    this.element = element;
    this.name = name;
  }

  set(value: unknown): void {
    this.disposeEffect?.();
    this.disposeEffect = bindAccessor(value, (next) => this.apply(next));
  }

  private apply(value: unknown): void {
    this.element.toggleAttribute(this.name, Boolean(value));
  }

  dispose(): void {
    this.disposeEffect?.();
    this.disposeEffect = null;
  }
}

class EventPart implements Part {
  private readonly element: Element;
  private readonly name: string;
  private handler: ((event: Event) => void) | null = null;
  private readonly listener: EventListener;

  constructor(element: Element, name: string) {
    this.element = element;
    this.name = name;
    this.listener = (event: Event) => {
      this.handler?.(event);
    };
    this.element.addEventListener(this.name, this.listener);
    onCleanup(() => this.element.removeEventListener(this.name, this.listener));
  }

  set(value: unknown): void {
    if (typeof value === 'function') {
      this.handler = value as (event: Event) => void;
      return;
    }
    if (Array.isArray(value) && typeof value[0] === 'function') {
      this.handler = value[0] as (event: Event) => void;
      return;
    }
    this.handler = null;
  }

  dispose(): void {
    this.handler = null;
    this.element.removeEventListener(this.name, this.listener);
  }
}

class RefPart implements Part {
  private readonly element: Element;
  private callback: ((element: Element | null) => void) | null = null;
  private disposed = false;

  constructor(element: Element) {
    this.element = element;
  }

  set(value: unknown): void {
    this.callback = typeof value === 'function' ? (value as (element: Element | null) => void) : null;
    this.callback?.(this.element);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.callback?.(null);
    this.callback = null;
  }
}

function removeBetween(start: Node, end: Node): void {
  let node = start.nextSibling;
  while (node && node !== end) {
    const next = node.nextSibling;
    node.parentNode?.removeChild(node);
    node = next;
  }
}

function moveRangeBefore(start: Node, end: Node, reference: Node): void {
  if (end.nextSibling === reference) return;
  const parent = reference.parentNode;
  if (!parent) return;

  const nodes: Node[] = [];
  let node: Node | null = start;
  while (node) {
    nodes.push(node);
    if (node === end) break;
    node = node.nextSibling;
  }
  for (const rangeNode of nodes) parent.insertBefore(rangeNode, reference);
}

export class ChildPart implements Part {
  readonly start: Comment;
  readonly end: Comment;
  readonly owner: Owner | null;

  private contentOwner: Owner | null = null;
  private directiveOwner: Owner | null = null;
  private accessorDispose: (() => void) | null = null;
  private directive: Directive | null = null;
  private textNode: Text | null = null;
  private lastKind: 'empty' | 'text' | 'node' | 'template' | 'directive' | 'array' = 'empty';
  private disposed = false;

  constructor(anchor: Comment, owner: Owner | null) {
    this.start = anchor;
    this.end = document.createComment('');
    anchor.parentNode?.insertBefore(this.end, anchor.nextSibling);
    this.owner = owner;
    onCleanup(() => this.dispose());
  }

  set(value: Renderable): void {
    if (isAccessor(value)) {
      this.disposeAccessor();
      this.accessorDispose = effect(() => {
        // Create the content owner before evaluating the accessor so effects
        // created by a component function belong to the content being replaced,
        // not to the part's long-lived parent.
        const owner = createOwner(this.owner);
        runInOwner(owner, () => {
          const next = value();
          untrack(() => this.renderValue(next, false, owner));
        });
      });
      return;
    }

    this.disposeAccessor();

    if (isDirective(value)) {
      this.clearContent(false);
      this.directive = value;
      // The directive owns its own content and anchors. Keep its owner separate
      // from `contentOwner`: a `when` branch replacement clears content but must
      // not dispose the directive that is currently running.
      const owner = createOwner(this.owner);
      this.directiveOwner = owner;
      runInOwner(owner, () => value.render(this));
      return;
    }

    this.renderValue(value, false);
  }

  /**
   * Used by directives that own the part's content (`when`, `boundary`).
   * The factory runs under a fresh owner, so branch-local effects are released
   * when the branch is replaced.
   */
  renderContent(render: () => Renderable): void {
    this.clearContent(true);
    const owner = createOwner(this.owner);
    runInOwner(owner, () => {
      try {
        const value = render();
        this.renderValue(value, true, owner);
      } catch (error) {
        disposeOwner(owner);
        throw error;
      }
    });
  }

  /** Remove children and (by default) the active directive. */
  clearContent(disposeDirective = true): void {
    if (disposeDirective) {
      this.directive?.dispose?.();
      this.directive = null;
      if (this.directiveOwner) {
        disposeOwner(this.directiveOwner);
        this.directiveOwner = null;
      }
    }

    if (this.contentOwner) {
      disposeOwner(this.contentOwner);
      this.contentOwner = null;
    }

    removeBetween(this.start, this.end);
    this.textNode = null;
    this.lastKind = 'empty';
  }

  private renderValue(value: Renderable, preserveDirective: boolean, ownerOverride: Owner | null = null): void {
    const owner = ownerOverride ?? createOwner(this.owner);
    const isText = typeof value === 'string' || typeof value === 'number';

    // Text updates keep the same node. Replacing it would move the caret in an
    // input-adjacent live region and churn the DOM on every keystroke.
    if (isText && this.lastKind === 'text' && this.textNode && this.textNode.parentNode === this.start.parentNode) {
      this.textNode.nodeValue = String(value);
      if (this.contentOwner && this.contentOwner !== owner) disposeOwner(this.contentOwner);
      this.contentOwner = owner;
      return;
    }

    this.clearContent(preserveDirective);

    runInOwner(owner, () => {
      if (value == null || typeof value === 'boolean') {
        disposeOwner(owner);
        return;
      }

      if (isText) {
        this.textNode = document.createTextNode(String(value));
        this.start.parentNode?.insertBefore(this.textNode, this.end);
        this.contentOwner = owner;
        this.lastKind = 'text';
        return;
      }

      if (isDirective(value)) {
        if (preserveDirective) {
          disposeOwner(owner);
          throw new Error('[render] a directive cannot replace a directive-owned part');
        }
        this.directive = value;
        this.directiveOwner = owner;
        value.render(this);
        this.lastKind = 'directive';
        return;
      }

      if (isTemplateResult(value)) {
        const { fragment } = instantiate(value, owner);
        this.start.parentNode?.insertBefore(fragment, this.end);
        this.contentOwner = owner;
        this.lastKind = 'template';
        return;
      }

      if (value instanceof Node) {
        this.start.parentNode?.insertBefore(value, this.end);
        this.contentOwner = owner;
        this.lastKind = 'node';
        return;
      }

      if (Array.isArray(value)) {
        const fragment = document.createDocumentFragment();
        for (const item of value) {
          if (item == null || typeof item === 'boolean') continue;
          if (typeof item === 'string' || typeof item === 'number') {
            fragment.append(document.createTextNode(String(item)));
            continue;
          }
          if (isTemplateResult(item)) {
            fragment.append(instantiate(item, owner).fragment);
            continue;
          }
          if (item instanceof Node) {
            fragment.append(item);
            continue;
          }
          throw new Error('[render] arrays may only contain strings, numbers, Nodes or templates');
        }
        this.start.parentNode?.insertBefore(fragment, this.end);
        this.contentOwner = owner;
        this.lastKind = 'array';
        return;
      }

      disposeOwner(owner);
      throw new Error(`[render] unsupported renderable: ${String(value)}`);
    });
  }

  private disposeAccessor(): void {
    this.accessorDispose?.();
    this.accessorDispose = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeAccessor();
    // Disposing a part must also dispose the directive that owns its content
    // (`each`, `when`, `boundary`, ...). `clearContent(false)` is only for
    // content replacement where the directive itself stays alive.
    this.clearContent(true);
    this.start.remove();
    this.end.remove();
  }
}

export { moveRangeBefore, removeBetween };
