import { useEffect, type ComponentProps } from 'react';
import { Leva } from 'leva';

type LevaProps = ComponentProps<typeof Leva>;

function isFormControl(element: Element | null) {
  return Boolean(element?.closest('input, select, textarea, button, a'));
}

function findSliderElement(target: EventTarget | null) {
  if (!(target instanceof Element) || isFormControl(target)) return null;

  const root = document.getElementById('leva__root');
  let element: Element | null = target;

  while (element && element !== root) {
    if (element instanceof HTMLElement) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hasNumericInputSibling = Boolean(element.parentElement?.querySelector('input[type="text"]'));
      const looksLikeSlider =
        hasNumericInputSibling &&
        style.touchAction === 'none' &&
        style.cursor === 'pointer' &&
        rect.width > 48 &&
        rect.height >= 12 &&
        rect.height <= 48;

      if (looksLikeSlider) return element;
    }

    element = element.parentElement;
  }

  return null;
}

function shouldBridgeTouchDrag() {
  if (navigator.maxTouchPoints <= 0) return false;

  const userAgent = navigator.userAgent;
  const isiOS = /iPad|iPhone|iPod/.test(userAgent);
  const isTouchMac = userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1;

  return isiOS || isTouchMac;
}

function patchPointerCapture(element: HTMLElement) {
  const originalSetPointerCapture = element.setPointerCapture;
  const originalReleasePointerCapture = element.releasePointerCapture;
  const originalHasPointerCapture = element.hasPointerCapture;

  element.setPointerCapture = () => undefined;
  element.releasePointerCapture = () => undefined;
  element.hasPointerCapture = () => false;

  return () => {
    element.setPointerCapture = originalSetPointerCapture;
    element.releasePointerCapture = originalReleasePointerCapture;
    element.hasPointerCapture = originalHasPointerCapture;
  };
}

function dispatchPointerEvent(element: HTMLElement, type: string, touch: Touch, isEnd = false) {
  if ('PointerEvent' in window) {
    element.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: touch.identifier || 1,
      pointerType: 'touch',
      isPrimary: true,
      buttons: isEnd ? 0 : 1,
      clientX: touch.clientX,
      clientY: touch.clientY,
      screenX: touch.screenX,
      screenY: touch.screenY,
    }));
    return;
  }

  element.dispatchEvent(new MouseEvent(
    type.replace('pointer', 'mouse'),
    {
      bubbles: true,
      cancelable: true,
      buttons: isEnd ? 0 : 1,
      clientX: touch.clientX,
      clientY: touch.clientY,
      screenX: touch.screenX,
      screenY: touch.screenY,
    },
  ));
}

function getChangedTouch(event: TouchEvent, touchId: number) {
  return Array.from(event.changedTouches).find((touch) => touch.identifier === touchId) ?? null;
}

function useMobileLevaSliders() {
  useEffect(() => {
    const root = document.getElementById('leva__root');
    if (!root) return undefined;

    let activeSlider: HTMLElement | null = null;
    let activeTouchId: number | null = null;
    let restorePointerCapture: (() => void) | null = null;

    const handleTouchStart = (event: TouchEvent) => {
      const slider = findSliderElement(event.target);
      if (!(slider instanceof HTMLElement)) return;

      activeSlider = slider;

      if (!shouldBridgeTouchDrag()) return;

      const touch = event.changedTouches[0];
      if (!touch) return;

      activeTouchId = touch.identifier;
      restorePointerCapture = patchPointerCapture(slider);
      if (event.cancelable) event.preventDefault();
      dispatchPointerEvent(slider, 'pointerdown', touch);
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!activeSlider || !event.cancelable) return;
      event.preventDefault();

      if (!shouldBridgeTouchDrag() || activeTouchId === null) return;

      const touch = getChangedTouch(event, activeTouchId);
      if (!touch) return;

      dispatchPointerEvent(activeSlider, 'pointermove', touch);
    };

    const endTouchDrag = (event: TouchEvent, type: 'pointerup' | 'pointercancel') => {
      if (activeSlider && shouldBridgeTouchDrag() && activeTouchId !== null) {
        const touch = getChangedTouch(event, activeTouchId);
        if (touch) {
          if (event.cancelable) event.preventDefault();
          dispatchPointerEvent(activeSlider, type, touch, true);
        }
      }

      restorePointerCapture?.();
      activeSlider = null;
      activeTouchId = null;
      restorePointerCapture = null;
    };

    const handleTouchEnd = (event: TouchEvent) => endTouchDrag(event, 'pointerup');
    const handleTouchCancel = (event: TouchEvent) => endTouchDrag(event, 'pointercancel');

    root.addEventListener('touchstart', handleTouchStart, { capture: true, passive: false });
    root.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
    root.addEventListener('touchend', handleTouchEnd, { capture: true, passive: false });
    root.addEventListener('touchcancel', handleTouchCancel, { capture: true, passive: false });

    return () => {
      root.removeEventListener('touchstart', handleTouchStart, { capture: true });
      root.removeEventListener('touchmove', handleTouchMove, { capture: true });
      root.removeEventListener('touchend', handleTouchEnd, { capture: true });
      root.removeEventListener('touchcancel', handleTouchCancel, { capture: true });
      restorePointerCapture?.();
    };
  }, []);
}

export function SketchControls(props: LevaProps) {
  useMobileLevaSliders();

  return (
    <aside className="sketch-controls">
      <Leva {...props} />
    </aside>
  );
}
