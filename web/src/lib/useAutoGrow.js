import { useEffect, useRef } from 'react';

/**
 * A textarea that grows to fit what has been typed.
 *
 * The height is reset to `auto` BEFORE scrollHeight is read. A browser never
 * reports a scrollHeight smaller than the element's own height, so without the
 * reset the box only ever gets taller — delete a paragraph and you are left
 * staring at the empty space it used to occupy.
 *
 * Beyond MAX_HEIGHT it scrolls rather than pushing the rest of the page away.
 */

const MIN_HEIGHT = 64;
const MAX_HEIGHT = 240;

export function useAutoGrow(value) {
  const ref = useRef(null);

  useEffect(() => {
    const field = ref.current;
    if (!field) return;

    field.style.height = 'auto';
    const content = Math.max(field.scrollHeight, MIN_HEIGHT);

    field.style.height = `${Math.min(content, MAX_HEIGHT)}px`;
    field.style.overflowY = content > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  return ref;
}
