/**
 * Save a Blob as a file. The link must be in the document and its URL must
 * outlive the click: a detached link or an immediately revoked URL makes
 * Chromium open an empty tab instead of (or besides) downloading.
 */
export function saveBlob(blob: Blob, name: string): void {
  const safeName = name.replace(/[\/:*?"<>|\u0000-\u001f]/g, '_') || 'download';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
