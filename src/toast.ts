export function showToast(message: string, undo?: () => Promise<void>) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(text);
  let remaining = 5000;
  let started = 0;
  let timer: number | undefined;

  function pause() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining -= performance.now() - started;
  }

  function resume() {
    if (timer !== undefined || toast.matches(':hover, :focus-within')) return;
    started = performance.now();
    timer = window.setTimeout(() => toast.remove(), Math.max(0, remaining));
  }

  if (undo) {
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = 'Undo';
    action.className = 'secondary';
    action.addEventListener('click', async () => {
      pause();
      const hadFocus = document.activeElement === action;
      action.disabled = true;
      try {
        await undo();
      } catch (error) {
        showToast((error as Error).message);
      } finally {
        toast.remove();
        if (hadFocus && document.activeElement === document.body) {
          document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
        }
      }
    });
    toast.append(action);
  }

  toast.addEventListener('pointerenter', pause);
  toast.addEventListener('pointerleave', resume);
  toast.addEventListener('focusin', pause);
  toast.addEventListener('focusout', () => queueMicrotask(resume));
  document.getElementById('toasts')!.append(toast);
  resume();
}
