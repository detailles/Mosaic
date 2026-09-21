/**
 * Compile-only consumer checks: a typed lens must preserve slot values without casts or reparsing.
 * The package typecheck runs this file; it deliberately does not execute or depend on Bun's test API.
 */
import { ContextManager, defineLens, type LensView } from '../src/index.js';

/** Checks inference, missing values, unknown keys and compatibility with a generic view consumer. */
function checkLensTypes(): void {
  const context = new ContextManager();
  const product = context.defineSlot<{ code: string }>('support.product');
  const reports = context.defineSlot<string[]>('support.reports');
  const lens = defineLens('interpretation', { slots: { product, reports } });
  const view = context.through(lens);
  const code: string | undefined = view.slots.product?.code;
  const entries: string[] | undefined = view.slots.reports;
  const genericView: LensView = view;
  void [code, entries, genericView];

  // @ts-expect-error No selected slot named missing exists.
  view.slots.missing;
  // @ts-expect-error The selected product is not a number.
  const wrong: number = view.slots.product;
  // @ts-expect-error An unset slot must be handled by its consumer.
  const required: { code: string } = view.slots.product;
  // @ts-expect-error A view's slot entries cannot be assigned.
  view.slots.product = { code: 'different' };
  // @ts-expect-error A lens definition is immutable.
  lens.slots!.product = reports;
  void [wrong, required];
}
void checkLensTypes;
