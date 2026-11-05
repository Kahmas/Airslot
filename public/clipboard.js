// Some browsers and embedded views refuse the clipboard API, so the older copy command backs it up.
function copyWithSelection(text, button) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  // Beside the button, because everything outside an open dialog can't be selected.
  button.parentElement.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  button.focus();
  return copied;
}

export async function copyText(text, button, toast) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = copyWithSelection(text, button);
  }
  toast(copied ? 'Copied.' : "Couldn't copy. Select the text and copy it yourself.");
}
