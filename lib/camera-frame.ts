/** Match the decoded area to a centred object-fit: cover preview. */
export function cameraFrame(
  sourceWidth: number,
  sourceHeight: number,
  viewWidth: number,
  viewHeight: number,
  cover = false,
) {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0)
    return null;
  let sw = sourceWidth,
    sh = sourceHeight;
  if (cover) {
    if (!Number.isFinite(viewWidth) || !Number.isFinite(viewHeight) || viewWidth <= 0 || viewHeight <= 0) return null;
    const ratio = viewWidth / viewHeight;
    if (sourceWidth / sourceHeight > ratio) sw = sourceHeight * ratio;
    else sh = sourceWidth / ratio;
  }
  const scale = Math.min(1, 720 / (cover ? Math.max(sw, sh) : sw));
  return {
    sx: (sourceWidth - sw) / 2,
    sy: (sourceHeight - sh) / 2,
    sw,
    sh,
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale)),
  };
}
