/**
 * Canvases on the applet stage keep a backing store at device resolution (see
 * `useCanvasBackingStore`), while simulations and renderers keep working in fixed
 * logical units. These helpers convert at the draw and input boundaries.
 */

/** Scale the context so drawing in logical units fills the whole backing store. */
export function setLogicalTransform(ctx: CanvasRenderingContext2D, logicalWidth: number): void {
  const k = ctx.canvas.width / logicalWidth;
  ctx.setTransform(k, 0, 0, k, 0, 0);
}

/** Pointer position in the canvas's logical coordinate system. */
export function logicalPointer(
  event: { clientX: number; clientY: number },
  canvas: HTMLCanvasElement,
  logicalWidth: number,
  logicalHeight: number
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * logicalWidth,
    y: ((event.clientY - rect.top) / rect.height) * logicalHeight
  };
}
