/**
 * Shared file input dialog utility.
 * Replaces repeated boilerplate for creating file input elements.
 */
export function openFileDialog(
  accept: string,
  onFile: (file: File) => void | Promise<void>,
): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.style.display = "none";
  document.body.appendChild(input);
  const cleanup = () => { if (input.parentNode) input.remove(); };
  input.addEventListener("change", async () => {
    cleanup();
    const file = input.files?.[0];
    if (file) await onFile(file);
  });
  // Cleanup on cancel (focus returns without change event)
  window.addEventListener("focus", () => setTimeout(cleanup, 300), { once: true });
  input.click();
}
