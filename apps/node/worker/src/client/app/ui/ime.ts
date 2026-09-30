/**
 * Whether a key press belongs to an input method's composition rather than to the page.
 *
 * A Chinese, Japanese or Korean reader types through an IME: the Enter that commits 发票 from the candidate list
 * is not a request to submit, and the arrows that move through candidates are not a request to move the
 * palette's selection. `isComposing` says so in most browsers. Safari fires that committing keydown after
 * `compositionend`, with `isComposing` false, and marks it only with `keyCode` 229, the value every browser
 * gives a key the IME consumed; so both are read. `keyCode` is deprecated, and it is still the only signal
 * Safari sends here.
 *
 * Every handler that acts on Enter (or on arrows, in a text field) asks this first. React's event carries the
 * browser's as `nativeEvent`.
 */
export function isComposingKey(event: { readonly isComposing: boolean; readonly keyCode: number }): boolean {
  return event.isComposing || event.keyCode === 229;
}
